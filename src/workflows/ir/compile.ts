// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontend -> unresolved workflow plan compiler (workflow-format-unification).
 *
 * ONE frontend now: {@link compileWorkflowPlan} lowers adapter-neutral source
 * IR into the current unresolved plan draft. Markdown and YAML never reach a
 * format-specific runtime compiler. This pass owns the
 * semantic rules the parser deliberately does not check:
 *
 *   - every reference string (`map.over` / `route.input` / `inputs[]`) parses
 *     against the CLOSED two-root grammar (`program/expressions.ts`);
 *   - `steps.<id>` references name an EARLIER step (a producer that has
 *     already run when the reference resolves);
 *   - `inputs:` entries must reference a STEP OUTPUT, never `params.*` — params
 *     are already attached to every unit unconditionally, so naming one as a
 *     declared input would be redundant.
 *
 * Node-id convention (stable, unique within a plan):
 *   step root  → `<stepId>`          (unit) or `<stepId>.map` (map)
 *   map unit   → `<stepId>.unit`     (template instantiated per item)
 *   gate       → `<stepId>.gate`
 *
 * Returns accumulated `WorkflowError`s rather than throwing. Pure and
 * deterministic: the same document always compiles to the same plan.
 */

import { formatReference, parseReference } from "../program/expressions";
import { type ProgramExec, type ProgramUnit, projectExecCore } from "../program/schema";
import type { WorkflowError } from "../schema";
import { sourceStepInstructions, sourceStepProgramUnit, sourceStepRef } from "../source-ir/program";
import {
  decodeWorkflowSourceIrV1,
  type WorkflowSourceIrV1,
  type WorkflowSourceStep,
  type WorkflowSourceUnit,
} from "../source-ir/schema";
import type { IrIsolation, IrMapReducer, IrOnError, IrRetry, IrRouteSpec } from "./schema";

export interface WorkflowUnitDraft {
  kind: "unit";
  id: string;
  instructions: string;
  /** Prior-step artifacts this unit consumes, as reference strings (compile-time validated). */
  inputs?: string[];
  /**
   * Shell-command dispatch (`unit.exec`). Carried structurally here; the
   * timeout it needs is a RESOLVED setting and stays on the parsed override bag
   * until the single freeze boundary, exactly like engine/model/timeout.
   */
  exec?: ProgramExec;
  schema?: Record<string, unknown>;
  retry?: IrRetry;
  onError: IrOnError;
  env?: string[];
  isolation?: IrIsolation;
  source?: import("../schema").SourceRef;
}

export interface WorkflowMapDraft {
  kind: "map";
  id: string;
  over: string;
  template: WorkflowUnitDraft;
  concurrency?: number;
  reducer: IrMapReducer;
  source?: import("../schema").SourceRef;
}

export interface WorkflowGateDraft {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  maxLoops?: number;
}

export interface WorkflowStepDraft {
  stepId: string;
  /** Always the step id — the shared source IR has no titles (a step IS its id). */
  title: string;
  sequenceIndex: number;
  root?: WorkflowUnitDraft | WorkflowMapDraft;
  route?: IrRouteSpec;
  outputSchema?: Record<string, unknown>;
  gate: WorkflowGateDraft;
}

export interface WorkflowPlanDraft {
  /** Run-level display title. Derived from the asset's canonical name — never authored. */
  title: string;
  params?: string[];
  paramSchemas?: Record<string, Record<string, unknown>>;
  /**
   * Named, optionally schema-validated projections of step artifacts,
   * exported when the run completes (P3b, spec §4.2). Absent, never `{}`,
   * when the source declares none.
   */
  outputs?: Record<string, { from: string; schema?: Record<string, unknown> }>;
  budget?: { maxTokens?: number; maxUnits?: number };
  steps: WorkflowStepDraft[];
}

export type WorkflowPlanCompileResult =
  | { ok: true; plan: WorkflowPlanDraft; warnings: WorkflowError[] }
  | { ok: false; errors: WorkflowError[] };

/**
 * Compile source IR into a frozen-plan-ready graph.
 * `title` is the run-level display title (the asset's canonical name — the
 * format carries no authored title). Assumes the document came out of
 * `parseWorkflow` ok (structure already valid).
 */
export function compileWorkflowPlan(
  input: WorkflowSourceIrV1,
  title: string,
  resolvedUnits: ReadonlyMap<string, { unit: ProgramUnit; instructions: string }> = new Map(),
): WorkflowPlanCompileResult {
  const sourceIr = decodeWorkflowSourceIrV1(input);
  const errors: WorkflowError[] = [];
  // The decoder guarantees exactly one job (P4 §3.3, docs/plans/specs/
  // p4-deletions-closeout.md, row B-43) — a 2+-job document is rejected at
  // the adapter boundary and never reaches this compiler.
  const sourceSteps = sourceIr.jobs[0]?.steps ?? [];
  const allStepIds = new Set(sourceSteps.map((step) => step.id));
  const earlierStepIds = new Set<string>();
  const steps: WorkflowStepDraft[] = [];

  sourceSteps.forEach((step, sequenceIndex) => {
    const check = { allStepIds, earlierStepIds, errors };

    if (step.map) {
      checkReferenceField(step.map.over, { ...check, line: step.source.start, label: `Step "${step.id}" map.over` });
    }
    if (step.route) {
      checkReferenceField(step.route.input, {
        ...check,
        line: step.source.start,
        label: `Step "${step.id}" route.input`,
      });
    }
    for (const [index, reference] of (step.inputs ?? []).entries()) {
      checkInputReference(reference, index, {
        ...check,
        line: step.source.start,
        label: `Step "${step.id}" inputs`,
      });
    }

    steps.push(compileStep(step, sequenceIndex, sourceIr.defaults, resolvedUnits.get(step.id)));
    earlierStepIds.add(step.id);
  });

  // P3b (spec §4.2, rows B-06/B-07): `outputs:` references are validated
  // against the FULL step id set (never `earlierStepIds` — resolution happens
  // at RUN COMPLETION, after every step has run, so an output may legitimately
  // name any declared step regardless of its position).
  for (const [name, declaration] of Object.entries(sourceIr.outputs ?? {})) {
    checkOutputReference(name, declaration.from, { errors, allStepIds, line: sourceIr.source.start });
  }

  if (errors.length > 0) return { ok: false, errors };

  const paramNames = sourceIr.params ? Object.keys(sourceIr.params) : [];
  return {
    ok: true,
    warnings: collectWorkflowWarnings(sourceIr),
    plan: {
      title,
      ...(paramNames.length > 0 ? { params: paramNames } : {}),
      ...(sourceIr.params && paramNames.length > 0
        ? { paramSchemas: sourceIr.params as Record<string, Record<string, unknown>> }
        : {}),
      ...(sourceIr.outputs ? { outputs: sourceIr.outputs } : {}),
      ...(sourceIr.budget
        ? {
            budget: {
              ...(sourceIr.budget.maxTokens !== undefined ? { maxTokens: sourceIr.budget.maxTokens } : {}),
              ...(sourceIr.budget.maxUnits !== undefined ? { maxUnits: sourceIr.budget.maxUnits } : {}),
            },
          }
        : {}),
      steps,
    },
  };
}

function compileStep(
  step: WorkflowSourceStep,
  sequenceIndex: number,
  defaults: WorkflowSourceIrV1["defaults"],
  resolved: { unit: ProgramUnit; instructions: string } | undefined,
): WorkflowStepDraft {
  const gate: WorkflowGateDraft = {
    kind: "gate",
    id: `${step.id}.gate`,
    stepId: step.id,
    // The body `### gate` rubric is carried through as the ONE criterion string
    // — the judge receives the whole section byte-exact (spec §2.4). A step
    // with no rubric needs no verification (criteria: []).
    criteria: step.gate?.rubric?.trim() ? [step.gate.rubric] : [],
    ...(step.gate?.maxLoops !== undefined ? { maxLoops: step.gate.maxLoops } : {}),
  };

  let root: WorkflowUnitDraft | WorkflowMapDraft | undefined;
  if (step.route === undefined) {
    const unit = resolved?.unit ?? sourceStepProgramUnit(step);
    const instructionsText = resolved?.instructions ?? sourceStepInstructions(step);
    if (step.map) {
      root = {
        kind: "map",
        id: `${step.id}.map`,
        over: step.map.over,
        template: compileUnit(unit, `${step.id}.unit`, instructionsText, defaults, step.inputs, sourceStepRef(step)),
        ...(step.map.concurrency !== undefined ? { concurrency: step.map.concurrency } : {}),
        reducer: step.map.reducer ?? "collect",
        source: step.source,
      };
    } else {
      root = compileUnit(unit, step.id, instructionsText, defaults, step.inputs, sourceStepRef(step));
    }
  }

  return {
    stepId: step.id,
    title: step.id,
    sequenceIndex,
    ...(root ? { root } : {}),
    ...(step.route
      ? {
          route: {
            input: step.route.input,
            when: Object.fromEntries(step.route.branches.map((b) => [b.match, b.stepId])),
            ...(step.route.defaultStepId !== undefined ? { defaultStepId: step.route.defaultStepId } : {}),
          },
        }
      : {}),
    ...(step.output !== undefined ? { outputSchema: step.output } : {}),
    gate,
  };
}

/**
 * Lower one source unit into the unresolved structural plan. Instructions are
 * ALWAYS the step's body prose, byte-exact — never templated, never scanned
 * for reference syntax. Engine/model/timeout settings remain on the parsed
 * override bag until the single freeze boundary.
 */
function compileUnit(
  unit: ProgramUnit,
  id: string,
  instructions: string,
  defaults: WorkflowSourceUnit | undefined,
  inputs: string[] | undefined,
  source: import("../schema").SourceRef | undefined,
): WorkflowUnitDraft {
  return {
    kind: "unit",
    id,
    instructions,
    ...(inputs && inputs.length > 0 ? { inputs: [...inputs] } : {}),
    // Shared projection: named pass-through scope is carried conditionally;
    // whole-process environment inheritance is not an authoring surface.
    ...(unit.exec ? { exec: projectExecCore(unit.exec) } : {}),
    ...(unit.output !== undefined ? { schema: unit.output } : {}),
    ...(unit.retry ? { retry: { max: unit.retry.max, on: [...unit.retry.on] } } : {}),
    onError: unit.onError ?? defaults?.onError ?? "fail",
    ...(unit.env ? { env: [...unit.env] } : {}),
    ...(unit.isolation !== undefined ? { isolation: unit.isolation } : {}),
    ...(source ? { source } : {}),
  };
}

// ── Reference validation ─────────────────────────────────────────────────────

interface ReferenceCheck {
  errors: WorkflowError[];
  /** Every step id in the document (to tell "later step" from "no such step"). */
  allStepIds: Set<string>;
  /** Ids of steps declared BEFORE the one being checked. */
  earlierStepIds: Set<string>;
  line: number;
  label: string;
}

/** Validate a whole-value reference field (`map.over`, `route.input`). */
function checkReferenceField(text: string, check: ReferenceCheck): void {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    check.errors.push({ line: check.line, message: `${check.label}: ${parsed.message}` });
    return;
  }
  if (parsed.expr.kind === "stepOutput" && !check.earlierStepIds.has(parsed.expr.stepId)) {
    const why = check.allStepIds.has(parsed.expr.stepId)
      ? `step "${parsed.expr.stepId}" does not come before this step — references must name an earlier step (a producer that has already run)`
      : `"${parsed.expr.stepId}" is not a step in this workflow`;
    check.errors.push({
      line: check.line,
      message: `${check.label}: "${formatReference(parsed.expr)}" cannot be resolved — ${why}.`,
    });
  }
}

/** Validate one `inputs[]` entry: must be a step-output reference to an earlier step. */
function checkInputReference(text: string, index: number, check: ReferenceCheck): void {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    check.errors.push({ line: check.line, message: `${check.label}[${index}]: ${parsed.message}` });
    return;
  }
  if (parsed.expr.kind === "param") {
    check.errors.push({
      line: check.line,
      message:
        `${check.label}[${index}]: "${formatReference(parsed.expr)}" names a param, not a step output — ` +
        `params are already attached to every unit, so declaring one as an input is redundant. "inputs:" only ` +
        `names step outputs (steps.<id>.output...).`,
    });
    return;
  }
  if (!check.earlierStepIds.has(parsed.expr.stepId)) {
    const why = check.allStepIds.has(parsed.expr.stepId)
      ? `step "${parsed.expr.stepId}" does not come before this step — references must name an earlier step (a producer that has already run)`
      : `"${parsed.expr.stepId}" is not a step in this workflow`;
    check.errors.push({
      line: check.line,
      message: `${check.label}[${index}]: "${formatReference(parsed.expr)}" cannot be resolved — ${why}.`,
    });
  }
}

/**
 * Validate one `outputs.<name>.from` reference (P3b, spec §4.2, rows
 * B-06/B-07): it must parse, it must name a STEP output — never a param (an
 * output projects a step artifact; a param is already on the run row) — and
 * that step must be DECLARED somewhere in the document. Unlike
 * {@link checkInputReference}, the named step need not be EARLIER: an output
 * resolves at run completion, after every step has already run.
 */
function checkOutputReference(
  name: string,
  text: string,
  check: { errors: WorkflowError[]; allStepIds: ReadonlySet<string>; line: number },
): void {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    check.errors.push({ line: check.line, message: `Output "${name}" from: ${parsed.message}` });
    return;
  }
  if (parsed.expr.kind === "param") {
    check.errors.push({
      line: check.line,
      message:
        `Output "${name}" from: "${formatReference(parsed.expr)}" names a param, not a step output — an output ` +
        `projects a STEP artifact, never a param. "outputs:" only names step outputs (steps.<id>.output...).`,
    });
    return;
  }
  if (!check.allStepIds.has(parsed.expr.stepId)) {
    check.errors.push({
      line: check.line,
      message:
        `Output "${name}" from: "${formatReference(parsed.expr)}" cannot be resolved — "${parsed.expr.stepId}" is ` +
        `not a step in this workflow.`,
    });
  }
}

// ── Non-fatal warnings ───────────────────────────────────────────────────────

/**
 * Collect the document's non-fatal WARNINGS — advisories that never fail
 * compilation, never change the frozen plan or its hash, and are surfaced as
 * `workflow-warning` entries in `akm lint`'s separate `warnings` channel
 * (human + JSON output, via `core/adapter/adapters/akm-lint.ts#
 * workflowCompileWarnings`) and as `warn()` lines at `workflow run`.
 *
 *   A. A unit/map step with NO step-level `output:` schema carries its units'
 *      raw results as an untyped artifact — permitted, but worth flagging.
 *   B. A `params.<name>` reference (in `map.over`/`route.input`) to an
 *      UNDECLARED param, but ONLY when the document declares a `params:`
 *      block — a likely typo. Prose can no longer carry param references at
 *      all (it is never scanned), so this warning's surface shrinks to the
 *      two whole-value fields that can legally contain one.
 *   C. `gate.max_loops` above 1 on an `exec` step. The engine judges such a
 *      step but never loops it (`exec/step-work.ts#effectiveGateMaxLoops`):
 *      a frozen argv cannot read the judge's feedback, so a second loop would
 *      only re-run the identical command — and its side effects. The declared
 *      budget is not silently different from what runs; say so.
 */
export function collectWorkflowWarnings(input: WorkflowSourceIrV1): WorkflowError[] {
  const sourceIr = decodeWorkflowSourceIrV1(input);
  const warnings: WorkflowError[] = [];
  const declaredParams = sourceIr.params ? new Set(Object.keys(sourceIr.params)) : undefined;

  for (const job of sourceIr.jobs) {
    for (const step of job.steps) {
      const maxLoops = step.gate?.maxLoops ?? 1;
      const execUnit = step.exec ?? step.run;
      if (maxLoops > 1 && execUnit && step.gate?.rubric?.trim()) {
        warnings.push({
          line: step.source.start,
          message:
            `Step "${step.id}" declares \`gate.max_loops: ${maxLoops}\` on an \`exec\` step — it runs its command ` +
            `ONCE. A gate loop re-executes the step so it can address the judge's feedback, and a frozen argv cannot ` +
            `read that feedback; looping would only repeat the command's side effects. The gate still evaluates and ` +
            `can still fail the step.`,
        });
      }

      if ((step.map || step.route === undefined) && step.output === undefined) {
        warnings.push({
          line: step.source.start,
          message:
            `Step "${step.id}" declares no \`output:\` schema — its unit results are carried as an untyped ` +
            `artifact (permitted). Add an \`output:\` JSON Schema to type and validate the step artifact.`,
        });
      }

      if (declaredParams) {
        const declaredList = [...declaredParams].join(", ");
        const scan = (text: string | undefined, label: string): void => {
          if (!text) return;
          const parsed = parseReference(text);
          if (!parsed.ok || parsed.expr.kind !== "param" || declaredParams.has(parsed.expr.name)) return;
          warnings.push({
            line: step.source.start,
            message:
              `${label}: "${formatReference(parsed.expr)}" references a param not declared in \`params:\` ` +
              `(declared: ${declaredList || "none"}) — likely a typo. An undeclared param supplied at start still ` +
              `resolves at run time.`,
          });
        };
        if (step.map) scan(step.map.over, `Step "${step.id}" map.over`);
        if (step.route) scan(step.route.input, `Step "${step.id}" route.input`);
      }
    }
  }

  return warnings;
}
