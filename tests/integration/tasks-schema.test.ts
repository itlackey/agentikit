// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../src/execution/limits";
import {
  classifyTaskV3Uses,
  parseTaskV3Yaml,
  TASK_V3_HOST_SHELLS,
  TASK_V3_MAX_COLLECTION_ITEMS,
  TASK_V3_MAX_SCHEDULES,
  TASK_V3_MAX_STRING_BYTES,
  TASK_V3_SCHEMA_VERSION,
} from "../../src/tasks/source-v3";
import { WORKFLOW_MAX_EXEC_PASS_ENV, WORKFLOW_MAX_RETRIES } from "../../src/workflows/resource-limits";

const root = path.resolve(import.meta.dir, "..", "..");

interface JsonSchema {
  [key: string]: unknown;
  properties: Record<string, JsonSchema>;
  definitions: Record<string, JsonSchema>;
  oneOf: unknown[];
  allOf: unknown[];
}

function readTaskSchema(): JsonSchema {
  return JSON.parse(fs.readFileSync(path.join(root, "schemas", "akm-task.json"), "utf8")) as JsonSchema;
}

test("published task schema pins the strict v3 source vocabulary", () => {
  const schema = readTaskSchema();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  expect(schema.properties.version?.const).toBe(TASK_V3_SCHEMA_VERSION);
  expect(schema.required).toEqual(["version"]);
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(
    ["akm", "env", "name", "on", "run", "shell", "uses", "version", "with", "working-directory"].sort(),
  );
  expect(schema.oneOf).toHaveLength(3);
  expect(schema.allOf).toHaveLength(1);
  expect(schema.properties.shell?.enum).toEqual(TASK_V3_HOST_SHELLS);
  expect(schema.properties.with?.$ref).toBe("#/definitions/jsonObject");
  expect(pkg.files).toContain("schemas");
});

test("published task schema closes AKM controls and trigger shapes at parser bounds", () => {
  const schema = readTaskSchema();
  const akm = schema.properties.akm;
  const on = schema.properties.on;
  if (!akm || !on) throw new Error("Published task schema must define akm and on properties");

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

  const workingDirectory = new RegExp(schema.properties["working-directory"]?.pattern as string);
  expect(workingDirectory.test("scripts/release")).toBe(true);
  expect(workingDirectory.test("scripts/release/")).toBe(false);
  expect(workingDirectory.test("\\absolute-on-windows")).toBe(false);
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
