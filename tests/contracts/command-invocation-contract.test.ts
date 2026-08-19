// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../../src/commands/command/builtin-action";
import {
  applyPortableCommandArguments,
  validatePortableCommandTemplate,
} from "../../src/commands/command/portable-template";
import {
  composePersonaFallbackPrompt,
  PERSONA_FALLBACK_NOTICE_CODE,
} from "../../src/integrations/agent/persona-fallback";

describe("portable command arguments", () => {
  test("replaces every literal $ARGUMENTS occurrence once without rescanning inserted text", () => {
    const resolved = applyPortableCommandArguments(
      "Before [$ARGUMENTS] middle [$ARGUMENTS] after.",
      "one\n'$ARGUMENTS' \"two\"",
      "fixture//commands/review",
    );

    expect(resolved).toEqual({
      template: "Before [$ARGUMENTS] middle [$ARGUMENTS] after.",
      argumentInput: "one\n'$ARGUMENTS' \"two\"",
      content: "Before [one\n'$ARGUMENTS' \"two\"] middle [one\n'$ARGUMENTS' \"two\"] after.",
    });
  });

  test("distinguishes omitted from explicit empty arguments while both expand to empty text", () => {
    expect(applyPortableCommandArguments("Do $ARGUMENTS now.", undefined, "inline")).toEqual({
      template: "Do $ARGUMENTS now.",
      content: "Do  now.",
    });
    expect(applyPortableCommandArguments("Do $ARGUMENTS now.", "", "inline")).toEqual({
      template: "Do $ARGUMENTS now.",
      argumentInput: "",
      content: "Do  now.",
    });
  });

  test("preserves templates with zero portable placeholders", () => {
    expect(applyPortableCommandArguments("Review this.", "exact input", "inline")).toEqual({
      template: "Review this.",
      argumentInput: "exact input",
      content: "Review this.",
    });
  });

  test.each([
    "Email reviewer@example.com before proceeding.",
    "Important! `code` is illustrative prose.",
    "Mention the literal ```! marker inline without opening a block.",
    "Use this ordinary fenced example:\n```sh\ngit status\n```",
  ])("preserves credential-free prose that only resembles native constructs", (template) => {
    expect(applyPortableCommandArguments(template, undefined, "inline").content).toBe(template);
  });

  test.each([
    ["positional", "Review $1 and $0"],
    ["indexed portable placeholder", "Review $ARGUMENTS[0]"],
    ["named", "Review $TARGET"],
    ["portable-prefix named", "Review $ARGUMENTS_SUFFIX"],
    ["expression", "Review ${TARGET}"],
    ["legacy", "Review {{0}}"],
    ["native expression", "Review ${{ inputs.target }}"],
    ["native shell interpolation", "Review !`git status`"],
    ["native fenced shell interpolation", "Review\n```!\ngit status\n```"],
    ["native file interpolation", "Review @secrets.env"],
  ])("rejects %s constructs before substitution", (_label, template) => {
    expect(() => validatePortableCommandTemplate(template, "fixture//commands/unsafe")).toThrow(
      /fixture\/\/commands\/unsafe.*unsupported.*template/i,
    );
  });

  test("errors identify the source and construct class without exposing command or argument content", () => {
    const secretTemplate = "private sentinel $1";
    try {
      applyPortableCommandArguments(secretTemplate, "argument secret", "fixture//commands/private");
      throw new Error("expected template rejection");
    } catch (error) {
      expect(String(error)).toContain("fixture//commands/private");
      expect(String(error)).toContain("$N");
      expect(String(error)).not.toContain("private sentinel");
      expect(String(error)).not.toContain("argument secret");
    }
  });
});

describe("built-in anonymous command action", () => {
  test.each([
    [{ ref: "fixture//commands/review" }, { kind: "stored", ref: "fixture//commands/review" }],
    [
      { ref: "commands/review", arguments: "  exact\ninput  " },
      { kind: "stored", ref: "commands/review", arguments: "  exact\ninput  " },
    ],
    [{ content: "Review $ARGUMENTS" }, { kind: "inline", content: "Review $ARGUMENTS" }],
    [
      { content: "", arguments: "" },
      { kind: "inline", content: "", arguments: "" },
    ],
  ] satisfies Array<
    [Record<string, unknown>, ParsedBuiltinCommandAction]
  >)("parses strict ref/content XOR inputs without normalizing exact strings", (input, expected) => {
    const parsed = parseBuiltinCommandAction(input);
    expect(parsed).toEqual(expected);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test.each([
    {},
    { ref: "commands/review", content: "Review" },
    { ref: "" },
    { ref: 1 },
    { content: 1 },
    { content: "Review", arguments: 1 },
    { content: "Review", extra: true },
  ])("rejects missing, ambiguous, wrongly typed, and unknown fields", (input) => {
    expect(() => parseBuiltinCommandAction(input)).toThrow();
  });

  test("rejects accessors, non-enumerable fields, symbols, and detaches from later mutation", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "content", {
      enumerable: true,
      get() {
        reads += 1;
        return "unsafe";
      },
    });
    expect(() => parseBuiltinCommandAction(accessor)).toThrow(/accessor|data property/i);
    expect(reads).toBe(0);

    const hidden = Object.defineProperty({}, "content", { value: "hidden", enumerable: false });
    expect(() => parseBuiltinCommandAction(hidden)).toThrow(/non-enumerable|enumerable/i);
    expect(() => parseBuiltinCommandAction({ content: "ok", [Symbol("extra")]: true })).toThrow(/symbol/i);

    const mutable = { content: "before", arguments: "first" };
    const parsed = parseBuiltinCommandAction(mutable);
    mutable.content = "after";
    mutable.arguments = "second";
    expect(parsed).toEqual({ kind: "inline", content: "before", arguments: "first" });
  });
});

describe("deterministic persona fallback", () => {
  test("preserves persona and command bytes in a stable delimited prompt with one structured notice", () => {
    const first = composePersonaFallbackPrompt("You are a reviewer.\n", "Review this change.\n", "fixture-engine");
    const second = composePersonaFallbackPrompt("You are a reviewer.\n", "Review this change.\n", "fixture-engine");

    expect(first).toEqual(second);
    expect(first.prompt).toContain("You are a reviewer.\n");
    expect(first.prompt).toContain("Review this change.\n");
    expect(first.prompt.indexOf("You are a reviewer.")).toBeLessThan(first.prompt.indexOf("Review this change."));
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toMatchObject({
      code: PERSONA_FALLBACK_NOTICE_CODE,
      severity: "info",
      adapter: "fixture-engine",
      field: "persona",
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.notices)).toBe(true);
    expect(Object.isFrozen(first.notices[0])).toBe(true);
  });
});
