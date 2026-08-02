// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * One-time rewrite of persisted 0.8 task `workflow:` targets. This module is
 * migrator-only: live task parsing remains strict 0.9 grammar. Planning parses
 * and resolves every legacy v1 target before changing that file; application
 * uses an atomic write. An interrupted batch is safely re-planned and resumed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMap, parseDocument, stringify as stringifyYaml } from "yaml";
import { bundlesToSourceEntries } from "../../../../src/core/config/config";
import type { AkmConfig, BundleConfigEntry } from "../../../../src/core/config/config-types";
import { ConfigError } from "../../../../src/core/errors";
import { resolveWritable } from "../../../../src/core/write-source";
import { resolveEntryContentDir } from "../../../../src/indexer/search/search-source";
import type { LockfileEntry } from "../../../../src/integrations/lockfile";
import { parseTaskDocument } from "../../../../src/tasks/parser";
import { classifyRefGrammar, legacyConceptId, parseAssetRef } from "../legacy-ref-grammar";
import { warn } from "../../../../src/core/warn";
import { normalizeLegacyTask } from "./legacy-task-normalize";
import {
  canonicalizeWorkflowName,
  type LegacySource,
  resolveAssetPathFromName,
  resolveSourcesForOrigin,
} from "./legacy-layout";

interface MigrationBundle {
  id: string;
  root: string;
  registryId?: string;
  primary: boolean;
  writable: boolean;
}

export interface TaskTargetRefRewrite {
  filePath: string;
  from?: string;
  to?: string;
  before: Buffer;
  after: Buffer;
  mode: number;
}

export interface TaskTargetRefMigrationPlan {
  rewrites: TaskTargetRefRewrite[];
  durabilityPaths: string[];
  /**
   * v1 task files found in read-only bundles. The migration NEVER rewrites a
   * read-only bundle (lock-materialized git/npm caches would be clobbered by
   * the next update; `writable: false` filesystem sources are user-protected),
   * but the 0.9 runtime removed the v1 parser, so these tasks will fail after
   * upgrade. Surfaced per bundle — and warned about at plan time — instead of
   * being silently omitted.
   */
  readOnlyLegacyTasks: Array<{ bundleId: string; files: string[] }>;
}

function migrationError(filePath: string, detail: string): ConfigError {
  return new ConfigError(
    `Cannot migrate persisted task target in ${filePath}: ${detail} ` +
      "Repair or remove this task, then rerun `akm-migrate apply`.",
    "INVALID_CONFIG_FILE",
  );
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function bundlesFromConfig(
  config: AkmConfig,
  pathResolutionBase: string,
  migrationLockEntries: readonly LockfileEntry[],
): MigrationBundle[] {
  const entries = Object.entries(config.bundles ?? {});
  const sourceEntries = new Map((bundlesToSourceEntries(config) ?? []).map((entry) => [entry.name, entry]));
  const defaultId = config.defaultBundle;
  const ordered = defaultId
    ? [...entries.filter(([id]) => id === defaultId), ...entries.filter(([id]) => id !== defaultId)]
    : entries;
  const bundles: MigrationBundle[] = [];
  const roots = new Map<string, string>();
  const lockRoots = new Map(migrationLockEntries.map((entry) => [entry.id, entry.localRoot]));
  for (const [id, rawEntry] of ordered) {
    const entry = rawEntry as BundleConfigEntry;
    const sourceEntry = sourceEntries.get(id);
    if (!sourceEntry) continue;
    const contentDir = lockRoots.get(id) ?? resolveEntryContentDir(sourceEntry);
    if (!contentDir) continue;
    const root = path.resolve(pathResolutionBase, expandTilde(contentDir));
    const rootIdentity = fs.existsSync(root) ? fs.realpathSync(root) : root;
    const prior = roots.get(rootIdentity);
    if (prior && prior !== id) {
      throw new ConfigError(
        `Cannot migrate persisted task targets because bundles "${prior}" and "${id}" resolve to the same root ${root}. ` +
          "Give each bundle a distinct path, then rerun `akm-migrate apply`.",
        "INVALID_CONFIG_FILE",
      );
    }
    roots.set(rootIdentity, id);
    bundles.push({
      id,
      root,
      ...(typeof entry.registryId === "string" && entry.registryId.length > 0 ? { registryId: entry.registryId } : {}),
      primary: id === defaultId,
      writable: resolveWritable(sourceEntry),
    });
  }
  return bundles;
}

function resolveOrigin(origin: string, bundles: MigrationBundle[], filePath: string): MigrationBundle {
  if (origin === "local" || origin === "stash") {
    const primary = bundles.find((bundle) => bundle.primary);
    if (primary) return primary;
    throw migrationError(filePath, `legacy origin "${origin}" has no configured default bundle.`);
  }

  let candidates = bundles.filter((bundle) => bundle.id === origin || bundle.registryId === origin);
  if (candidates.length === 0) {
    const sources: LegacySource[] = bundles.map((bundle) => ({
      path: bundle.root,
      registryId: bundle.registryId ?? bundle.id,
    }));
    const resolved = resolveSourcesForOrigin(origin, sources);
    candidates = resolved
      .map((source) => bundles[sources.indexOf(source)])
      .filter((bundle): bundle is MigrationBundle => bundle !== undefined);
  }
  if (candidates.length === 0) {
    throw migrationError(filePath, `legacy workflow origin "${origin}" does not resolve to a configured bundle.`);
  }
  if (candidates.length > 1) {
    throw migrationError(
      filePath,
      `legacy workflow origin "${origin}" is ambiguous across bundles ${candidates.map((bundle) => `"${bundle.id}"`).join(", ")}.`,
    );
  }
  const candidate = candidates[0];
  if (!candidate) throw migrationError(filePath, `legacy workflow origin "${origin}" did not resolve.`);
  return candidate;
}

function assertWorkflowPathSafe(bundle: MigrationBundle, name: string, rawRef: string, filePath: string): void {
  const candidate = resolveAssetPathFromName("workflow", path.join(bundle.root, "workflows"), name);
  // A stale task is valid persisted state. Rewrite its deterministic ref and let
  // task sync/run continue to report the missing workflow per task.
  if (!fs.existsSync(candidate)) return;
  if (!fs.statSync(candidate).isFile())
    throw migrationError(filePath, `legacy target "${rawRef}" is not a file in bundle "${bundle.id}".`);
  const realRoot = fs.realpathSync(bundle.root);
  const realCandidate = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw migrationError(filePath, `legacy target "${rawRef}" resolves outside bundle "${bundle.id}".`);
  }
}

function assertRealPathWithin(root: string, candidate: string, filePath: string, detail: string): void {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw migrationError(filePath, detail);
}

function planTaskFile(
  filePath: string,
  containing: MigrationBundle,
  bundles: MigrationBundle[],
): TaskTargetRefRewrite | undefined {
  const before = fs.readFileSync(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
  } catch {
    throw migrationError(filePath, "task YAML contains invalid UTF-8 bytes.");
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  const yamlError = doc.errors[0];
  if (yamlError) throw migrationError(filePath, `invalid YAML (${yamlError.message}).`);
  if (!isMap(doc.contents)) throw migrationError(filePath, "task YAML must be a mapping.");
  const raw = doc.toJS() as Record<string, unknown>;
  const version = raw.version;
  if (version !== undefined && version !== 1) return undefined;

  let normalized: Record<string, unknown>;
  try {
    normalized = normalizeLegacyTask(raw);
  } catch (error) {
    throw migrationError(filePath, error instanceof Error ? error.message : String(error));
  }

  let from: string | undefined;
  let to: string | undefined;
  if (typeof normalized.workflow === "string") {
    from = normalized.workflow.trim();
    if (classifyRefGrammar(from) === "legacy") {
      let parsed: ReturnType<typeof parseAssetRef>;
      try {
        parsed = parseAssetRef(from);
      } catch (error) {
        throw migrationError(
          filePath,
          `legacy workflow target "${from}" is invalid (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      if (parsed.type !== "workflow") {
        throw migrationError(filePath, `legacy target "${from}" has type "${parsed.type}", not "workflow".`);
      }
      const name = canonicalizeWorkflowName(parsed.name);
      const targetBundle = parsed.origin ? resolveOrigin(parsed.origin, bundles, filePath) : containing;
      assertWorkflowPathSafe(targetBundle, name, from, filePath);
      const conceptId = legacyConceptId("workflow", name);
      to = parsed.origin ? `${targetBundle.id}//${conceptId}` : conceptId;
      normalized.workflow = to;
    }
  }

  const after = Buffer.from(stringifyYaml(normalized));
  try {
    parseTaskDocument({ yaml: after.toString("utf8"), filePath, id: path.basename(filePath, ".yml") });
  } catch (error) {
    throw migrationError(filePath, `the converted v2 task is invalid (${error instanceof Error ? error.message : String(error)}).`);
  }
  return {
    filePath,
    ...(from !== undefined && to !== undefined ? { from, to } : {}),
    before,
    after,
    mode: fs.lstatSync(filePath).mode & 0o777,
  };
}

/** Preflight every persisted v1 task target without changing disk. */
export function planTaskTargetRefMigration(
  config: AkmConfig,
  pathResolutionBase = process.cwd(),
  migrationLockEntries: readonly LockfileEntry[] = [],
): TaskTargetRefMigrationPlan {
  const bundles = bundlesFromConfig(config, pathResolutionBase, migrationLockEntries);
  const rewrites: TaskTargetRefRewrite[] = [];
  const durabilityPaths: string[] = [];
  const readOnlyLegacyTasks: Array<{ bundleId: string; files: string[] }> = [];
  for (const bundle of bundles) {
    if (!bundle.writable) {
      // The migration must not write into a read-only bundle, but SILENTLY
      // skipping it strands any persisted v1 tasks there: the 0.9 runtime
      // removed the v1 compatibility parser, so those tasks fail after an
      // upgrade that reported current. Surface them with the remedy instead —
      // never block the apply on content only the bundle's maintainer can fix.
      const legacy = legacyTaskFilesIn(bundle);
      if (legacy.length > 0) {
        readOnlyLegacyTasks.push({ bundleId: bundle.id, files: legacy });
        warn(
          `[akm] migrate: bundle "${bundle.id}" is read-only and contains v1 task file(s) the 0.9 runtime can ` +
            `no longer parse: ${legacy.join(", ")}. They will not run after upgrade. Update them where the bundle ` +
            "is maintained (its upstream repo/package), or for a local read-only source set `writable: true` and " +
            "rerun `akm-migrate apply` to have them rewritten.",
        );
      }
      continue;
    }
    const tasksDir = path.join(bundle.root, "tasks");
    if (!fs.existsSync(tasksDir)) continue;
    const tasksStat = fs.lstatSync(tasksDir);
    if (tasksStat.isSymbolicLink()) {
      throw new ConfigError(
        `Cannot migrate persisted task targets because ${tasksDir} is a symbolic link. Replace it with a real ` +
          "directory, then rerun `akm-migrate apply`.",
        "INVALID_CONFIG_FILE",
      );
    }
    if (!tasksStat.isDirectory()) {
      throw new ConfigError(
        `Cannot migrate persisted task targets because ${tasksDir} is not a directory. Repair it, then rerun ` +
          "`akm-migrate apply`.",
        "INVALID_CONFIG_FILE",
      );
    }
    assertRealPathWithin(bundle.root, tasksDir, tasksDir, "the tasks directory resolves outside its bundle.");
    for (const entry of fs
      .readdirSync(tasksDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".yml")) continue;
      const filePath = path.join(tasksDir, entry.name);
      if (!entry.isFile())
        throw migrationError(filePath, "task migration does not follow symbolic links or special files.");
      assertRealPathWithin(bundle.root, filePath, filePath, "the task file resolves outside its bundle.");
      const rewrite = planTaskFile(filePath, bundle, bundles);
      if (rewrite) rewrites.push(rewrite);
    }
  }
  return { rewrites, durabilityPaths, readOnlyLegacyTasks };
}

/**
 * Names of task files in a bundle that still carry the v1 shape (`version`
 * absent or `1`). Read-only detection support for the preflight: parse
 * failures are reported as legacy too — an unparseable task in a bundle the
 * migration cannot rewrite needs the same operator attention.
 */
function legacyTaskFilesIn(bundle: MigrationBundle): string[] {
  const tasksDir = path.join(bundle.root, "tasks");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const legacy: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
    try {
      const doc = parseDocument(fs.readFileSync(path.join(tasksDir, entry.name), "utf8"), { uniqueKeys: true });
      if (doc.errors.length > 0 || !isMap(doc.contents)) {
        legacy.push(entry.name);
        continue;
      }
      const version = (doc.toJS() as Record<string, unknown>).version;
      if (version === undefined || version === 1) legacy.push(entry.name);
    } catch {
      legacy.push(entry.name);
    }
  }
  return legacy;
}

function syncParentDirectory(filePath: string): void {
  const fd = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeTaskFileDurably(target: string, content: Buffer, mode: number): void {
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    const fd = fs.openSync(temp, "wx", mode);
    try {
      fs.fchmodSync(fd, mode);
      let offset = 0;
      while (offset < content.byteLength) {
        const written = fs.writeSync(fd, content, offset, content.byteLength - offset);
        if (written <= 0) throw new Error(`Could not make progress writing task migration temp file ${temp}.`);
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    renamed = true;
    syncParentDirectory(target);
  } catch (error) {
    if (!renamed) fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Apply a preflighted plan with exact-byte fencing and durable atomic writes. */
export function applyTaskTargetRefMigration(plan: TaskTargetRefMigrationPlan): number {
  let rewritten = 0;
  for (const rewrite of plan.rewrites) {
    const current = fs.readFileSync(rewrite.filePath);
    if (current.equals(rewrite.after)) {
      syncParentDirectory(rewrite.filePath);
      continue;
    }
    if (!current.equals(rewrite.before)) {
      throw migrationError(rewrite.filePath, "the task changed after migration preflight; it was left untouched.");
    }
    writeTaskFileDurably(rewrite.filePath, rewrite.after, rewrite.mode);
    rewritten++;
  }
  for (const filePath of plan.durabilityPaths) syncParentDirectory(filePath);
  return rewritten;
}
