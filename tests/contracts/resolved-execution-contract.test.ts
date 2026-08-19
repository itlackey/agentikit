import { describe, expect, test } from "bun:test";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import { BUILTIN_ADAPTERS } from "../../src/core/adapter/registry";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../src/execution/limits";
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
import {
  createAdapterExtensions,
  decodeExecutionSourceIdentity,
  type ExecutionSourceIdentity,
} from "../../src/execution/source";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { WORKFLOW_MAX_TIMEOUT_MS } from "../../src/workflows/resource-limits";
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
    agent: "fixture//agents/reviewer",
    persona: createResolvedPersona(personaSource()),
    engine: { name: "fixture-agent", kind: "agent", platform: "opencode" },
    model: { input: "balanced", interpretation: "alias", resolved: "provider/exact-model" },
    inference: { temperature: 0, enableThinking: false, extraParams: {} },
    outputSchema: null,
    tools: [],
    authorization: { status: "not-required", reason: "no tools selected", policy: {} },
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
    expect(Object.hasOwn(minimalJson, "agent")).toBe(false);
    expect(Object.hasOwn(minimalJson, "model")).toBe(false);
    expect(Object.hasOwn(minimalJson, "inference")).toBe(false);
    expect(Object.hasOwn(minimalJson, "tools")).toBe(false);
    expect(Object.hasOwn(minimal.command, "argumentInput")).toBe(false);

    expect(explicitJson).toMatchObject({
      schemaVersion: 1,
      command: { argumentInput: "" },
      agent: "fixture//agents/reviewer",
      inference: { temperature: 0, enableThinking: false, extraParams: {} },
      outputSchema: null,
      tools: [],
      runtime: { timeoutMs: 0, workspace: "", environment: {} },
    });
  });

  test("preserves the exact selected agent selector through durable request bytes", () => {
    const source = commandSource();
    const make = (agent: string | null | undefined) =>
      createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        ...(agent === undefined ? {} : { agent }),
        persona:
          agent === undefined || agent === "fixture//agents/reviewer" ? createResolvedPersona(personaSource()) : null,
        engine: { name: "fixture-agent", kind: "agent" },
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      });
    const omitted = make(undefined);
    const cleared = make(null);
    const native = make("native-reviewer");
    const other = make("different-native-reviewer");

    expect(Object.hasOwn(omitted, "agent")).toBe(false);
    expect(decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(cleared))).agent).toBeNull();
    expect(decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(native))).agent).toBe(
      "native-reviewer",
    );
    expect(canonicalResolvedExecutionRequest(native)).not.toBe(canonicalResolvedExecutionRequest(other));
  });

  test("rejects durable agent selector and persona states the common planner cannot emit", () => {
    const source = commandSource();
    const command = createResolvedCommand({ source, content: source.content });
    const reviewer = createResolvedPersona(personaSource());
    const base = {
      command,
      engine: { name: "fixture-agent", kind: "agent" } as const,
      authorization: { status: "not-required" } as const,
      runtime: {},
      notices: [],
    };

    expect(() => createResolvedExecutionRequest({ ...base, agent: "native\nselector", persona: null })).toThrow(
      /stable|control|selector/i,
    );
    expect(() => createResolvedExecutionRequest({ ...base, agent: null, persona: reviewer })).toThrow(/agent|persona/i);
    expect(() => createResolvedExecutionRequest({ ...base, agent: null })).toThrow(/agent|persona/i);
    expect(() => createResolvedExecutionRequest({ ...base, agent: "native-reviewer", persona: reviewer })).toThrow(
      /agent|persona/i,
    );
    expect(() => createResolvedExecutionRequest({ ...base, agent: "native-reviewer" })).toThrow(/agent|persona/i);
    expect(() =>
      createResolvedExecutionRequest({ ...base, agent: "fixture//agents/other", persona: reviewer }),
    ).toThrow(/agent|persona/i);
    expect(() => createResolvedExecutionRequest({ ...base, agent: "fixture//agents/reviewer", persona: null })).toThrow(
      /agent|persona/i,
    );

    expect(createResolvedExecutionRequest({ ...base, persona: reviewer }).persona?.source.ref).toBe(
      "fixture//agents/reviewer",
    );
    expect(createResolvedExecutionRequest({ ...base, agent: null, persona: null }).agent).toBeNull();
    expect(createResolvedExecutionRequest({ ...base, agent: "native-reviewer", persona: null }).persona).toBeNull();

    const validWire = JSON.parse(
      canonicalResolvedExecutionRequest(
        createResolvedExecutionRequest({
          ...base,
          agent: "fixture//agents/reviewer",
          persona: reviewer,
        }),
      ),
    ) as Record<string, unknown>;
    for (const invalid of [
      { ...validWire, agent: "native\nselector", persona: null },
      { ...validWire, agent: null },
      { ...validWire, agent: "native-reviewer" },
      { ...validWire, agent: "fixture//agents/other" },
      { ...validWire, persona: null },
    ]) {
      expect(() => decodeResolvedExecutionRequest(invalid)).toThrow(/agent|persona|stable|control|selector/i);
    }
  });

  test("construction and durable decode fixtures are equivalent without claiming caller cutover", () => {
    const source = commandSource();
    const constructed = commonRequest(
      createResolvedCommand({
        source,
        argumentInput: "packages/core",
        content: "Review packages/core exactly once.\n",
      }),
    );
    const durableFixture = JSON.parse(canonicalResolvedExecutionRequest(constructed));
    const decoded = decodeResolvedExecutionRequest(durableFixture);

    expect(canonicalResolvedExecutionRequest(decoded)).toBe(canonicalResolvedExecutionRequest(constructed));
    expect(canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(decoded))).toBe(
      canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(constructed)),
    );
    // Production direct/task/workflow cutover remains owned by WP3/WP4/WP5.
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

    const sparseNotices = JSON.parse(canonical) as { notices: unknown[] };
    delete sparseNotices.notices[0];
    expect(() => decodeResolvedExecutionRequest(sparseNotices)).toThrow(/notices.*array|dense|sparse/i);

    const decoratedNotices = JSON.parse(canonical) as { notices: unknown[] & { raw?: string } };
    decoratedNotices.notices.raw = "native bytes";
    expect(() => decodeResolvedExecutionRequest(decoratedNotices)).toThrow(/notices.*array|propert/i);
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
      authorization: { status: "not-required" },
      runtime: { timeoutMs: null, workspace: null, environment: null },
      notices: [],
    });

    expect(request.command.source).toBeNull();
    expect(Object.hasOwn(request, "persona")).toBe(true);
    expect(request.persona).toBeNull();
    expect(request.model).toBeNull();
    expect(request.tools).toBeNull();
  });

  test("enforces exact tool-selection and authorization-state pairing", () => {
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
      for (const status of ["allowed", "denied"] as const) {
        expect(() => createResolvedExecutionRequest({ ...base, tools, authorization: { status } })).toThrow(
          /empty|no tools|not-required/i,
        );
      }
    }
    for (const tools of ["read", ["read"], { read: true }] as const) {
      expect(() => createResolvedExecutionRequest({ ...base, tools })).toThrow(/not-required.*no tools are selected/i);
      for (const status of ["allowed", "denied"] as const) {
        expect(() => createResolvedExecutionRequest({ ...base, tools, authorization: { status } })).not.toThrow();
      }
    }
  });

  test("rejects extension-owner collisions instead of silently merging adapter metadata", () => {
    expect(() =>
      createAdapterExtensions(["claude", { argumentHint: "<target>" }], ["claude", { another: true }]),
    ).toThrow(/duplicate extension owner.*claude/i);
    for (const owner of ["__proto__", "constructor", "Constructor", "prototype", "PROTOTYPE", "toString", "TOSTRING"]) {
      expect(() => createAdapterExtensions(owner, { polluted: true })).toThrow(/canonical|reserved/i);
    }
    const safe = createAdapterExtensions("claude", { argumentHint: "<target>" });
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(Object.isFrozen(safe)).toBe(true);

    let entryReads = 0;
    const accessorEntry: unknown[] = [];
    Object.defineProperty(accessorEntry, "0", {
      enumerable: true,
      get: () => {
        entryReads += 1;
        return "claude";
      },
    });
    Object.defineProperty(accessorEntry, "1", {
      enumerable: true,
      get: () => {
        entryReads += 1;
        return { argumentHint: "<target>" };
      },
    });
    accessorEntry.length = 2;
    expect(() => createAdapterExtensions(accessorEntry as never)).toThrow(/extension entry|array|data propert/i);
    expect(entryReads).toBe(0);
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

  test("requires own frozen brands and clones command/persona leaves into each request", () => {
    const source = commandSource();
    const command = createResolvedCommand({ source, content: source.content });
    const persona = createResolvedPersona(personaSource());
    const request = createResolvedExecutionRequest({
      command,
      persona,
      engine: { name: "fixture-llm", kind: "llm" },
      authorization: { status: "not-required" },
      runtime: {},
      notices: [],
    });

    expect(request.command).not.toBe(command);
    expect(request.persona).not.toBe(persona);
    expect(Object.isFrozen(request.command)).toBe(true);
    expect(Object.isFrozen(request.persona)).toBe(true);
    expect(Object.getPrototypeOf(request.command)).toBe(Object.prototype);
    expect(Reflect.set(command as unknown as Record<string, unknown>, "content", "mutated")).toBe(false);
    expect(request.command.content).toBe(source.content);

    const inherited = Object.create(command) as typeof command;
    const overridden = Object.create(command, {
      content: { value: "---\nfrontmatter: leaked\n---\nWrong.", enumerable: true },
      raw: { value: "native bytes", enumerable: true },
      frontmatter: { value: { model: "attacker/model" }, enumerable: true },
    }) as typeof command;
    const base = {
      engine: { name: "fixture-llm", kind: "llm" as const },
      authorization: { status: "not-required" as const },
      runtime: {},
      notices: [],
    };
    expect(() => createResolvedExecutionRequest({ ...base, command: inherited })).toThrow(/execution boundary/i);
    expect(() => createResolvedExecutionRequest({ ...base, command: overridden })).toThrow(/execution boundary/i);
  });

  test("does not treat reflected construction symbols as execution provenance", () => {
    const source = commandSource();
    const command = createResolvedCommand({ source, content: source.content });
    const persona = createResolvedPersona(personaSource());
    const [commandBrand] = Object.getOwnPropertySymbols(command);
    const [personaBrand] = Object.getOwnPropertySymbols(persona);
    if (!commandBrand || !personaBrand) throw new Error("execution leaf brands are missing");

    const forgedCommand = {
      template: command.template,
      content: "---\nraw: leaked\n---\nDo the wrong work.",
      source: command.source,
    };
    Object.defineProperty(forgedCommand, commandBrand, { value: true, enumerable: false });
    Object.freeze(forgedCommand);

    const forgedPersona = {
      content: "---\nfrontmatter: leaked\n---\nWrong persona.",
      source: persona.source,
    };
    Object.defineProperty(forgedPersona, personaBrand, { value: true, enumerable: false });
    Object.freeze(forgedPersona);

    const base = {
      command,
      engine: { name: "fixture-llm", kind: "llm" as const },
      authorization: { status: "not-required" as const },
      runtime: {},
      notices: [],
    };
    expect(() => createResolvedExecutionRequest({ ...base, command: forgedCommand as never })).toThrow(
      /execution boundary/i,
    );
    expect(() => createResolvedExecutionRequest({ ...base, persona: forgedPersona as never })).toThrow(
      /execution boundary/i,
    );
  });

  test("rejects accessor-backed structured inputs before reading changing values", () => {
    const source = commandSource();
    let nameReads = 0;
    const engine = { kind: "llm" } as Record<string, unknown>;
    Object.defineProperty(engine, "name", {
      enumerable: true,
      get: () => {
        nameReads += 1;
        return nameReads === 1 ? "fixture-llm" : "mutated-engine";
      },
    });

    expect(() =>
      createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        engine: engine as never,
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      }),
    ).toThrow(/engine\.name|accessor|data propert/i);
    expect(nameReads).toBe(0);
  });

  test("clones caller-owned nested records before they can be mutated", () => {
    const source = commandSource();
    const engineSettings = { endpoint: "before" };
    const runtimeEnvironment = { MODE: "before" };
    const engine = { name: "fixture-llm", kind: "llm" as const, settings: engineSettings };
    const runtime = { environment: runtimeEnvironment };
    const request = createResolvedExecutionRequest({
      command: createResolvedCommand({ source, content: source.content }),
      engine,
      authorization: { status: "not-required" },
      runtime,
      notices: [],
    });

    engine.name = "mutated";
    engineSettings.endpoint = "after";
    runtimeEnvironment.MODE = "after";
    expect(request.engine).toEqual({ name: "fixture-llm", kind: "llm", settings: { endpoint: "before" } });
    expect(request.runtime.environment).toEqual({ MODE: "before" });
  });

  test("validates canonical identity in both adapter construction and durable decoding", () => {
    const valid: ExecutionSourceIdentity = {
      ref: "fixture//commands/review",
      bundle: "fixture",
      adapter: "akm",
      file: "commands/review.md",
      hash: "a".repeat(64),
    };
    for (const adapter of BUILTIN_ADAPTERS) {
      expect(decodeExecutionSourceIdentity({ ...valid, adapter: adapter.id }).adapter).toBe(adapter.id);
    }

    const invalid: Array<Partial<ExecutionSourceIdentity>> = [
      { ref: "fixture//../secrets/x" },
      { ref: "fixture//commands//review" },
      { ref: "fixture//commands/review " },
      { ref: "fixture//commands/re\u0301view" },
      { ref: "fixture//commands/review#fragment" },
      { bundle: "other" },
      { file: "C:/commands/review.md" },
      { file: "commands/\u0000review.md" },
      { file: "commands/\u001freview.md" },
      { file: "commands/\u2028review.md" },
      { ref: "fixture//commands/\u202Ereview" },
      { file: "commands/\uFEFFreview.md" },
      { ref: "fix\uD800ture//commands/review", bundle: "fix\uD800ture" },
      { adapter: "bad adapter" },
      { adapter: "Bad-Adapter" },
      { adapter: "bad.adapter" },
      { adapter: "bad_adapter" },
    ];
    for (const patch of invalid) {
      expect(() => decodeExecutionSourceIdentity({ ...valid, ...patch })).toThrow();
      expect(() =>
        renderMarkdownExecutionSource({
          kind: "command",
          raw: "---\nmodel: provider/exact\n---\nReview.\n",
          identity: {
            ref: patch.ref ?? valid.ref,
            bundle: patch.bundle ?? valid.bundle,
            adapter: patch.adapter ?? valid.adapter,
            file: patch.file ?? valid.file,
          },
        }),
      ).toThrow();
    }

    const source = commandSource();
    const canonical = JSON.parse(
      canonicalResolvedExecutionRequest(
        createResolvedExecutionRequest({
          command: createResolvedCommand({ source, content: source.content }),
          engine: { name: "fixture-llm", kind: "llm" },
          authorization: { status: "not-required" },
          runtime: {},
          notices: [],
        }),
      ),
    ) as { command: { source: ExecutionSourceIdentity } };
    for (const patch of invalid) {
      const hostile = structuredClone(canonical);
      Object.assign(hostile.command.source, patch);
      expect(() => decodeResolvedExecutionRequest(hostile)).toThrow();
    }

    expect(
      decodeExecutionSourceIdentity({
        ...valid,
        ref: "fixture//commands/レビュー",
        file: "commands/レビュー.md",
      }),
    ).toMatchObject({ ref: "fixture//commands/レビュー", file: "commands/レビュー.md" });
    expect(
      decodeExecutionSourceIdentity({
        ...valid,
        ref: "fixture//commands/👩‍💻",
        file: "commands/نامه‌نگاری.md",
      }),
    ).toMatchObject({ ref: "fixture//commands/👩‍💻", file: "commands/نامه‌نگاری.md" });
  });

  test("canonical encoding accepts only provenance-validated requests", () => {
    const source = commandSource();
    const request = createResolvedExecutionRequest({
      command: createResolvedCommand({ source, content: source.content }),
      engine: { name: "fixture-llm", kind: "llm" },
      authorization: { status: "not-required" },
      runtime: {},
      notices: [],
    });
    const canonical = canonicalResolvedExecutionRequest(request);
    const decoded = decodeResolvedExecutionRequest(JSON.parse(canonical));
    expect(canonicalResolvedExecutionRequest(decoded)).toBe(canonical);

    const unknown = { ...request, capabilities: { tools: true } };
    expect(() => canonicalResolvedExecutionRequest(unknown as never)).toThrow(/constructed|provenance|boundary/i);
    expect(() => canonicalResolvedExecutionRequest(JSON.parse(canonical) as never)).toThrow(
      /constructed|provenance|boundary/i,
    );
  });

  test("rejects unknown constructor fields, mismatched exact models, and unsafe timeouts", () => {
    const source = commandSource();
    const base = {
      command: createResolvedCommand({ source, content: source.content }),
      engine: { name: "fixture-llm", kind: "llm" as const },
      authorization: { status: "not-required" as const },
      runtime: {},
      notices: [],
    };
    expect(() => createResolvedExecutionRequest({ ...base, capabilities: {} } as never)).toThrow(/capabilities/i);
    expect(() =>
      createResolvedExecutionRequest({
        ...base,
        engine: { name: "fixture-llm", kind: "llm", capabilities: { tools: true } },
      } as never),
    ).toThrow(/capabilities/i);
    expect(() => createResolvedCommand({ source, content: source.content, raw: COMMAND_RAW } as never)).toThrow(/raw/i);
    expect(() =>
      createInlineResolvedCommand({ template: "Inline.", content: "Inline.", frontmatter: {} } as never),
    ).toThrow(/frontmatter/i);
    expect(() => createResolvedExecutionRequest({ ...base, runtime: { cwd: "/tmp" } } as never)).toThrow(/cwd/i);
    expect(() =>
      createResolvedExecutionRequest({ ...base, authorization: { status: "not-required", extra: true } } as never),
    ).toThrow(/extra/i);
    expect(() =>
      createResolvedExecutionRequest({
        ...base,
        notices: [{ code: "X", severity: "info", adapter: "akm", message: "x", extra: true }],
      } as never),
    ).toThrow(/extra/i);
    expect(() =>
      createResolvedExecutionRequest({
        ...base,
        model: { input: "provider/one", interpretation: "exact", resolved: "provider/two" },
      }),
    ).toThrow(/exact.*match|input.*resolved/i);
    expect(() =>
      createResolvedExecutionRequest({
        ...base,
        model: { input: "provider/one", interpretation: "exact", resolved: "provider/one", extra: true },
      } as never),
    ).toThrow(/model.*extra|extra/i);

    for (const timeoutMs of [-1, 1.5, WORKFLOW_MAX_TIMEOUT_MS + 1]) {
      expect(() => createResolvedExecutionRequest({ ...base, runtime: { timeoutMs } })).toThrow(/timeoutMs/i);
    }
    for (const timeoutMs of [0, WORKFLOW_MAX_TIMEOUT_MS]) {
      expect(createResolvedExecutionRequest({ ...base, runtime: { timeoutMs } }).runtime.timeoutMs).toBe(timeoutMs);
    }
    expect(EXECUTION_MAX_TIMEOUT_MS).toBe(WORKFLOW_MAX_TIMEOUT_MS);
  });

  test("every resolved-request constructor form canonicalizes and strictly decodes byte-identically", () => {
    const source = commandSource();
    const cases = [
      createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        engine: { name: "fixture-llm", kind: "llm" },
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      }),
      commonRequest(createResolvedCommand({ source, argumentInput: "", content: "Review  exactly once.\n" })),
      createResolvedExecutionRequest({
        command: createInlineResolvedCommand({ template: "Inline.", content: "Inline." }),
        persona: null,
        engine: { name: "fixture-agent", kind: "agent", settings: {} },
        model: null,
        inference: null,
        outputSchema: null,
        tools: null,
        authorization: { status: "not-required" },
        runtime: { timeoutMs: 0, workspace: "", environment: {}, settings: {} },
        notices: [],
        extensions: createAdapterExtensions("akm", {}),
      }),
    ];

    for (const request of cases) {
      const canonical = canonicalResolvedExecutionRequest(request);
      expect(canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(JSON.parse(canonical)))).toBe(canonical);
    }
  });
});
