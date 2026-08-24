// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for durable workflow IR v4.
 *
 * Keep every import of the deliberately absent v4 module inside its test. The
 * baseline therefore reports one RED result per contract instead of stopping
 * at module evaluation with a single loader error. Once v4 lands, these become
 * ordinary strict-decoder and compatibility tests.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { canonicalPlanJson, computePlanHash, decodeCanonicalPlan } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/stored-plan-v3";
import { classifyWorkflowRunPlan } from "../../src/workflows/runtime/plan-classifier";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`fixture requires ${label}`);
  return value;
}

const WORKFLOW_BYTES = "workflow-v4-source-bytes\n";
const COMMAND_BYTES = "command-v4-source-bytes\n";
const COMMAND_CONTENT = "Review the change exactly once.";

function identity(ref: string, file: string, bytes: string) {
  return {
    ref,
    bundle: "fixture",
    adapter: "akm",
    file,
    hash: sha256(bytes),
  };
}

const WORKFLOW_IDENTITY = identity("fixture//workflows/review", "workflows/review.md", WORKFLOW_BYTES);
const COMMAND_IDENTITY = identity("fixture//commands/review", "commands/review.md", COMMAND_BYTES);

function snapshot(sourceIdentity: ReturnType<typeof identity>, size: number, ordinal: number) {
  return {
    identity: structuredClone(sourceIdentity),
    containmentPhysicalIdentity: `root-device:7/root-inode:${100 + ordinal}`,
    physicalIdentity: `file-device:7/file-inode:${200 + ordinal}`,
    size,
  };
}

const CWD_IDENTITY = Object.freeze({
  requestedRoot: "/workspace",
  realRoot: "/workspace",
  rootDevice: "7",
  rootInode: "100",
  requestedCwd: "/workspace",
  realCwd: "/workspace",
  cwdDevice: "7",
  cwdInode: "100",
});

function requestWire(options: { stored?: boolean; content?: string; authorization?: "not-required" | "denied" } = {}) {
  const content = options.content ?? COMMAND_CONTENT;
  return {
    schemaVersion: 1,
    command: {
      template: content,
      content,
      source: options.stored === false ? null : structuredClone(COMMAND_IDENTITY),
    },
    engine: { name: "fast", kind: "llm" },
    authorization: {
      status: options.authorization ?? "not-required",
      ...(options.authorization === "denied" ? { reason: "operator policy denied tools" } : {}),
    },
    runtime: {},
    notices: [],
  };
}

function commandUnit() {
  return {
    kind: "unit",
    id: "review",
    instructions: "Review the change.",
    templating: "verbatim",
    frozenTarget: {
      kind: "command",
      ref: "fixture//commands/review",
      contentHash: sha256(COMMAND_CONTENT),
      request: requestWire(),
      runner: {
        kind: "llm",
        engine: "fast",
        connection: {
          endpoint: "https://example.test/v1/chat/completions",
          model: "qwen",
        },
        credential: { names: ["FAST_API_KEY"], required: true },
        timeoutMs: 600_000,
      },
    },
    environment: [
      { kind: "literal", name: "REGION", value: "us-east-1" },
      { kind: "pass-through", name: "DEPLOY_TOKEN" },
    ],
    onError: "fail",
    isolation: "none",
  };
}

function v4Plan() {
  return {
    irVersion: 4,
    title: "review",
    sourceReadSet: [
      snapshot(COMMAND_IDENTITY, Buffer.byteLength(COMMAND_BYTES), 1),
      snapshot(WORKFLOW_IDENTITY, Buffer.byteLength(WORKFLOW_BYTES), 2),
    ],
    execution: {
      maxConcurrency: 2,
    },
    steps: [
      {
        stepId: "review",
        title: "review",
        sequenceIndex: 0,
        root: commandUnit(),
        gate: {
          kind: "gate",
          id: "review.gate",
          stepId: "review",
          criteria: [],
          maxLoops: 1,
          frozenJudge: null,
        },
      },
    ],
  };
}

function v3GoldenPlan(): WorkflowPlanGraph {
  return {
    irVersion: 3,
    title: "v3-golden",
    execution: {
      maxConcurrency: 1,
      engines: {
        fast: {
          name: "fast",
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "qwen",
          timeoutMs: 600_000,
          concurrency: 1,
        },
      },
    },
    steps: [
      {
        stepId: "one",
        title: "one",
        sequenceIndex: 0,
        root: {
          kind: "unit",
          id: "one",
          instructions: "Preserve v3 exactly.",
          templating: "verbatim",
          invocation: { engine: "fast", model: "qwen", modelPresent: false, timeoutMs: 600_000 },
          onError: "fail",
          isolation: "none",
        },
        gate: { kind: "gate", id: "one.gate", stepId: "one", criteria: [], maxLoops: 1, judge: null },
      },
    ],
  };
}

function rootUnit(plan: ReturnType<typeof v4Plan>): Record<string, unknown> {
  const root = plan.steps[0]?.root;
  if (!root || root.kind !== "unit") throw new Error("fixture requires a unit root");
  return root as unknown as Record<string, unknown>;
}

function frozenTarget(plan: ReturnType<typeof v4Plan>): Record<string, unknown> {
  const target = rootUnit(plan).frozenTarget;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("fixture requires a frozen target");
  }
  return target as Record<string, unknown>;
}

describe("durable workflow IR v4 — version and compatibility island", () => {
  test("publishes the additive v4 decoder while retaining a v3|v4 executable union", async () => {
    const module = await import("../../src/workflows/ir/schema-v4");
    expect(module.WORKFLOW_IR_V4_VERSION).toBe(4);
    const decoded = module.decodeWorkflowPlanV4(v4Plan());
    expect(decoded.irVersion).toBe(4);
    expect(decoded.sourceReadSet).toHaveLength(2);
  });

  test("dispatches executable decode by persisted version and rejects row/JSON disagreement", async () => {
    const { decodeExecutableWorkflowPlan } = await import("../../src/workflows/ir/schema-v4");
    expect(decodeExecutableWorkflowPlan(v3GoldenPlan(), 3).irVersion).toBe(3);
    expect(decodeExecutableWorkflowPlan(v4Plan(), 4).irVersion).toBe(4);
    expect(() => decodeExecutableWorkflowPlan(v4Plan(), 3)).toThrow(/version|expected|3|4/i);
    expect(() => decodeExecutableWorkflowPlan(v3GoldenPlan(), 4)).toThrow(/version|expected|3|4/i);
    expect(() => decodeExecutableWorkflowPlan({ irVersion: 5 }, 5)).toThrow(/unsupported|version|5/i);
  });

  test("keeps the v3 canonical bytes and hash byte-exact", () => {
    const plan = v3GoldenPlan();
    expect(canonicalPlanJson(plan)).toBe(
      '{"execution":{"engines":{"fast":{"concurrency":1,"endpoint":"https://example.test/v1/chat/completions","kind":"llm","model":"qwen","name":"fast","timeoutMs":600000}},"maxConcurrency":1},"irVersion":3,"steps":[{"gate":{"criteria":[],"id":"one.gate","judge":null,"kind":"gate","maxLoops":1,"stepId":"one"},"root":{"id":"one","instructions":"Preserve v3 exactly.","invocation":{"engine":"fast","model":"qwen","modelPresent":false,"timeoutMs":600000},"isolation":"none","kind":"unit","onError":"fail","templating":"verbatim"},"sequenceIndex":0,"stepId":"one","title":"one"}],"title":"v3-golden"}',
    );
    expect(computePlanHash(plan)).toBe("0ceb78452b938493c947239862a0aa36879e0c5355efc942a9741d6e34490a50");
  });

  test("canonical plan decode and hashing accept both versions without normalizing v3", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = decodeWorkflowPlanV4(v4Plan());
    const canonical = canonicalPlanJson(plan);
    const hash = computePlanHash(plan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(decodeCanonicalPlan("v4-run", canonical, hash)).toEqual(plan);

    const v3 = v3GoldenPlan();
    const v3Canonical = canonicalPlanJson(v3);
    expect(decodeCanonicalPlan("v3-run", v3Canonical, computePlanHash(v3))).toEqual(v3);
  });

  test("runtime classification supports persisted v3 and v4 rows but not future versions", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const v3 = v3GoldenPlan();
    const v4 = decodeWorkflowPlanV4(v4Plan());
    expect(
      classifyWorkflowRunPlan({
        id: "legacy-v3",
        plan_json: canonicalPlanJson(v3),
        plan_hash: computePlanHash(v3),
        plan_ir_version: 3,
      }).support,
    ).toBe("supported");
    expect(
      classifyWorkflowRunPlan({
        id: "fresh-v4",
        plan_json: canonicalPlanJson(v4),
        plan_hash: computePlanHash(v4),
        plan_ir_version: 4,
      }).support,
    ).toBe("supported");
    expect(
      classifyWorkflowRunPlan({
        id: "future-v5",
        plan_json: '{"irVersion":5}',
        plan_hash: sha256('{"irVersion":5}'),
        plan_ir_version: 5,
      }).support,
    ).toBe("unsupported-version");
  });
});

describe("durable workflow IR v4 — strict source read set", () => {
  test("requires sourceReadSet and remains recursively closed", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const missing = v4Plan() as Record<string, unknown>;
    delete missing.sourceReadSet;
    expect(() => decodeWorkflowPlanV4(missing)).toThrow(/sourceReadSet|required/i);

    const extra = v4Plan() as Record<string, unknown>;
    extra.surprise = true;
    expect(() => decodeWorkflowPlanV4(extra)).toThrow(/surprise|unknown|unsupported/i);

    const nested = v4Plan();
    frozenTarget(nested).surprise = true;
    expect(() => decodeWorkflowPlanV4(nested)).toThrow(/surprise|unknown|unsupported/i);
  });

  test("requires canonical tuple ordering by ref, adapter, file", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    expect(() => decodeWorkflowPlanV4(v4Plan())).not.toThrow();
    const reversed = v4Plan();
    reversed.sourceReadSet.reverse();
    expect(() => decodeWorkflowPlanV4(reversed)).toThrow(/sourceReadSet|canonical|sort|order/i);
  });

  test("rejects a duplicate physical source key even when hashes or physical values differ", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = v4Plan();
    const duplicate = structuredClone(first(plan.sourceReadSet, "a source snapshot"));
    duplicate.identity.hash = sha256("different bytes");
    duplicate.physicalIdentity = "file-device:99/file-inode:99";
    plan.sourceReadSet.splice(1, 0, duplicate);
    expect(() => decodeWorkflowPlanV4(plan)).toThrow(/sourceReadSet|duplicate|identity|key/i);
  });

  test("requires every stored command/persona source identity in the read set", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = v4Plan();
    plan.sourceReadSet = plan.sourceReadSet.filter((entry) => entry.identity.ref !== COMMAND_IDENTITY.ref);
    expect(() => decodeWorkflowPlanV4(plan)).toThrow(/read.?set|command|source|identity|missing/i);
  });

  test("rejects two logical refs that alias one physical file", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = v4Plan();
    const alias = snapshot(identity("fixture//commands/alias", "commands/alias.md", COMMAND_BYTES), 12, 7);
    const original = first(plan.sourceReadSet, "a source snapshot");
    alias.containmentPhysicalIdentity = original.containmentPhysicalIdentity;
    alias.physicalIdentity = original.physicalIdentity;
    plan.sourceReadSet.splice(1, 0, alias);
    expect(() => decodeWorkflowPlanV4(plan)).toThrow(/alias|physical|same file|identity/i);
  });
});

describe("durable workflow IR v4 — resolved targets and environment", () => {
  test("persists a strict canonical resolved request and binds its exact command hash", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const decoded = decodeWorkflowPlanV4(v4Plan());
    const decodedRoot = decoded.steps[0]?.root;
    expect(decodedRoot?.kind).toBe("unit");
    if (!decodedRoot || decodedRoot.kind !== "unit") return;
    expect(decodedRoot.frozenTarget.kind).toBe("command");
    if (decodedRoot.frozenTarget.kind !== "command") return;
    expect(decodedRoot.frozenTarget.request.command.content).toBe(COMMAND_CONTENT);
    expect(decodedRoot.frozenTarget.contentHash).toBe(sha256(COMMAND_CONTENT));

    const mismatch = v4Plan();
    frozenTarget(mismatch).contentHash = sha256("other content");
    expect(() => decodeWorkflowPlanV4(mismatch)).toThrow(/contentHash|command|hash|mismatch/i);
  });

  test("strictly freezes runner transport without credential values and binds it to request engine", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const { decodeFrozenRunnerSpec } = await import("../../src/integrations/agent/execution-lowering");
    const runner = frozenTarget(v4Plan()).runner as RunnerSpec;
    expect(decodeFrozenRunnerSpec(runner)).toEqual(runner);

    const withApiKey = v4Plan();
    const leakedRunner = frozenTarget(withApiKey).runner as {
      connection: Record<string, unknown>;
    };
    leakedRunner.connection.apiKey = "must-never-be-frozen";
    expect(() => decodeWorkflowPlanV4(withApiKey)).toThrow(/runner|connection|apiKey|credential/i);

    const mismatch = v4Plan();
    const mismatchedRunner = frozenTarget(mismatch).runner as Record<string, unknown>;
    mismatchedRunner.engine = "other-engine";
    expect(() => decodeWorkflowPlanV4(mismatch)).toThrow(/runner|request|engine|match/i);
  });

  test("accepts a complete frozen agent profile and rejects secret-shaped profile env", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = v4Plan();
    const target = frozenTarget(plan);
    target.request = {
      ...requestWire(),
      engine: { name: "fast", kind: "agent", platform: "codex" },
    };
    target.runner = {
      kind: "agent",
      engine: "fast",
      profile: {
        name: "codex",
        platform: "codex",
        personaChannel: "native",
        workspace: "/workspace",
        bin: "codex",
        args: ["exec"],
        stdio: "captured",
        envPassthrough: ["CODEX_CONFIG"],
        parseOutput: "text",
        model: "gpt-5",
        modelIsExact: true,
      },
      timeoutMs: null,
    };
    expect(() => decodeWorkflowPlanV4(plan)).not.toThrow();

    const leak = structuredClone(plan);
    const runner = frozenTarget(leak).runner as { profile: { env?: Record<string, string> } };
    runner.profile.env = { SAFE_LOOKING_NAME: "github_pat_012345678901234567890123456789" };
    expect(() => decodeWorkflowPlanV4(leak)).toThrow(/runner|profile.*env|secret/i);
  });

  test("fails closed on denied authorization and request-owned live environment", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const denied = v4Plan();
    const deniedTarget = frozenTarget(denied);
    deniedTarget.request = requestWire({ authorization: "denied" });
    expect(() => decodeWorkflowPlanV4(denied)).toThrow(/authorization|denied|policy/i);

    const ambient = v4Plan();
    const ambientRequest = requestWire() as ReturnType<typeof requestWire> & {
      runtime: { environment?: Record<string, string> };
    };
    ambientRequest.runtime.environment = { API_TOKEN: "must-not-be-durable" };
    frozenTarget(ambient).request = ambientRequest;
    expect(() => decodeWorkflowPlanV4(ambient)).toThrow(/runtime.*environment|environment.*request|live/i);
  });

  test("keeps literal values and symbolic pass-through bindings distinct without durable secret values", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const secretValue = "github_pat_012345678901234567890123456789";
    const decoded = decodeWorkflowPlanV4(v4Plan());
    const root = decoded.steps[0]?.root;
    expect(root?.kind).toBe("unit");
    if (!root || root.kind !== "unit") return;
    expect(root.environment).toEqual([
      { kind: "literal", name: "REGION", value: "us-east-1" },
      { kind: "pass-through", name: "DEPLOY_TOKEN" },
    ]);
    expect(canonicalPlanJson(decoded)).not.toContain(secretValue);

    const leak = v4Plan();
    rootUnit(leak).environment = [{ kind: "literal", name: "REGION", value: secretValue }];
    expect(() => decodeWorkflowPlanV4(leak)).toThrow(/secret|literal|environment/i);
  });

  test("rejects inheritEnv because only frozen named bindings may be live-valued", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = v4Plan();
    rootUnit(plan).frozenTarget = {
      kind: "shell",
      contentHash: sha256("printf safe"),
      exec: { command: ["sh", "-c", "printf safe"], timeoutMs: 30_000, inheritEnv: true },
      cwdIdentity: structuredClone(CWD_IDENTITY),
    };
    expect(() => decodeWorkflowPlanV4(plan)).toThrow(/inheritEnv|environment|allowlist/i);
  });

  test("requires script exact bytes, byte count, digest, and an exec arm without exposing its private sentinel", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const scriptBytes = Buffer.from("#!/bin/sh\nprintf exact\\n\n", "utf8");
    const scriptIdentity = identity("fixture//scripts/tool.sh", "scripts/tool.sh", scriptBytes.toString("utf8"));
    const plan = v4Plan();
    plan.sourceReadSet = [
      snapshot(scriptIdentity, scriptBytes.byteLength, 1),
      snapshot(WORKFLOW_IDENTITY, Buffer.byteLength(WORKFLOW_BYTES), 2),
    ];
    const root = rootUnit(plan);
    root.environment = [];
    root.frozenTarget = {
      kind: "script",
      ref: scriptIdentity.ref,
      contentHash: sha256(scriptBytes),
      exec: { command: ["akm-internal-frozen-script"], timeoutMs: 30_000 },
      interpreter: "sh",
      extension: ".sh",
      bytesBase64: scriptBytes.toString("base64"),
      byteLength: scriptBytes.byteLength,
      cwdIdentity: structuredClone(CWD_IDENTITY),
      materialization: "ephemeral-0700-delete",
    };

    const decoded = decodeWorkflowPlanV4(plan);
    const decodedRoot = decoded.steps[0]?.root;
    expect(decodedRoot?.kind).toBe("unit");
    if (!decodedRoot || decodedRoot.kind !== "unit") return;
    expect(decodedRoot.frozenTarget).toMatchObject({
      kind: "script",
      ref: scriptIdentity.ref,
      bytesBase64: scriptBytes.toString("base64"),
      byteLength: scriptBytes.byteLength,
      contentHash: sha256(scriptBytes),
      materialization: "ephemeral-0700-delete",
    });

    const wrongHash = structuredClone(plan);
    frozenTarget(wrongHash).contentHash = sha256("different script");
    expect(() => decodeWorkflowPlanV4(wrongHash)).toThrow(/script|contentHash|hash|bytes/i);
    const wrongLength = structuredClone(plan);
    frozenTarget(wrongLength).byteLength = scriptBytes.byteLength + 1;
    expect(() => decodeWorkflowPlanV4(wrongLength)).toThrow(/script|byteLength|length|bytes/i);
    const noExec = structuredClone(plan);
    delete frozenTarget(noExec).exec;
    expect(() => decodeWorkflowPlanV4(noExec)).toThrow(/script|exec|arm/i);
  });
});

describe("durable workflow IR v4 — v5 work identity", () => {
  test("uses collision-safe full SHA-256 suffixes for v4 fan-out and preserves v3 12-hex ids", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const plan = decodeWorkflowPlanV4(v4Plan());
    const step = structuredClone(first(plan.steps, "a v4 step"));
    const unit = step.root;
    if (!unit || unit.kind !== "unit") throw new Error("fixture requires unit root");
    step.root = {
      kind: "map",
      id: "review.map",
      over: `\${{ params.files }}`,
      template: { ...unit, id: "review.unit" },
      concurrency: 2,
      reducer: "collect",
    };
    const v4Work = computeStepWorkList(step, {
      runId: "v4-run",
      params: { files: ["a.ts", "b.ts"] },
      stepOutputs: {},
      engines: {},
    });
    expect(v4Work.ok).toBe(true);
    if (!v4Work.ok) return;
    expect(v4Work.list.units.map((work) => work.unitId)).toEqual([
      `review.unit:${sha256('"a.ts"')}`,
      `review.unit:${sha256('"b.ts"')}`,
    ]);
    expect(v4Work.list.units.every((work) => /^review\.unit:[0-9a-f]{64}$/.test(work.unitId))).toBe(true);

    const v3 = first(v3GoldenPlan().steps, "a v3 step");
    const v3Root = v3.root;
    if (!v3Root || v3Root.kind !== "unit") throw new Error("fixture requires v3 unit root");
    const v3Step = {
      ...structuredClone(v3),
      root: {
        kind: "map" as const,
        id: "one.map",
        over: `\${{ params.files }}`,
        template: { ...structuredClone(v3Root), id: "one.unit" },
        concurrency: 2,
        reducer: "collect" as const,
      },
    };
    const v3Work = computeStepWorkList(v3Step, {
      runId: "v3-run",
      params: { files: ["a.ts"] },
      stepOutputs: {},
      engines: v3GoldenPlan().execution.engines,
    });
    expect(v3Work.ok).toBe(true);
    if (v3Work.ok) expect(v3Work.list.units[0]?.unitId).toBe(`one.unit:${sha256('"a.ts"').slice(0, 12)}`);
  });

  test("v5 input hashes cover frozen requests and symbolic environment bindings", async () => {
    const { decodeWorkflowPlanV4 } = await import("../../src/workflows/ir/schema-v4");
    const input = { runId: "run", params: {}, stepOutputs: {} };
    const base = decodeWorkflowPlanV4(v4Plan());
    const changedCommandFixture = v4Plan();
    const changedContent = "Review a different frozen command.";
    frozenTarget(changedCommandFixture).request = requestWire({ content: changedContent });
    frozenTarget(changedCommandFixture).contentHash = sha256(changedContent);
    const changedCommand = decodeWorkflowPlanV4(changedCommandFixture);
    const changedEnvFixture = v4Plan();
    rootUnit(changedEnvFixture).environment = [
      { kind: "literal", name: "REGION", value: "eu-west-1" },
      { kind: "pass-through", name: "DEPLOY_TOKEN" },
    ];
    const changedEnv = decodeWorkflowPlanV4(changedEnvFixture);

    const hashOf = (plan: typeof base): string => {
      const result = computeStepWorkList(first(plan.steps, "a v4 step"), {
        ...input,
        engines: {},
      });
      if (!result.ok) throw new Error(result.error);
      return first(result.list.units, "a v4 work unit").inputHash;
    };
    const hashes = [hashOf(base), hashOf(changedCommand), hashOf(changedEnv)];
    expect(new Set(hashes).size).toBe(3);
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
});
