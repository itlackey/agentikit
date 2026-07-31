// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-level contract tests for the workflow driver family, pinning the exit
 * code + JSON envelope the module-level suites (run-lease) prove only at the
 * function boundary:
 *
 *   - `akm workflow complete` is refused at the CLI while a LIVE engine lease is
 *     held; the {ok:false} error envelope (exit 2) names the holder so a scripted
 *     driver knows to back off (module coverage: run-lease.test.ts).
 *   - `akm workflow start` surfaces a YAML program's compiler warnings as
 *     non-fatal `warn()` lines on stderr; the run still starts.
 *
 * Driven in-process via `runCliCapture` against per-test isolated storage
 * (`withIsolatedAkmStorage`) — no real agent binary, LLM, git, or subprocess, so
 * the suite stays deterministic, order-independent, and parallel-safe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  // Q-05: `brief`/`report`/`run` are gated behind `experimental.workflowEngine`
  // (off by default). This file's tests exist to pin the driver-protocol CLI
  // envelope contracts, not the gate itself (that is
  // `tests/integration/commands/workflow-engine-gate.test.ts`), so opt in here
  // to keep exercising the same behavior these tests always have.
  writeSandboxConfig({ experimental: { workflowEngine: true } });
});

afterEach(() => storage.cleanup());

/**
 * Write a single-step unified-format workflow (frontmatter graph + `## <id>`
 * body — spec §2.2) into a stash's `workflows/` dir.
 */
function writeSingleStepWorkflow(stashDir: string, name: string): void {
  const file = path.join(stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: Driver CLI test workflow",
      "steps:",
      "  - id: only-step",
      "---",
      "",
      `# ${name}`,
      "",
      "## only-step",
      "",
      "Do the watched thing.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe("akm workflow complete — refused while a live engine lease is held (CLI envelope)", () => {
  test("the {ok:false} error envelope names the holder and exits 2", async () => {
    writeSingleStepWorkflow(storage.stashDir, "lease-block");
    const started = await startWorkflowRun("workflows/lease-block", {});
    const runId = started.run.id;

    // Plant a LIVE engine lease directly (simulates an engine driving the run).
    await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(runId, "engine-XYZ", isoIn(90_000), new Date().toISOString())).toBe(true);
    });

    const { code, stderr } = await runCliCapture([
      "workflow",
      "complete",
      runId,
      "--step",
      "only-step",
      "--summary",
      "Tried to complete it by hand while the engine drives.",
    ]);

    expect(code).toBe(2);
    const env = JSON.parse(stderr) as { ok: boolean; error: string };
    expect(env.ok).toBe(false);
    expect(env.error).toContain("engine-XYZ");
    expect(env.error).toMatch(/being driven by engine|run lease/);

    // The refusal did not advance the step — it is still the current step.
    const { stdout } = await runCliCapture(["workflow", "status", runId]);
    const status = JSON.parse(stdout) as { run: { currentStepId: string; status: string } };
    expect(status.run.currentStepId).toBe("only-step");
    expect(status.run.status).toBe("active");
  });
});

describe("akm workflow refs — unknown bundles fail consistently", () => {
  test("start, next, list, status, and brief return the usage envelope", async () => {
    const commands = [
      ["workflow", "start", "ghost//missing"],
      ["workflow", "next", "ghost//missing"],
      ["workflow", "list", "--ref", "ghost//missing"],
      ["workflow", "status", "ghost//missing"],
      ["workflow", "brief", "ghost//missing"],
    ];
    for (const command of commands) {
      const result = await runCliCapture([...command]);
      expect(result.code, `${command.join(" ")}: ${result.stderr}`).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    }
  });
});

describe("akm workflow start — surfaces program warnings on stderr", () => {
  /**
   * Write a unified-format workflow that trips both non-fatal warnings
   * (`collectWorkflowWarnings`, ir/compile.ts): a map step with no `output:`
   * schema (untyped-artifact warning), whose `map.over` references
   * `params.changed_file` — a typo of the declared `params.changed_files` —
   * (undeclared-param warning). Prose is never scanned for references
   * (spec §2.3), so this warning's only surface now is `map.over`/
   * `route.input`.
   */
  function writeWarnyProgram(stashDir: string, name: string): string {
    const file = path.join(stashDir, "workflows", `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "---",
        "type: workflow",
        "description: Warny driver workflow",
        "params:",
        "  changed_files: { type: array }",
        "steps:",
        "  - id: review",
        "    map:",
        "      over: params.changed_file",
        "---",
        "",
        "## review",
        "",
        "Review the changed files given by the map item.",
        "",
      ].join("\n"),
      "utf8",
    );
    return file;
  }

  test("workflow start emits the program's warnings as non-fatal warn() lines (stderr)", async () => {
    writeWarnyProgram(storage.stashDir, "warny-start");
    const captured: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") captured.push(args.map((a) => String(a)).join(" "));
      },
      async () => {
        const started = await startWorkflowRun("workflows/warny-start");
        // Non-fatal: the run still starts.
        expect(started.run.status).toBe("active");
      },
    );
    const joined = captured.join("\n");
    expect(joined).toMatch(/workflow start:.*no `output:` schema/);
    expect(joined).toMatch(/workflow start:.*params\.changed_file.*not declared/);
  });
});
