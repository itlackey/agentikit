import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAgentDispatch } from "../../src/commands/agent/agent-dispatch";
import type { AkmConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { RunAgentOptions } from "../../src/integrations/agent/spawn";
import { runTask } from "../../src/tasks/runner";
import { runCliCapture } from "../_helpers/cli";
import {
  assertFixtureBytesUnchanged,
  canonicalResolvedRequestForTest,
  captureFixtureBytes,
  EXECUTION_CONTRACT_FIXTURES,
  projectCurrentRunnerRequestForTest,
  projectCurrentWorkflowUnitForTest,
  runnerFromCapturedProfile,
} from "../_helpers/execution-contracts";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { freezeWorkflow } from "../_helpers/workflow";

const NATIVE_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "native");
const TASK_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "tasks/v2");
const WORKFLOW_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "workflows");
const PROMPT = "Review the execution contract.";
const NOW = () => new Date("2026-08-19T12:00:00.000Z");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function fixtureConfig(): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: {
      "fixture-agent": {
        kind: "agent",
        platform: "aider",
        bin: "/bin/echo",
        args: [],
        workspace: storage.stashDir,
        model: "fixture-default-model",
        timeoutMs: 45_000,
      },
    },
    defaults: { engine: "fixture-agent" },
  };
}

function installFixture(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

describe("current execution entry points projected onto one test-only request shape", () => {
  test("direct agent, task prompt, and workflow freeze agree on their currently shared resolved subset", async () => {
    const config = fixtureConfig();
    writeSandboxConfig(config);

    const taskSource = path.join(TASK_ROOT, "deterministic/prompt-inline-agent.yml");
    installFixture(taskSource, path.join(storage.stashDir, "tasks/equivalent.yml"));

    let capturedProfile: AgentProfile | undefined;
    let capturedPrompt: string | undefined;
    let capturedOptions: RunAgentOptions | undefined;
    const taskResult = await runTask("equivalent", {
      stashDir: storage.stashDir,
      logDir: path.join(storage.root, "task-logs"),
      now: NOW,
      runAgentImpl: async (profile, prompt, options) => {
        capturedProfile = profile;
        capturedPrompt = prompt;
        capturedOptions = options;
        return { ok: true, exitCode: 0, stdout: "reviewed", stderr: "", durationMs: 1 };
      },
    });
    expect(taskResult.status).toBe("completed");
    if (!capturedProfile || capturedPrompt === undefined || !capturedOptions) {
      throw new Error("task prompt did not reach the captured runner seam");
    }

    const directRunner = resolveEngine("fixture-agent", config);
    if (directRunner.kind === "llm") throw new Error("fixture-agent must lower to an agent runner");
    const direct = projectCurrentRunnerRequestForTest({
      runner: directRunner,
      prompt: PROMPT,
      dispatch: { prompt: PROMPT, model: "fixture-exact-model", modelIsExact: true },
    });
    const task = projectCurrentRunnerRequestForTest({
      runner: runnerFromCapturedProfile("fixture-agent", capturedProfile, capturedOptions.timeoutMs ?? null),
      prompt: capturedPrompt,
      workspace: capturedOptions.cwd,
    });

    const workflowSource = path.join(WORKFLOW_ROOT, "current/agent-unit.md");
    const workflowPlan = freezeWorkflow(
      fs.readFileSync(workflowSource, "utf8"),
      "workflows/current-agent-unit.md",
      config,
    );
    const workflow = projectCurrentWorkflowUnitForTest(workflowPlan, "review");

    const directBytes = canonicalResolvedRequestForTest(direct);
    expect(canonicalResolvedRequestForTest(task)).toBe(directBytes);
    expect(canonicalResolvedRequestForTest(workflow)).toBe(directBytes);
    expect(JSON.parse(directBytes)).toMatchObject({
      command: { content: PROMPT },
      engine: { name: "fixture-agent", kind: "agent", platform: "aider" },
      model: "fixture-exact-model",
      timeoutMs: 45_000,
      workspace: storage.stashDir,
    });
  });
});

describe("explicitly non-normative 0.9.1 observations", () => {
  test("direct agent assets currently supply the CLI system prompt, model hint, and tool policy", async () => {
    const base = fixtureConfig();
    const config: AkmConfig = {
      ...base,
      engines: {
        "fixture-agent": {
          ...base.engines?.["fixture-agent"],
          kind: "agent",
          platform: "claude",
          bin: "/bin/echo",
          args: [],
        },
      },
    };
    writeSandboxConfig(config);
    const fixtureBytes = captureFixtureBytes(NATIVE_ROOT);
    const agentSource = path.join(NATIVE_ROOT, "akm/agents/contract-reviewer.md");
    installFixture(agentSource, path.join(storage.stashDir, "agents/contract-reviewer.md"));
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const cli = await runCliCapture(["agent", "agents/contract-reviewer", "--prompt", PROMPT, "--format=json", "-q"]);
    expect(cli.code).toBe(0);
    const result = JSON.parse(cli.stdout) as { ok: boolean; stdout: string };
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("--system-prompt");
    expect(result.stdout).toContain("Review the requested change without modifying files.");
    expect(result.stdout).toContain("--model fixture-balanced");
    expect(result.stdout).toContain("--allowedTools read,grep");
    expect(result.stdout).toContain(PROMPT);
    expect(result.stdout).not.toContain("type: agent");
    assertFixtureBytesUnchanged(NATIVE_ROOT, fixtureBytes);
  });

  test("direct --command dispatch currently reads raw bytes and fills only legacy {{N}} placeholders", async () => {
    const config = fixtureConfig();
    const source = path.join(NATIVE_ROOT, "akm/commands/contract-review.md");
    const fixtureBytes = captureFixtureBytes(NATIVE_ROOT);
    const destination = path.join(storage.stashDir, "commands/contract-review.md");
    installFixture(source, destination);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await akmAgentDispatch({
      engine: "fixture-agent",
      commandRef: "commands/contract-review",
      args: ["fixture-target"],
      agentConfig: config,
    });
    const currentPrompt = fs.readFileSync(source, "utf8").replaceAll("{{0}}", "fixture-target");

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(`${currentPrompt}\n`);
    expect(result.stdout).toStartWith("---\n");
    expect(result.stdout).toContain("$ARGUMENTS");
    expect(result.stdout).toContain("$1");
    expect(result.stdout).not.toContain("{{0}}");
    assertFixtureBytesUnchanged(NATIVE_ROOT, fixtureBytes);
  });

  test("task prompt assets currently become raw prompt text, not an agent persona", async () => {
    const config = fixtureConfig();
    writeSandboxConfig(config);
    const fixtureBytes = captureFixtureBytes(NATIVE_ROOT);
    const agentSource = path.join(NATIVE_ROOT, "akm/agents/contract-reviewer.md");
    installFixture(agentSource, path.join(storage.stashDir, "agents/contract-reviewer.md"));
    installFixture(
      path.join(TASK_ROOT, "blocked/prompt-agent-ref.yml"),
      path.join(storage.stashDir, "tasks/prompt-agent-ref.yml"),
    );

    let capturedPrompt = "";
    const result = await runTask("prompt-agent-ref", {
      stashDir: storage.stashDir,
      logDir: path.join(storage.root, "task-logs"),
      now: NOW,
      runAgentImpl: async (_profile, prompt) => {
        capturedPrompt = prompt;
        return { ok: true, exitCode: 0, stdout: "reviewed", stderr: "", durationMs: 1 };
      },
    });

    expect(result.status).toBe("completed");
    expect(capturedPrompt).toBe(fs.readFileSync(agentSource, "utf8"));
    expect(capturedPrompt).toStartWith("---\n");
    expect(capturedPrompt).toContain("type: agent");
    assertFixtureBytesUnchanged(NATIVE_ROOT, fixtureBytes);
  });
});
