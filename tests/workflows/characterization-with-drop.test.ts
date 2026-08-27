// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane A / R-01): a workflow step `uses: tasks/<ref>`
 * accepts a `with:` mapping at the decoder — the shape-check fires for every
 * `uses` target — but `taskDispatch` (src/workflows/ir/source-freeze-v4.ts)
 * never reads `source.with`, so the authored mapping is silently dropped: no
 * error, no warning, no trace in the frozen plan.
 *
 * These tests pin that CURRENT (defective) behavior so P1a's rejection is a
 * one-file test diff instead of a judgment call. See
 * docs/plans/specs/p0-invariants.md row R-01 and the Lane A checklist for the
 * authoritative source-site citations reproduced in the comments below.
 *
 * Fixture pattern: task-composition fixtures follow
 * tests/integration/workflows/immutable-resolution-v4-red.test.ts:197-228
 * (`writeTask`/`writeWorkflow` shape). Hand-built source-IR fixtures follow
 * the "strict source IR decoder" pattern in tests/workflows/source-ir-contract.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { compileGithubWorkflowSource } from "../../src/workflows/source-ir/compile";
import { decodeWorkflowSourceIrV1 } from "../../src/workflows/source-ir/schema";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

// ── Pure source-IR fixtures (no sandbox needed) ──────────────────────────────

const FIXTURE_PATH = "workflows/with-drop.yml";

function span() {
  return { path: FIXTURE_PATH, start: 8, end: 8 };
}

/** A minimal, otherwise-valid source IR wrapping exactly one step under test. */
function baseIr(step: Record<string, unknown>): unknown {
  return {
    sourceIrVersion: 1,
    name: "With-drop characterization",
    triggers: [{ kind: "workflow_dispatch", source: { path: FIXTURE_PATH, start: 2, end: 2 } }],
    jobs: [
      {
        id: "main",
        needs: [],
        steps: [step],
        source: { path: FIXTURE_PATH, start: 5, end: 9 },
      },
    ],
    source: { path: FIXTURE_PATH, start: 1, end: 9 },
  };
}

describe("R-01(a)(b)(d) — with: on tasks/<ref>: decode-level acceptance, guardrails, and contrast (source-ir/schema.ts)", () => {
  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
  // Flips in P1a (rejection of `with:` on a non-builtin-command `uses`).
  test("R-01(a): a scalar with: mapping on 'uses: tasks/<t>' decodes with no error (schema.ts:144, shape-check at :389-393)", () => {
    const step = { id: "dispatch", uses: "tasks/build", with: { scope: "all" }, source: span() };
    expect(() => decodeWorkflowSourceIrV1(baseIr(step))).not.toThrow();
    const decoded = decodeWorkflowSourceIrV1(baseIr(step));
    expect(decoded.jobs[0]?.steps[0]?.with).toEqual({ scope: "all" });
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
  test("R-01(a): the identical shape compiles cleanly through the real GitHub-YAML source adapter", () => {
    const result = compileGithubWorkflowSource(
      [
        "name: With drop",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: tasks/build",
        "        with:",
        "          scope: all",
        "",
      ].join("\n"),
      { path: FIXTURE_PATH },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ir.jobs[0]?.steps[0]?.with).toEqual({ scope: "all" });
  });

  // FLIPPED + RE-SCOPED (P2b, spec docs/plans/specs/p2b-input-bindings.md
  // §1.7 A-N3, §7 F-A2): scalarRecord's "must be a scalar" restriction now
  // narrows to NON-task uses targets only (schema.ts:389,912) — a
  // tasks/<ref> step's with: may carry a nested value (see the sibling test
  // below). This re-points the ORIGINAL assertion at the two uses kinds
  // where a nested with: value is still rejected, for two DIFFERENT reasons:
  //   - commands/<ref> is unaffected by the task-only widening, so
  //     scalarRecord's own "must be a scalar" message still fires exactly
  //     as before (verified directly against the same fixture shape the
  //     original tasks/x test used).
  //   - akm/command is unaffected too, but for a different reason:
  //     validateWorkflowBuiltinCommand's own ref/content/arguments
  //     string-typing (schema.ts:362-374) runs BEFORE scalarRecord and
  //     rejects a nested value first — the surfaced message differs, but
  //     the net effect (a non-scalar with: value is refused) is identical.
  test("R-01(b): a non-scalar with value is still rejected for non-task targets — commands/<ref> (scalarRecord, schema.ts:389) and akm/command (validateWorkflowBuiltinCommand, schema.ts:362-374)", () => {
    const commandStep = {
      id: "nonscalar-command",
      uses: "commands/review",
      with: { scope: { nested: true } },
      source: span(),
    };
    expect(() => decodeWorkflowSourceIrV1(baseIr(commandStep))).toThrow(/must be a scalar/i);

    const builtinStep = {
      id: "nonscalar-builtin",
      uses: "akm/command",
      commandMode: "literal",
      with: { content: { nested: true } },
      source: span(),
    };
    expect(() => decodeWorkflowSourceIrV1(baseIr(builtinStep))).toThrow(/must be a string/i);
  });

  // NEW (P2b, spec §1.7 A-N3, §7 F-A2): the task-only decode widening — a
  // tasks/<ref> step's with: may now carry any JSON value the bounded
  // document front end already accepts, including a nested object. Freeze
  // (src/workflows/freeze/**) decides what a declared input actually
  // accepts; decode only checks the key grammar.
  test("R-01(b): with: on tasks/<ref> now decodes a nested value (A-N3, schema.ts:389)", () => {
    const step = { id: "nonscalar-task", uses: "tasks/build", with: { scope: { nested: true } }, source: span() };
    expect(() => decodeWorkflowSourceIrV1(baseIr(step))).not.toThrow();
    const decoded = decodeWorkflowSourceIrV1(baseIr(step));
    expect(decoded.jobs[0]?.steps[0]?.with).toEqual({ scope: { nested: true } });
  });

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("R-01(b): with: without uses: still fails with the exact 'with is legal only with uses' message (schema.ts:393)", () => {
    const step = { id: "runwith", run: "echo ok", with: { a: "b" }, source: span() };
    expect(() => decodeWorkflowSourceIrV1(baseIr(step))).toThrow(/step runwith with is legal only with uses/);
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
  // R-01(d) contrast, rejecting half: the akm/command path structurally
  // validates `with` (schema.ts:362-374, validateWorkflowBuiltinCommand) — an
  // unsupported field is rejected here, unlike the tasks/x acceptance already
  // pinned by R-01(a) above (`baseIr(step)` at :64/:72, asserted `.not.toThrow()`
  // there — not re-asserted here, so this test does not also flip on P1a's
  // tasks/x rejection). The consuming half — a VALID with reaching the frozen
  // command target — is pinned by the freeze-level describe block below.
  test("R-01(d): with: {bogus} is structurally rejected for uses: akm/command (schema.ts:362-374, validateWorkflowBuiltinCommand)", () => {
    const consumed = {
      id: "builtin",
      uses: "akm/command",
      commandMode: "literal",
      with: { bogus: "value" },
      source: span(),
    };
    expect(() => decodeWorkflowSourceIrV1(baseIr(consumed))).toThrow(/unsupported field/i);
  });
});

describe("R-01(c) — with: on tasks/<ref> now rejects at freeze (source-freeze-v4.ts:211-272, taskDispatch)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, content: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  async function planRow(runId: string) {
    return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
  }

  function firstTarget(plan: ReturnType<typeof decodeWorkflowPlanV4>): FrozenWorkflowTarget | undefined {
    const root = plan.steps[0]?.root;
    if (!root) return undefined;
    return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
  }

  // FLIPPED (P1a, Lane A): docs/plans/specs/p1a-with-rejection-classifier.md
  // §3.1, §7 rows F-01a/F-01b. Before P1a this test proved the SILENT DROP —
  // freeze-equality of the with/without halves and byte-absence of the
  // authored value from the persisted plan JSON (see git history for the
  // prior body). P1a turns the drop into a fail-closed rejection: the
  // with-half now throws UsageError COMPOSITION_INVALID naming the step id
  // and the authored task ref, before the frozen dispatch is ever produced.
  // The without-half is untouched by the new guard and still freezes to a
  // command dispatch exactly as before (B-04) — both halves are asserted in
  // this one test, per F-01b.
  test("R-01(c): a task-composed step's with: now rejects at freeze with COMPOSITION_INVALID; the without-half still freezes unchanged", async () => {
    write("commands/review.md", "Review the dropped with value.\n");
    write(
      "tasks/command-task.yml",
      ["version: 3", "uses: commands/review", "akm:", '  schedule: "@daily"', ""].join("\n"),
    );
    write(
      "workflows/with-drop-with.yml",
      [
        "name: With drop",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: tasks/command-task",
        "        with:",
        "          r01DroppedSentinel: r01-dropped-sentinel",
        "",
      ].join("\n"),
    );
    write(
      "workflows/with-drop-without.yml",
      [
        "name: With drop",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: tasks/command-task",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // F-01a: the with-half now rejects at freeze instead of silently
    // dropping the mapping and dispatching a command.
    let withError: unknown;
    try {
      await startWorkflowRun("workflows/with-drop-with");
    } catch (error) {
      withError = error;
    }
    expect(withError).toBeInstanceOf(UsageError);
    if (!(withError instanceof UsageError)) return;
    expect(withError.code).toBe("COMPOSITION_INVALID");
    // P2b (spec §1.7 A-N5, §7 F-A3) message-byte flip: the fixture's
    // version: 3 task declares no inputs: at all, so the rejection is now
    // the no-declared-inputs COMPOSITION_INVALID (src/workflows/freeze/targets/task.ts's
    // noDeclaredInputsError), not P1a's "not supported yet" placeholder.
    expect(withError.message).toBe(
      "Workflow step dispatch cannot pass with: to task target tasks/command-task; tasks/command-task declares no inputs.",
    );

    // F-01b: the without-half is unaffected by the new guard and still
    // freezes to a command dispatch, unchanged from before P1a.
    const withoutRun = await startWorkflowRun("workflows/with-drop-without");
    const withoutRow = await planRow(withoutRun.run.id);
    const withoutPlan = decodeWorkflowPlanV4(JSON.parse(withoutRow?.plan_json ?? "null"));
    expect(firstTarget(withoutPlan)?.kind).toBe("command");
  });
});

describe("R-01(d) — freeze-level contrast: a valid with: on uses: akm/command IS consumed (source-freeze-v4.ts:145-153)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, content: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P1a (with: rejection extends to
  // every non-builtin-command uses target) and P2b (real with: -> task-param
  // bindings are implemented for tasks/x). This is R-01(d)'s other half: the
  // tasks/x drop (R-01(c) above) has a builtin-command CONTRAST that must
  // itself stay pinned, or a P1a change that blanket-rejects `with` on every
  // `uses` target — silently killing the builtin-command path too — would not
  // be caught by any test in this suite.
  test("R-01(d): a valid with: {content} on uses: akm/command freezes to a command target carrying that content", async () => {
    write(
      "workflows/with-consumed.yml",
      [
        "name: With consumed",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: akm/command",
        "        with:",
        "          content: Consume this authored with value.",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/with-consumed");
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const root = plan.steps[0]?.root;
    const target: FrozenWorkflowTarget | undefined = root && root.kind !== "map" ? root.frozenTarget : undefined;

    // The consumed path, proven directly: unlike the tasks/x drop (R-01(c)),
    // the akm/command `with:` mapping reaches the frozen command target — the
    // authored content survives verbatim into the persisted plan.
    expect(target?.kind).toBe("command");
    if (target?.kind !== "command") return;
    expect(target.request.command.content).toBe("Consume this authored with value.");
  });
});
