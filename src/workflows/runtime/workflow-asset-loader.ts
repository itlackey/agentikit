// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
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
import { workflowNameForConceptId } from "../source-files";
import { compileWorkflowSource } from "../source-ir/compile";
import { sourceStepInstructions } from "../source-ir/program";
import type { WorkflowSourceIrV1, WorkflowSourceStep } from "../source-ir/schema";

/**
 * A workflow asset compiled from either authored format into the one source IR.
 */
export type WorkflowAsset = {
  ref: string;
  path: string;
  sourcePath: string;
  adapterId?: string;
  /**
   * Run-level display title. The shared source IR carries no authored title
   * (workflow-format-unification, spec §2.2) — a step is its id, and the
   * asset's human name is its `description`/H1 like any other asset. This is
   * the asset's canonical name (the file-derived slug), used only for the
   * `workflow_runs.workflow_title` display column (unchanged journal shape).
   */
  title: string;
  parameters?: WorkflowParameter[];
  steps: WorkflowStepDefinition[];
  sourceIr: WorkflowSourceIrV1;
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
  return (await loadWorkflowAsset(ref)).ref;
}

/**
 * Resolve a workflow ref and compile its authored bytes into source IR.
 */
export async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
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

  const sourceIr = compileWorkflowSourceFromDisk(assetPath, resolvedSourcePath);
  return projectAsset(sourceIr, fullRef, assetPath, resolvedSourcePath, workflowAdapterId as string, canonicalName);
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

function compileWorkflowSourceFromDisk(assetPath: string, workspaceRoot: string): WorkflowSourceIrV1 {
  const content = fs.readFileSync(assetPath, "utf8");
  const result = compileWorkflowSource(content, { path: assetPath, workspaceRoot });
  if (!result.ok) {
    const details = result.errors.map((error) => `  ${error.path}:${error.line} — ${error.message}`).join("\n");
    throw new UsageError(`Workflow source has ${result.errors.length} error(s):\n${details}`);
  }
  return result.ir;
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
  sourceIr: WorkflowSourceIrV1,
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
    ...(sourceIr.params
      ? {
          parameters: Object.entries(sourceIr.params).map(([name, schema]) => {
            const description = schema.description;
            return { name, ...(typeof description === "string" && description ? { description } : {}) };
          }),
        }
      : {}),
    steps: sourceIr.jobs.flatMap((job) =>
      job.steps.map((step, sequenceIndex) => ({
        id: step.id,
        title: step.id,
        instructions: step.route ? stepFallbackInstructions(step) : sourceStepInstructions(step),
        ...(step.gate?.rubric?.trim() ? { completionCriteria: [step.gate.rubric] } : {}),
        sequenceIndex,
      })),
    ),
    sourceIr,
  };
}

/** A route-only step with no body section still needs a non-empty spine instructions string. */
function stepFallbackInstructions(step: WorkflowSourceStep): string {
  if (!step.route) return "";
  const branches = step.route.branches.map((b) => `"${b.match}" -> ${b.stepId}`);
  if (step.route.defaultStepId !== undefined) branches.push(`default -> ${step.route.defaultStepId}`);
  return `Route on ${step.route.input}: ${branches.join(", ")}.`;
}
