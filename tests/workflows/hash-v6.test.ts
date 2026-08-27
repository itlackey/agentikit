// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane A TESTS — `hashVersion` 6 (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md §3.3, rows A-11…A-16) and the
 * `computeChildInvocationKey` helper (§3.4, rows A-17…A-19). Both bumps ride
 * in Lane A's ONE commit (§0.2 commit ladder, #3), so this file combines them
 * exactly like P2a's `tests/execution/input-contract.test.ts` combined its
 * own multi-group scope in one file — see that file's header for the
 * precedent this one follows.
 *
 * RED phase, whole-file block failure by design:
 * `src/workflows/exec/child-invocation.ts` does not exist on disk yet, so it
 * is imported as a NAMESPACE behind exactly one directly-preceding
 * `@ts-expect-error` pin (the P2a `tests/tasks/source-v4.test.ts` /
 * `tests/execution/input-contract.test.ts` convention: TypeScript reports
 * exactly one TS2307 "Cannot find module" at that import, every name it
 * introduces is typed `any` for the rest of the file, and — because this is
 * a *static* top-level import — Bun's module loader fails to load this
 * ENTIRE file at test-run time before any `describe`/`test` registers. Every
 * test below (including the ones that only exercise ALREADY-REAL functions
 * like `computeStepWorkList`) therefore fails as a block during the RED
 * window; that is the intended, and only, RED signal this file produces
 * before Implement lands `child-invocation.ts`. Implement removes the one
 * directive the moment the import resolves.
 *
 * `FrozenChildWorkflowTarget` is likewise not yet a member of
 * `FrozenWorkflowTarget` (schema-v4.ts) — every fixture funnels through the
 * single `asFrozenTarget` cast below (RED-PHASE TYPE PINS: "Implement
 * removes ONE `@ts-expect-error` directive, not one per call site" — the
 * exact convention `tests/workflows/task-input-bindings.test.ts`'s
 * `frozenInputBindings` helper established for the mirror-image case, A-N7
 * there vs A-N1's frozen-target union growth here).
 *
 * IMPORTANT for whoever lands `hashVersion` 6 (§3.3's field table says the
 * preimage "otherwise byte-identical to head", but does not itself flag
 * this): `computeStepWorkList`'s existing per-unit resolution
 * (`step-work.ts`, building `StepWorkUnitContext`) has exactly one line that
 * assumes every NON-command frozen target carries an `.exec` spec —
 * `target.kind === "command" ? … : target.exec.timeoutMs` — true for
 * `shell`/`script` today, but `FrozenChildWorkflowTarget` (§3.5) has no
 * `exec` field at all. Unless that ternary also learns about
 * `kind: "child-workflow"`, `computeStepWorkList` throws a bare
 * `TypeError` reading `.timeoutMs` off `undefined` for exactly the fixtures
 * this file needs — before ever reaching `computeUnitInputHash`. The spec's
 * A-15/§3.3 wording ("frozenTarget … covers … the entire embedded child
 * plan") only makes sense if a child-workflow-targeted unit's OWN input hash
 * is computable (P3b's `invocation_key` needs exactly that value), so this
 * is read as in-scope for the same commit, not a separate finding to defer.
 *
 * TEST-REVIEW FOLLOW-UP (round 2): the `TypeError` above is not
 * hypothetical — it fires for every hand-built `child-workflow` fixture in
 * this file, unconditionally, because a static top-level import block-fails
 * the ENTIRE file today (see above) so the failure was never actually
 * observed against a real `hashVersion` mismatch. The spec's §3.1 file table
 * for `step-work.ts` authorizes only the two prefix bumps (`:691,:694` and
 * `:1830,:1833`); it does NOT authorize touching the `:450` ternary, so that
 * fix is NOT assumed here — it is recorded, unresolved, in the spec's
 * "Review log" (docs/plans/specs/p3a-plan-v5-child-freeze.md). Consequently:
 * the "unit input hash (A-11, A-15)" describe block below now splits its
 * fixtures by what each row actually needs to prove. A-11 — the general
 * "does the preimage match §3.3's field list under the new prefix" claim —
 * needs no child-workflow support at all, so its tests now use an ordinary,
 * already-handled `shell` target (`buildOrdinaryShellTarget`) and are
 * independently red on the `hashVersion` 6 bump alone, today, with no
 * dependency on the `:450` ternary. A-15 — "a changed embedded child
 * planHash changes the unit's input hash" — is inherently a claim about
 * `child-workflow` targets and keeps its child-workflow fixture; it stays
 * blocked on the same `TypeError` until the `:450` fix is either authorized
 * (spec amendment) or the ternary fix rides in some other explicitly
 * authorized commit. That is a known, recorded gap, not a bug in this file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
// @ts-expect-error P3a red-phase: computeChildInvocationKey lands in Implement (the implementation removes this directive)
import * as ChildInvocationModule from "../../src/workflows/exec/child-invocation";
import type { UnitDispatchResult } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { computeStepWorkList, type WorkListInput } from "../../src/workflows/exec/step-work";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget, type IrStepPlanV4 } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const { computeChildInvocationKey } = ChildInvocationModule;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── Shared child-workflow-target fixture builder (see file header) ─────────

interface ChildWorkflowTargetFixture {
  readonly kind: "child-workflow";
  readonly ref: string;
  readonly planHash: string;
  readonly frozenPlan: unknown;
  readonly contentHash: string;
  readonly via: "direct" | "task";
  readonly taskRef?: string;
  readonly inputBindings?: readonly TaskInputBinding[];
}

/** §3.5: FrozenChildWorkflowTarget lands in Implement — isolated so ONE directive is removed, not one per call site. */
function asFrozenTarget(target: ChildWorkflowTargetFixture): FrozenWorkflowTarget {
  // @ts-expect-error P3a red-phase: FrozenChildWorkflowTarget lands in Implement (the implementation removes this directive)
  return target;
}

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

function buildChildTargetFixture(options: {
  ref?: string;
  planHash: string;
  frozenPlan: unknown;
  via?: "direct" | "task";
  taskRef?: string;
  inputBindings?: readonly TaskInputBinding[];
}): ChildWorkflowTargetFixture {
  const ref = options.ref ?? "workflows/child";
  const via = options.via ?? "direct";
  return {
    kind: "child-workflow",
    ref,
    planHash: options.planHash,
    frozenPlan: options.frozenPlan,
    contentHash: childContentHash({
      ref,
      planHash: options.planHash,
      via,
      taskRef: options.taskRef,
      inputBindings: options.inputBindings,
    }),
    via,
    ...(options.taskRef ? { taskRef: options.taskRef } : {}),
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/** A minimal one-unit step plan whose sole unit targets `target`. */
function stepPlanWithTarget(target: FrozenWorkflowTarget, stepId = "spawn"): IrStepPlanV4 {
  return {
    stepId,
    title: stepId,
    sequenceIndex: 0,
    root: {
      kind: "unit",
      id: `${stepId}.unit`,
      instructions: "Spawn the child workflow.",
      onError: "fail",
      isolation: "none",
      frozenTarget: target,
      environment: [],
    },
    gate: { kind: "gate", id: `${stepId}.gate`, stepId, criteria: [], frozenJudge: null },
  };
}

/**
 * An ORDINARY, already-supported `shell` target (see file header,
 * "TEST-REVIEW FOLLOW-UP (round 2)"). Unlike `buildChildTargetFixture`, this
 * needs no `@ts-expect-error` cast — `FrozenWorkflowShellTarget` is real,
 * landed schema — and `computeStepWorkList`'s `:450` timeoutMs ternary
 * already handles `kind: "shell"` correctly today, so a fixture built from
 * this function can never trip the `target.exec.timeoutMs`-on-`undefined`
 * `TypeError` that every `child-workflow` fixture in this file hits. Used by
 * the A-11 tests below, which are claims about the preimage SHAPE and prefix
 * in general — not about child-workflow composition specifically — so they
 * do not need a child-workflow fixture to be meaningful.
 */
function buildOrdinaryShellTarget(options: { inputBindings?: readonly TaskInputBinding[] } = {}): FrozenWorkflowTarget {
  return {
    kind: "shell",
    contentHash: "s".repeat(64),
    exec: { command: ["/bin/sh", "-c", "echo hi"], timeoutMs: 60_000 },
    cwdIdentity: {
      requestedRoot: "/stash",
      realRoot: "/stash",
      rootDevice: "1",
      rootInode: "1",
      requestedCwd: "/stash",
      realCwd: "/stash",
      cwdDevice: "1",
      cwdInode: "1",
    },
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

// ── A-11, A-15: computeUnitInputHash (via computeStepWorkList) ─────────────
//
// A-11 (the preimage shape/prefix in general) uses buildOrdinaryShellTarget
// so it is independently red on the hashVersion 6 bump alone, today — see
// the file header's "TEST-REVIEW FOLLOW-UP (round 2)" note. A-15 (a claim
// specifically about embedded child planHash sensitivity) keeps its
// child-workflow fixture, and stays blocked on the recorded, unresolved
// step-work.ts:450 gap until that gets its own explicit authorization.

describe("hashVersion 6 — unit input hash (A-11, A-14, A-15)", () => {
  test("the preimage matches §3.3's field list exactly, under the akm.workflow.unit\\0v6\\0 prefix (an ordinary target — independent of child-workflow support)", () => {
    const target = buildOrdinaryShellTarget();
    const stepPlan = stepPlanWithTarget(target);
    const input: WorkListInput = { runId: "run-1", params: { p: 1 }, stepOutputs: {} };

    const result = computeStepWorkList(stepPlan, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = result.list.units[0];
    if (!unit) throw new Error("expected exactly one unit");

    const expectedHash = createHash("sha256")
      .update("akm.workflow.unit\0v6\0")
      .update(
        canonicalJson({
          hashVersion: 6,
          role: "unit",
          stepId: stepPlan.stepId,
          nodeId: unit.nodeId,
          template: "Spawn the child workflow.",
          item: null,
          inputs: [],
          params: input.params,
          frozenTarget: unit.frozenTarget,
          environment: [],
          schema: null,
          isolation: "none",
        }),
      )
      .digest("hex");

    // RED today: the real prefix is still akm.workflow.unit\0v5\0 / hashVersion 5.
    expect(unit.inputHash).toBe(expectedHash);
  });

  test("a changed embedded child planHash changes the unit's input hash (A-15)", () => {
    const childPlanA = { title: "child-a", irVersion: 5 };
    const childPlanB = { title: "child-b", irVersion: 5 };
    const targetA = asFrozenTarget(
      buildChildTargetFixture({ ref: "workflows/child", planHash: "a".repeat(64), frozenPlan: childPlanA }),
    );
    const targetB = asFrozenTarget(
      buildChildTargetFixture({ ref: "workflows/child", planHash: "b".repeat(64), frozenPlan: childPlanB }),
    );
    const input: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };

    const resultA = computeStepWorkList(stepPlanWithTarget(targetA), input);
    const resultB = computeStepWorkList(stepPlanWithTarget(targetB), input);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    const hashA = resultA.list.units[0]?.inputHash;
    const hashB = resultB.list.units[0]?.inputHash;
    expect(hashA).toBeTruthy();
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).not.toBe(hashB);
  });

  test("a changed inputBindings entry changes the unit's input hash, target kind held constant (A-11's frozenTarget field)", () => {
    const withoutBindings = buildOrdinaryShellTarget();
    const withBindings = buildOrdinaryShellTarget({
      inputBindings: [{ kind: "literal", name: "x", value: "a" }],
    });
    const input: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };

    const resultA = computeStepWorkList(stepPlanWithTarget(withoutBindings), input);
    const resultB = computeStepWorkList(stepPlanWithTarget(withBindings), input);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.list.units[0]?.inputHash).not.toBe(resultB.list.units[0]?.inputHash);
  });
});

// ── A-12: the gate hash ─────────────────────────────────────────────────────

function writeProgram(name: string, markdown: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, "utf8");
}

const GATE_WF = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
  "### gate",
  "",
  "- the work is verified",
  "",
].join("\n");

describe("hashVersion 6 — the gate hash (A-12)", () => {
  test("the gate hash prefix is akm.workflow.gate\\0v6\\0 with hashVersion 6 in the preimage, dispatch/invocation/prompt otherwise unchanged", async () => {
    writeProgram("gate-hash", GATE_WF);
    const started = await startWorkflowRun("workflows/gate-hash");
    const runId = started.run.id;

    // SummaryJudge's prompt argument is the {system, user} pair
    // (validate-summary.ts) — the hash preimage hashes this whole object,
    // never a spliced string.
    let capturedPrompt: { system: string; user: string } | undefined;
    const result = await runWorkflowSteps({
      target: runId,
      summaryJudge: async (prompt) => {
        capturedPrompt = prompt;
        return '{"complete": true, "missing": []}';
      },
      dispatcher: async (): Promise<UnitDispatchResult> => ({ ok: true, text: "done" }),
    });
    expect(result.done).toBe(true);
    expect(capturedPrompt).toBeTruthy();

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "work"));
    const gateRow = rows.find((row) => row.phase === "gate");
    expect(gateRow?.input_hash).toBeTruthy();

    const planRow = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const plan = decodeWorkflowPlanV4(JSON.parse(planRow?.plan_json ?? "null"));
    const gateTarget = plan.steps[0]?.gate.frozenJudge;
    expect(gateTarget).toBeTruthy();

    const expectedHash = createHash("sha256")
      .update("akm.workflow.gate\0v6\0")
      .update(canonicalJson({ hashVersion: 6, dispatch: gateTarget, invocation: null, prompt: capturedPrompt }))
      .digest("hex");

    // RED today: the real prefix is still akm.workflow.gate\0v5\0 / hashVersion 5.
    expect(gateRow?.input_hash).toBe(expectedHash);
  });
});

// ── A-17…A-19: computeChildInvocationKey ────────────────────────────────────

describe("computeChildInvocationKey (§3.4, A-17…A-19)", () => {
  const base = { parentRunId: "run-1", parentUnitId: "unit-1", unitInputHash: "d".repeat(64) };

  test("is deterministic: the same three inputs hash identically", () => {
    const first = computeChildInvocationKey(base);
    const second = computeChildInvocationKey({ ...base });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the exact documented preimage: sha256('akm.workflow.child-invocation\\0v1\\0' + canonicalJson({parentRunId, parentUnitId, unitInputHash}))", () => {
    const input = { parentRunId: "run-42", parentUnitId: "unit-7", unitInputHash: "e".repeat(64) };
    const expected = createHash("sha256")
      .update("akm.workflow.child-invocation\0v1\0")
      .update(
        canonicalJson({
          parentRunId: input.parentRunId,
          parentUnitId: input.parentUnitId,
          unitInputHash: input.unitInputHash,
        }),
      )
      .digest("hex");
    expect(computeChildInvocationKey(input)).toBe(expected);
  });

  test("a changed parentRunId produces a different key", () => {
    expect(computeChildInvocationKey(base)).not.toBe(computeChildInvocationKey({ ...base, parentRunId: "run-2" }));
  });

  test("a changed parentUnitId produces a different key", () => {
    expect(computeChildInvocationKey(base)).not.toBe(computeChildInvocationKey({ ...base, parentUnitId: "unit-2" }));
  });

  test("a changed unitInputHash produces a different key", () => {
    expect(computeChildInvocationKey(base)).not.toBe(
      computeChildInvocationKey({ ...base, unitInputHash: "f".repeat(64) }),
    );
  });

  test("collision-free across a grid of parentRunId/parentUnitId/unitInputHash variations", () => {
    const runIds = ["run-1", "run-2", "run-3"];
    const unitIds = ["unit-a", "unit-b", "unit-c"];
    const hashes = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    const seen = new Set<string>();
    for (const parentRunId of runIds) {
      for (const parentUnitId of unitIds) {
        for (const unitInputHash of hashes) {
          const key = computeChildInvocationKey({ parentRunId, parentUnitId, unitInputHash });
          expect(key).toMatch(/^[0-9a-f]{64}$/);
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBe(runIds.length * unitIds.length * hashes.length);
  });
});
