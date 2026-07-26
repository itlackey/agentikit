// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { adapterForId } from "../../core/adapter/registry";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, parseRefInput } from "../../core/asset/resolve-ref";
import { isWithin } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../../core/recognition-util";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { buildFileContext } from "../../indexer/walk/file-context";
import { resolveAssetPath } from "../../sources/resolve";
import type { WorkflowParameter, WorkflowStepDefinition } from "../../sources/types";
import { withIndexDb } from "../../storage/repositories/index-db";
import { formatWorkflowErrors } from "../authoring/authoring";
import { parseWorkflow } from "../parser";
import { parseWorkflowProgram } from "../program/parser";
import { isWorkflowProgramPath, projectProgramParameters, projectProgramStepDefinitions } from "../program/project";
import type { WorkflowProgram } from "../program/schema";
import type { WorkflowDocument } from "../schema";

/**
 * A workflow asset projected from its on-disk (or index-cached) document into
 * the shape the run repository needs to start and track a run.
 */
export type WorkflowAsset = {
  ref: string;
  path: string;
  sourcePath: string;
  adapterId?: string;
  title: string;
  parameters?: WorkflowParameter[];
  steps: WorkflowStepDefinition[];
  /**
   * The full parsed document, retained so the run engine can compile the
   * plan-graph IR (`workflows/ir/compile.ts`). Present for MARKDOWN
   * workflows only; YAML programs carry `program` instead.
   */
  document?: WorkflowDocument;
  /**
   * Parsed YAML workflow *program* (redesign addendum, R1). Present when the
   * asset is a YAML orchestration program under `workflows/`; undefined for
   * markdown workflows. The freeze boundary compiles and resolves it when a
   * run starts.
   */
  program?: WorkflowProgram;
};

/**
 * The canonical durable `workflow_runs.workflow_ref` run-key:
 * `[origin//]workflows/<canonical-name>` (normative §11.4 — the chunk-8
 * cutover re-keys pre-existing legacy rows onto this spelling; every mint
 * site MUST build the key through this one helper).
 */
export function canonicalWorkflowRunRef(origin: string | undefined, canonicalName: string): string {
  return `${origin ? `${origin}//` : ""}workflows/${canonicalName}`;
}

/** Parse a workflow ref using the canonical `[bundle//]workflows/<name>` grammar. */
export function parseWorkflowRefInput(ref: string): AssetRef {
  return parseRefInput(ref.trim());
}

/** Resolve input sugar to the workflow's canonical run identity. */
export async function canonicalizeWorkflowRefInput(ref: string): Promise<string> {
  return (await loadWorkflowAsset(ref)).ref;
}

/**
 * Resolve a workflow ref to a fully-projected {@link WorkflowAsset}. Prefers the
 * parsed document cached in `index.db` (fast path) and falls back to reading +
 * parsing the source file from disk.
 */
export async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
  const bundleRef = parseBundleRef(ref.trim());
  if (bundleRef.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${bundleRef.fragment}" is not accepted in a workflow ref.`,
      "INVALID_FLAG_VALUE",
    );
  }
  let parsed: AssetRef | undefined;
  try {
    parsed = parseWorkflowRefInput(ref);
  } catch {
    // Standalone akm-workflow bundles use root-relative concept ids.
  }

  const config = loadConfig();
  const allSources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(allSources);
  const searchSources = allSources.flatMap((source, index) => {
    const bundleId = installations[index]?.id;
    if (!bundleId || (bundleRef.bundle !== undefined && bundleRef.bundle !== bundleId)) return [];
    return [{ source, bundleId }];
  });
  if (bundleRef.bundle && searchSources.length === 0) {
    throw new UsageError(`Bundle "${bundleRef.bundle}" was not found among configured sources.`, "INVALID_FLAG_VALUE");
  }
  let assetPath: string | undefined;
  let sourcePath: string | undefined;
  let sourceBundleId: string | undefined;
  let workflowName: string | undefined;
  let workflowAdapterId: string | undefined;
  let rejectedSource: { source: SearchSource; bundleId: string } | undefined;

  for (const candidateSource of searchSources) {
    const { source, bundleId } = candidateSource;
    try {
      const adapterId = source.adapterId ?? detectAdapterId(source.path);
      const candidateName =
        adapterId === "akm-workflow" ? bundleRef.conceptId : parsed?.type === "workflow" ? parsed.name : undefined;
      const ownedSource = source.adapterId ? source : { ...source, adapterId };
      if (!candidateName) {
        if (adapterOwnsConcept(source.path, adapterId, bundleRef.conceptId)) {
          rejectedSource ??= { source: ownedSource, bundleId };
          break;
        }
        continue;
      }
      const candidate = await resolveNativeWorkflowPath(source.path, adapterId, candidateName);
      if (!ownsNativeWorkflowRuntime(ownedSource)) {
        rejectedSource ??= { source: ownedSource, bundleId };
        break;
      }
      assetPath = candidate;
      sourcePath = source.path;
      sourceBundleId = bundleId;
      workflowName = candidateName;
      workflowAdapterId = adapterId;
      break;
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
  }

  if (!assetPath) {
    if (rejectedSource) {
      const sourceName = rejectedSource.bundleId;
      const adapterId = rejectedSource.source.adapterId ?? "unassigned";
      throw new UsageError(
        `Bundle "${sourceName}" uses adapter "${adapterId}", which does not support native workflow execution.`,
        "INVALID_FLAG_VALUE",
      );
    }
    throw new NotFoundError(`Workflow not found for ref: ${ref}`);
  }

  const resolvedSourcePath = sourcePath as string;
  // Canonicalize the stored ref: `workflows/foo.yaml` and `workflows/foo`
  // resolve to the same file, so they MUST share one run identity. The raw
  // `parsed.name` (with any extension) is what drives file resolution above;
  // only the persisted/queried ref is collapsed (matches the index entry key,
  // which is keyed by the extension-stripped canonical name).
  const canonicalName = canonicalizeWorkflowName(workflowName as string);
  const fullRef =
    workflowAdapterId === "akm-workflow"
      ? makeBundleRef(sourceBundleId, canonicalName)
      : canonicalWorkflowRunRef(bundleRef.bundle, canonicalName);

  // Format detection by extension: `.yaml`/`.yml` is a YAML workflow program
  // (redesign addendum, R1); everything else is the markdown document format.
  if (isWorkflowProgramPath(assetPath)) {
    const program = loadWorkflowProgramFromDisk(assetPath);
    return projectProgramAsset(program, fullRef, assetPath, resolvedSourcePath, workflowAdapterId as string);
  }

  const cached = readWorkflowDocumentFromIndex(resolvedSourcePath, fullRef, workflowAdapterId as string);
  const document = cached ?? loadWorkflowDocumentFromDisk(assetPath);
  return projectAsset(document, fullRef, assetPath, resolvedSourcePath, workflowAdapterId as string);
}

function ownsNativeWorkflowRuntime(source: SearchSource): boolean {
  return source.adapterId === "akm" || source.adapterId === "akm-workflow";
}

function adapterOwnsConcept(sourcePath: string, adapterId: string, conceptId: string): boolean {
  const adapter = adapterForId(adapterId);
  if (!adapter) return false;
  const normalized = conceptId.replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return false;
  }
  const extensions = [...adapter.extensions].sort((left, right) => right.length - left.length);
  const extension = extensions.find((candidate) => normalized.toLowerCase().endsWith(candidate.toLowerCase()));
  const extensionless = extension ? normalized.slice(0, -extension.length) : normalized;
  const parent = path.join(sourcePath, path.posix.dirname(extensionless));
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = fs.realpathSync(sourcePath);
    realParent = fs.realpathSync(parent);
  } catch {
    return false;
  }
  if (!isWithin(realParent, realRoot)) return false;
  const basename = path.posix.basename(extensionless);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realParent, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const recognizedExtension = extensions.find(
      (candidate) =>
        entry.name.toLowerCase().endsWith(candidate.toLowerCase()) &&
        entry.name.slice(0, -candidate.length) === basename,
    );
    if (!recognizedExtension) continue;
    const candidatePath = path.join(realParent, entry.name);
    try {
      const document = adapter.recognize(
        { id: adapterId, adapter: adapterId, root: realRoot, writable: false },
        buildFileContext(realRoot, candidatePath),
      );
      if (document) return true;
    } catch {
      // A malformed matching file still belongs to the earlier adapter and cannot be bypassed for execution.
      return true;
    }
  }
  return false;
}

async function resolveNativeWorkflowPath(sourcePath: string, adapterId: string, name: string): Promise<string> {
  if (adapterId !== "akm-workflow") return resolveAssetPath(sourcePath, "workflow", name);
  const canonicalName = canonicalizeWorkflowName(name);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(sourcePath);
  } catch {
    throw new NotFoundError(`Workflow bundle root not found: ${sourcePath}`);
  }
  const parent = path.join(sourcePath, path.dirname(canonicalName));
  if (!isWithin(parent, realRoot)) {
    throw new UsageError("Workflow ref resolves outside the bundle root.", "PATH_ESCAPE_VIOLATION");
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    throw new NotFoundError(`Workflow not found: ${name}`);
  }
  const basename = path.basename(canonicalName);
  for (const extension of WORKFLOW_EXTENSIONS) {
    const matches = entries.filter((entry) => {
      if (!entry.isFile() && !entry.isSymbolicLink()) return false;
      const entryExtension = path.extname(entry.name);
      return entryExtension.toLowerCase() === extension && entry.name.slice(0, -entryExtension.length) === basename;
    });
    if (matches.length > 1) {
      throw new UsageError(
        `Workflow "${canonicalName}" has multiple ${extension} files that differ only by extension case.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const match = matches[0];
    if (!match) continue;
    const candidate = path.join(parent, match.name);
    let realTarget: string;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      realTarget = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isWithin(realTarget, realRoot)) {
      throw new UsageError("Workflow ref resolves outside the bundle root.", "PATH_ESCAPE_VIOLATION");
    }
    return realTarget;
  }
  throw new NotFoundError(`Workflow not found: ${name}`);
}

/**
 * Resolve the `entries.id` for an indexed workflow, or null when the index
 * database does not yet exist or has no matching entry.
 */
export function resolveWorkflowEntryId(sourcePath: string, ref: string, adapterId?: string): number | null {
  if (!fs.existsSync(getDbPath())) return null;

  const entryKey = workflowEntryKey(sourcePath, ref, adapterId);
  return withIndexDb((db) => {
    const row = db
      .prepare(
        `SELECT id
         FROM entries
         WHERE entry_type = 'workflow'
            AND entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as { id: number } | undefined;
    return row?.id ?? null;
  });
}

function loadWorkflowProgramFromDisk(assetPath: string): WorkflowProgram {
  const content = fs.readFileSync(assetPath, "utf8");
  const result = parseWorkflowProgram(content, { path: assetPath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(assetPath, result.errors));
  }
  return result.program;
}

function loadWorkflowDocumentFromDisk(assetPath: string): WorkflowDocument {
  const content = fs.readFileSync(assetPath, "utf8");
  const result = parseWorkflow(content, { path: assetPath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(assetPath, result.errors));
  }
  return result.document;
}

function readWorkflowDocumentFromIndex(sourcePath: string, ref: string, adapterId: string): WorkflowDocument | null {
  if (!fs.existsSync(getDbPath())) return null;

  const entryKey = workflowEntryKey(sourcePath, ref, adapterId);
  return withIndexDb((db) => {
    const row = db
      .prepare(
        `SELECT wd.document_json AS document_json
           FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_type = 'workflow' AND e.entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as { document_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.document_json) as WorkflowDocument;
    } catch {
      return null;
    }
  });
}

function workflowEntryKey(sourcePath: string, ref: string, adapterId?: string): string {
  const bundleRef = parseBundleRef(ref);
  if ((adapterId ?? detectAdapterId(sourcePath)) === "akm-workflow") {
    return `${sourcePath}:concept:${bundleRef.conceptId}`;
  }
  const parsed = parseWorkflowRefInput(ref);
  if (parsed.type !== "workflow") throw new UsageError(`Expected a workflow ref, got "${ref}".`);
  return `${sourcePath}:${parsed.type}:${parsed.name}`;
}

function projectAsset(
  doc: WorkflowDocument,
  ref: string,
  assetPath: string,
  sourcePath: string,
  adapterId: string,
): WorkflowAsset {
  return {
    ref,
    path: assetPath,
    sourcePath,
    adapterId,
    title: doc.title,
    ...(doc.parameters
      ? {
          parameters: doc.parameters.map((p) => ({
            name: p.name,
            ...(p.description ? { description: p.description } : {}),
          })),
        }
      : {}),
    steps: doc.steps.map((s) => ({
      id: s.id,
      title: s.title,
      instructions: s.instructions.text,
      ...(s.completionCriteria ? { completionCriteria: s.completionCriteria.map((c) => c.text) } : {}),
      sequenceIndex: s.sequenceIndex,
    })),
    document: doc,
  };
}

/**
 * Project a parsed YAML program into the run-repository asset shape. Step
 * instructions carry the RAW `${{ … }}` templates — resolution happens in
 * the engine against the frozen plan, never here.
 */
function projectProgramAsset(
  program: WorkflowProgram,
  ref: string,
  assetPath: string,
  sourcePath: string,
  adapterId: string,
): WorkflowAsset {
  const parameters = projectProgramParameters(program);
  return {
    ref,
    path: assetPath,
    sourcePath,
    adapterId,
    title: program.name,
    ...(parameters ? { parameters } : {}),
    steps: projectProgramStepDefinitions(program),
    program,
  };
}
