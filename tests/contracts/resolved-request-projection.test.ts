import { describe, expect, test } from "bun:test";
import {
  canonicalResolvedRequestForTest,
  normalizeResolvedRequestForTest,
  sha256Utf8,
  type TestResolvedRequestInput,
} from "../_helpers/execution-contracts";

const request: TestResolvedRequestInput = {
  command: {
    content: "Review the execution contract.",
    arguments: "packages/core",
    source: {
      ref: "fixture//commands/contract-review",
      bundle: "fixture",
      adapter: "akm",
      file: "commands/contract-review.md",
      hash: "fixture-command-hash",
    },
  },
  persona: {
    content: "Review without modifying files.",
    source: {
      ref: "fixture//agents/contract-reviewer",
      bundle: "fixture",
      adapter: "akm",
      file: "agents/contract-reviewer.md",
      hash: "fixture-persona-hash",
    },
  },
  engine: { name: "fixture-agent", kind: "agent", platform: "opencode" },
  model: "provider/exact-model",
  effort: "high",
  schema: {
    type: "object",
    properties: { verdict: { type: "string" }, score: { type: "number" } },
    required: ["verdict"],
  },
  inference: { temperature: 0, extraParams: { seed: 7, response: { z: false, a: true } } },
  tools: { write: false, read: true },
  authorization: { status: "allowed", reason: "fixture policy" },
  timeoutMs: 45_000,
  workspace: "/workspace/fixture",
  environment: { Z_LAST: "last", A_FIRST: "first" },
  notices: [{ z: 2, a: 1 }],
};

describe("test-only normalized resolved-request projection", () => {
  test("retains dispatch-significant fields and gives every optional value one spelling", () => {
    expect(normalizeResolvedRequestForTest(request)).toEqual({
      schemaVersion: 1,
      command: {
        content: "Review the execution contract.",
        arguments: "packages/core",
        source: {
          ref: "fixture//commands/contract-review",
          bundle: "fixture",
          adapter: "akm",
          file: "commands/contract-review.md",
          hash: "fixture-command-hash",
        },
      },
      persona: {
        content: "Review without modifying files.",
        source: {
          ref: "fixture//agents/contract-reviewer",
          bundle: "fixture",
          adapter: "akm",
          file: "agents/contract-reviewer.md",
          hash: "fixture-persona-hash",
        },
      },
      engine: { name: "fixture-agent", kind: "agent", platform: "opencode" },
      model: "provider/exact-model",
      effort: "high",
      schema: {
        properties: { score: { type: "number" }, verdict: { type: "string" } },
        required: ["verdict"],
        type: "object",
      },
      inference: { extraParams: { response: { a: true, z: false }, seed: 7 }, temperature: 0 },
      tools: { read: true, write: false },
      authorization: { status: "allowed", reason: "fixture policy" },
      timeoutMs: 45_000,
      workspace: "/workspace/fixture",
      environment: { A_FIRST: "first", Z_LAST: "last" },
      notices: [{ a: 1, z: 2 }],
    });

    expect(
      normalizeResolvedRequestForTest({
        command: { content: "work" },
        engine: { name: "fixture-llm", kind: "llm" },
        timeoutMs: null,
      }),
    ).toEqual({
      schemaVersion: 1,
      command: { content: "work", arguments: "", source: null },
      persona: null,
      engine: { name: "fixture-llm", kind: "llm", platform: null },
      model: null,
      effort: null,
      schema: null,
      inference: {},
      tools: null,
      authorization: { status: "not-observed", reason: null },
      timeoutMs: null,
      workspace: null,
      environment: {},
      notices: [],
    });
  });

  test("canonical bytes ignore object insertion order but retain array order", () => {
    const reordered: TestResolvedRequestInput = {
      ...request,
      command: {
        ...request.command,
        source: {
          hash: "fixture-command-hash",
          file: "commands/contract-review.md",
          adapter: "akm",
          bundle: "fixture",
          ref: "fixture//commands/contract-review",
        },
      },
      persona: {
        ...request.persona!,
        source: {
          hash: "fixture-persona-hash",
          file: "agents/contract-reviewer.md",
          adapter: "akm",
          bundle: "fixture",
          ref: "fixture//agents/contract-reviewer",
        },
      },
      schema: {
        required: ["verdict"],
        properties: { score: { type: "number" }, verdict: { type: "string" } },
        type: "object",
      },
      inference: { extraParams: { response: { a: true, z: false }, seed: 7 }, temperature: 0 },
      tools: { read: true, write: false },
      environment: { A_FIRST: "first", Z_LAST: "last" },
      notices: [{ a: 1, z: 2 }],
    };
    const canonical = canonicalResolvedRequestForTest(request);
    expect(canonicalResolvedRequestForTest(reordered)).toBe(canonical);
    expect(canonical.endsWith("\n")).toBe(true);
    expect(sha256Utf8(canonical)).toMatch(/^[a-f0-9]{64}$/);

    const twoNotices = canonicalResolvedRequestForTest({ ...request, notices: [{ first: true }, { second: true }] });
    const reversedTwo = canonicalResolvedRequestForTest({ ...request, notices: [{ second: true }, { first: true }] });
    expect(reversedTwo).not.toBe(twoNotices);

    expect(canonicalResolvedRequestForTest({ ...request, effort: "low" })).not.toBe(canonical);
    expect(
      canonicalResolvedRequestForTest({
        ...request,
        schema: { ...request.schema, required: ["score"] },
      }),
    ).not.toBe(canonical);
  });
});
