// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { loadAdapterExecutionSource } from "../../commands/command/execution-source-loader";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import type { AkmConfig } from "../../core/config/config-types";
import { parseEnvRef } from "../../core/env-secret-ref";
import { UsageError } from "../../core/errors";
import type { GuardedExecutionSource, GuardedExecutionSourceCollector } from "../../execution/guarded-source";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveAssetPath } from "../../sources/resolve";
import { freezeWorkflowEnvironment } from "../ir/environment-v4";
import type { FrozenWorkflowEnvironmentBinding } from "../ir/schema-v4";
import type { ProgramExec } from "../program/schema";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import type { WorkflowSourceStep } from "../source-ir/schema";
import type { OwnedAsset, ResolutionContext } from "./step-values";

export function freezeEnvironment(
  source: WorkflowSourceStep,
  exec: ProgramExec | undefined,
  context: ResolutionContext,
): FrozenWorkflowEnvironmentBinding[] {
  const literals = Object.entries(source.env ?? {}).map(([name, value]) =>
    Object.freeze({ kind: "literal" as const, name, value: String(value) }),
  );
  const passThrough = (exec?.passEnv ?? []).map((name) => Object.freeze({ kind: "pass-through" as const, name }));
  const refs = source.unit?.env ?? [];
  const envRefs = freezeWorkflowEnvironment(refs, {
    collector: context.collector,
    resolveRef: (ref) => {
      const parsedEnv = parseEnvRef(ref);
      if (parsedEnv.type !== "env") throw new UsageError(`Expected an env ref; got ${ref}.`, "INVALID_FLAG_VALUE");
      const owned = resolveOwnedAssetSync(ref, "env", context);
      return { ref: owned.ref, bundle: owned.bundle, adapter: owned.adapter, root: owned.root, path: owned.file };
    },
  });
  return [...literals, ...passThrough, ...envRefs];
}

export async function guardedExecutionSource(ref: string, kind: "command" | "persona", context: ResolutionContext) {
  const owned = await resolveOwnedAsset(ref, kind === "command" ? "command" : "agent", context);
  captureOwned(owned, context.collector);
  const options = {
    config: context.config,
    fileContext: () => context.collector.fileContext(owned.root, owned.file),
  };
  const rendered =
    kind === "command"
      ? await loadAdapterExecutionSource(owned.ref, "command", options)
      : await loadAdapterExecutionSource(owned.ref, "persona", options);
  context.collector.bindIdentity(owned.file, owned.root, rendered.identity);
  return rendered;
}

export async function resolveOwnedAsset(
  ref: string,
  type: "command" | "agent" | "task" | "workflow" | "script" | "env",
  context: ResolutionContext,
): Promise<OwnedAsset> {
  return resolveOwnedAssetCore(ref, type, context, false) as Promise<OwnedAsset>;
}

export function resolveOwnedAssetSync(ref: string, type: "env", context: ResolutionContext): OwnedAsset {
  return resolveOwnedAssetCore(ref, type, context, true) as OwnedAsset;
}

export function resolveOwnedAssetCore(
  refInput: string,
  type: "command" | "agent" | "task" | "workflow" | "script" | "env",
  context: ResolutionContext,
  sync: boolean,
): OwnedAsset | Promise<OwnedAsset> {
  const parsed = parseBundleRef(refInput);
  const plural = type === "env" ? "env" : `${type}s`;
  const conceptId = parsed.conceptId.startsWith(`${plural}/`) ? parsed.conceptId : `${plural}/${parsed.conceptId}`;
  const name = conceptId.slice(plural.length + 1);
  const direct = parsed.bundle ? configuredOwner(parsed.bundle, context.config) : undefined;
  const sources = resolveSourceEntries(undefined, context.config);
  const installations = deriveInstallations(sources);
  const candidates = direct
    ? [direct]
    : sources.flatMap((source, index) => {
        const installation = installations[index];
        if (!installation || (parsed.bundle && installation.id !== parsed.bundle)) return [];
        return [
          {
            bundle: installation.id,
            root: source.path,
            adapter: source.adapterId ?? installation.components[0]?.adapter ?? "akm",
          },
        ];
      });
  const findSync = (): OwnedAsset => {
    for (const candidate of candidates) {
      const directory = path.join(candidate.root, plural);
      for (const extension of assetExtensions(type)) {
        const file = path.resolve(directory, `${name}${extension}`);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          return { ...candidate, ref: makeBundleRef(candidate.bundle, conceptId), file };
        }
      }
    }
    throw new UsageError(`Workflow source target ${refInput} was not found.`, "INVALID_FLAG_VALUE");
  };
  if (sync) return findSync();
  return (async () => {
    for (const candidate of candidates) {
      try {
        const file = await resolveAssetPath(candidate.root, type, name);
        return { ...candidate, ref: makeBundleRef(candidate.bundle, conceptId), file };
      } catch {
        // Continue in installation priority order.
      }
    }
    return findSync();
  })();
}

export function configuredOwner(
  bundle: string,
  config: AkmConfig,
): { bundle: string; root: string; adapter: string } | undefined {
  const entry = config.bundles?.[bundle];
  if (!entry || typeof entry.path !== "string") return undefined;
  const components = entry.components ? Object.values(entry.components) : [];
  const component = components[0];
  return {
    bundle,
    root: path.resolve(entry.path, component?.root ?? "."),
    adapter: component?.adapter ?? "akm",
  };
}

export function assetExtensions(type: string): readonly string[] {
  if (type === "script")
    return [
      "",
      ".sh",
      ".ts",
      ".js",
      ".py",
      ".rb",
      ".go",
      ".pl",
      ".php",
      ".lua",
      ".r",
      ".swift",
      ".kt",
      ".kts",
      ".ps1",
      ".cmd",
      ".bat",
    ];
  if (type === "env") return ["", ".env"];
  return ["", ".md", ".yml"];
}

export function captureOwned(owned: OwnedAsset, collector: GuardedExecutionSourceCollector): GuardedExecutionSource {
  trackAncestry(collector, owned.root, owned.file);
  const retained = collector.capture(owned.file, owned.root, { authored: true });
  return collector.bindIdentity(owned.file, owned.root, {
    ref: owned.ref,
    bundle: owned.bundle,
    adapter: owned.adapter,
    file: retained.relativePath,
    hash: retained.sha256,
  });
}

export function trackAncestry(collector: GuardedExecutionSourceCollector, rootInput: string, file: string): void {
  const root = path.resolve(rootInput);
  collector.trackDirectory(root, root);
  const relative = path.relative(root, path.dirname(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`${file} resolves outside its owning root.`, "PATH_ESCAPE_VIOLATION");
  }
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    collector.trackDirectory(current, root);
  }
}

export function qualifyRef(ref: string, plural: string, asset: WorkflowAsset, config: AkmConfig): string {
  const parsed = parseBundleRef(ref);
  if (parsed.bundle) return ref;
  const bundle = parseBundleRef(asset.ref).bundle ?? config.defaultBundle;
  if (!bundle) throw new UsageError(`Workflow ref ${ref} has no owning bundle.`, "INVALID_FLAG_VALUE");
  const concept = parsed.conceptId.startsWith(`${plural}/`) ? parsed.conceptId : `${plural}/${parsed.conceptId}`;
  return makeBundleRef(bundle, concept);
}
