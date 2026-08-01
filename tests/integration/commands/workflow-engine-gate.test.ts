// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Q-05 — the `experimental.workflowEngine` external-driver gate at the CLI
 * boundary. `workflow run` is canonical and ungated; `brief`/`report` refuse
 * with `WORKFLOW_ENGINE_NOT_ENABLED` while the key is off and operate normally
 * when it is on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { WORKFLOW_ENGINE_CONFIG_KEY } from "../../../src/workflows/exec/workflow-engine-gate";
import { completeWorkflowStep, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  // Every scenario here needs a resolvable default engine so `startWorkflowRun`
  // can freeze the plan at all (a prerequisite unrelated to this gate); the
  // per-describe-block beforeEach layers the gate-specific config on top.
  writeWorkflowTestConfig();
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => storage.cleanup());

/**
 * Write a single-step unified-format workflow (frontmatter graph + `## <id>`
 * body — workflow-format-unification spec §2.2) into the sandboxed stash.
 */
function writeSingleStepWorkflow(name: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: Gate test workflow",
      "steps:",
      "  - id: only-step",
      "---",
      "",
      `# ${name}`,
      "",
      "## only-step",
      "",
      "Do the gated thing.",
      "",
    ].join("\n"),
    "utf8",
  );
}

interface ErrorEnvelope {
  ok: boolean;
  code: string;
  error: string;
}

describe("akm workflow — experimental.workflowEngine gate OFF (default)", () => {
  test("`workflow run` is canonical and no longer requires the experimental opt-in", async () => {
    writeSingleStepWorkflow("gated-run");
    const started = await startWorkflowRun("workflows/gated-run", {});
    await completeWorkflowStep({
      runId: started.run.id,
      stepId: "only-step",
      status: "completed",
      summary: "Completed before the no-op run assertion.",
    });

    const { code, stdout } = await runCliCapture(["workflow", "run", started.run.id]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ done: true, run: { status: "completed" } });
  });

  test("`workflow brief` refuses with the same error shape", async () => {
    writeSingleStepWorkflow("gated-brief");
    const started = await startWorkflowRun("workflows/gated-brief", {});

    const { code, stderr } = await runCliCapture(["workflow", "brief", started.run.id]);
    expect(code).toBe(78);
    const env = JSON.parse(stderr) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_ENGINE_NOT_ENABLED");
    expect(env.error).toContain(WORKFLOW_ENGINE_CONFIG_KEY);
  });

  test("`workflow report --settle` refuses with the same error shape", async () => {
    writeSingleStepWorkflow("gated-report");
    const started = await startWorkflowRun("workflows/gated-report", {});

    const { code, stderr } = await runCliCapture(["workflow", "report", started.run.id, "--settle"]);
    expect(code).toBe(78);
    const env = JSON.parse(stderr) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_ENGINE_NOT_ENABLED");
    expect(env.error).toContain(WORKFLOW_ENGINE_CONFIG_KEY);
  });

  // workflow-format-unification (spec §3): the YAML workflow *program* is
  // deleted as a distinct on-disk format, so `create <name>.yaml` is no
  // longer a gated surface at all — it is now a plain, always-on usage error
  // regardless of `experimental.workflowEngine`. Pinned below (gate-independent).
  test("`workflow create <name>.yaml` refuses unconditionally: workflows are markdown-only now", async () => {
    const { code, stderr } = await runCliCapture(["workflow", "create", "gated-program.yaml"]);
    expect(code).toBe(2);
    const env = JSON.parse(stderr) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error).toContain("markdown-only");
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "gated-program.yaml"))).toBe(false);
  });
});

describe("akm workflow — stable surfaces are not gated by experimental.workflowEngine", () => {
  test("`workflow create <name>.md` (markdown, the default) is unaffected", async () => {
    const { code, stdout } = await runCliCapture(["workflow", "create", "ungated-md"]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; ref: string };
    expect(env.ok).toBe(true);
    expect(env.ref).toContain("workflows/ungated-md");
  });

  test("`workflow status` remains ungated", async () => {
    writeSingleStepWorkflow("ungated-manual");
    const started = await startWorkflowRun("workflows/ungated-manual");

    const status = await runCliCapture(["workflow", "status", started.run.id]);
    expect(status.code).toBe(0);
  });
});

describe("akm workflow — experimental.workflowEngine gate ON", () => {
  beforeEach(() => {
    writeSandboxConfig({ experimental: { workflowEngine: true } });
  });

  // Opting into the gate does NOT resurrect the deleted YAML-program format —
  // `create <name>.yaml` still refuses (workflow-format-unification, spec §3).
  test("`workflow create <name>.yaml` still refuses even with the gate opted in", async () => {
    const { code, stderr } = await runCliCapture(["workflow", "create", "opted-in-program.yaml"]);
    expect(code).toBe(2);
    const env = JSON.parse(stderr) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error).toContain("markdown-only");
  });

  test("`workflow brief` runs past the gate and returns the driver-protocol brief", async () => {
    writeSingleStepWorkflow("opted-in-brief");
    const started = await startWorkflowRun("workflows/opted-in-brief", {});

    const { code, stdout } = await runCliCapture(["workflow", "brief", started.run.id]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { ok: boolean }).ok).toBe(true);
  });

  test("`akm config set experimental.workflowEngine true` resolves against the schema (not `Unknown config key`)", async () => {
    const set = await runCliCapture(["config", "set", "experimental.workflowEngine", "true"]);
    expect(set.code).toBe(0);

    const get = await runCliCapture(["config", "get", "experimental.workflowEngine"]);
    expect(get.code).toBe(0);
  });
});
