// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Validated JSON shape for the unified workflow asset (workflow-format-
 * unification): orchestration graph in frontmatter, per-step prose in the
 * markdown body, joined by step id.
 *
 * `parseWorkflow` (parser.ts) converts Markdown syntax into a
 * `WorkflowDocument` plus a list of `WorkflowError`s. This is an
 * adapter-internal Markdown parse tree: the compiler immediately projects it
 * into the shared workflow source IR consumed by indexing, rendering, and
 * execution. It is neither persisted nor a second runtime architecture.
 *
 * There are no titles anywhere in this shape — a step is its id; the asset's
 * human name is its `description`/H1 like any other asset (spec §2.2).
 */

import type { ProgramDefaults, ProgramGate, ProgramMap, ProgramRoute, ProgramUnit } from "./program/schema";

export const WORKFLOW_SCHEMA_VERSION = 2;

/** 1-indexed inclusive line range in a markdown file. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A line span anchored to a specific source file (relative to the source root). */
export interface SourceRef extends LineSpan {
  path: string;
}

/** A byte-exact slice of the markdown body, plus where it came from. */
export interface WorkflowInstructionBlock {
  text: string;
  source: SourceRef;
}

/**
 * One step of the gated spine: the frontmatter graph declaration joined with
 * its markdown body section by id. A step with neither `map` nor `route` IS a
 * unit step — bare `{ id: "validate" }` is the complete minimal declaration.
 */
export interface WorkflowStep {
  id: string;
  sequenceIndex: number;
  /** Optional dispatch-override bag; present only when the frontmatter declares one. */
  unit?: ProgramUnit;
  map?: ProgramMap;
  route?: ProgramRoute;
  /** Prior-step artifacts this unit/map step consumes, as reference strings. */
  inputs?: string[];
  /** Step artifact JSON Schema. */
  output?: Record<string, unknown>;
  /** Optional gate loop configuration from frontmatter; the rubric lives in `gateRubric`. */
  gate?: ProgramGate;
  /**
   * The step's markdown body section — byte-exact from its `## <id>` heading
   * to the next H2 or EOF, MINUS any `### gate` sub-section. Required for
   * unit/map steps (enforced by the parser's body rule 2); optional for a
   * route step (documentation only).
   */
  instructions?: WorkflowInstructionBlock;
  /**
   * The step's `### gate` sub-section, if present — the completion-gate
   * rubric, full prose, running to the section end (spec §2.4). Omitted or
   * empty rubric text skips validation.
   */
  gateRubric?: WorkflowInstructionBlock;
  /** The step's frontmatter declaration (YAML-anchored, best-effort line span). */
  source: SourceRef;
}

/**
 * One `outputs:` entry (P3b, spec §4.2): a validated `steps.<id>.output(.<seg>)*`
 * reference into a step artifact, plus an optional bounded JSON Schema. A
 * run-level export projection over already-promoted step artifacts — distinct
 * from a step's own `output:` (`outputSchema`), which is a typed-artifact
 * contract on ONE step (B-N2).
 */
export interface WorkflowOutputDeclaration {
  from: string;
  schema?: Record<string, unknown>;
}

export interface WorkflowDocument {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  description?: string;
  tags?: string[];
  /** Run parameters: name -> JSON Schema declaration (adopted from the program vocabulary). */
  params?: Record<string, Record<string, unknown>>;
  /**
   * Named, optionally schema-validated projections of step artifacts,
   * exported when the run completes (P3b, spec §4.2). Markdown-frontmatter
   * only — symmetrical with `params:` (B-N4).
   */
  outputs?: Record<string, WorkflowOutputDeclaration>;
  defaults?: ProgramDefaults;
  budget?: { maxTokens?: number; maxUnits?: number };
  steps: WorkflowStep[];
  /** Free preamble prose before the first `## <id>` heading (or the whole body absent any H2s). */
  preamble?: string;
  source: { path: string; lineCount: number };
}

/**
 * A single problem in the source markdown. CLI and indexer format these
 * uniformly as `path:line — message`. The fix is baked into the message
 * itself; source adapters may attach a stable code, but there is no separate
 * hint or severity field.
 */
export interface WorkflowError {
  /** Optional stable code supplied by a format adapter's semantic boundary. */
  code?: string;
  /** 1-indexed line in the source markdown the problem refers to. */
  line: number;
  /** Human-readable message including the offending value and how to fix it. */
  message: string;
}

export type WorkflowParseResult = { ok: true; document: WorkflowDocument } | { ok: false; errors: WorkflowError[] };
