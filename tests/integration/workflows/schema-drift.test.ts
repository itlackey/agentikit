// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXTRA_PARAMS_CREDENTIAL_KEYS, EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS } from "../../../src/core/extra-params";
import {
  PROGRAM_ISOLATION_KINDS,
  PROGRAM_ON_ERROR,
  PROGRAM_PARAM_NAME_PATTERN,
  PROGRAM_REDUCERS,
  PROGRAM_RETRY_REASONS,
  PROGRAM_STEP_ID_PATTERN,
} from "../../../src/workflows/program/schema";

/**
 * `schemas/akm-workflow.json` stays in sync with the TypeScript vocabulary
 * (workflow-format-unification, spec §2.5) — the closed-key JSON Schema
 * replaces the old hand-maintained frontmatter allowlist, but its enum
 * vocabularies and patterns must never drift from `program/schema.ts`'s
 * exported constants, which the parser (`parser.ts`) actually enforces.
 */
describe("schemas/akm-workflow.json stays in sync with the TS vocabulary", () => {
  const schemaPath = path.resolve(import.meta.dir, "../../../schemas/akm-workflow.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    definitions: Record<string, { enum?: string[]; pattern?: string; properties?: Record<string, unknown> }>;
    properties: Record<string, { propertyNames?: { pattern?: string } }>;
  };
  const envelopePath = path.resolve(import.meta.dir, "../../../schemas/akm-asset-envelope.json");
  const envelope = JSON.parse(fs.readFileSync(envelopePath, "utf8")) as {
    definitions: Record<string, unknown>;
  };

  test("enum vocabularies match the exported constants", () => {
    expect(schema.definitions.onError!.enum).toEqual([...PROGRAM_ON_ERROR]);
    expect(schema.definitions.reducer!.enum).toEqual([...PROGRAM_REDUCERS]);
    expect(schema.definitions.isolation!.enum).toEqual([...PROGRAM_ISOLATION_KINDS]);
    expect(schema.definitions.failureReason!.enum).toEqual([...PROGRAM_RETRY_REASONS]);
  });

  test("id and param-name patterns match", () => {
    expect(schema.definitions.identifier!.pattern).toBe(PROGRAM_STEP_ID_PATTERN.source);
    expect(schema.properties.params!.propertyNames?.pattern).toBe(PROGRAM_PARAM_NAME_PATTERN.source);
  });

  test("budget block keys match the parser's vocabulary", () => {
    expect(Object.keys(schema.definitions.budget!.properties ?? {}).sort()).toEqual(["max_tokens", "max_units"]);
    expect("budget" in schema.properties).toBe(true);
  });

  test("no version/name/title/instructions/criteria keys survive", () => {
    expect("version" in schema.properties).toBe(false);
    expect("name" in schema.properties).toBe(false);
    const stepKeys = Object.keys(
      (schema.definitions.step as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(stepKeys).not.toContain("title");
    const unitKeys = Object.keys(
      (schema.definitions.unit as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(unitKeys).not.toContain("instructions");
    const gateKeys = Object.keys(
      (schema.definitions.gate as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(gateKeys).not.toContain("criteria");
    expect(gateKeys).not.toContain("required");
    expect(gateKeys).toEqual(["max_loops"]);
    expect(stepKeys).toContain("inputs");
  });

  test("extra_params documents top-level protection and recursive credential semantics", () => {
    const extraParams = schema.definitions.extraParams as Record<string, unknown>;
    expect(extraParams["x-akm-protectedTopLevelNormalizedKeys"]).toEqual(EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS);
    expect(extraParams["x-akm-recursivelyForbiddenNormalizedKeys"]).toEqual(EXTRA_PARAMS_CREDENTIAL_KEYS);
  });

  test("the workflow schema $refs the shared asset envelope for every envelope key", () => {
    const envelopeKeys = Object.keys(envelope.definitions);
    for (const key of [
      "type",
      "description",
      "tags",
      "when_to_use",
      "xrefs",
      "updated",
      "timestamp",
      "generated",
      "verified",
      "provenance",
      "status",
      "stale_after",
    ]) {
      expect(envelopeKeys).toContain(key);
      const prop = schema.properties[key] as unknown as { $ref?: string };
      expect(prop?.$ref).toBe(`akm-asset-envelope.json#/definitions/${key}`);
    }
  });
});
