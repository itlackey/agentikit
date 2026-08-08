// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The JSON-Schema subset's NEWLY ENFORCED keywords — `pattern` and the
 * combinators `allOf`/`anyOf`/`oneOf`/`not` (`src/core/json-schema.ts`).
 *
 * Each was previously a loud author-time error precisely because the runtime
 * ignored it, so the load-bearing assertion in every case below is the
 * NEGATIVE one: an invalid value must be REJECTED. A test that only checks
 * that a valid value passes would pass just as happily against the old
 * ignore-the-keyword behavior.
 *
 * Also pins the ReDoS screen and the evaluation bounds documented in that
 * module's header: an unsafe pattern and an over-long subject are ERRORS, not
 * silent acceptances — the subset never fails open.
 */

import { describe, expect, test } from "bun:test";
import {
  JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH,
  JSON_SCHEMA_MAX_PATTERN_LENGTH,
  JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS,
  screenPattern,
  validateJsonSchemaSubset,
} from "../../src/core/json-schema";

describe("validateJsonSchemaSubset — pattern", () => {
  const semver = { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" };

  test("a matching string passes and a non-matching one is REJECTED (proving it is evaluated)", () => {
    expect(validateJsonSchemaSubset("1.2.3", semver)).toEqual([]);
    const errors = validateJsonSchemaSubset("v1.2", semver);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not match pattern");
  });

  test("pattern composes with the surrounding object/array constraints", () => {
    const schema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", pattern: "^(?:pass|fail)$" },
        tags: { type: "array", items: { type: "string", pattern: "^[a-z][a-z0-9-]*$" } },
      },
    };
    expect(validateJsonSchemaSubset({ verdict: "pass", tags: ["needs-work"] }, schema)).toEqual([]);
    const errors = validateJsonSchemaSubset({ verdict: "maybe", tags: ["Needs Work"] }, schema);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("$.verdict");
    expect(errors[1]).toContain("$.tags[0]");
  });

  test("pattern only constrains strings (a non-string is left to `type`)", () => {
    expect(validateJsonSchemaSubset(42, { pattern: "^a$" })).toEqual([]);
    expect(validateJsonSchemaSubset(null, { pattern: "^a$" })).toEqual([]);
  });

  test("an unsafe pattern is an ERROR at evaluation time, never a silent pass", () => {
    const errors = validateJsonSchemaSubset("aaaaaaaaaaaaaaaaaaaa!", { type: "string", pattern: "^(a+)+$" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot be evaluated safely");
  });

  test("a subject longer than the matching bound is an ERROR, not a match attempt", () => {
    const long = "x".repeat(JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH + 1);
    const errors = validateJsonSchemaSubset(long, { type: "string", pattern: "^x+$" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH}-character limit`);
    // Exactly at the bound it is matched normally.
    expect(
      validateJsonSchemaSubset("x".repeat(JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH), {
        type: "string",
        pattern: "^x+$",
      }),
    ).toEqual([]);
  });
});

describe("screenPattern — the ReDoS guard", () => {
  test("ordinary authoring patterns are accepted", () => {
    for (const pattern of [
      "^\\d+\\.\\d+\\.\\d+$",
      "^[a-z][a-z0-9-]*$",
      "^(?:pass|fail|skip)$",
      "^v?\\d+(\\.\\d+)*$",
      "^[a-f0-9]{40}$",
      "^https?://[^\\s]+$",
      "^\\w+(-\\w+)*$",
      "(foo|bar)+",
    ]) {
      expect(screenPattern(pattern).ok).toBe(true);
    }
  });

  test("the constructs that backtrack exponentially or polynomially are rejected", () => {
    const unsafe = ["^(a+)+$", "^(a|a)*$", "^(a*)*$", "^.*.*$", "\\d+\\w+"];
    for (const pattern of unsafe) {
      const screened = screenPattern(pattern);
      expect(screened.ok).toBe(false);
      if (!screened.ok) expect(screened.reason.length).toBeGreaterThan(0);
    }
  });

  test("size bounds: pattern length, counted repetition, and invalid syntax", () => {
    const tooLong = `^${"a".repeat(JSON_SCHEMA_MAX_PATTERN_LENGTH)}$`;
    expect(screenPattern(tooLong).ok).toBe(false);
    expect(screenPattern("a{1,5000}").ok).toBe(false);
    expect(screenPattern("(").ok).toBe(false);
    expect(screenPattern("[a-z").ok).toBe(false);
  });

  test("screening is total — it never throws, on any of these shapes", () => {
    for (const pattern of ["", "*", ")", "\\", "(?<name>a)", "(?=a)b", "[]", "[^]", "a{", "{2}", "\\p{L}+"]) {
      expect(() => screenPattern(pattern)).not.toThrow();
    }
  });
});

describe("validateJsonSchemaSubset — combinators", () => {
  test("oneOf accepts exactly one match and REJECTS zero or several", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "integer" }] };
    expect(validateJsonSchemaSubset("x", schema)).toEqual([]);
    expect(validateJsonSchemaSubset(7, schema)).toEqual([]);

    const none = validateJsonSchemaSubset(true, schema);
    expect(none).toHaveLength(1);
    expect(none[0]).toContain('matches none of the 2 "oneOf" schemas');

    // `integer` also satisfies `number`, so 7 matches BOTH branches here.
    const several = validateJsonSchemaSubset(7, { oneOf: [{ type: "integer" }, { type: "number" }] });
    expect(several).toHaveLength(1);
    expect(several[0]).toContain("exactly one must match");
  });

  test("anyOf accepts any matching branch and REJECTS a value matching none", () => {
    const schema = {
      anyOf: [
        { type: "string", minLength: 3 },
        { type: "integer", minimum: 10 },
      ],
    };
    expect(validateJsonSchemaSubset("abc", schema)).toEqual([]);
    expect(validateJsonSchemaSubset(11, schema)).toEqual([]);

    const errors = validateJsonSchemaSubset("ab", schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('matches none of the 2 "anyOf" schemas');
    // The summary names why each branch failed, so it is actionable.
    expect(errors[0]).toContain("minLength");
  });

  test("allOf requires every branch and surfaces each failure verbatim", () => {
    const schema = {
      allOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    };
    expect(validateJsonSchemaSubset({ a: 1, b: 2 }, schema)).toEqual([]);
    const errors = validateJsonSchemaSubset({ a: 1 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`missing required property "b"`);
  });

  test("not inverts its subschema", () => {
    expect(validateJsonSchemaSubset("x", { not: { type: "number" } })).toEqual([]);
    const errors = validateJsonSchemaSubset(3, { not: { type: "number" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`must not match the "not" schema`);
  });

  test("combinators nest inside properties/items and keep the value path", () => {
    const schema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: { anyOf: [{ type: "string", pattern: "^ok$" }, { type: "null" }] },
        },
      },
    };
    expect(validateJsonSchemaSubset({ results: ["ok", null] }, schema)).toEqual([]);
    const errors = validateJsonSchemaSubset({ results: ["ok", "nope"] }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("$.results[1]");
  });

  test("combinators and the type/enum keywords coexist on one schema", () => {
    const schema = { type: "string", enum: ["pass", "fail"], allOf: [{ minLength: 4 }] };
    expect(validateJsonSchemaSubset("pass", schema)).toEqual([]);
    expect(validateJsonSchemaSubset("skip", schema)).not.toEqual([]);
    expect(validateJsonSchemaSubset(7, schema)).not.toEqual([]);
  });
});

describe("validateJsonSchemaSubset — totality", () => {
  test("a deeply nested combinator chain terminates and reports the depth limit", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200; i++) schema = { allOf: [schema] };
    const errors = validateJsonSchemaSubset("x", schema);
    expect(errors.some((e) => e.includes("depth limit"))).toBe(true);
  });

  test("a large array against a combinator schema stays bounded and fails closed", () => {
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
    };
    const value = Array.from({ length: 200_000 }, (_, i) => i);
    const errors = validateJsonSchemaSubset(value, schema);
    // The evaluation is stopped by the node budget rather than running forever,
    // and says so instead of returning a clean (i.e. "valid") result.
    expect(errors.some((e) => e.includes("exceeded the limit"))).toBe(true);
  });

  test("the advertised supported-keyword list names the newly enforced keywords", () => {
    for (const keyword of ["pattern", "allOf", "anyOf", "oneOf", "not"]) {
      expect(JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS).toContain(keyword);
    }
  });
});
