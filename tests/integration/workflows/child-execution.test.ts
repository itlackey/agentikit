// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane A TESTS — the child executor's publication, identity, driving, and
 * status-mapping contract (docs/plans/specs/p3b-child-executor.md §2.2 "
 * Publication and identity" + §2.3 "Driving and status mapping", rows
 * A-07…A-27; §3.3 "driveChildWorkflowUnit — the drive contract", §3.4
 * "Status mapping (exact)"). This file owns ONLY these 21 rows.
 *
 * RED today, as a BLOCK: `src/workflows/exec/child-workflow.ts` does not
 * exist yet, so this file's single import of `driveChildWorkflowUnit` cannot
 * resolve at the bun:test *runtime* — every test below is expected to fail
 * as a block until Implement creates the module (the established convention:
 * `tests/execution/input-contract.test.ts`'s docstring, `@ts-expect-error
 * P1b red-phase`, commit `ddceaa9`). At the TypeScript layer, ONE
 * `// @ts-expect-error P3b red-phase: …` directive on that one import line
 * suppresses the unresolvable-module diagnostic; every name the import
 * introduces is typed `any` for the rest of the file, so no further
 * per-usage directive is needed anywhere below (and none would be legal — a
 * directive on a line with no diagnostic is itself a tsc error). Implement
 * removes the one directive the moment the module exists.
 *
 * Two testing levels are used deliberately:
 *
 *   - DIRECT `driveChildWorkflowUnit(input)` calls, for the publication
 *     contract (A-07…A-17) and the drive contract's exact call-shape
 *     (A-24, A-25) — precise control over `target`/`childParams`/`inputHash`,
 *     including deliberately CORRUPTED ones (A-10…A-12), that a real
 *     freeze/publish pipeline could never produce, plus a spy on the
 *     `runWorkflowSteps` reuse seam itself for the "what did we pass it"
 *     claims (B-N6, B-N7).
 *   - The FULL top-level engine, `runWorkflowSteps({target: parentRunId,
 *     …})` (already real; the exported entry point `akm workflow run`
 *     itself calls), for the rows whose full observable behavior spans the
 *     unit AND the composing STEP AND the parent RUN (A-21's exact blocked
 *     notes, A-26's `stepsProcessed` accounting) — `driveChildWorkflowUnit`
 *     alone only returns a `UnitOutcome`; it is `finalizeExecutedStep`
 *     (`run-workflow.ts`'s `runStepGateLoop`, run on the PARENT's own spine)
 *     that turns a `childBlocked` unit outcome into a blocked STEP with
 *     notes. Both levels seed a run directly via the repository / the
 *     `tests/_helpers/workflow.ts` helpers — never through a live agent/LLM.
 *
 * A child's own frozen plan is built with the REAL, already-implemented
 * `freezeWorkflow` helper (`tests/_helpers/workflow.ts`) — a genuine,
 * dispatchable `WorkflowPlanGraphV4` — then wrapped into a
 * `FrozenChildWorkflowTarget` by `buildChildTarget` below, mirroring
 * `tests/workflows/hash-v6.test.ts`'s established fixture-builder
 * convention for this exact target shape (kept local to this file per this
 * repo's test-file self-containment convention).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import type { TaskInputBinding } from "../../../src/execution/input-contract";
import { readStateEvents } from "../../../src/storage/repositories/events-repository";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { computeChildInvocationKey } from "../../../src/workflows/exec/child-invocation";
// @ts-expect-error P3b red-phase: driveChildWorkflowUnit lands in Implement
import { driveChildWorkflowUnit } from "../../../src/workflows/exec/child-workflow";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import * as runWorkflowModule from "../../../src/workflows/exec/run-workflow";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList, type WorkListInput } from "../../../src/workflows/exec/step-work";
import { canonicalJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type {
  FrozenChildWorkflowTarget,
  FrozenWorkflowTarget,
  IrStepPlanV4,
  WorkflowPlanGraphV4,
} from "../../../src/workflows/ir/schema-v4";
import { frozenStepRows } from "../../../src/workflows/runtime/plan-classifier";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { freezeWorkflow } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── Shared fixtures ──────────────────────────────────────────────────────────

function childContentHash(fields: {
  ref: string;
  planHash: string;
  via: "direct" | "task";
  taskRef?: string;
  inputBindings?: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: fields.taskRef ?? null,
        inputBindings: fields.inputBindings ?? null,
      }),
    )
    .digest("hex");
}

function buildChildTarget(
  childPlan: WorkflowPlanGraphV4,
  options: { ref?: string; inputBindings?: readonly TaskInputBinding[] } = {},
): FrozenChildWorkflowTarget {
  const ref = options.ref ?? "workflows/child";
  const planHash = computePlanHash(childPlan);
  return {
    kind: "child-workflow",
    ref,
    planHash,
    frozenPlan: childPlan,
    contentHash: childContentHash({ ref, planHash, via: "direct", inputBindings: options.inputBindings }),
    via: "direct",
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/** A minimal one-step child plan with no declared params and no completion criteria. */
function leafChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do the child's work.", ""].join(
      "\n",
    ),
    "workflows/child.md",
  );
}

/** A 4-step child plan (for A-26's "the child runs all its steps" claim). */
function fourStepChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    [
      "---",
      "type: workflow",
      "steps:",
      "  - id: step1",
      "  - id: step2",
      "  - id: step3",
      "  - id: step4",
      "---",
      "",
      "## step1",
      "",
      "Do step 1.",
      "",
      "## step2",
      "",
      "Do step 2.",
      "",
      "## step3",
      "",
      "Do step 3.",
      "",
      "## step4",
      "",
      "Do step 4.",
      "",
    ].join("\n"),
    "workflows/child-four.md",
  );
}

/** A one-step child plan declaring a single required string param `scope`. */
function paramChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    [
      "---",
      "type: workflow",
      "params:",
      "  scope: { type: string }",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the child's work.",
      "",
    ].join("\n"),
    "workflows/child-param.md",
  );
}

/** A one-step child plan whose step declares a non-empty completion criterion (a resolvable frozen judge, per `writeWorkflowTestConfig`'s `workflow.judgeEngine`). */
function gatedChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    [
      "---",
      "type: workflow",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the child's work.",
      "",
      "### gate",
      "",
      "- the work is actually done",
      "",
    ].join("\n"),
    "workflows/child-gated.md",
  );
}

interface SeededParent {
  runId: string;
  stepId: string;
  scopeKey: string;
  agentHarness: string | null;
  agentSessionId: string | null;
}

/** Seed a real `workflow_runs` + `workflow_run_steps` row-pair for the PARENT — the fields `driveChildWorkflowUnit` copies onto the child row (A-08). */
async function seedParentRun(overrides: Partial<SeededParent> = {}): Promise<SeededParent> {
  const parent: SeededParent = {
    runId: overrides.runId ?? randomUUID(),
    stepId: overrides.stepId ?? "compose",
    scopeKey: overrides.scopeKey ?? "dir:v1:parent",
    agentHarness: overrides.agentHarness ?? "claude-code",
    agentSessionId: overrides.agentSessionId ?? "session-123",
  };
  const now = new Date().toISOString();
  await withWorkflowRunsRepo(async (repo) => {
    repo.insertRun({
      id: parent.runId,
      workflowRef: "workflows/parent",
      scopeKey: parent.scopeKey,
      workflowEntryId: null,
      workflowTitle: "Parent",
      paramsJson: "{}",
      currentStepId: parent.stepId,
      createdAt: now,
      updatedAt: now,
      agentHarness: parent.agentHarness,
      agentSessionId: parent.agentSessionId,
      checkinArmedAt: null,
    });
    repo.insertSteps([
      {
        runId: parent.runId,
        stepId: parent.stepId,
        stepTitle: parent.stepId,
        instructions: "Compose the child workflow.",
        completionJson: null,
        sequenceIndex: 0,
      },
    ]);
  });
  return parent;
}

/** A `journalBaseId`-shaped unit id, mirroring `unitIdFor`'s `<nodeId>:solo` convention (B-N8). */
function parentUnitId(stepId: string): string {
  return `${stepId}:solo`;
}

/** A minimal, structurally-valid sourceReadSet entry — decodeWorkflowPlanV4 requires at least one. Mirrors `freezeWorkflow`'s own fixture entry (`tests/_helpers/workflow.ts`). */
function fakeSourceReadSet(): WorkflowPlanGraphV4["sourceReadSet"] {
  return [
    {
      identity: {
        ref: "test//workflows/parent",
        bundle: "test",
        adapter: "akm-workflow",
        file: "workflows/parent.yml",
        hash: createHash("sha256").update("parent-fixture").digest("hex"),
      },
      containmentPhysicalIdentity: "test-fixture-root",
      physicalIdentity: createHash("sha256").update("workflows/parent.yml\0parent-fixture").digest("hex"),
      size: 0,
    },
  ];
}

/** Assembles a `DriveChildWorkflowInput`-shaped object (spec §3.3) ready for `driveChildWorkflowUnit`. */
function buildDriveInput(input: {
  parent: SeededParent;
  target: FrozenChildWorkflowTarget;
  childParams?: Record<string, unknown>;
  inputHash?: string;
  dispatcher: (request: UnitDispatchRequest, feedback?: string) => Promise<UnitDispatchResult>;
  signal?: AbortSignal;
  maxConcurrency?: number;
  eventSource?: string;
}) {
  const unitId = parentUnitId(input.parent.stepId);
  return {
    request: {
      runId: input.parent.runId,
      stepId: input.parent.stepId,
      unitId,
      nodeId: input.parent.stepId,
      prompt: "Compose the child workflow.",
      frozenTarget: input.target,
      timeoutMs: null,
    } satisfies UnitDispatchRequest,
    target: input.target,
    ctx: {
      runId: input.parent.runId,
      workflowRef: "workflows/parent",
      params: {},
      evidence: {},
      dispatcher: input.dispatcher,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.eventSource !== undefined ? { eventSource: input.eventSource } : {}),
    },
    childParams: input.childParams ?? {},
    inputHash: input.inputHash ?? "h".repeat(64),
    dispatcher: input.dispatcher,
  };
}

/** A dispatcher that answers every unit dispatch `ok: true`, and (for a gated child) every judge dispatch with a well-formed accepting verdict. */
function successDispatcher(): (request: UnitDispatchRequest) => Promise<UnitDispatchResult> {
  return async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
    if (request.nodeId.endsWith(".gate")) {
      return { ok: true, text: JSON.stringify({ complete: true, missing: [], feedback: "looks good" }) };
    }
    return { ok: true, text: "done" };
  };
}

/** A dispatcher that fails every UNIT dispatch (never a judge dispatch — this fixture's children declare no criteria). */
function failureDispatcher(): (request: UnitDispatchRequest) => Promise<UnitDispatchResult> {
  return async (): Promise<UnitDispatchResult> => ({
    ok: false,
    text: "",
    failureReason: "dispatch_error",
    error: "synthetic dispatch failure",
  });
}

/** A dispatcher that answers unit dispatches `ok: true` but responds to the completion-criteria judge with a MALFORMED (non-JSON) verdict — the verifier-infrastructure-failure path that blocks the step (§3.4). */
function judgeInfrastructureFailureDispatcher(): (request: UnitDispatchRequest) => Promise<UnitDispatchResult> {
  return async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
    if (request.nodeId.endsWith(".gate")) {
      return { ok: true, text: "not a well-formed verdict" };
    }
    return { ok: true, text: "done" };
  };
}

/** Direct-SQL escape hatch — flips a run row's status without going through a real drive (constructing an "already blocked/failed from a previous attempt" fixture, A-22/A-23). */
function forceRunStatus(runId: string, status: "blocked" | "failed"): void {
  const db = openStateDatabase(getStateDbPath());
  try {
    db.prepare("UPDATE workflow_runs SET status = ? WHERE id = ?").run(status, runId);
  } finally {
    db.close();
  }
}

// ── A-07…A-09: first publication ────────────────────────────────────────────

describe("A-07, A-08, A-09 — first publication of a child run", () => {
  test("A-07: derives the invocation key, publishes exactly one child row, one workflow_started event, one step set", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    const dispatcher = successDispatcher();

    await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher }));

    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId));
    expect(children).toHaveLength(1);

    const key = computeChildInvocationKey({
      parentRunId: parent.runId,
      parentUnitId: parentUnitId(parent.stepId),
      unitInputHash: "h".repeat(64),
    });
    expect(children[0]?.invocation_key).toBe(key);

    const childRunId = children[0]!.id;
    const db = openStateDatabase(getStateDbPath());
    let startedEventsForChild: number;
    try {
      startedEventsForChild = readStateEvents(db, { type: "workflow_started" }).events.filter(
        (event) => (event.metadata as Record<string, unknown> | undefined)?.runId === childRunId,
      ).length;
    } finally {
      db.close();
    }
    expect(startedEventsForChild).toBe(1);
  });

  test("A-08: the published child row's identity fields match the spec's exact table", async () => {
    const parent = await seedParentRun({
      scopeKey: "dir:v1:distinctive-scope",
      agentHarness: "claude-code",
      agentSessionId: "session-xyz",
    });
    const target = buildChildTarget(leafChildPlan(), { ref: "workflows/leaf-child" });
    const dispatcher = successDispatcher();

    await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher }));

    const child = (await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId)))[0];
    expect(child).toBeDefined();
    expect(child?.parent_run_id).toBe(parent.runId);
    expect(child?.parent_unit_id).toBe(parentUnitId(parent.stepId));
    expect(child?.scope_key).toBe(parent.scopeKey);
    expect(child?.plan_ir_version).toBe(5);
    // B-N14: a child run's workflow_entry_id is NULL — the index lookup
    // publishChildWorkflowRun has no access to.
    expect(child?.workflow_entry_id).toBeNull();
    expect(child?.agent_harness).toBe(parent.agentHarness);
    expect(child?.agent_session_id).toBe(parent.agentSessionId);
    expect(child?.workflow_ref).toBe("workflows/leaf-child");
  });

  test("A-09: params_json carries exactly the resolved inputBindings of the composing unit; {} when the step binds nothing", async () => {
    const parentNoBindings = await seedParentRun();
    const targetNoBindings = buildChildTarget(leafChildPlan());
    await driveChildWorkflowUnit(
      buildDriveInput({ parent: parentNoBindings, target: targetNoBindings, dispatcher: successDispatcher() }),
    );
    const childNoBindings = (await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentNoBindings.runId)))[0];
    expect(JSON.parse(childNoBindings?.params_json ?? "null")).toEqual({});

    const parentWithBindings = await seedParentRun();
    const targetWithBindings = buildChildTarget(paramChildPlan(), { ref: "workflows/param-child" });
    await driveChildWorkflowUnit(
      buildDriveInput({
        parent: parentWithBindings,
        target: targetWithBindings,
        childParams: { scope: "prod" },
        dispatcher: successDispatcher(),
      }),
    );
    const childWithBindings = (await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentWithBindings.runId)))[0];
    expect(JSON.parse(childWithBindings?.params_json ?? "null")).toEqual({ scope: "prod" });
  });
});

// ── A-10…A-12: publication failures ─────────────────────────────────────────

describe("A-10, A-11, A-12 — publication failures never publish a child row or event", () => {
  test("A-10: a recomputed planHash mismatch fails the parent unit with child_workflow_publish_failed, naming the ref and both hashes; no child row", async () => {
    const parent = await seedParentRun();
    const childPlan = leafChildPlan();
    const realHash = computePlanHash(childPlan);
    const tamperedTarget = buildChildTarget(childPlan, { ref: "workflows/tampered-child" });
    const target = { ...tamperedTarget, planHash: `${realHash.slice(0, -1)}0` } as unknown as FrozenChildWorkflowTarget;

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_publish_failed");
    expect(outcome.error).toContain("workflows/tampered-child");
    expect(outcome.error).toContain(realHash);
    expect(outcome.error).toContain(target.planHash);

    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId));
    expect(children).toHaveLength(0);
  });

  test("A-11: childParams violating the child plan's paramSchemas fails with child_workflow_publish_failed, carrying validateWorkflowParams' errors; no child row", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(paramChildPlan(), { ref: "workflows/param-child" });

    const outcome = await driveChildWorkflowUnit(
      buildDriveInput({
        parent,
        target,
        // `scope` is declared `type: string`; a number violates it.
        childParams: { scope: 123 },
        dispatcher: successDispatcher(),
      }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_publish_failed");
    expect(outcome.error).toContain("scope");

    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId));
    expect(children).toHaveLength(0);
  });

  test("A-12: publishChildWorkflowRun throwing for any other reason fails with the same reason, wrapping the cause; no child row survives", async () => {
    const parent = await seedParentRun();
    const childPlan = leafChildPlan();
    // Corrupt the embedded plan's OWN steps to collide on the workflow_run_steps
    // PRIMARY KEY (run_id, step_id) — a duplicate stepId that a real freeze
    // pipeline could never produce, but this hand-built fixture can. This makes
    // publishChildWorkflowRun's own insertSteps() throw a raw SQLite error
    // *inside* its transaction — the "any other reason" class row A-12 asks for
    // — while the planHash integrity check (step 1) and params validation
    // (step 2) both still pass, since neither inspects step-id uniqueness.
    const duplicateStepId = childPlan.steps[0]!.stepId;
    const corruptPlan: WorkflowPlanGraphV4 = {
      ...childPlan,
      steps: [...childPlan.steps, { ...childPlan.steps[0]!, stepId: duplicateStepId, sequenceIndex: 1 }],
    };
    const target = buildChildTarget(corruptPlan, { ref: "workflows/duplicate-step-child" });

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_publish_failed");
    expect(typeof outcome.error).toBe("string");
    expect((outcome.error as string).length).toBeGreaterThan(0);

    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId));
    expect(children).toHaveLength(0);
  });
});

// ── A-13…A-17: idempotency and per-invocation identity ──────────────────────

describe("A-13, A-14, A-15 — retry/resume reuses the same child", () => {
  test("A-13: calling the seam twice with the same three key inputs finds the SAME child both times", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());

    const first = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));
    const second = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(first.childRun?.runId).toBeDefined();
    expect(second.childRun?.runId).toBe(first.childRun?.runId);

    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId));
    expect(children).toHaveLength(1);
  });

  test("A-14: a parent RESUME of the composing step (same invocation_key) drives the SAME child, never re-publishing", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());

    const first = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));
    // A "resume" is nothing more than re-entering the seam with the SAME
    // (parentRunId, parentUnitId, unitInputHash) — journalBaseId is
    // retry/resume-stable (B-N8) and the unit input hash is unchanged.
    const resumed = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(resumed.childRun?.runId).toBe(first.childRun?.runId);
    expect(await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId))).toHaveLength(1);
  });

  test("A-15: a parent RETRY of the composing step (journalBaseId retry-stable) reuses the same child", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());

    // A retry re-dispatches under the SAME journalBaseId (native-executor.ts's
    // attemptIdFor returns journalBaseId for every attempt) — modeled here by
    // simply invoking the seam twice with the identical request.unitId.
    const attempt1 = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));
    const attempt2 = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(attempt2.childRun?.runId).toBe(attempt1.childRun?.runId);
  });
});

describe("A-16 — a gate loop's changed gateFeedback yields a NEW child", () => {
  test("A-16: computeUnitInputHash differs under different gateFeedback, and feeding the two hashes into the seam yields two DIFFERENT child runs", async () => {
    const target = buildChildTarget(leafChildPlan());
    const plan: IrStepPlanV4 = {
      stepId: "compose",
      title: "compose",
      sequenceIndex: 0,
      root: {
        kind: "unit",
        id: "compose",
        instructions: "Compose the child workflow.",
        onError: "fail",
        isolation: "none",
        frozenTarget: target as FrozenWorkflowTarget,
        environment: [],
      },
      gate: { kind: "gate", id: "compose.gate", stepId: "compose", criteria: [], frozenJudge: null },
    };
    const baseInput: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };
    const loopedInput: WorkListInput = {
      ...baseInput,
      gateLoop: 2,
      gateFeedback: { feedback: "try again", missing: ["something"] },
    };

    const baseResult = computeStepWorkList(plan, baseInput);
    const loopedResult = computeStepWorkList(plan, loopedInput);
    expect(baseResult.ok).toBe(true);
    expect(loopedResult.ok).toBe(true);
    if (!baseResult.ok || !loopedResult.ok) return;

    const baseHash = baseResult.list.units[0]?.inputHash;
    const loopedHash = loopedResult.list.units[0]?.inputHash;
    expect(baseHash).toBeDefined();
    expect(loopedHash).toBeDefined();
    // Asserted directly on the two hashes (P3a §3.3's gateFeedback preimage
    // field), not on any id suffix.
    expect(loopedHash).not.toBe(baseHash);

    const parent = await seedParentRun();
    const first = await driveChildWorkflowUnit(
      buildDriveInput({ parent, target, inputHash: baseHash, dispatcher: successDispatcher() }),
    );
    const second = await driveChildWorkflowUnit(
      buildDriveInput({ parent, target, inputHash: loopedHash, dispatcher: successDispatcher() }),
    );
    expect(second.childRun?.runId).not.toBe(first.childRun?.runId);
    expect(await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId))).toHaveLength(2);
  });
});

describe("A-17 — two composing steps, same child ref, same bindings — two independent children", () => {
  test("A-17: different parentUnitId yields a different invocation_key and therefore a second child run", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());

    const stepA = await driveChildWorkflowUnit(
      buildDriveInput({ parent: { ...parent, stepId: "compose-a" }, target, dispatcher: successDispatcher() }),
    );
    const stepB = await driveChildWorkflowUnit(
      buildDriveInput({ parent: { ...parent, stepId: "compose-b" }, target, dispatcher: successDispatcher() }),
    );

    expect(stepB.childRun?.runId).not.toBe(stepA.childRun?.runId);
    expect(await withWorkflowRunsRepo((repo) => repo.childRunsOf(parent.runId))).toHaveLength(2);
  });
});

// ── A-18…A-23, A-27: driving and status mapping ─────────────────────────────

describe("A-18, A-19 — an active child is driven to completion; the exported result is promoted", () => {
  test("A-18: runWorkflowSteps drives the newly-published (active) child", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(outcome.childRun?.runId).toBeDefined();
    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(outcome.childRun.runId));
    expect(childRow?.status).toBe("completed");
  });

  test("A-19: the parent unit completes with the child's exported {runId, status} result (no outputs: declared)", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(outcome.ok).toBe(true);
    const childRunId = outcome.childRun?.runId as string;
    expect(childRunId).toBeDefined();
    // §4.4: a child with no `outputs:` declaration exports {runId, status}
    // metadata only — synthesized, never stored.
    expect(outcome.result).toEqual({ runId: childRunId, status: "completed" });
  });
});

describe("A-20 — a failed child fails the parent unit, naming the child run, ref, and failed step", () => {
  test("A-20: failure_reason is child_workflow_failed and the message names the child run id, ref, and its failed step", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan(), { ref: "workflows/failing-child" });

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: failureDispatcher() }));

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_failed");
    const childRunId = outcome.childRun?.runId as string;
    expect(childRunId).toBeDefined();
    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId));
    expect(childRow?.status).toBe("failed");
    expect(outcome.error).toContain(childRunId);
    expect(outcome.error).toContain("workflows/failing-child");
    expect(outcome.error).toContain("work");
    // Never a member of PROGRAM_RETRY_REASONS — an authored retry.on can
    // never re-drive a failed child automatically.
    expect(outcome.failureReason).not.toBe("dispatch_error");
  });
});

describe("A-21 — a blocked child blocks the parent RUN, with the exact resume notes", () => {
  test("A-21: the composing STEP completes blocked (not failed), the parent RUN derives blocked, and the notes name the child run id + both resume commands verbatim", async () => {
    const parentRunId = randomUUID();
    const parentStepId = "compose";
    const childPlan = gatedChildPlan();
    const target = buildChildTarget(childPlan, { ref: "workflows/gated-child" });

    // A full top-level parent drive is required here: driveChildWorkflowUnit
    // alone returns only a UnitOutcome — it is finalizeExecutedStep
    // (run-workflow.ts's runStepGateLoop, on the PARENT's own spine) that
    // turns a childBlocked unit outcome into a blocked STEP with notes.
    const parentPlan: WorkflowPlanGraphV4 = {
      irVersion: 5,
      title: "Parent",
      execution: { maxConcurrency: 1 },
      sourceReadSet: fakeSourceReadSet(),
      steps: [
        {
          stepId: parentStepId,
          title: parentStepId,
          sequenceIndex: 0,
          root: {
            kind: "unit",
            id: parentStepId,
            instructions: "Compose the gated child workflow.",
            onError: "fail",
            isolation: "none",
            frozenTarget: target as FrozenWorkflowTarget,
            environment: [],
          },
          gate: {
            kind: "gate",
            id: `${parentStepId}.gate`,
            stepId: parentStepId,
            criteria: [],
            maxLoops: 1,
            frozenJudge: null,
          },
        },
      ],
    };
    const now = new Date().toISOString();
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
            params_json, current_step_id, created_at, updated_at, plan_json, plan_hash, plan_ir_version)
         VALUES (?, 'workflows/parent', 'dir:v1:parent', NULL, 'Parent', 'active', '{}', ?, ?, ?, ?, ?, 5)`,
      ).run(parentRunId, parentStepId, now, now, canonicalJson(parentPlan), computePlanHash(parentPlan));
      const parentStepRow = frozenStepRows(parentPlan)[0]!;
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        parentRunId,
        parentStepRow.stepId,
        parentStepRow.stepTitle,
        parentStepRow.instructions,
        parentStepRow.completionJson,
        parentStepRow.sequenceIndex,
      );
    } finally {
      db.close();
    }

    const result = await runWorkflowSteps({
      target: parentRunId,
      dispatcher: judgeInfrastructureFailureDispatcher(),
    });

    expect(result.run.status).toBe("blocked");
    const parentStep = await withWorkflowRunsRepo((repo) => repo.getStep(parentRunId, parentStepId));
    expect(parentStep?.status).toBe("blocked");

    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(children).toHaveLength(1);
    const childRunId = children[0]!.id;
    const childStepId = "work";

    const expectedNotes =
      `Step "${parentStepId}" composes child workflow run ${childRunId} (workflows/gated-child), ` +
      `which is blocked at its own step "${childStepId}". Nothing in this run advances ` +
      `until the child does — a gate is a gate for a child workflow too, so \`akm\` will ` +
      `not resume it for you. Clear it with \`akm workflow resume ${childRunId}\`, then ` +
      `\`akm workflow resume ${parentRunId}\` and \`akm workflow run ${parentRunId}\` to ` +
      `continue: re-driving the parent drives the resumed child.`;
    expect(parentStep?.notes).toBe(expectedNotes);
  });
});

describe("A-22, A-23 — a child already blocked/failed from a previous attempt is not re-driven", () => {
  test("A-22: a child already blocked is mapped identically to A-21 WITHOUT driving it — no lease taken, no new unit rows", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(gatedChildPlan(), { ref: "workflows/pre-blocked-child" });
    const key = computeChildInvocationKey({
      parentRunId: parent.runId,
      parentUnitId: parentUnitId(parent.stepId),
      unitInputHash: "h".repeat(64),
    });
    const childRunId = randomUUID();
    const childPlan = target.frozenPlan;
    await withWorkflowRunsRepo(async (repo) =>
      repo.publishChildWorkflowRun({
        parentRunId: parent.runId,
        spawnedByUnitId: parentUnitId(parent.stepId),
        invocationKey: key,
        run: {
          id: childRunId,
          workflowRef: target.ref,
          scopeKey: parent.scopeKey,
          workflowEntryId: null,
          workflowTitle: childPlan.title,
          paramsJson: "{}",
          currentStepId: childPlan.steps[0]?.stepId ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agentHarness: null,
          agentSessionId: null,
          checkinArmedAt: null,
        },
        steps: frozenStepRows(childPlan).map((row) => ({ ...row, runId: childRunId })),
        planJson: canonicalJson(childPlan),
        planHash: target.planHash,
      }),
    );
    forceRunStatus(childRunId, "blocked");
    const beforeUnits = await withWorkflowRunsRepo((repo) =>
      repo.getUnitsForStep(childRunId, childPlan.steps[0]!.stepId),
    );
    const beforeLease = await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId));
    expect(beforeLease?.engine_lease_holder).toBeNull();

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_blocked");
    expect(outcome.childRun?.runId).toBe(childRunId);

    const afterUnits = await withWorkflowRunsRepo((repo) =>
      repo.getUnitsForStep(childRunId, childPlan.steps[0]!.stepId),
    );
    expect(afterUnits.length).toBe(beforeUnits.length);
    const afterLease = await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId));
    expect(afterLease?.engine_lease_holder).toBeNull();
    expect(afterLease?.status).toBe("blocked");
  });

  test("A-23: a child already failed is mapped identically to A-20 WITHOUT driving it", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan(), { ref: "workflows/pre-failed-child" });
    const key = computeChildInvocationKey({
      parentRunId: parent.runId,
      parentUnitId: parentUnitId(parent.stepId),
      unitInputHash: "h".repeat(64),
    });
    const childRunId = randomUUID();
    const childPlan = target.frozenPlan;
    await withWorkflowRunsRepo(async (repo) =>
      repo.publishChildWorkflowRun({
        parentRunId: parent.runId,
        spawnedByUnitId: parentUnitId(parent.stepId),
        invocationKey: key,
        run: {
          id: childRunId,
          workflowRef: target.ref,
          scopeKey: parent.scopeKey,
          workflowEntryId: null,
          workflowTitle: childPlan.title,
          paramsJson: "{}",
          currentStepId: childPlan.steps[0]?.stepId ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agentHarness: null,
          agentSessionId: null,
          checkinArmedAt: null,
        },
        steps: frozenStepRows(childPlan).map((row) => ({ ...row, runId: childRunId })),
        planJson: canonicalJson(childPlan),
        planHash: target.planHash,
      }),
    );
    forceRunStatus(childRunId, "failed");

    const outcome = await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_failed");
    expect(outcome.childRun?.runId).toBe(childRunId);
    const afterLease = await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId));
    expect(afterLease?.engine_lease_holder).toBeNull();
    expect(afterLease?.status).toBe("failed");
  });
});

describe("A-27 — a child whose lease is already held busies the parent unit", () => {
  test("A-27: failure_reason is child_workflow_busy, message carries the holder and expiry, and the parent run stays resumable", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan(), { ref: "workflows/busy-child" });
    const key = computeChildInvocationKey({
      parentRunId: parent.runId,
      parentUnitId: parentUnitId(parent.stepId),
      unitInputHash: "h".repeat(64),
    });
    const childRunId = randomUUID();
    const childPlan = target.frozenPlan;
    await withWorkflowRunsRepo(async (repo) =>
      repo.publishChildWorkflowRun({
        parentRunId: parent.runId,
        spawnedByUnitId: parentUnitId(parent.stepId),
        invocationKey: key,
        run: {
          id: childRunId,
          workflowRef: target.ref,
          scopeKey: parent.scopeKey,
          workflowEntryId: null,
          workflowTitle: childPlan.title,
          paramsJson: "{}",
          currentStepId: childPlan.steps[0]?.stepId ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agentHarness: null,
          agentSessionId: null,
          checkinArmedAt: null,
        },
        steps: frozenStepRows(childPlan).map((row) => ({ ...row, runId: childRunId })),
        planJson: canonicalJson(childPlan),
        planHash: target.planHash,
      }),
    );
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const holderAcquired = await withWorkflowRunsRepo((repo) =>
      repo.acquireEngineLease(childRunId, "other-driver-holder", expiresAt, new Date().toISOString()),
    );
    expect(holderAcquired).toBe(true);

    const outcome = await driveChildWorkflowUnit(
      buildDriveInput({ parent, target, inputHash: "h".repeat(64), dispatcher: successDispatcher() }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("child_workflow_busy");
    expect(outcome.error).toContain("other-driver-holder");
    expect(outcome.error).toContain(expiresAt);
  });
});

// ── A-24, A-25: the exact reuse-seam call shape (B-N6, B-N7) ────────────────

describe("A-24, A-25 — the child drive passes a no-op disposeDispatchResources and no maxSteps/maxRetries", () => {
  test("A-24: disposeDispatchResources is passed as a no-op — never the shared registry drain", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    const spy = spyOn(runWorkflowModule, "runWorkflowSteps").mockImplementation(
      async (options: { disposeDispatchResources?: () => void | Promise<void> }) => {
        expect(typeof options.disposeDispatchResources).toBe("function");
        // The no-op must be safely callable and do nothing observable — never
        // the real SDK-server registry drain (which this test never imports,
        // so calling it here proves nothing OTHER than "it returns").
        await options.disposeDispatchResources?.();
        return {
          run: { id: "child-run-id", workflowRef: target.ref, status: "completed" },
          executed: [],
          stepsProcessed: 0,
          done: true,
        } as unknown as ReturnType<typeof runWorkflowSteps> extends Promise<infer R> ? R : never;
      },
    );
    try {
      await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("A-25: maxSteps and maxRetries are never forwarded into the child drive's runWorkflowSteps call", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    let captured: Record<string, unknown> | undefined;
    const spy = spyOn(runWorkflowModule, "runWorkflowSteps").mockImplementation(async (options) => {
      captured = options as unknown as Record<string, unknown>;
      return {
        run: { id: "child-run-id", workflowRef: target.ref, status: "completed" },
        executed: [],
        stepsProcessed: 0,
        done: true,
      } as unknown as ReturnType<typeof runWorkflowSteps> extends Promise<infer R> ? R : never;
    });
    try {
      await driveChildWorkflowUnit(buildDriveInput({ parent, target, dispatcher: successDispatcher() }));
      expect(captured).toBeDefined();
      expect(Object.hasOwn(captured ?? {}, "maxSteps")).toBe(false);
      expect(Object.hasOwn(captured ?? {}, "maxRetries")).toBe(false);
      expect(captured?.target).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── A-26: the parent's maxSteps counts ONE composing step, not the child's ──

describe("A-26 — a composing step consumes exactly one parent maxSteps allowance", () => {
  test("A-26: --max-steps 1 on a workflow whose first step composes a 4-step child still runs all 4 child steps", async () => {
    const parentRunId = randomUUID();
    const parentStepId = "compose";
    const target = buildChildTarget(fourStepChildPlan(), { ref: "workflows/four-step-child" });
    const parentPlan: WorkflowPlanGraphV4 = {
      irVersion: 5,
      title: "Parent",
      execution: { maxConcurrency: 1 },
      sourceReadSet: fakeSourceReadSet(),
      steps: [
        {
          stepId: parentStepId,
          title: parentStepId,
          sequenceIndex: 0,
          root: {
            kind: "unit",
            id: parentStepId,
            instructions: "Compose the 4-step child workflow.",
            onError: "fail",
            isolation: "none",
            frozenTarget: target as FrozenWorkflowTarget,
            environment: [],
          },
          gate: {
            kind: "gate",
            id: `${parentStepId}.gate`,
            stepId: parentStepId,
            criteria: [],
            maxLoops: 1,
            frozenJudge: null,
          },
        },
      ],
    };
    const now = new Date().toISOString();
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
            params_json, current_step_id, created_at, updated_at, plan_json, plan_hash, plan_ir_version)
         VALUES (?, 'workflows/parent', 'dir:v1:parent', NULL, 'Parent', 'active', '{}', ?, ?, ?, ?, ?, 5)`,
      ).run(parentRunId, parentStepId, now, now, canonicalJson(parentPlan), computePlanHash(parentPlan));
      const parentStepRow = frozenStepRows(parentPlan)[0]!;
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        parentRunId,
        parentStepRow.stepId,
        parentStepRow.stepTitle,
        parentStepRow.instructions,
        parentStepRow.completionJson,
        parentStepRow.sequenceIndex,
      );
    } finally {
      db.close();
    }

    const result = await runWorkflowSteps({
      target: parentRunId,
      maxSteps: 1,
      dispatcher: successDispatcher(),
    });

    expect(result.stepsProcessed).toBe(1);
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(children).toHaveLength(1);
    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(children[0]!.id));
    expect(childRow?.status).toBe("completed");
    const childSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(children[0]!.id));
    expect(childSteps.every((step) => step.status === "completed")).toBe(true);
    expect(childSteps).toHaveLength(4);
  });
});
