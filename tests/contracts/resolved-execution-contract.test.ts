import { describe, expect, test } from "bun:test";
import {
  canonicalResolvedExecutionRequest,
  createInlineResolvedCommand,
  createResolvedCommand,
  createResolvedExecutionRequest,
  createResolvedPersona,
  decodeResolvedExecutionRequest,
  type ResolvedEngineSelection,
  type ResolvedExecutionRequestV1,
} from "../../src/execution/resolved-request";
import { createAdapterExtensions, renderMarkdownExecutionSource } from "../../src/execution/source";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import {
  canonicalResolvedRequestForTest,
  projectResolvedExecutionRequestForTest,
} from "../_helpers/execution-contracts";

const COMMAND_RAW = `---
description: Review one target
model: balanced
---
Review $ARGUMENTS exactly once.
`;

const PERSONA_RAW = `---
description: Read-only reviewer
tools: []
---
Review without modifying files.
`;

function commandSource() {
  return renderMarkdownExecutionSource({
    kind: "command",
    raw: COMMAND_RAW,
    identity: {
      ref: "fixture//commands/review",
      bundle: "fixture",
      adapter: "akm",
      file: "commands/review.md",
    },
    defaults: { model: "balanced", tools: [] },
  });
}

function personaSource() {
  return renderMarkdownExecutionSource({
    kind: "persona",
    raw: PERSONA_RAW,
    identity: {
      ref: "fixture//agents/reviewer",
      bundle: "fixture",
      adapter: "akm",
      file: "agents/reviewer.md",
    },
    defaults: { tools: [] },
  });
}

function commonRequest(command: ReturnType<typeof createResolvedCommand>): ResolvedExecutionRequestV1 {
  return createResolvedExecutionRequest({
    command,
    persona: createResolvedPersona(personaSource()),
    engine: { name: "fixture-agent", kind: "agent", platform: "opencode" },
    model: { input: "balanced", interpretation: "alias", resolved: "provider/exact-model" },
    inference: { temperature: 0, enableThinking: false, extraParams: {} },
    outputSchema: null,
    tools: [],
    authorization: { status: "allowed", reason: "fixture policy", policy: {} },
    runtime: { timeoutMs: 0, workspace: "", environment: {} },
    notices: [
      {
        code: "PERSONA_PROMPT_COMPOSED",
        severity: "warning",
        adapter: "fixture-agent",
        field: "persona.content",
        message: "Persona was composed into the user prompt.",
        details: { deterministic: true },
      },
    ],
    extensions: createAdapterExtensions("fixture-agent", { transport: "stdio" }),
  });
}

describe("resolved execution request v1", () => {
  test("preserves template, exact argument input, and final one-pass output", () => {
    const source = commandSource();
    const omitted = createResolvedCommand({ source, content: source.content });
    const explicitEmpty = createResolvedCommand({
      source,
      argumentInput: "",
      content: "Review  exactly once.\n",
    });

    expect(omitted.template).toBe("Review $ARGUMENTS exactly once.\n");
    expect(omitted.content).toBe(omitted.template);
    expect(Object.hasOwn(omitted, "argumentInput")).toBe(false);
    expect(Object.hasOwn(explicitEmpty, "argumentInput")).toBe(true);
    expect(explicitEmpty.argumentInput).toBe("");
    expect(explicitEmpty.content).toBe("Review  exactly once.\n");
  });

  test("keeps omitted, false, zero, empty, empty-string, and null values distinct in canonical bytes", () => {
    const source = commandSource();
    const minimal = createResolvedExecutionRequest({
      command: createResolvedCommand({ source, content: source.content }),
      engine: { name: "fixture-llm", kind: "llm" },
      authorization: { status: "not-required" },
      runtime: {},
      notices: [],
    });
    const explicit = commonRequest(
      createResolvedCommand({ source, argumentInput: "", content: "Review  exactly once.\n" }),
    );
    const minimalJson = JSON.parse(canonicalResolvedExecutionRequest(minimal)) as Record<string, unknown>;
    const explicitJson = JSON.parse(canonicalResolvedExecutionRequest(explicit)) as Record<string, unknown>;

    expect(Object.hasOwn(minimalJson, "persona")).toBe(false);
    expect(Object.hasOwn(minimalJson, "model")).toBe(false);
    expect(Object.hasOwn(minimalJson, "inference")).toBe(false);
    expect(Object.hasOwn(minimalJson, "tools")).toBe(false);
    expect(Object.hasOwn(minimal.command, "argumentInput")).toBe(false);

    expect(explicitJson).toMatchObject({
      schemaVersion: 1,
      command: { argumentInput: "" },
      inference: { temperature: 0, enableThinking: false, extraParams: {} },
      outputSchema: null,
      tools: [],
      runtime: { timeoutMs: 0, workspace: "", environment: {} },
    });
  });

  test("direct, task, and workflow entrypoint adapters construct identical contract bytes", () => {
    const source = commandSource();
    const build = (): ResolvedExecutionRequestV1 =>
      commonRequest(
        createResolvedCommand({
          source,
          argumentInput: "packages/core",
          content: "Review packages/core exactly once.\n",
        }),
      );

    const fromDirect = build();
    const fromTask = build();
    const fromWorkflowFreeze = build();
    expect(canonicalResolvedExecutionRequest(fromTask)).toBe(canonicalResolvedExecutionRequest(fromDirect));
    expect(canonicalResolvedExecutionRequest(fromWorkflowFreeze)).toBe(canonicalResolvedExecutionRequest(fromDirect));
    expect(canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(fromTask))).toBe(
      canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(fromDirect)),
    );
    expect(canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(fromWorkflowFreeze))).toBe(
      canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(fromDirect)),
    );
  });

  test("strictly rehydrates the same durable bytes for workflow resume", () => {
    const source = commandSource();
    const request = commonRequest(
      createResolvedCommand({
        source,
        argumentInput: "packages/core",
        content: "Review packages/core exactly once.\n",
      }),
    );
    const canonical = canonicalResolvedExecutionRequest(request);
    const resumed = decodeResolvedExecutionRequest(JSON.parse(canonical));

    expect(canonicalResolvedExecutionRequest(resumed)).toBe(canonical);
    expect(resumed.command.argumentInput).toBe("packages/core");
    expect(resumed.command.source).toEqual(request.command.source);

    for (const hostileField of ["raw", "frontmatter"] as const) {
      const hostile = JSON.parse(canonical) as Record<string, Record<string, unknown>>;
      const hostileCommand = hostile.command;
      if (!hostileCommand) throw new Error("canonical request omitted its command");
      hostileCommand[hostileField] = COMMAND_RAW;
      expect(() => decodeResolvedExecutionRequest(hostile)).toThrow(
        new RegExp(`command contains unsupported field: ${hostileField}`, "i"),
      );

      const hostileSource = JSON.parse(canonical) as {
        command?: { source?: Record<string, unknown> };
      };
      const sourceIdentity = hostileSource.command?.source;
      if (!sourceIdentity) throw new Error("canonical request omitted its command source identity");
      sourceIdentity[hostileField] = COMMAND_RAW;
      expect(() => decodeResolvedExecutionRequest(hostileSource)).toThrow(
        new RegExp(`command.source contains unsupported field: ${hostileField}`, "i"),
      );
    }
    const unknownTopLevel = JSON.parse(canonical) as Record<string, unknown>;
    unknownTopLevel.capabilities = { tools: true };
    expect(() => decodeResolvedExecutionRequest(unknownTopLevel)).toThrow(
      /resolved execution request contains unsupported field: capabilities/i,
    );
  });

  test("covers every runner transport kind without embedding a capability matrix", () => {
    const source = commandSource();
    const runnerKinds = { agent: true, sdk: true, llm: true } satisfies Record<
      RunnerSpec["kind"] | ResolvedEngineSelection["kind"],
      true
    >;
    for (const kind of Object.keys(runnerKinds) as Array<keyof typeof runnerKinds>) {
      const request = createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        engine: { name: `fixture-${kind}`, kind },
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      });
      expect(request.engine.kind).toBe(kind);
      expect(Object.hasOwn(request.engine, "capabilities")).toBe(false);
    }
  });

  test("supports explicit anonymous command content without pretending it came from a native file", () => {
    const command = createInlineResolvedCommand({ template: "Do the work.", content: "Do the work." });
    const request = createResolvedExecutionRequest({
      command,
      persona: null,
      engine: { name: "fixture-llm", kind: "llm" },
      model: null,
      tools: null,
      authorization: { status: "allowed" },
      runtime: { timeoutMs: null, workspace: null, environment: null },
      notices: [],
    });

    expect(request.command.source).toBeNull();
    expect(Object.hasOwn(request, "persona")).toBe(true);
    expect(request.persona).toBeNull();
    expect(request.model).toBeNull();
    expect(request.tools).toBeNull();
  });

  test("permits not-required authorization only when the selected tool set is semantically empty", () => {
    const source = commandSource();
    const base = {
      command: createResolvedCommand({ source, content: source.content }),
      engine: { name: "fixture-llm", kind: "llm" as const },
      authorization: { status: "not-required" as const },
      runtime: {},
      notices: [],
    };
    for (const tools of [null, "", [], {}] as const) {
      expect(() => createResolvedExecutionRequest({ ...base, tools })).not.toThrow();
    }
    for (const tools of ["read", ["read"], { read: true }] as const) {
      expect(() => createResolvedExecutionRequest({ ...base, tools })).toThrow(/not-required.*no tools are selected/i);
    }
  });

  test("rejects extension-owner collisions instead of silently merging adapter metadata", () => {
    expect(() =>
      createAdapterExtensions(["claude", { argumentHint: "<target>" }], ["claude", { another: true }]),
    ).toThrow(/duplicate extension owner.*claude/i);
    expect(() => createAdapterExtensions("__proto__", { polluted: true })).toThrow(/canonical adapter identifier/i);
  });

  test("uses locale-independent canonical key order and rejects invalid optional model extensions", () => {
    const source = commandSource();
    const request = createResolvedExecutionRequest({
      command: createResolvedCommand({ source, content: source.content }),
      engine: { name: "fixture-llm", kind: "llm", settings: { a: 1, Z: 2 } },
      model: {
        input: "provider/model",
        interpretation: "exact",
        resolved: "provider/model",
      },
      authorization: { status: "not-required" },
      runtime: {},
      notices: [],
    });

    expect(canonicalResolvedExecutionRequest(request)).toContain('"settings":{"Z":2,"a":1}');

    const invalidWire = JSON.parse(canonicalResolvedExecutionRequest(request)) as {
      model: Record<string, unknown>;
    };
    invalidWire.model.extensions = null;
    expect(() => decodeResolvedExecutionRequest(invalidWire)).toThrow(/model\.extensions/i);
  });
});
