// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Q-05 — the `experimental.workflowEngine` gate at the CLI boundary.
 *
 * Before Q-05 the workflow-engine dispatch (`akm workflow run`/`brief`/
 * `report`, and creating a YAML workflow *program*) ran
 * unconditionally: STABILITY.md documented `experimental.workflowEngine`, but
 * it was absent from the config schema and read nowhere in the runtime.
 * Because the top-level config schema is `.passthrough()`, setting the key
 * was silently accepted and inert — exactly the silent no-op the
 * release-review ruling forbids.
 *
 * These pin, at the actual CLI boundary (`runCliCapture`, in-process citty
 * dispatch — see `tests/_helpers/cli.ts`):
 *   - gate OFF (the default): every gated surface REFUSES outright — a
 *     classified `WORKFLOW_ENGINE_NOT_ENABLED` error naming the exact config
 *     key, which the CLI's JSON error envelope always routes to stderr with a
 *     non-zero exit (never a silent no-op);
 *   - the classic linear-markdown workflow contract is untouched either way;
 *   - gate ON: the same surfaces run normally, and the dotted `config set`
 *     path actually resolves (it is no longer an unregistered key).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { WORKFLOW_ENGINE_CONFIG_KEY } from "../../../src/workflows/exec/workflow-engine-gate";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
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
  test("`workflow run` refuses outright: exits 78 naming the config key", async () => {
    writeSingleStepWorkflow("gated-run");
    const started = await startWorkflowRun("workflows/gated-run", {});

    const { code, stderr } = await runCliCapture(["workflow", "run", started.run.id]);

    expect(code).toBe(78);
    const env = JSON.parse(stderr) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_ENGINE_NOT_ENABLED");
    expect(env.error).toContain(WORKFLOW_ENGINE_CONFIG_KEY);
    expect(env.error).toContain("akm workflow run");
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

describe("akm workflow — surfaces NOT gated by experimental.workflowEngine", () => {
  test("`workflow create <name>.md` (markdown, the default) is unaffected", async () => {
    const { code, stdout } = await runCliCapture(["workflow", "create", "ungated-md"]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; ref: string };
    expect(env.ok).toBe(true);
    expect(env.ref).toContain("workflows/ungated-md");
  });

  test("`workflow start`/`status` (the classic manual contract) are unaffected", async () => {
    writeSingleStepWorkflow("ungated-manual");
    const started = await runCliCapture(["workflow", "start", "workflows/ungated-manual"]);
    expect(started.code).toBe(0);
    const startedJson = JSON.parse(started.stdout) as { run: { id: string } };

    const status = await runCliCapture(["workflow", "status", startedJson.run.id]);
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
