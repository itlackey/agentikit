// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue 2 — `resolveJudge` (src/workflows/freeze/resolve-steps.ts) used to
 * hard-require `workflow.judgeEngine`, so akm's own `workflow create`
 * scaffold (which ships a `### gate`) failed `workflow run` on ANY install
 * that had not explicitly set that key — even one with a perfectly usable
 * `defaults.engine`. Fixed to fall back to the same default-engine
 * resolution the freeze pass already applies to ordinary unit targets, and —
 * only when NO engine resolves anywhere — to freeze `frozenJudge: null`
 * rather than refusing to freeze at all, deferring to the runtime's existing
 * graceful block instead of erroring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { compileResolveFreezeWorkflowV4 } from "../../../src/workflows/ir/freeze-v4";
import { getWorkflowStatus, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
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

/** A one-step workflow whose step declares completion criteria via `### gate`. */
const GATED_WORKFLOW = [
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
  "- Confirm the work is done.",
  "",
].join("\n");

/**
 * Same shape, but `work` is an `exec:` unit — no engine at all. Isolates the
 * gate's judge resolution from ordinary unit-target resolution, which (unlike
 * the judge before this fix) has always tolerated an engine-less install for
 * exec-only steps.
 */
const GATED_EXEC_WORKFLOW = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "    unit:",
  '      exec: { command: ["true"] }',
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
  "### gate",
  "",
  "- Confirm the work is done.",
  "",
].join("\n");

describe("resolveJudge falls back to the default engine when workflow.judgeEngine is unset", () => {
  test("a configured defaults.engine is used for the gate's judge", async () => {
    writeSandboxConfig({
      engines: { reviewer: { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test-model" } },
      defaults: { engine: "reviewer" },
      // No workflow.judgeEngine.
    });
    resetConfigCache();
    write("workflows/gated.md", GATED_WORKFLOW);

    const asset = await loadWorkflowAsset("workflows/gated");
    const frozen = await compileResolveFreezeWorkflowV4(asset, loadConfig());
    const step = frozen.plan.steps.find((s) => s.stepId === "work");
    expect(step?.gate.criteria.length).toBeGreaterThan(0);
    expect(step?.gate.frozenJudge).not.toBeNull();
    expect(step?.gate.frozenJudge?.request.engine.name).toBe("reviewer");
  });
});

describe("resolveJudge freezes frozenJudge: null (never refuses) when no engine resolves anywhere", () => {
  test("freezing a gated workflow succeeds and warns instead of throwing", async () => {
    // No workflow.judgeEngine, no defaults.engine, no engines at all — and no
    // opencode-sdk binary on PATH in this sandbox, so nothing resolves.
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);

    const warnCalls: string[] = [];
    const asset = await loadWorkflowAsset("workflows/gated");
    const frozen = await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      },
      () => compileResolveFreezeWorkflowV4(asset, loadConfig()),
    );

    const step = frozen.plan.steps.find((s) => s.stepId === "work");
    expect(step?.gate.criteria.length).toBeGreaterThan(0);
    expect(step?.gate.frozenJudge).toBeNull();
    expect(warnCalls.some((w) => w.includes("no verification engine is available"))).toBe(true);
  });

  test("end to end: `workflow create` + `workflow run` no longer fails outright on a default install — the run blocks gracefully at the gate instead", async () => {
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);

    // This alone reproduces the original bug: freezing used to throw
    // INVALID_CONFIG_FILE here, before a run could even be created.
    const started = await startWorkflowRun("workflows/gated");
    expect(started.run.status).toBe("active");

    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => ({ ok: true, text: "did the work" }),
      summaryJudge: null,
    });

    // Never a thrown ConfigError: the unit dispatched and journaled fine (no
    // engine was needed for it), and the step blocks on the GATE alone —
    // naming the missing judge, consuming no gate loop, preserving the
    // journaled unit for `akm workflow resume`.
    expect(result.run.status).toBe("blocked");
    expect(result.judgeFailure?.stepId).toBe("work");
    expect(result.judgeFailure?.message).toContain("no verification judge is available");
    const status = await getWorkflowStatus(started.run.id);
    expect(status.run.status).toBe("blocked");
    expect(status.workflow.steps[0]?.status).toBe("blocked");
    // The exec unit's result is preserved — resuming re-evaluates the gate,
    // it does not re-dispatch (and re-pay for) the unit.
    expect(status.workflow.steps[0]?.evidence?.output).toBe("did the work");
  }, 30_000);
});
