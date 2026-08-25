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

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
  // This guardrail is untouched by R-01's flip — it fires on the shape of `with`
  // itself, independent of which `uses` target consumes it.
  test("R-01(b): scalarRecord still rejects a non-scalar with value on a tasks/x step (schema.ts:389)", () => {
    const step = { id: "nonscalar", uses: "tasks/build", with: { scope: { nested: true } }, source: span() };
    expect(() => decodeWorkflowSourceIrV1(baseIr(step))).toThrow(/must be a scalar/i);
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
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

describe("R-01(c) — with: values leave no trace at freeze (source-freeze-v4.ts:211-272, taskDispatch)", () => {
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

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P1a (the drop becomes a rejection)
  // and P2b (a real `with:` -> task-param binding is implemented).
  test("R-01(c): a task-composed step freezes byte-identically whether or not with: is authored, and the values are absent from the persisted plan JSON", async () => {
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
        "          scope: all",
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

    const withRun = await startWorkflowRun("workflows/with-drop-with");
    const withoutRun = await startWorkflowRun("workflows/with-drop-without");
    const withRow = await planRow(withRun.run.id);
    const withoutRow = await planRow(withoutRun.run.id);
    const withPlan = decodeWorkflowPlanV4(JSON.parse(withRow?.plan_json ?? "null"));
    const withoutPlan = decodeWorkflowPlanV4(JSON.parse(withoutRow?.plan_json ?? "null"));
    const withTarget = firstTarget(withPlan);
    const withoutTarget = firstTarget(withoutPlan);

    // The authored step actually reached a command dispatch (sanity check the
    // fixture exercises taskDispatch's command arm, not some earlier failure).
    expect(withTarget?.kind).toBe("command");
    // R-01(c) — the drop, proven by equality: two otherwise-identical steps
    // (one with `with:`, one without) resolve to the SAME frozen target.
    expect(withTarget).toEqual(withoutTarget);
    // R-01(c) — the drop, proven directly: the authored with: key is byte-absent
    // from the persisted plan JSON (the distinctive "scope" key would survive
    // verbatim in any JSON encoding, quoted or not, if it had left any trace).
    expect(withRow?.plan_json ?? "").not.toContain("scope");
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
