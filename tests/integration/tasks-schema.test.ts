// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Schema-drift gate for `schemas/akm-task.json`.
 *
 * P2a (spec docs/plans/specs/p2a-task-source-v4.md §5.3, §6 F-1) turns the
 * published schema into a two-arm `oneOf` at the document root: "arm 1:
 * today's v3 object, moved under the arm unchanged"; "arm 2: the v4 object".
 * `v3Arm()` / `v4Arm()` below find each arm by its `properties.version.const`
 * rather than by array index, so this file makes no assumption about arm
 * ORDER (the spec's prose lists v3 first, but nothing pins that as the
 * on-disk index). `definitions` stays shared at the document root: §5.3 has
 * the v4 arm "reusing the existing outputSchema grammar definition" and
 * keeping the `uses` oneOf's non-github alternative, both possible only if
 * `$ref: "#/definitions/…"` still resolves against one shared,
 * un-duplicated map — the moment defs were split per-arm, a `$ref` would
 * need rewriting, which the spec's "unchanged" language for the v3 arm rules
 * out.
 *
 * The five tests F-1 names ("Its five existing tests keep their intent,
 * re-rooted at the v3 arm") are re-rooted at `v3Arm(schema)` below; the one
 * F-1 says "stays as-is" is untouched; `published schema declares the
 * authoritative runtime-only resource constraints` — present at HEAD but not
 * named by F-1's prose — is KEPT (deleting an existing test to make a flip
 * disappear is not authorized, spec §9 acceptance criteria) with only its
 * `authoritativeParser` expectation loosened to name both parsers, since
 * `x-akm-runtimeConstraints` itself stays document-level metadata, not
 * per-arm.
 *
 * The new v4-arm tests below prefer BEHAVIORAL assertions (compile the
 * schema with Ajv and validate/reject representative documents) over
 * structural ones (poking `.properties`/`.additionalProperties` of a
 * sub-schema) wherever the spec does not pin an exact JSON-Schema authoring
 * shape — Implement is free to express "closed to TASK_INPUT_DECLARATION_KEYS"
 * or "bounded at TASK_V3_MAX_SCHEDULES" however it likes; what matters is the
 * resulting accept/reject behavior. The exception is the v4 arm's top-level
 * `properties` key SET, which is spec-pinned exactly ("properties exactly
 * TASK_SOURCE_V4_TOP_LEVEL_KEYS") and is checked structurally, mirroring how
 * `published task schema pins the strict v3 source vocabulary` already
 * checks the v3 arm's own top-level key set today.
 *
 * Every v4 assertion is derived from task source v4's exported constants
 * (`TASK_SOURCE_V4_VERSION`, `TASK_SOURCE_V4_TOP_LEVEL_KEYS`,
 * `TASK_SOURCE_V4_SCHEDULE_KEYS`, `TASK_INPUT_DECLARATION_KEYS`) or from
 * existing shared bounds (`TASK_V3_MAX_SCHEDULES`, `WORKFLOW_MAX_PARAMS`) —
 * never restated as literals — per the task brief's binding instruction.
 *
 * RED phase: `src/tasks/source/task-source-v4.ts` does not exist on disk yet
 * (Lane A), so the one import of it below carries a directly-preceding
 *
 *   // @ts-expect-error P2a red-phase: <symbol> lands in Implement
 *
 * directive, placed on the module-specifier line per this phase's convention
 * (established in tests/tasks/source-v4.test.ts and
 * tests/execution/input-contract.test.ts, verified empirically against this
 * repo's tsconfig: one pin exactly where `tsc` reports the diagnostic, none
 * on any downstream use). `schemas/akm-task.json` itself also has no v4 arm
 * yet, so every new test below fails at runtime too, until the schema, the
 * task-source-v4.ts constants, and this file land together in one commit
 * (spec §5.3, binding).
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../src/execution/limits";
import {
  TASK_INPUT_DECLARATION_KEYS,
  TASK_SOURCE_V4_SCHEDULE_KEYS,
  TASK_SOURCE_V4_TOP_LEVEL_KEYS,
  TASK_SOURCE_V4_VERSION,
  // @ts-expect-error P2a red-phase: src/tasks/source/task-source-v4.ts lands in Implement (whole module is new; tsc reports the diagnostic on the module-specifier line directly below)
} from "../../src/tasks/source/task-source-v4";
import {
  classifyTaskV3Uses,
  parseTaskV3Yaml,
  TASK_V3_HOST_SHELLS,
  TASK_V3_MAX_COLLECTION_ITEMS,
  TASK_V3_MAX_SCHEDULES,
  TASK_V3_MAX_STRING_BYTES,
  TASK_V3_SCHEMA_VERSION,
} from "../../src/tasks/source-v3";
import { PROGRAM_PARAM_NAME_PATTERN } from "../../src/workflows/program/schema";
import {
  WORKFLOW_MAX_EXEC_PASS_ENV,
  WORKFLOW_MAX_PARAMS,
  WORKFLOW_MAX_RETRIES,
} from "../../src/workflows/resource-limits";

const root = path.resolve(import.meta.dir, "..", "..");

interface JsonSchema {
  [key: string]: unknown;
  properties: Record<string, JsonSchema>;
  definitions: Record<string, JsonSchema>;
  oneOf: unknown[];
  allOf: unknown[];
}

/** The document root after P2a: a shared `definitions` map plus a two-arm `oneOf` (§5.3). */
interface TaskSchemaDocument {
  [key: string]: unknown;
  oneOf: JsonSchema[];
  definitions: Record<string, JsonSchema>;
}

function readTaskSchema(): TaskSchemaDocument {
  return JSON.parse(fs.readFileSync(path.join(root, "schemas", "akm-task.json"), "utf8")) as TaskSchemaDocument;
}

/** Find the root `oneOf` arm whose `properties.version.const` matches — order-independent (see file header). */
function armByVersion(schema: TaskSchemaDocument, version: number): JsonSchema {
  const arm = schema.oneOf.find((candidate) => candidate.properties?.version?.const === version);
  if (!arm) {
    throw new Error(`published task schema must publish a root oneOf arm with properties.version.const === ${version}`);
  }
  return arm;
}

function v3Arm(schema: TaskSchemaDocument): JsonSchema {
  return armByVersion(schema, TASK_V3_SCHEMA_VERSION);
}

function v4Arm(schema: TaskSchemaDocument): JsonSchema {
  return armByVersion(schema, TASK_SOURCE_V4_VERSION);
}

// ── The five tests F-1 re-roots at the v3 arm, plus the one it leaves as-is ─

test("published task schema pins the strict v3 source vocabulary", () => {
  const schema = readTaskSchema();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const v3 = v3Arm(schema);

  expect(v3.properties.version?.const).toBe(TASK_V3_SCHEMA_VERSION);
  expect(v3.required).toEqual(["version"]);
  expect(v3.additionalProperties).toBe(false);
  expect(Object.keys(v3.properties).sort()).toEqual(
    ["akm", "env", "name", "on", "run", "shell", "uses", "version", "with", "working-directory"].sort(),
  );
  expect(v3.oneOf).toHaveLength(3);
  expect(v3.allOf).toHaveLength(1);
  expect(v3.properties.shell?.enum).toEqual(TASK_V3_HOST_SHELLS);
  expect(v3.properties.with?.$ref).toBe("#/definitions/jsonObject");
  expect(pkg.files).toContain("schemas");
  // The root itself is now the two-arm oneOf described in the file header —
  // exactly one other arm exists (the v4 one, asserted in its own tests
  // below), so the v3 arm is not accidentally one of three-or-more.
  expect(schema.oneOf).toHaveLength(2);
});

test("published task schema closes AKM controls and trigger shapes at parser bounds", () => {
  const schema = readTaskSchema();
  const v3 = v3Arm(schema);
  const akm = v3.properties.akm;
  const on = v3.properties.on;
  if (!akm || !on) throw new Error("Published task schema's v3 arm must define akm and on properties");

  expect(akm.additionalProperties).toBe(false);
  expect(Object.keys(akm.properties).sort()).toEqual(
    [
      "agent",
      "description",
      "enabled",
      "engine",
      "inference",
      "maxRetries",
      "maxSteps",
      "model",
      "outputSchema",
      "redact",
      "schedule",
      "tags",
      "timeout",
      "tools",
      "when_to_use",
    ].sort(),
  );
  expect(akm.properties.maxRetries?.maximum).toBe(WORKFLOW_MAX_RETRIES);
  expect(akm.properties.redact?.maxItems).toBe(WORKFLOW_MAX_EXEC_PASS_ENV);
  expect((akm.properties.timeout?.oneOf as JsonSchema[])[0]?.maximum).toBe(EXECUTION_MAX_TIMEOUT_MS);

  expect(on.additionalProperties).toBe(false);
  expect(Object.keys(on.properties).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(on.properties.schedule?.minItems).toBe(1);
  expect(on.properties.schedule?.maxItems).toBe(TASK_V3_MAX_SCHEDULES);
  expect(on.properties.schedule?.items).toMatchObject({
    type: "object",
    required: ["cron"],
    additionalProperties: false,
  });
  expect(schema.definitions.jsonArray?.maxItems).toBe(TASK_V3_MAX_COLLECTION_ITEMS);
  expect(schema.definitions.jsonValue?.oneOf).toContainEqual({
    type: "string",
    maxLength: TASK_V3_MAX_STRING_BYTES,
  });
});

test("every published pattern is valid ECMAScript and representative uses refs agree with the production parser", () => {
  const schema = readTaskSchema();
  const v3 = v3Arm(schema);
  const patterns: string[] = [];
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "pattern" && typeof child === "string") patterns.push(child);
      else stack.push(child);
    }
  }
  expect(patterns.length).toBeGreaterThan(0);
  for (const pattern of patterns) expect(() => new RegExp(pattern), pattern).not.toThrow();

  const executableRef = new RegExp(schema.definitions.akmExecutableRef?.pattern as string);
  const githubActionRef = new RegExp(schema.definitions.githubActionRef?.pattern as string);
  expect(executableRef.test("commands/review")).toBe(true);
  expect(executableRef.test("team//workflows/release")).toBe(true);
  expect(executableRef.test("agents/reviewer")).toBe(false);
  expect(executableRef.test("commands/review//nested")).toBe(false);
  expect(executableRef.test("commands/review/")).toBe(false);
  expect(executableRef.test("commands/my command")).toBe(false);
  for (const candidate of ["commands/./review", "commands/../review", "commands/review\0"]) {
    expect(executableRef.test(candidate), candidate).toBe(false);
    expect(() => classifyTaskV3Uses(candidate), candidate).toThrow();
  }
  expect(githubActionRef.test("actions/checkout@v4")).toBe(true);
  expect(githubActionRef.test("owner/repo@@v1")).toBe(false);
  for (const candidate of ["owner/.@v1", "owner/..@v1", "owner/repo/.@v1", "owner/repo/..@v1", "owner/repo@v1\u007f"]) {
    expect(githubActionRef.test(candidate), candidate).toBe(false);
    expect(() => classifyTaskV3Uses(candidate), candidate).toThrow();
  }

  const workingDirectory = new RegExp(v3.properties["working-directory"]?.pattern as string);
  expect(workingDirectory.test("scripts/release")).toBe(true);
  expect(workingDirectory.test("scripts/release/")).toBe(false);
  expect(workingDirectory.test("\\absolute-on-windows")).toBe(false);
});

test("draft-07 validation follows the parser's exact uses-classification precedence", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const executableRef = new RegExp(schema.definitions.akmExecutableRef?.pattern as string);
  const githubActionRef = new RegExp(schema.definitions.githubActionRef?.pattern as string);
  const cases = [
    ["akm/command", { with: { content: "" } }, 0],
    ["commands/review", {}, 1],
    ["commands/review@v1", {}, 1],
    ["commands/tools/review@v1", {}, 1],
    ["workflows/release@v1", {}, 1],
    ["scripts/check@v1", {}, 1],
    ["team//commands/review@v1", {}, 1],
    ["actions/checkout@v4", {}, 1],
  ] as const;

  for (const [uses, extra, expectedPatternMatches] of cases) {
    expect(() => classifyTaskV3Uses(uses), uses).not.toThrow();
    const patternMatches = Number(executableRef.test(uses)) + Number(githubActionRef.test(uses));
    expect(patternMatches, `${uses} must select exactly its parser-precedence schema arm`).toBe(expectedPatternMatches);
    expect(
      validate({ version: 3, uses, ...extra, akm: { schedule: "@daily" } }),
      `${uses}: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);
  }
});

test("published schema declares the authoritative runtime-only resource constraints", () => {
  const schema = readTaskSchema();
  const constraints = schema["x-akm-runtimeConstraints"] as Record<string, unknown>;
  // §5.3: "title / description / x-akm-runtimeConstraints.authoritativeParser
  // updated to name both parsers." The spec does not pin whether that value
  // becomes an array or a joined string, so this only asserts both parser
  // paths are named SOMEWHERE in the field rather than fixing one encoding.
  const authoritativeParser = JSON.stringify(constraints.authoritativeParser);
  expect(authoritativeParser).toContain("src/tasks/source-v3.ts");
  expect(authoritativeParser).toContain("src/tasks/source/task-source-v4.ts");
  expect(constraints.maxSourceUtf8Bytes).toBe(1_048_576);
  expect(constraints.maxStringUtf8Bytes).toBe(TASK_V3_MAX_STRING_BYTES);
  expect(constraints.maxJsonDepth).toBe(64);
  expect(constraints.maxJsonNodes).toBe(10_000);
  expect(constraints.canonicalRefsRequireNfc).toBe(true);
  expect(constraints.workingDirectoryRequiresWorkspaceRoot).toBe(true);

  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const byteBounded = { version: 3, name: "😀".repeat(70_000), uses: "commands/review", akm: { schedule: "@daily" } };
  expect(validate(byteBounded), JSON.stringify(validate.errors)).toBe(true);
  expect(() => parseTaskV3Yaml({ yaml: JSON.stringify(byteBounded), filePath: "utf8-bytes.yml" })).toThrow(
    /byte|string/i,
  );

  const noncanonicalRef = { version: 3, uses: "commands/cafe\u0301", akm: { schedule: "@daily" } };
  expect(validate(noncanonicalRef), JSON.stringify(validate.errors)).toBe(true);
  expect(() => parseTaskV3Yaml({ yaml: JSON.stringify(noncanonicalRef), filePath: "canonical-ref.yml" })).toThrow(
    /canonical|ref|uses/i,
  );
});

test("published outputSchema grammar rejects keywords the runtime subset cannot enforce", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const validTask = {
    version: 3,
    uses: "commands/review",
    akm: {
      schedule: "@daily",
      outputSchema: {
        type: "object",
        properties: { result: { type: "string", minLength: 1 } },
        required: ["result"],
        additionalProperties: false,
      },
    },
  };
  const unsupported = structuredClone(validTask);
  unsupported.akm.outputSchema.properties.result = { type: "string", pattern: "^ok$" } as never;

  expect(validate(validTask), JSON.stringify(validate.errors)).toBe(true);
  expect(() => parseTaskV3Yaml({ yaml: JSON.stringify(validTask), filePath: "valid.yml" })).not.toThrow();
  expect(validate(unsupported), JSON.stringify(validate.errors)).toBe(false);
  expect(() => parseTaskV3Yaml({ yaml: JSON.stringify(unsupported), filePath: "unsupported.yml" })).toThrow(
    /pattern|unsupported/i,
  );
});

test("the production parser consumes the same strict v3 spellings the schema publishes", () => {
  const task = parseTaskV3Yaml({
    filePath: "/stash/tasks/daily.yml",
    yaml: [
      "version: 3",
      "name: Daily",
      "uses: workflows/daily-backup",
      "with:",
      "  keep: 7",
      "env:",
      "  QUIET: false",
      "akm:",
      "  enabled: false",
      "  timeout: 20m",
      "  maxSteps: 8",
      "  maxRetries: 1",
      "on:",
      "  schedule:",
      "    - cron: '0 3 * * *'",
      "  workflow_dispatch: {}",
      "",
    ].join("\n"),
  });

  expect(task.version).toBe(3);
  expect(task.target).toMatchObject({ kind: "uses", uses: { kind: "workflow", ref: "workflows/daily-backup" } });
  expect(task.akm).toMatchObject({ enabled: false, timeout: "20m", maxSteps: 8, maxRetries: 1 });
  expect(task.triggers).toEqual({
    manual: true,
    schedules: [{ cron: "0 3 * * *", source: "on.schedule[0].cron", ordinal: 0 }],
  });
});

// ── NEW: the v4 arm, asserted against task source v4's exported constants ──

test("published task schema's v4 arm publishes the exact top-level key set (D2-N7)", () => {
  const schema = readTaskSchema();
  const v4 = v4Arm(schema);

  expect(v4.properties.version?.const).toBe(TASK_SOURCE_V4_VERSION);
  expect(v4.additionalProperties).toBe(false);
  expect(Object.keys(v4.properties).sort()).toEqual([...TASK_SOURCE_V4_TOP_LEVEL_KEYS].sort());
  // D2-N7: the akm: bag and the on: trigger block are gone in v4.
  expect(TASK_SOURCE_V4_TOP_LEVEL_KEYS).not.toContain("akm");
  expect(TASK_SOURCE_V4_TOP_LEVEL_KEYS).not.toContain("on");
  expect(Object.keys(v4.properties)).not.toContain("akm");
  expect(Object.keys(v4.properties)).not.toContain("on");
});

test("published task schema's root oneOf validates version: 4 only against the v4 arm (an akm: / on: key fails it, D2-N7)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  // Sanity: the base document (no akm:/on:) is otherwise valid — proves the
  // two rejections below are specifically about akm:/on:, not some unrelated
  // shape mistake in this fixture.
  expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...base, akm: { schedule: "@daily" } }), "akm: must fail every oneOf arm for a v4 document").toBe(
    false,
  );
  expect(
    validate({ ...base, on: { workflow_dispatch: null } }),
    "on: must fail every oneOf arm for a v4 document",
  ).toBe(false);
});

test("published task schema's v4 arm removes the github-action uses: target while the v3 arm keeps it (B-13)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const githubRef = "actions/checkout@v4";

  // v3 still recognizes (and, per source-v3.ts, rejects at the parser layer
  // with an "unsupported" message — but the PUBLISHED SCHEMA still accepts
  // the shape, unchanged by P2a).
  expect(
    validate({ version: 3, uses: githubRef, akm: { schedule: "@daily" } }),
    "v3 arm must still accept a github-action uses: shape",
  ).toBe(true);

  // v4 removes the target outright: neither variant validates.
  expect(
    validate({ version: TASK_SOURCE_V4_VERSION, uses: githubRef }),
    "v4 arm must reject a github-action uses:",
  ).toBe(false);
  expect(
    validate({ version: TASK_SOURCE_V4_VERSION, uses: "commands/review" }),
    "v4 arm must still accept a canonical uses: ref",
  ).toBe(true);
});

test("published task schema's v4 arm bounds schedule: at TASK_V3_MAX_SCHEDULES and closes each entry to TASK_SOURCE_V4_SCHEDULE_KEYS (D2-N5)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };
  const entry = (i: number) => ({ cron: `${i % 60} * * * *` });

  const atBound = Array.from({ length: TASK_V3_MAX_SCHEDULES }, (_, i) => entry(i));
  const overBound = [...atBound, entry(TASK_V3_MAX_SCHEDULES)];
  expect(validate({ ...base, schedule: atBound }), `schedule: at exactly ${TASK_V3_MAX_SCHEDULES} entries`).toBe(true);
  expect(validate({ ...base, schedule: overBound }), `schedule: one entry over ${TASK_V3_MAX_SCHEDULES}`).toBe(false);

  // String shorthand (D2): one enabled binding, no inputs.
  expect(validate({ ...base, schedule: "0 8 * * 1" })).toBe(true);

  // Every TASK_SOURCE_V4_SCHEDULE_KEYS key is accepted on one entry...
  const fullEntry: Record<string, unknown> = { cron: "0 8 * * 1" };
  if (TASK_SOURCE_V4_SCHEDULE_KEYS.includes("enabled")) fullEntry.enabled = false;
  if (TASK_SOURCE_V4_SCHEDULE_KEYS.includes("inputs")) fullEntry.inputs = { scope: "all" };
  expect(Object.keys(fullEntry).sort()).toEqual([...TASK_SOURCE_V4_SCHEDULE_KEYS].sort());
  expect(validate({ ...base, schedule: [fullEntry] }), JSON.stringify(validate.errors)).toBe(true);

  // ...but a key outside that closed set is rejected.
  expect(validate({ ...base, schedule: [{ cron: "0 8 * * 1", bogusKey: true }] }), "an unlisted schedule key").toBe(
    false,
  );
});

test("published task schema's v4 arm closes input declarations to TASK_INPUT_DECLARATION_KEYS (D2-N3)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  // Sample values for every key TASK_INPUT_DECLARATION_KEYS lists (spec
  // §1.5 D2-N3), each offered one at a time alongside a bare `type: "string"`
  // base so a bad sample for one key cannot mask a real rejection of
  // another. Values are illustrative only — the SET of keys under test comes
  // from the constant, not from this map.
  const sampleValueByKey: Readonly<Record<string, unknown>> = {
    type: "string",
    enum: ["a", "b"],
    properties: { a: { type: "string" } },
    required: true, // D2-N3: at the declaration ROOT, `required` is a boolean, not a JSON-Schema array.
    items: { type: "string" },
    additionalProperties: false,
    minItems: 0,
    maxItems: 10,
    minLength: 0,
    maxLength: 10,
    minimum: 0,
    maximum: 10,
    allOf: [{ type: "string" }],
    anyOf: [{ type: "string" }],
    oneOf: [{ type: "string" }],
    not: { type: "number" },
    title: "Title",
    description: "Description",
    default: "value",
  };

  for (const key of TASK_INPUT_DECLARATION_KEYS) {
    if (!Object.hasOwn(sampleValueByKey, key)) continue; // no sample authored above — not a coverage gap in the constant, just this test's fixture table
    const declaration = { type: "string", [key]: sampleValueByKey[key] };
    const doc = { ...base, inputs: { x: declaration } };
    expect(
      validate(doc),
      `inputs.x.${key} = ${JSON.stringify(sampleValueByKey[key])}: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);
  }

  // Every sample key offered above is actually one TASK_INPUT_DECLARATION_KEYS lists.
  for (const key of Object.keys(sampleValueByKey)) {
    expect(TASK_INPUT_DECLARATION_KEYS, `${key} must be listed in TASK_INPUT_DECLARATION_KEYS`).toContain(key);
  }

  // `pattern` is deliberately absent from TASK_INPUT_DECLARATION_KEYS (it is
  // also the runtime-subset probe the existing outputSchema test above
  // uses) — a declaration that names it must be rejected as an unknown key.
  expect(TASK_INPUT_DECLARATION_KEYS).not.toContain("pattern");
  expect(
    validate({ ...base, inputs: { x: { type: "string", pattern: "^ok$" } } }),
    "an input declaration with an unlisted keyword must be rejected",
  ).toBe(false);

  // D2-N3: `required` at the declaration root is the boolean flag, not JSON
  // Schema's `required` ARRAY — the array shape must be rejected here even
  // though it is a perfectly ordinary keyword one level down (inside
  // `properties`, tested implicitly above via the `properties` sample).
  expect(
    validate({ ...base, inputs: { x: { type: "string", required: ["x"] } } }),
    "declaration-root required: must be boolean, not an array",
  ).toBe(false);
});

test("published task schema's v4 arm bounds inputs: at WORKFLOW_MAX_PARAMS declared inputs (D2-N3)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  const declarations = (count: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      const name = `p${i}`;
      expect(PROGRAM_PARAM_NAME_PATTERN.test(name), name).toBe(true);
      out[name] = { type: "string" };
    }
    return out;
  };

  expect(
    validate({ ...base, inputs: declarations(WORKFLOW_MAX_PARAMS) }),
    `exactly ${WORKFLOW_MAX_PARAMS} inputs`,
  ).toBe(true);
  expect(
    validate({ ...base, inputs: declarations(WORKFLOW_MAX_PARAMS + 1) }),
    `one input over ${WORKFLOW_MAX_PARAMS}`,
  ).toBe(false);
});
