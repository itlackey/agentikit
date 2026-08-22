// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for WP7's immutable executable projection.
 *
 * These fixtures deliberately keep the older v4 command target readable while
 * pinning the richer shape emitted by every new start. V3 stays a byte-exact
 * compatibility island.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const WORKFLOW_BYTES = "immutable executable workflow\n";
const WORKFLOW_IDENTITY = {
  ref: "fixture//workflows/immutable",
  bundle: "fixture",
  adapter: "akm",
  file: "workflows/immutable.md",
  hash: sha256(WORKFLOW_BYTES),
};

const CWD_IDENTITY = Object.freeze({
  requestedRoot: "/workspace",
  realRoot: "/workspace",
  rootDevice: "7",
  rootInode: "100",
  requestedCwd: "/workspace/project",
  realCwd: "/workspace/project",
  cwdDevice: "7",
  cwdInode: "101",
});

function executableIdentity(requested = "/bin/true") {
  const absolutePath = path.resolve(requested);
  const realPath = fs.realpathSync.native(absolutePath);
  const stat = fs.lstatSync(realPath, { bigint: true });
  return {
    requested,
    absolutePath,
    realPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: Number(stat.size),
    sha256: sha256(fs.readFileSync(realPath)),
  };
}

function sourceSnapshot(identity = WORKFLOW_IDENTITY, ordinal = 1) {
  return {
    identity: structuredClone(identity),
    containmentPhysicalIdentity: `root-device:7/root-inode:${100 + ordinal}`,
    physicalIdentity: `file-device:7/file-inode:${200 + ordinal}`,
    size: identity === WORKFLOW_IDENTITY ? Buffer.byteLength(WORKFLOW_BYTES) : 1,
  };
}

function cwdTarget(overrides: Record<string, unknown> = {}) {
  const content = "Run the immutable request.";
  return {
    kind: "command",
    ref: null,
    contentHash: sha256(content),
    request: {
      schemaVersion: 1,
      command: { template: content, content, source: null },
      engine: { name: "cli", kind: "agent", platform: "claude" },
      authorization: { status: "not-required" },
      runtime: { workspace: "/workspace/project" },
      notices: [],
    },
    runner: {
      kind: "agent",
      engine: "cli",
      profile: {
        name: "cli",
        platform: "claude",
        bin: "/bin/true",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
      timeoutMs: null,
    },
    cwdIdentity: structuredClone(CWD_IDENTITY),
    executable: executableIdentity(),
    ...overrides,
  };
}

function commandPlan(options: { isolation?: "none" | "worktree"; target?: Record<string, unknown> } = {}) {
  const isolation = options.isolation ?? "none";
  const target = options.target ?? cwdTarget(isolation === "worktree" ? { gitCommitOid: "a".repeat(40) } : {});
  return {
    irVersion: 4,
    title: "immutable",
    sourceReadSet: [sourceSnapshot()],
    execution: {
      maxConcurrency: 1,
      engines: {
        cli: {
          name: "cli",
          kind: "agent",
          runnerKind: "agent",
          platform: "claude",
          bin: "/bin/true",
          args: [],
          workspace: "/workspace/project",
          envPassthrough: [],
          commandBuilder: "claude",
          fallbackLlmEngine: null,
        },
      },
    },
    steps: [
      {
        stepId: "run",
        title: "run",
        sequenceIndex: 0,
        root: {
          kind: "unit",
          id: "run",
          instructions: "legacy projection must not regain authority",
          templating: "verbatim",
          invocation: { engine: "cli", model: null, modelPresent: false, timeoutMs: null },
          frozenTarget: target,
          environment: [],
          onError: "fail",
          isolation,
        },
        gate: { kind: "gate", id: "run.gate", stepId: "run", criteria: [], maxLoops: 1, judge: null },
      },
    ],
  };
}

function rootTarget(plan: ReturnType<typeof commandPlan>): Record<string, unknown> {
  return rootUnit(plan).frozenTarget;
}

function rootUnit(plan: ReturnType<typeof commandPlan>) {
  const root = plan.steps[0]?.root;
  if (!root) throw new Error("fixture requires a root");
  return root;
}

describe("durable workflow v4 immutable executable schema", () => {
  test("accepts the exact frozen CLI executable, cwd identity, and worktree commit projection", () => {
    const decoded = decodeWorkflowPlanV4(commandPlan({ isolation: "worktree" }));
    const root = decoded.steps[0]?.root;
    expect(root?.kind).toBe("unit");
    if (!root || root.kind !== "unit" || root.frozenTarget.kind !== "command") return;
    expect(root.frozenTarget).toMatchObject({
      cwdIdentity: CWD_IDENTITY,
      executable: executableIdentity(),
      gitCommitOid: "a".repeat(40),
    });
  });

  test("rejects a bare, relative, or internally inconsistent executable identity", () => {
    const bare = commandPlan();
    rootTarget(bare).executable = { ...executableIdentity(), absolutePath: "true" };
    expect(() => decodeWorkflowPlanV4(bare)).toThrow(/executable|absolute|path/i);

    const escaped = commandPlan();
    rootTarget(escaped).executable = { ...executableIdentity(), realPath: "../true" };
    expect(() => decodeWorkflowPlanV4(escaped)).toThrow(/executable|realPath|absolute|path/i);

    const wrongHash = commandPlan();
    rootTarget(wrongHash).executable = { ...executableIdentity(), sha256: "0".repeat(63) };
    expect(() => decodeWorkflowPlanV4(wrongHash)).toThrow(/executable|sha256|hash|identity/i);
  });

  test("requires a canonical Git OID exactly for worktree-isolated targets", () => {
    const missing = commandPlan({ isolation: "worktree", target: cwdTarget() });
    expect(() => decodeWorkflowPlanV4(missing)).toThrow(/gitCommitOid|git.*oid|worktree/i);

    for (const oid of ["A".repeat(40), "a".repeat(39), "g".repeat(40)]) {
      const invalid = commandPlan({ isolation: "worktree", target: cwdTarget({ gitCommitOid: oid }) });
      expect(() => decodeWorkflowPlanV4(invalid)).toThrow(/gitCommitOid|git.*oid|hex|worktree/i);
    }

    const unnecessary = commandPlan({ target: cwdTarget({ gitCommitOid: "b".repeat(64) }) });
    expect(() => decodeWorkflowPlanV4(unnecessary)).toThrow(/gitCommitOid|git.*oid|isolation|worktree/i);
  });

  test("accepts shell and script executable identities while retaining exact script bytes", () => {
    const shellExec = { command: ["/bin/sh", "-c", "printf shell"], timeoutMs: 30_000 };
    const shellEnvironment: never[] = [];
    const shell = commandPlan();
    shell.execution.engines = {} as never;
    const shellRoot = rootUnit(shell);
    delete (shellRoot as { invocation?: unknown }).invocation;
    (shellRoot as { exec?: unknown }).exec = shellExec;
    shellRoot.environment = shellEnvironment;
    shellRoot.frozenTarget = {
      kind: "shell",
      contentHash: sha256(
        `akm.workflow.shell.v1\0${JSON.stringify({ cwdIdentity: CWD_IDENTITY, environment: shellEnvironment, exec: shellExec })}`,
      ),
      cwdIdentity: structuredClone(CWD_IDENTITY),
      executable: executableIdentity("/bin/sh"),
    };

    // Use the production canonicalizer for the shell hash rather than relying
    // on object insertion order in the fixture above.
    shellRoot.frozenTarget.contentHash = sha256(
      `akm.workflow.shell.v1\0${canonicalJson({ exec: shellExec, environment: shellEnvironment, cwdIdentity: CWD_IDENTITY })}`,
    );
    expect(() => decodeWorkflowPlanV4(shell)).not.toThrow();

    const scriptBytes = Buffer.from("#!/bin/sh\nprintf script\n", "utf8");
    const scriptIdentity = {
      ref: "fixture//scripts/tool.sh",
      bundle: "fixture",
      adapter: "akm",
      file: "scripts/tool.sh",
      hash: sha256(scriptBytes),
    };
    const script = structuredClone(shell);
    script.sourceReadSet = [
      { ...sourceSnapshot(scriptIdentity, 1), size: scriptBytes.byteLength },
      sourceSnapshot(WORKFLOW_IDENTITY, 2),
    ];
    rootUnit(script).frozenTarget = {
      kind: "script",
      ref: scriptIdentity.ref,
      contentHash: sha256(scriptBytes),
      interpreter: "sh",
      extension: ".sh",
      bytesBase64: scriptBytes.toString("base64"),
      byteLength: scriptBytes.byteLength,
      cwdIdentity: structuredClone(CWD_IDENTITY),
      materialization: "ephemeral-0700-delete",
      executable: executableIdentity("/bin/sh"),
    };
    expect(() => decodeWorkflowPlanV4(script)).not.toThrow();
  });

  test("keeps an in-process SDK target free of a host executable requirement", () => {
    const content = "Use the frozen SDK request.";
    const sdk = commandPlan({
      target: {
        kind: "command",
        ref: null,
        contentHash: sha256(content),
        request: {
          schemaVersion: 1,
          command: { template: content, content, source: null },
          engine: { name: "sdk", kind: "sdk", platform: "opencode-sdk" },
          authorization: { status: "not-required" },
          runtime: {},
          notices: [],
        },
        runner: {
          kind: "sdk",
          engine: "sdk",
          profile: {
            name: "sdk",
            platform: "opencode-sdk",
            personaChannel: "native",
            bin: "opencode",
            args: [],
            stdio: "captured",
            envPassthrough: [],
            parseOutput: "text",
          },
          timeoutMs: null,
        },
      },
    });
    const sdkEngines = sdk.execution.engines as Record<string, unknown>;
    sdkEngines.sdk = {
      name: "sdk",
      kind: "agent",
      runnerKind: "sdk",
      platform: "opencode-sdk",
      bin: "opencode",
      args: [],
      workspace: null,
      envPassthrough: [],
      commandBuilder: "opencode-sdk",
      fallbackLlmEngine: null,
    } as never;
    delete sdkEngines.cli;
    rootUnit(sdk).invocation.engine = "sdk";
    expect(() => decodeWorkflowPlanV4(sdk)).not.toThrow();
  });

  test("keeps a direct LLM target free of a host executable requirement", () => {
    const content = "Use the frozen LLM request.";
    const llm = commandPlan({
      target: {
        kind: "command",
        ref: null,
        contentHash: sha256(content),
        request: {
          schemaVersion: 1,
          command: { template: content, content, source: null },
          engine: {
            name: "fast",
            kind: "llm",
            platform: "openai-compatible",
          },
          model: { input: "frozen-model", interpretation: "exact", resolved: "frozen-model" },
          authorization: { status: "not-required" },
          runtime: {},
          notices: [],
        },
        runner: {
          kind: "llm",
          engine: "fast",
          connection: {
            endpoint: "https://example.invalid/v1/chat/completions",
            apiKeyEnv: null,
            headers: {},
            model: "frozen-model",
          },
          timeoutMs: null,
        },
      },
    });
    const llmEngines = llm.execution.engines as Record<string, unknown>;
    llmEngines.fast = {
      name: "fast",
      kind: "llm",
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "frozen-model",
      timeoutMs: null,
      concurrency: 1,
    } as never;
    delete llmEngines.cli;
    const invocation = rootUnit(llm).invocation as Record<string, unknown>;
    invocation.engine = "fast";
    invocation.model = "frozen-model";
    invocation.modelPresent = true;
    expect(() => decodeWorkflowPlanV4(llm)).not.toThrow();
  });
});

describe("durable workflow v3 compatibility control", () => {
  test("keeps historical v3 canonical bytes and plan hash exact", () => {
    const plan: WorkflowPlanGraph = {
      irVersion: 3,
      title: "immutable-v3-control",
      execution: { maxConcurrency: 1, engines: {} },
      steps: [
        {
          stepId: "old",
          title: "old",
          sequenceIndex: 0,
          root: {
            kind: "unit",
            id: "old",
            instructions: "Preserve this old dispatch.",
            templating: "verbatim",
            exec: { command: ["/bin/sh", "-c", "printf old"], timeoutMs: 30_000 },
            onError: "fail",
            isolation: "none",
          },
          gate: { kind: "gate", id: "old.gate", stepId: "old", criteria: [], maxLoops: 1, judge: null },
        },
      ],
    };
    expect(canonicalPlanJson(plan)).toBe(
      '{"execution":{"engines":{},"maxConcurrency":1},"irVersion":3,"steps":[{"gate":{"criteria":[],"id":"old.gate","judge":null,"kind":"gate","maxLoops":1,"stepId":"old"},"root":{"exec":{"command":["/bin/sh","-c","printf old"],"timeoutMs":30000},"id":"old","instructions":"Preserve this old dispatch.","isolation":"none","kind":"unit","onError":"fail","templating":"verbatim"},"sequenceIndex":0,"stepId":"old","title":"old"}],"title":"immutable-v3-control"}',
    );
    expect(computePlanHash(plan)).toBe("1f6b0795d2f83f24b442fdf4cfec9325e0660db0e1a654aba40bc186c4bf5c9d");
  });
});
