// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-directory document drain — akm 0.9.0 Chunk 5, milestone F4a M-core-2 (the
 * engine swap). Replaces the live indexer's per-dir flat-walk matcher-pass
 * `IndexDocument` stream with the `akm` adapter's `recognize` `IndexDocument`
 * stream, reconstructing the durable `IndexDocument` via {@link
 * indexDocumentToStashEntry} (proven lossless by the shadow-parity gate).
 *
 * Two behaviors the adapter fold does NOT carry, restored here at the drain
 * layer (spec §14.2 "drain the full document stream"):
 *
 *  - **Broken-workflow drop (item 3).** The live path dropped a broken workflow
 *    via the renderer contributor's throw → metadata-pass skip-with-warning; the
 *    `akm` adapter's synchronous `foldRecognizedMetadata` SWALLOWS the parse
 *    error, so a broken workflow would otherwise silently index. We re-run
 *    `parseWorkflow` on drained workflow docs and DROP
 *    the entry with the same `Skipped workflow …` warning
 *    ({@link buildMetadataSkipWarning}), so the workflow-skip summary counts it.
 *  - **Workflow-document side-table (workflow-md only).** The valid parsed
 *    `WorkflowDocument` is handed to the persist layer through the same
 *    `document-cache` side channel the live renderer contributor used, keyed by
 *    the reconstructed entry — so `takeWorkflowDocument(entry)` in the persist
 *    loop writes the `workflow_documents` row exactly as before.
 *
 * `doc.hash` (= sha256 of the file content) is surfaced per recognized file so
 * the persist layer can populate the `content_hash` column (item 2). It is keyed
 * by the file's absolute path rather than by the entry object.
 *
 * Pure of DB/global state beyond the workflow-document side channel; a new leaf
 * (nothing imports it back), so it joins no import cycle.
 */

import path from "node:path";
import { akmAdapter } from "../../core/adapter/adapters/akm-adapter";
import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import type { BundleComponent, IndexDocument } from "../../core/adapter/types";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { cacheWorkflowDocument } from "../../workflows/runtime/document-cache";
import {
  resolveUniqueWorkflowSource,
  WorkflowSourceRejectionError,
  workflowNameForSourcePath,
} from "../../workflows/source-files";
import { compileWorkflowSource } from "../../workflows/source-ir/compile";
import { WorkflowSourceProjectionError, workflowSourceIrToDocument } from "../../workflows/source-ir/document";
import { buildMetadataSkipWarning, type StashFile } from "../passes/metadata";
import { buildFileContext, type FileContext } from "../walk/file-context";
import { indexDocumentToStashEntry } from "./doc-to-entry";

/** The markdown-workflow renderer name the `akm` adapter carries on `documentJson.renderer`. */
const WORKFLOW_MD_RENDERER = "workflow-md";

export interface DrainedDir {
  /** The reconstructed durable entries, broken workflows already dropped. */
  entries: IndexDocument[];
  /** Per-file skip warnings (broken workflows), same shape the metadata pass emitted. */
  warnings: string[];
  /** `doc.hash` keyed by the recognized file's absolute path (content_hash source, item 2). */
  hashByFile: Map<string, string>;
  /**
   * `doc.conceptId` keyed by the recognized file's absolute path. The persist
   * layer prefers this over re-deriving via akm's `stashDirFor` scheme so a
   * non-akm adapter's identity (`pages/foo`, snapshot paths, …) survives into
   * `item_ref` verbatim (D-R3: identity comes from the owning adapter).
   */
  conceptIdByFile: Map<string, string>;
  /** Authored paths rejected by workflow source-ownership preflight. */
  rejectedPaths: Set<string>;
  /** Adapter-owned canonical concept ids rejected before workflow parsing. */
  rejectedConceptIds: Set<string>;
}

/**
 * Drain one directory's recognized documents into durable entries.
 *
 * `fileContexts` are the dir's walked files (the drain no longer pre-filters —
 * adapter-owned filtering, owner ruling 2026-07-21). `adapter.recognize` returns
 * `null` for a file it abstains on (no matcher claims it, an OKF reserved file,
 * or an AKM sensitive/infra file) — silently skipped, the same contract the
 * legacy flat-walk pass's "no matcher claims the file" case had.
 */
export function drainDirDocuments(
  adapter: BundleAdapter,
  component: BundleComponent,
  fileContexts: readonly FileContext[],
): DrainedDir {
  const entries: IndexDocument[] = [];
  const warnings: string[] = [];
  const hashByFile = new Map<string, string>();
  const conceptIdByFile = new Map<string, string>();
  const rejectedPaths = new Set<string>();
  const rejectedConceptIds = new Set<string>();
  const workflowLookups = new Map<string, string>();

  for (const file of fileContexts) {
    const workflowName = workflowNameForSourcePath(component.root, adapter.id, file.absPath);
    if (workflowName !== undefined) {
      const canonicalName = canonicalizeWorkflowName(workflowName);
      if (!workflowLookups.has(canonicalName)) workflowLookups.set(canonicalName, workflowName);
    }
  }

  for (const [canonicalName, workflowName] of [...workflowLookups].sort(([left], [right]) =>
    comparePaths(left, right),
  )) {
    try {
      resolveUniqueWorkflowSource(component.root, adapter.id, workflowName);
    } catch (error) {
      if (!(error instanceof WorkflowSourceRejectionError)) throw error;
      rejectedConceptIds.add(adapter.id === "akm" ? `workflows/${canonicalName}` : canonicalName);
      for (const relativePath of error.sourcePaths) {
        rejectedPaths.add(path.join(component.root, relativePath));
      }
      warnings.push(error.message);
    }
  }

  for (const file of fileContexts) {
    if (rejectedPaths.has(file.absPath)) continue;

    const doc = adapter.recognize(component, file);
    if (doc === null) continue;
    if (!doc.conceptId) {
      warnings.push(`Skipped ${file.absPath}: adapter "${adapter.id}" returned no conceptId.`);
      continue;
    }

    const entry = indexDocumentToStashEntry(doc);
    // Workflow docs: drop-with-warning if broken; otherwise cache a lossless
    // runtime projection when the current executor can represent the source.
    const dropWarning = handleWorkflowDoc(doc, entry, file, component.root);
    if (dropWarning !== null) {
      warnings.push(dropWarning);
      continue;
    }

    if (doc.hash !== undefined) hashByFile.set(file.absPath, doc.hash);
    conceptIdByFile.set(file.absPath, doc.conceptId);
    entries.push(entry);
  }

  return { entries, warnings, hashByFile, conceptIdByFile, rejectedPaths, rejectedConceptIds };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `(stashRoot, files) → StashFile` drop-in for the deleted flat-walk matcher
 * pass (F4a M-core-3): builds a FileContext per file and drains them through the
 * `akm` adapter's `recognize`. The recognize engine is the proven-equal
 * replacement for the old matcher-pass metadata assembly (shadow-parity gate), so
 * callers that only need the recognized entries (`manifest`'s no-index fallback,
 * the `registry` static-index builder, and the metadata unit tests) get identical
 * entries — plus the D-R6 reserved-file exclusion and the AKM sensitive/infra
 * abstention the adapter now enforces itself. Provenance is not persisted by these
 * callers, so the synthetic component id is immaterial.
 */
export function recognizeStashEntries(stashRoot: string, files: string[]): StashFile {
  const component: BundleComponent = { id: stashRoot, adapter: "akm", root: stashRoot, writable: false };
  // No pre-filter: the `akm` adapter's `recognize` claims/abstains per file
  // (owner ruling 2026-07-21 — adapter-owned filtering).
  const contexts = files.map((file) => buildFileContext(stashRoot, file));
  const drained = drainDirDocuments(akmAdapter, component, contexts);
  return drained.warnings.length > 0
    ? { entries: drained.entries, warnings: drained.warnings }
    : { entries: drained.entries };
}

/**
 * If `doc` is a workflow, re-parse it: return a `Skipped workflow …` drop
 * warning when it is broken, or cache the parsed markdown `WorkflowDocument`
 * (Markdown or GitHub-shaped YAML) and return `null` when valid. Non-workflow
 * docs return `null` immediately.
 */
function handleWorkflowDoc(
  doc: IndexDocument,
  entry: IndexDocument,
  file: FileContext,
  workspaceRoot: string,
): string | null {
  if (
    doc.type !== "workflow" ||
    (doc.adapterId !== "akm" && doc.adapterId !== "akm-workflow") ||
    (docRenderer(doc) !== WORKFLOW_MD_RENDERER && doc.adapterId !== "akm-workflow")
  ) {
    return null;
  }

  const result = compileWorkflowSource(file.content(), { path: file.relPath, workspaceRoot });
  if (!result.ok) return workflowDropWarning(file, result.errors);
  try {
    cacheWorkflowDocument(entry, workflowSourceIrToDocument(result.ir, { mode: "runtime" }));
  } catch (cause) {
    // A valid source target may require a later resolver (for example tasks/*).
    // Keep it indexable/showable; the runtime loader will surface the precise
    // unsupported projection instead of caching a semantically false document.
    if (!(cause instanceof WorkflowSourceProjectionError)) throw cause;
  }
  return null;
}

/** The winning renderer name the `akm` adapter carries on `documentJson.renderer`, or `undefined`. */
function docRenderer(doc: IndexDocument): string | undefined {
  const dj = doc.documentJson;
  if (dj !== null && typeof dj === "object" && "renderer" in dj) {
    const renderer = (dj as { renderer?: unknown }).renderer;
    return typeof renderer === "string" ? renderer : undefined;
  }
  return undefined;
}

/**
 * Build the `Skipped workflow <path>:\n…` warning byte-for-byte the way the live
 * pipeline did: the workflow parser's `path:line — message` summary wrapped in
 * the `Workflow has errors:` prefix (the string `loadDocument`/`loadProgram`
 * threw), then {@link buildMetadataSkipWarning}'s workflow branch. `startsWith
 * "Skipped workflow "` so `isWorkflowSkipWarning` counts it for the summary.
 */
function workflowDropWarning(file: FileContext, errors: ReadonlyArray<{ line: number; message: string }>): string {
  const summary = errors.map((e) => `${file.relPath}:${e.line} — ${e.message}`).join("\n");
  return buildMetadataSkipWarning(file.absPath, "workflow", `Workflow has errors:\n${summary}`);
}
