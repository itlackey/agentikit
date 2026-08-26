// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane B — delivery (spec docs/plans/specs/p2b-input-bindings.md §4,
 * rows B-35..B-40).
 *
 * A workflow step's `with:` on `uses: tasks/<ref>` binds the composed task's
 * declared `inputs:` (Lane A2, §3). This file pins how the EFFECTIVE bound
 * values are delivered to each of the three composed-target kinds:
 *
 *   - shell/script  -> ONE `AKM_TASK_INPUTS` env var, canonical JSON, never
 *     one var per input (§4.1, B-35/B-36), and the same spawn-boundary size
 *     guard that already covers `AKM_INPUTS`/`AKM_PARAMS`/`AKM_ITEM` covers it
 *     too (§4.1/B-N1, B-37);
 *   - command (agent/LLM) -> a structured `## Task inputs` fenced JSON block
 *     appended to the assembled prompt, after the byte-exact authored prose,
 *     never spliced into it (§4.2/B-N2, B-38);
 *   - workflow -> the effective inputs become the child run's `params`
 *     (§4.3, B-40) — this one is NOT step composition; it is a v4 TASK whose
 *     OWN target is `uses: workflows/<ref>`, run via `akm task run`.
 *
 * RED TODAY, for the same reason across every scenario below: `taskDispatch`
 * (`src/workflows/ir/source-freeze-v4.ts`) still throws `UsageError`
 * `COMPOSITION_INVALID` the instant a task-composed step authors ANY `with:`
 * (P1a's fail-closed placeholder, spec §1.7 A-N5) — so every
 * `startWorkflowRun(...)` call below rejects before freeze ever reaches the
 * new binding logic. The workflow-target scenario (B-40) fails differently:
 * it never throws, but `projectTaskSourceV4` does not yet forward a v4 task's
 * `inputs:` into the child run's params (P2a's own docstring: "input delivery
 * is P2b"), so the child run's `params` come back `{}` instead of the
 * expected effective inputs — an assertion failure, not a thrown error.
 *
 * No `// @ts-expect-error P2b red-phase` pins are needed anywhere in this
 * file: every scenario is driven through the REAL workflow-source YAML
 * grammar (`with:` is authored as plain YAML/JSON, decoded structurally,
 * never a TypeScript symbol) and observed through REAL subprocess execution
 * (`executeStepPlan`) or the REAL `akm task run` CLI path — no not-yet-
 * existing TypeScript export is referenced directly anywhere below.
 *
 * Sandbox/freeze pattern follows
 * tests/integration/workflows/immutable-resolution-v4-red.test.ts (task
 * composition via `startWorkflowRun` + `akmIndex`) and
 * tests/integration/workflows/exec-unit.test.ts (real-subprocess execution
 * via `executeStepPlan`, and the `AKM_*` spawn-boundary ceiling tests this
 * file's oversized-input test mirrors directly).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { canonicalInputJson } from "../../../src/execution/input-contract";
import { akmIndex } from "../../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import {
  executeStepPlan as executeFrozenStepPlan,
  type StepExecutionResult,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../../src/workflows/exec/native-executor";
import { decodeWorkflowPlanV4, type IrStepPlanV4, type WorkflowPlanGraphV4 } from "../../../src/workflows/ir/schema-v4";
import { execContextLimits } from "../../../src/workflows/resource-limits";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let workDir = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  // Layered on top of writeWorkflowTestConfig()'s engine config: an explicit
  // named bundle so `akm task run` (the CLI path the workflow-target
  // scenario, B-40, drives) resolves the fixture the same way
  // tests/integration/commands/tasks-input-flags.test.ts's P2a precedent
  // does. writeSandboxConfig merges over the existing engines/defaults keys
  // rather than replacing them.
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
  });
  resetConfigCache();
  workDir = path.join(storage.root, "scratch", "work");
  fs.mkdirSync(workDir, { recursive: true });
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

function workflowYaml(steps: string): string {
  return [
    "name: Delivery",
    "on:",
    "  workflow_dispatch:",
    "jobs:",
    "  contract:",
    "    runs-on: [self-hosted]",
    "    steps:",
    steps,
    "",
  ].join("\n");
}

function writeWorkflow(name: string, steps: string): void {
  write(`workflows/${name}.yml`, workflowYaml(steps));
}

/** Index the fixture bundle, start the run, and return its first frozen step plus its run id. */
async function firstStep(ref: string): Promise<{ runId: string; step: IrStepPlanV4 }> {
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const started = await startWorkflowRun(ref);
  const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
  const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null")) as WorkflowPlanGraphV4;
  const step = plan.steps[0];
  if (!step) throw new Error(`frozen plan for ${ref} has no steps`);
  return { runId: started.run.id, step };
}

// ── B-35/B-36 — shell/script targets: ONE AKM_TASK_INPUTS env var ──────────

describe("shell/script task target — AKM_TASK_INPUTS is exactly one canonical-JSON env var (B-35, B-36)", () => {
  test("a shell-target (run:/shell:) task receives AKM_TASK_INPUTS with the exact canonical JSON, and no per-input AKM_TASK_INPUT_* var exists (B-35)", async () => {
    write(
      "tasks/shell-echo.yml",
      [
        "version: 4",
        "name: Shell echo",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: changed",
        "  strict:",
        "    type: boolean",
        "    default: true",
        "run: |",
        "  printf '%s' \"$AKM_TASK_INPUTS\"",
        "  printf '\\n---NAMES---\\n'",
        "  env | cut -d= -f1",
        "shell: sh",
        "",
      ].join("\n"),
    );
    writeWorkflow(
      "shell-delivery",
      ["      - id: dispatch", "        uses: tasks/shell-echo", "        with:", "          scope: all"].join("\n"),
    );

    const { runId, step } = await firstStep("workflows/shell-delivery");
    const result: StepExecutionResult = await executeFrozenStepPlan(step, {
      runId,
      workflowRef: "workflows/shell-delivery",
      params: {},
      evidence: {},
      workDir,
    });

    expect(result.ok).toBe(true);
    const [jsonPart, namesPart] = String(result.evidence.output).split("\n---NAMES---\n");
    // The effective inputs are the authored literal (scope: all) plus the
    // untouched default (strict: true) — canonical JSON, sorted keys.
    expect(jsonPart).toBe(canonicalInputJson({ scope: "all", strict: true }));

    const names = (namesPart ?? "").split("\n").filter((n) => n.length > 0);
    expect(names).toContain("AKM_TASK_INPUTS");
    // The roster is closed and enumerable: never one var per input.
    expect(names.some((n) => /^AKM_TASK_INPUT_/.test(n))).toBe(false);
  });

  test("a script-target (uses: scripts/<ref>) task receives the identical AKM_TASK_INPUTS delivery (B-36)", async () => {
    write(
      "scripts/echo-inputs.sh",
      ["#!/bin/sh", "printf '%s' \"$AKM_TASK_INPUTS\"", "printf '\\n---NAMES---\\n'", "env | cut -d= -f1", ""].join(
        "\n",
      ),
    );
    write(
      "tasks/script-echo.yml",
      [
        "version: 4",
        "name: Script echo",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: changed",
        "uses: scripts/echo-inputs.sh",
        "",
      ].join("\n"),
    );
    writeWorkflow(
      "script-delivery",
      ["      - id: dispatch", "        uses: tasks/script-echo", "        with:", "          scope: all"].join("\n"),
    );

    const { runId, step } = await firstStep("workflows/script-delivery");
    const result: StepExecutionResult = await executeFrozenStepPlan(step, {
      runId,
      workflowRef: "workflows/script-delivery",
      params: {},
      evidence: {},
      workDir,
    });

    expect(result.ok).toBe(true);
    const [jsonPart, namesPart] = String(result.evidence.output).split("\n---NAMES---\n");
    expect(jsonPart).toBe(canonicalInputJson({ scope: "all" }));
    const names = (namesPart ?? "").split("\n").filter((n) => n.length > 0);
    expect(names).toContain("AKM_TASK_INPUTS");
    expect(names.some((n) => /^AKM_TASK_INPUT_/.test(n))).toBe(false);
  });
});

// ── B-37 — the spawn-boundary size guard covers AKM_TASK_INPUTS too ────────

describe("oversized effective inputs fail exec_context_too_large at the spawn boundary, before spawn (B-37, B-N1)", () => {
  test("a literal input whose canonical JSON exceeds THIS platform's per-variable ceiling fails naming AKM_TASK_INPUTS, its size, and the platform limit", async () => {
    const LIMITS = execContextLimits();
    // Same idiom as tests/integration/workflows/exec-unit.test.ts's own
    // AKM_INPUTS ceiling test: comfortably past perVarBytes.
    const HUGE = "z".repeat(LIMITS.perVarBytes + 1_000);
    write(
      "tasks/blob-echo.yml",
      ["version: 4", "name: Blob echo", "inputs:", "  blob:", "    type: string", 'run: "true"', "shell: sh", ""].join(
        "\n",
      ),
    );
    writeWorkflow(
      "blob-delivery",
      [
        "      - id: dispatch",
        "        uses: tasks/blob-echo",
        "        with:",
        `          blob: ${JSON.stringify(HUGE)}`,
      ].join("\n"),
    );

    const { runId, step } = await firstStep("workflows/blob-delivery");
    const result: StepExecutionResult = await executeFrozenStepPlan(step, {
      runId,
      workflowRef: "workflows/blob-delivery",
      params: {},
      evidence: {},
      workDir,
    });

    expect(result.ok).toBe(false);
    expect(result.units[0]?.failureReason).toBe("exec_context_too_large");
    const error = result.units[0]?.error ?? "";
    expect(error).toContain("AKM_TASK_INPUTS");
    expect(error).toContain(String(LIMITS.perVarBytes));
    expect(error).toMatch(/\d+ bytes/);
    expect(error).toContain(LIMITS.source);
    // Said BEFORE process creation is attempted — the same actionable-error
    // contract the AKM_INPUTS/AKM_PARAMS/AKM_ITEM ceiling already proves.
    expect(error).toContain("E2BIG");
  }, 30_000);
});

// ── B-38 — command (agent/LLM) targets: the fenced "## Task inputs" block ──

describe("command target — a structured '## Task inputs' fenced JSON block, prose byte-unchanged, never interpolated (B-38, B-N2)", () => {
  test("the assembled prompt carries the resolved inputs as a fenced JSON block; the composed command's authored prose survives byte-exact; the bound value is never spliced into prose", async () => {
    const INSTRUCTIONS = "Echo the composed note for the delivery suite.\n";
    write("commands/echo-note.md", INSTRUCTIONS);
    write(
      "tasks/inputs-command.yml",
      [
        "version: 4",
        "name: Inputs command",
        "inputs:",
        "  note:",
        "    type: string",
        "uses: commands/echo-note",
        "",
      ].join("\n"),
    );
    const MARKER = "DELIVERY-MARKER-f2ac9e7b";
    writeWorkflow(
      "command-inputs",
      [
        "      - id: dispatch",
        "        uses: tasks/inputs-command",
        "        with:",
        `          note: "${MARKER}"`,
      ].join("\n"),
    );

    const { runId, step } = await firstStep("workflows/command-inputs");
    let capturedPrompt: string | undefined;
    const result: StepExecutionResult = await executeFrozenStepPlan(step, {
      runId,
      workflowRef: "workflows/command-inputs",
      params: {},
      evidence: {},
      workDir,
      dispatcher: async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
        capturedPrompt = request.prompt;
        return { ok: true, text: "noted" };
      },
    });

    expect(result.ok).toBe(true);
    if (capturedPrompt === undefined) {
      throw new Error("the injected dispatcher was never invoked — the unit never reached command dispatch");
    }
    const prompt = capturedPrompt;

    // The authored prose is appended byte-exact — never templated.
    expect(prompt).toContain(INSTRUCTIONS);

    // A structured fenced JSON block carries the resolved inputs (spec §4.2
    // quotes this heading/sentence verbatim).
    expect(prompt).toContain("## Task inputs");
    expect(prompt).toContain("The composed task's declared inputs resolved to:");
    expect(prompt).toContain(canonicalInputJson({ note: MARKER }));

    // Never interpolated: the bound value appears strictly at/after the
    // structured block's heading, never spliced into the prose that
    // precedes it.
    const headingIndex = prompt.indexOf("## Task inputs");
    expect(headingIndex).toBeGreaterThan(-1);
    expect(prompt.slice(0, headingIndex)).not.toContain(MARKER);
    expect(prompt.indexOf(MARKER)).toBeGreaterThan(headingIndex);
  });
});

// ── B-40 — workflow targets: effective inputs become the child run's params ─
// This is NOT step composition — it is a v4 TASK whose own target is
// `uses: workflows/<ref>`, run directly via `akm task run` (spec §4.3).

describe("workflow target — a v4 task's effective inputs become the child run's params (B-40)", () => {
  function writeChildWorkflow(): void {
    writeWorkflow("child", ["      - id: work", '        run: "true"', "        shell: sh"].join("\n"));
  }

  function writeDelegateTask(): void {
    write(
      "tasks/delegate.yml",
      [
        "version: 4",
        "name: Delegate",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: changed",
        "uses: workflows/child",
        "",
      ].join("\n"),
    );
  }

  async function paramsOfTheOneChildRun(): Promise<Record<string, unknown> | undefined> {
    const { runs } = await listWorkflowRuns();
    const childRuns = runs.filter((run) => run.workflowRef.includes("child"));
    expect(childRuns).toHaveLength(1);
    return childRuns[0]?.params;
  }

  test("no --scope flag: the declared DEFAULT becomes the child run's params", async () => {
    writeChildWorkflow();
    writeDelegateTask();

    await runCliCapture(["task", "run", "delegate"]);

    expect(await paramsOfTheOneChildRun()).toEqual({ scope: "changed" });
  });

  test("--scope urgent: the supplied FLAG value becomes the child run's params, overriding the default", async () => {
    writeChildWorkflow();
    writeDelegateTask();

    await runCliCapture(["task", "run", "delegate", "--scope", "urgent"]);

    expect(await paramsOfTheOneChildRun()).toEqual({ scope: "urgent" });
  });
});
