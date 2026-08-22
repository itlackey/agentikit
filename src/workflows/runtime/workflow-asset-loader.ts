// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { deriveInstallations } from "../../indexer/installations";
import { resolveAdapterConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import type { WorkflowParameter, WorkflowStepDefinition } from "../../sources/types";
import { withIndexDb } from "../../storage/repositories/index-db";
import { computeSourceHash } from "../../storage/repositories/index-entries-repository";
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDocument } from "../schema";
import { workflowNameForConceptId } from "../source-files";
import { compileWorkflowSource } from "../source-ir/compile";
import { WorkflowSourceProjectionError, workflowSourceIrToDocument } from "../source-ir/document";

/**
 * A workflow asset projected from its on-disk (or index-cached) document into
 * the shape the run repository needs to start and track a run.
 */
export type WorkflowAsset = {
  ref: string;
  path: string;
  sourcePath: string;
  adapterId?: string;
  /**
   * Run-level display title. The unified format carries no authored title
   * (workflow-format-unification, spec §2.2) — a step is its id, and the
   * asset's human name is its `description`/H1 like any other asset. This is
   * the asset's canonical name (the file-derived slug), used only for the
   * `workflow_runs.workflow_title` display column (unchanged journal shape).
   */
  title: string;
  parameters?: WorkflowParameter[];
  steps: WorkflowStepDefinition[];
  /**
   * The full parsed document, retained so the run engine can compile the
   * plan-graph IR (`workflows/ir/compile.ts`).
   */
  document: WorkflowDocument;
};

/**
 * Build the canonical `workflow_runs.workflow_ref` for an AKM workflow asset.
 */
export function canonicalWorkflowRunRef(bundle: string | undefined, canonicalName: string): string {
  return makeBundleRef(bundle, `workflows/${canonicalName}`);
}

/** Parse a workflow ref using the canonical `[bundle//]conceptId` grammar. */
export function parseWorkflowRefInput(ref: string): BundleRef {
  const parsed = parseBundleRef(ref.trim());
  if (parsed.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${parsed.fragment}" is not accepted in a workflow ref.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (parsed.conceptId.startsWith("workflow:")) {
    throw new UsageError(
      `Invalid workflow ref "${ref.trim()}". Use [bundle//]conceptId, such as workflows/release.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return parsed;
}

/** Resolve input sugar to the workflow's canonical run identity. */
export async function canonicalizeWorkflowRefInput(ref: string): Promise<string> {
  return (await loadWorkflowAsset(ref, { projectionMode: "display" })).ref;
}

/**
 * Resolve a workflow ref to a fully-projected {@link WorkflowAsset}. Prefers the
 * parsed document cached in `index.db` (fast path) and falls back to reading +
 * parsing the source file from disk.
 */
export async function loadWorkflowAsset(
  ref: string,
  options: { readonly projectionMode?: "display" | "runtime" } = {},
): Promise<WorkflowAsset> {
  const bundleRef = parseWorkflowRefInput(ref);

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
    const adapterId = source.adapterId ?? detectAdapterId(source.path);
    const ownedSource = source.adapterId ? source : { ...source, adapterId };
    const owner = resolveAdapterConceptOwner(source.path, adapterId, bundleRef.conceptId);
    if (!owner) continue;
    if (!ownsNativeWorkflowRuntime(ownedSource) || !owner.workflowSource) {
      rejectedSource ??= { source: ownedSource, bundleId };
      break;
    }
    assetPath = owner.path;
    sourcePath = source.path;
    sourceBundleId = bundleId;
    workflowName = owner.workflowSource.canonicalName;
    workflowAdapterId = adapterId;
    break;
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
  // Canonicalize the stored ref: `workflows/foo.md` and `workflows/foo` resolve
  // to the same file, so they MUST share one run identity.
  const canonicalName = canonicalizeWorkflowName(workflowName as string);
  const fullRef =
    workflowAdapterId === "akm-workflow"
      ? makeBundleRef(sourceBundleId, canonicalName)
      : canonicalWorkflowRunRef(sourceBundleId, canonicalName);

  const projectionMode = options.projectionMode ?? "runtime";
  const cached =
    projectionMode === "runtime"
      ? readWorkflowDocumentFromIndex(resolvedSourcePath, fullRef, workflowAdapterId as string, assetPath)
      : null;
  const document = cached ?? loadWorkflowDocumentFromDisk(assetPath, resolvedSourcePath, projectionMode);
  return projectAsset(document, fullRef, assetPath, resolvedSourcePath, workflowAdapterId as string, canonicalName);
}

function ownsNativeWorkflowRuntime(source: SearchSource): boolean {
  return source.adapterId === "akm" || source.adapterId === "akm-workflow";
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

function loadWorkflowDocumentFromDisk(
  assetPath: string,
  workspaceRoot: string,
  projectionMode: "display" | "runtime" = "runtime",
): WorkflowDocument {
  const content = fs.readFileSync(assetPath, "utf8");
  return compileWorkflowDocument(content, assetPath, workspaceRoot, projectionMode);
}

function compileWorkflowDocument(
  content: string,
  sourcePath: string,
  workspaceRoot: string,
  projectionMode: "display" | "runtime" = "runtime",
): WorkflowDocument {
  const result = compileWorkflowSource(content, { path: sourcePath, workspaceRoot });
  if (!result.ok) {
    const details = result.errors.map((error) => `  ${error.path}:${error.line} — ${error.message}`).join("\n");
    throw new UsageError(`Workflow source has ${result.errors.length} error(s):\n${details}`);
  }
  try {
    return workflowSourceIrToDocument(result.ir, { mode: projectionMode });
  } catch (cause) {
    if (cause instanceof WorkflowSourceProjectionError) throw new UsageError(cause.message, "INVALID_FLAG_VALUE");
    throw cause;
  }
}

function readWorkflowDocumentFromIndex(
  sourcePath: string,
  ref: string,
  adapterId: string,
  assetPath: string,
): WorkflowDocument | null {
  if (!fs.existsSync(getDbPath())) return null;

  const entryKey = workflowEntryKey(sourcePath, ref, adapterId);
  return withIndexDb((db) => {
    const row = db
      .prepare(
        `SELECT wd.document_json AS document_json, wd.schema_version AS schema_version,
                wd.source_path AS source_path, wd.source_hash AS source_hash,
                e.file_path AS file_path, e.item_ref AS item_ref,
                e.concept_id AS concept_id, e.adapter_id AS adapter_id,
                e.content_hash AS content_hash
           FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_type = 'workflow' AND e.entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as
      | {
          document_json: string;
          schema_version: number;
          source_path: string;
          source_hash: string;
          file_path: string;
          item_ref: string | null;
          concept_id: string | null;
          adapter_id: string | null;
          content_hash: string | null;
        }
      | undefined;
    if (!row || row.schema_version !== WORKFLOW_SCHEMA_VERSION) return null;

    const expectedConceptId = parseBundleRef(ref).conceptId;
    if (
      row.adapter_id !== adapterId ||
      row.item_ref !== ref ||
      row.concept_id !== expectedConceptId ||
      !sameAuthoredSourcePath(row.file_path, assetPath) ||
      !sameDocumentSourcePath(sourcePath, row.source_path, assetPath) ||
      path.extname(row.source_path).toLowerCase() !== path.extname(assetPath).toLowerCase()
    ) {
      return null;
    }

    let sourceBytes: Buffer;
    try {
      sourceBytes = fs.readFileSync(assetPath);
    } catch {
      return null;
    }
    if (
      row.source_hash !== computeSourceHash(sourceBytes) ||
      row.content_hash !== createHash("sha256").update(sourceBytes).digest("hex")
    ) {
      return null;
    }

    try {
      const document = JSON.parse(row.document_json) as WorkflowDocument;
      if (document.source?.path !== row.source_path) return null;
      const authoritativeDocument = compileWorkflowDocument(sourceBytes.toString("utf8"), row.source_path, sourcePath);
      if (JSON.stringify(document) !== JSON.stringify(authoritativeDocument)) return null;
      return document;
    } catch {
      return null;
    }
  });
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return path.resolve(fs.realpathSync(left)) === path.resolve(fs.realpathSync(right));
  } catch {
    return false;
  }
}

function sameAuthoredSourcePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right) && sameRealPath(left, right);
}

function sameDocumentSourcePath(sourceRoot: string, documentSourcePath: string, assetPath: string): boolean {
  const candidate = path.isAbsolute(documentSourcePath)
    ? documentSourcePath
    : path.resolve(sourceRoot, documentSourcePath);
  return sameAuthoredSourcePath(candidate, assetPath);
}

function workflowEntryKey(sourcePath: string, ref: string, adapterId?: string): string {
  const bundleRef = parseBundleRef(ref);
  if ((adapterId ?? detectAdapterId(sourcePath)) === "akm-workflow") {
    return `${sourcePath}:concept:${bundleRef.conceptId}`;
  }
  const name = workflowNameForConceptId("akm", bundleRef.conceptId);
  if (!name) throw new UsageError(`Expected a workflow ref, got "${ref}".`);
  return `${sourcePath}:workflow:${name}`;
}

function projectAsset(
  doc: WorkflowDocument,
  ref: string,
  assetPath: string,
  sourcePath: string,
  adapterId: string,
  canonicalName: string,
): WorkflowAsset {
  const title = canonicalName.split("/").pop() || canonicalName;
  return {
    ref,
    path: assetPath,
    sourcePath,
    adapterId,
    title,
    ...(doc.params
      ? {
          parameters: Object.entries(doc.params).map(([name, schema]) => {
            const description = schema.description;
            return { name, ...(typeof description === "string" && description ? { description } : {}) };
          }),
        }
      : {}),
    steps: doc.steps.map((s) => ({
      id: s.id,
      title: s.id,
      instructions: s.instructions?.text ?? stepFallbackInstructions(s),
      ...(s.gateRubric?.text.trim() ? { completionCriteria: [s.gateRubric.text] } : {}),
      sequenceIndex: s.sequenceIndex,
    })),
    document: doc,
  };
}

/** A route-only step with no body section still needs a non-empty spine instructions string. */
function stepFallbackInstructions(step: WorkflowDocument["steps"][number]): string {
  if (!step.route) return "";
  const branches = step.route.branches.map((b) => `"${b.match}" -> ${b.stepId}`);
  if (step.route.defaultStepId !== undefined) branches.push(`default -> ${step.route.defaultStepId}`);
  return `Route on ${step.route.input}: ${branches.join(", ")}.`;
}
