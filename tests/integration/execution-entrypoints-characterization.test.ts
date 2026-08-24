import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { planTaskToV3File } from "../../scripts/akm-migrate/migrate/task-to-v3";
import { akmAgentDispatch } from "../../src/commands/agent/agent-dispatch";
import { parseRefInput } from "../../src/core/asset/resolve-ref";
import type { AkmConfig } from "../../src/core/config/config";
import type { SpawnedSubprocess, SpawnFn } from "../../src/core/subprocess";
import { akmIndex, lookup } from "../../src/indexer/indexer";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
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
const DIRECT_CAPTURE_HELPER = path.join(import.meta.dir, "../_helpers/capture-agent-dispatch.ts");

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
    defaultBundle: "stash",
    bundles: {
      stash: {
        path: storage.stashDir,
        components: { main: { root: ".", adapter: "akm" } },
      },
    },
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
      "fixture-llm": {
        kind: "llm",
        provider: "openai-compatible",
        endpoint: "https://fixture.invalid/v1/chat/completions",
        model: "fixture-base-model",
        timeoutMs: 60_000,
      },
    },
    defaults: { engine: "fixture-agent", llmEngine: "fixture-llm" },
  };
}

function installFixture(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function installMigratedTaskFixture(source: string, destination: string): void {
  const outcome = planTaskToV3File({
    filePath: source,
    bytes: fs.readFileSync(source),
    mode: 0o600,
    writable: true,
  });
  expect(outcome.status, outcome.detail).toBe("changed");
  if (outcome.status !== "changed") throw new Error(outcome.detail ?? outcome.reason);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, outcome.after);
}

interface DirectDispatchCapture {
  runner: Extract<RunnerSpec, { kind: "agent" | "sdk" }>;
  prompt: string;
  options: RunAgentOptions;
  result: {
    ok: boolean;
    engine: string;
    stdout: string;
  };
}

async function captureDirectAgentDispatch(options: Record<string, unknown>): Promise<DirectDispatchCapture> {
  const child = Bun.spawn([process.execPath, DIRECT_CAPTURE_HELPER, JSON.stringify(options)], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as DirectDispatchCapture;
}

function completedSubprocess(stdout = "completed\n"): SpawnedSubprocess {
  return {
    exitCode: 0,
    exited: Promise.resolve(0),
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    kill() {},
  };
}

describe("current execution entry points projected onto one test-only request shape", () => {
  test("direct agent, task prompt, and workflow freeze agree on their currently shared resolved subset", async () => {
    const config = fixtureConfig();
    writeSandboxConfig(config);

    const taskSource = path.join(TASK_ROOT, "deterministic/prompt-inline-agent.yml");
    installMigratedTaskFixture(taskSource, path.join(storage.stashDir, "tasks/equivalent.yml"));

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

    const directCapture = await captureDirectAgentDispatch({
      engine: "fixture-agent",
      prompt: PROMPT,
      dispatch: { prompt: PROMPT, model: "fixture-exact-model", modelIsExact: true },
    });
    const direct = projectCurrentRunnerRequestForTest({
      runner: directCapture.runner,
      prompt: directCapture.prompt,
      dispatch: directCapture.options.dispatch,
      timeoutMs: directCapture.options.timeoutMs,
      workspace: directCapture.options.cwd,
      environment: directCapture.options.env,
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
    expect(directCapture.result).toMatchObject({ ok: true, engine: "fixture-agent", stdout: "captured-direct" });
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

  test("direct agent --workflow refuses to flatten workflow IR into anonymous prompt content", async () => {
    await expect(
      akmAgentDispatch({
        engine: "fixture-agent",
        workflowRef: "workflows/current-agent-unit",
        args: ["must-not-be-substituted"],
        agentConfig: fixtureConfig(),
      }),
    ).rejects.toThrow(/akm workflow run|cannot be flattened/i);
  });

  test("task command, workflow, and direct-LLM targets reach their production injection seams", async () => {
    writeSandboxConfig(fixtureConfig());
    for (const id of ["command-string", "workflow-ref-full", "prompt-inline-full"]) {
      installMigratedTaskFixture(
        path.join(TASK_ROOT, `deterministic/${id}.yml`),
        path.join(storage.stashDir, `tasks/${id}.yml`),
      );
    }
    installFixture(
      path.join(WORKFLOW_ROOT, "current/agent-unit.md"),
      path.join(storage.stashDir, "workflows/contract-review.md"),
    );

    let commandCapture: { cmd: string[]; options: Parameters<SpawnFn>[1] } | undefined;
    const commandSpawn: SpawnFn = (cmd, options) => {
      commandCapture = { cmd, options };
      return completedSubprocess("indexed\n");
    };
    const commandResult = await runTask("command-string", {
      stashDir: storage.stashDir,
      logDir: path.join(storage.root, "task-logs"),
      now: NOW,
      spawnFn: commandSpawn,
    });
    expect(commandResult).toMatchObject({
      status: "completed",
      target: { kind: "command" },
    });
    expect(commandCapture?.cmd).toEqual(["sh", "-c", "akm index --full"]);
    expect(commandCapture?.options).toMatchObject({
      cwd: storage.stashDir,
      detached: true,
      env: { AKM_EVENT_SOURCE: "task" },
    });

    let workflowCapture: Record<string, unknown> | undefined;
    const workflowResult = await runTask("workflow-ref-full", {
      stashDir: storage.stashDir,
      logDir: path.join(storage.root, "task-logs"),
      now: NOW,
      runWorkflowStepsImpl: (async (input: Record<string, unknown>) => {
        workflowCapture = input;
        return {
          run: {
            id: "fixture-workflow-run",
            workflowRef: String(input.target),
            workflowTitle: "Contract review",
            status: "completed",
            currentStepId: null,
            createdAt: NOW().toISOString(),
            updatedAt: NOW().toISOString(),
            completedAt: NOW().toISOString(),
            params: input.params as Record<string, unknown>,
          },
          executed: [],
          done: true,
        };
      }) as never,
    });
    expect(workflowResult).toMatchObject({
      status: "completed",
      target: { kind: "workflow", ref: "stash//workflows/contract-review" },
    });
    expect(workflowCapture).toMatchObject({
      target: "stash//workflows/contract-review",
      params: { target: "packages/core", strict: true },
      maxSteps: 8,
      maxRetries: 2,
    });
    expect((workflowCapture?.signal as AbortSignal).aborted).toBe(false);

    let llmCapture:
      | {
          connection: Record<string, unknown>;
          messages: unknown[];
          options: unknown;
        }
      | undefined;
    const llmResult = await runTask("prompt-inline-full", {
      stashDir: storage.stashDir,
      logDir: path.join(storage.root, "task-logs"),
      now: NOW,
      chatCompletionImpl: async (connection, messages, options) => {
        llmCapture = { connection, messages, options: options ?? {} };
        return "contract-reviewed";
      },
    });
    expect(llmResult).toMatchObject({
      status: "completed",
      target: { kind: "prompt", engine: "fixture-llm" },
    });
    expect(llmCapture).toEqual({
      connection: {
        provider: "openai-compatible",
        endpoint: "https://fixture.invalid/v1/chat/completions",
        model: "fixture-exact-model",
        temperature: 0,
        maxTokens: 256,
        supportsJsonSchema: false,
        extraParams: { seed: 7 },
        contextLength: 4096,
        enableThinking: false,
        timeoutMs: 45_000,
      },
      messages: [
        {
          role: "user",
          content: "Review the execution contract.\nReturn the literal marker contract-reviewed.",
        },
      ],
      options: { timeoutMs: 45_000 },
    });
  });

  test("current workflow unit schema is retained by the normalized projection", () => {
    const source = path.join(WORKFLOW_ROOT, "current/agent-unit-schema.md");
    const plan = freezeWorkflow(
      fs.readFileSync(source, "utf8"),
      "workflows/current-agent-unit-schema.md",
      fixtureConfig(),
    );
    expect(projectCurrentWorkflowUnitForTest(plan, "review").schema).toEqual({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    });
  });

  test("configured Claude and OpenCode roots remain byte-exact when indexed in place", async () => {
    const claudeRoot = path.join(NATIVE_ROOT, "claude");
    const opencodeRoot = path.join(NATIVE_ROOT, "opencode");
    writeSandboxConfig({
      ...fixtureConfig(),
      bundles: {
        "fixture-claude": {
          path: claudeRoot,
          components: { native: { root: ".", adapter: "claude", writable: false } },
        },
        "fixture-opencode": {
          path: opencodeRoot,
          components: { native: { root: ".", adapter: "opencode", writable: false } },
        },
      },
      defaultBundle: "fixture-claude",
    });
    const claudeBytes = captureFixtureBytes(claudeRoot);
    const opencodeBytes = captureFixtureBytes(opencodeRoot);

    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect((await lookup(parseRefInput("fixture-claude//agents/contract-reviewer")))?.adapterId).toBe("claude");
    expect((await lookup(parseRefInput("fixture-opencode//agents/contract-reviewer")))?.adapterId).toBe("opencode");

    assertFixtureBytesUnchanged(claudeRoot, claudeBytes);
    assertFixtureBytesUnchanged(opencodeRoot, opencodeBytes);
  });
});

describe("WP3 authorization boundary", () => {
  test("an agent asset cannot authorize its own nonempty tool selection", async () => {
    const base = fixtureConfig();
    const config: AkmConfig = {
      ...base,
      engines: {
        ...base.engines,
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
    const installedBytes = captureFixtureBytes(storage.stashDir);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const cli = await runCliCapture(["agent", "agents/contract-reviewer", "--prompt", PROMPT, "--format=json", "-q"]);
    expect(cli.code).toBe(78);
    expect(cli.stdout).toBe("");
    expect(JSON.parse(cli.stderr)).toMatchObject({
      ok: false,
      code: "EXECUTION_NOT_AUTHORIZED",
      hint: expect.stringMatching(/policy|selected tools/i),
    });
    assertFixtureBytesUnchanged(NATIVE_ROOT, fixtureBytes);
    assertFixtureBytesUnchanged(storage.stashDir, installedBytes);
  });
});

describe("WP4 command compatibility boundary", () => {
  test("direct --command delegates to adapter rendering and rejects unsupported native placeholders", async () => {
    const config = fixtureConfig();
    const source = path.join(NATIVE_ROOT, "akm/commands/contract-review.md");
    const fixtureBytes = captureFixtureBytes(NATIVE_ROOT);
    const destination = path.join(storage.stashDir, "commands/contract-review.md");
    installFixture(source, destination);
    const installedBytes = captureFixtureBytes(storage.stashDir);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    await expect(
      akmAgentDispatch({
        engine: "fixture-agent",
        commandRef: "commands/contract-review",
        argumentInput: "fixture-target",
        agentConfig: config,
      }),
    ).rejects.toThrow(/unsupported portable template construct/i);
    assertFixtureBytesUnchanged(NATIVE_ROOT, fixtureBytes);
    assertFixtureBytesUnchanged(storage.stashDir, installedBytes);
  });
});

describe("retired task-v2 execution observations", () => {
  test("an agent-shaped v2 prompt ref is migration-only and blocks instead of becoming command work", () => {
    const fixtureBytes = captureFixtureBytes(NATIVE_ROOT);
    const source = path.join(TASK_ROOT, "blocked/prompt-agent-ref.yml");
    const outcome = planTaskToV3File({
      filePath: source,
      bytes: fs.readFileSync(source),
      mode: 0o600,
      writable: true,
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "agent-ref-has-persona-but-no-command-work",
    });
    assertFixtureBytesUnchanged(NATIVE_ROOT, fixtureBytes);
  });
});
