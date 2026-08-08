// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Structural JSON-Schema-subset validator (orchestration plan P1).
 *
 * The workflow engine's structured-output normalization needs to validate
 * unit results against the author-declared unit `output` schema on any harness —
 * including ones with no native schema support. Pulling in a full
 * draft-2020-12 validator is deliberately avoided (dependency surface); this
 * module implements the bounded subset that covers the schemas workflow
 * authors actually write:
 *
 *   Supported: `type` (string | string[] — string, number, integer, boolean,
 *   object, array, null), `properties`, `required`, `items`,
 *   `additionalProperties: false`, `enum` (primitives), `minItems`,
 *   `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`
 *   (screened — see below), and the combinators `allOf`, `anyOf`, `oneOf`,
 *   `not`.
 *
 *   Ignored (permissive): `$ref`, `format`, `patternProperties`, tuple-form
 *   `items`, schema-form `additionalProperties`, and every other keyword.
 *   Unknown keywords never throw — a schema using them simply constrains
 *   less. Callers needing full JSON Schema semantics should validate
 *   downstream.
 *
 * ## Totality and bounds
 *
 * Evaluation is TOTAL and BOUNDED. Recursion is capped at
 * {@link MAX_VALIDATION_DEPTH} and the whole evaluation shares a single
 * node-visit budget ({@link MAX_VALIDATION_NODES}); exhausting either emits an
 * explicit error rather than silently accepting the value — the subset never
 * fails open. The schema tree is finite and acyclic (no `$ref`), so combinator
 * branching multiplies work by schema size, never exponentially.
 *
 * ## `pattern` and ReDoS
 *
 * `pattern` is matched with the platform `RegExp`, which backtracks, so every
 * pattern passes a conservative static screen ({@link screenPattern}) BEFORE
 * any match is attempted, and the screen result is memoized per pattern
 * source. The guarantee is:
 *
 * INVARIANT: a pattern the screen accepts cannot match any subject in
 * super-linear time. The screen enforces it by admitting only patterns in
 * which **every choice a backtracking engine could make is forced by the
 * input**, so each subject position is decided once and never re-explored:
 *
 *   1. the pattern source is at most {@link JSON_SCHEMA_MAX_PATTERN_LENGTH}
 *      characters and must compile;
 *   2. every group's alternatives must be PROVABLY DISJOINT
 *      ({@link branchesProvablyDisjoint}) — no two branches may match the same
 *      text, so the branch taken is determined by the subject. This holds
 *      whether or not the group carries a quantifier, because repeating an
 *      ambiguous group TEXTUALLY (`(a|aa)(a|aa)…`) encodes exactly the same
 *      exponential search as quantifying it (`(a|aa)+`);
 *   3. every atom whose consumed length can vary ({@link atomLengthVaries})
 *      must end on characters DISJOINT from everything that can follow it, so
 *      the split point is forced too. This subsumes both the classic
 *      exponential shape (`(a+)+`) and the polynomial one (`.*.*`, `\d+\w+`).
 *      Exactly ONE unforced boundary is tolerated per pattern, and only when
 *      everything after it is fixed-length and it is not inside a repetition —
 *      that costs a single linear factor (`^\[.*\]$`) and, being budgeted
 *      globally, cannot compound;
 *   4. a quantified group additionally may not have an empty-matchable or
 *      self-overlapping body ({@link ambiguousRepeatedBody});
 *   5. constructs the analysis cannot model are REJECTED, not assumed safe:
 *      backreferences (whose language depends on a capture) and unsupported
 *      group prefixes. Lookarounds are modelled as the zero-width assertions
 *      they are, and their bodies are screened like any other;
 *   6. counted quantifiers are capped at {@link MAX_PATTERN_REPEAT}, group
 *      nesting at {@link MAX_PATTERN_GROUP_DEPTH}, and the total number of
 *      choice points at {@link JSON_SCHEMA_MAX_PATTERN_CHOICE_POINTS} — a work
 *      budget that bounds the search a pattern can express at all, even if one
 *      of the structural rules above had a gap;
 *   7. a subject string longer than
 *      {@link JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH} is never matched at all —
 *      it is reported as a validation error instead.
 *
 * The resulting worst case is a bounded scan: at most `subject length ×
 * pattern size` character steps, with both factors capped by (1) and (7) — on
 * the order of 10⁶ steps, whatever the pattern and whatever the subject.
 *
 * Note that the bound must be STATIC. Matching happens inside the CLI/engine
 * process, and a synchronous `RegExp.exec` cannot be preempted by a timer;
 * moving it off-thread would make validation asynchronous and its result
 * wall-clock-dependent, which gate decisions cannot tolerate. Screening before
 * matching is therefore the only mechanism that keeps validation total AND
 * deterministic. A pattern the screen rejects is a loud authoring error
 * (`checkJsonSchemaDefinition`) and, if one somehow reaches evaluation, a loud
 * validation error — never a silent pass.
 *
 * Returns a flat list of human-readable error strings (empty = valid), each
 * prefixed with a JSON-pointer-ish path — the shape `runStructured`'s
 * corrective-feedback builder wants.
 *
 * {@link checkJsonSchemaDefinition} is the companion DEFINITION checker: it
 * walks an author-declared schema OBJECT (not a value) and reports typo'd
 * `type` names / structurally malformed keywords as `"malformed"` issues, and
 * recognized JSON Schema keywords this subset silently ignores as
 * `"unsupported"` issues — so a schema that would constrain nothing at
 * runtime can be rejected loudly at authoring time (the workflow parser does
 * exactly that for `output:` and `params` schemas). It deliberately does NOT
 * change {@link validateJsonSchemaSubset}'s permissive evaluation semantics.
 */

/** Longest `pattern` source the subset will accept (screen rule 1). */
export const JSON_SCHEMA_MAX_PATTERN_LENGTH = 256;

/** Longest string the subset will match a `pattern` against (screen rule 5). */
export const JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH = 4096;

/** Largest counted-quantifier bound (`a{n,m}`) the pattern screen accepts. */
const MAX_PATTERN_REPEAT = 1000;

/** Deepest `(` nesting the pattern screen accepts. */
const MAX_PATTERN_GROUP_DEPTH = 16;

/**
 * Most choice points ({@link ScreenedPattern}`.choicePoints`) a pattern may
 * contain — atoms whose consumed length can vary, plus groups with more than
 * one alternative. The structural rules below already require every one of
 * them to be resolved by the input, so this is a BUDGET, not a correctness
 * rule: it caps how much search a pattern can express at all, even if one of
 * those rules had a gap, and it is what makes the "repeat an ambiguous group
 * N times" family impossible by construction rather than merely by rule.
 * Ordinary authoring patterns use a handful (`^v?\d+(\.\d+)*$` uses 4).
 */
export const JSON_SCHEMA_MAX_PATTERN_CHOICE_POINTS = 24;

/** Deepest schema nesting {@link validateJsonSchemaSubset} evaluates. */
const MAX_VALIDATION_DEPTH = 64;

/** Total (schema node × value node) visits one {@link validateJsonSchemaSubset} call may make. */
const MAX_VALIDATION_NODES = 100_000;

export function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const budget = { nodes: MAX_VALIDATION_NODES, exceeded: false };
  validateNode(value, schema, "$", { errors, budget, depth: 0 });
  if (budget.exceeded) {
    errors.push(`$: schema evaluation exceeded the limit of ${MAX_VALIDATION_NODES} checks and was stopped`);
  }
  return errors;
}

// ── Schema-definition checking ───────────────────────────────────────────────

export interface SchemaDefinitionIssue {
  /** Key path of the offending keyword within the schema object (empty = root). */
  path: Array<string | number>;
  /** Dotted display form of `path`, rooted at `$` (e.g. `$.properties.name.type`). */
  pointer: string;
  /** The keyword the issue is about. */
  keyword: string;
  /**
   * `"malformed"`: the keyword's value is structurally invalid (typo'd `type`
   * name, non-array `required`, …). `"unsupported"`: a recognized JSON Schema
   * keyword the subset validator silently ignores — the schema would constrain
   * nothing at runtime where the author expects it to.
   */
  kind: "malformed" | "unsupported";
  message: string;
}

/** Human-readable list of the keywords {@link validateJsonSchemaSubset} enforces (for error messages). */
export const JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS =
  "type, enum, properties, required, items, additionalProperties: false, minItems, maxItems, " +
  "minLength, maxLength, minimum, maximum, pattern, allOf, anyOf, oneOf, not";

const KNOWN_TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

// Annotation keywords (`title`, `description`, `default`, `examples`,
// `$schema`, `$id`, `$comment`, `deprecated`, `readOnly`, `writeOnly`) are
// deliberately NOT in the unsupported set below: they constrain nothing in
// full JSON Schema either, so the subset ignoring them loses no semantics.
// Like any other unrecognized keyword (e.g. `x-…` extensions), they fall
// through the checker unreported — JSON Schema's own open-keyword behavior.

/**
 * Recognized JSON Schema keywords {@link validateJsonSchemaSubset} silently
 * ignores — a schema relying on one of these constrains LESS at runtime than
 * its author intended, so definition checking reports each as `"unsupported"`.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "if",
  "then",
  "else",
  "const",
  "format",
  "patternProperties",
  "propertyNames",
  "additionalItems",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

/**
 * Per-keyword follow-up for the `"unsupported"` message: the subset supports
 * something that expresses the same intent, so say so instead of leaving the
 * author at a dead end.
 */
const UNSUPPORTED_KEYWORD_HINTS = new Map<string, string>([
  ["$ref", `inline the referenced schema (the subset resolves no references, so it cannot follow "$ref")`],
  ["$defs", `inline the definitions at their use sites — "$ref" is not resolved, so "$defs" can never be reached`],
  [
    "definitions",
    `inline the definitions at their use sites — "$ref" is not resolved, so "definitions" can never be reached`,
  ],
  ["const", `use a single-value "enum" (e.g. enum: [pass])`],
  [
    "format",
    `"format" is annotation-only in JSON Schema 2020-12 — use "pattern" for a regex the runtime actually enforces`,
  ],
  ["patternProperties", `declare the properties explicitly under "properties", or drop the constraint`],
  ["if", `use "anyOf"/"oneOf" to express the alternatives directly`],
  ["then", `use "anyOf"/"oneOf" to express the alternatives directly`],
  ["else", `use "anyOf"/"oneOf" to express the alternatives directly`],
  ["uniqueItems", `drop the constraint, or validate uniqueness in the step's gate rubric`],
]);

const MAX_DEFINITION_DEPTH = 64;

/**
 * Check a JSON Schema DEFINITION (the schema object itself, not a value)
 * against the subset {@link validateJsonSchemaSubset} enforces. Returns
 * accumulated issues (empty = the schema is a well-formed subset schema).
 * Keywords that are neither subset-enforced, unsupported-but-recognized, nor
 * annotations are ignored, matching JSON Schema's own open-keyword behavior.
 */
export function checkJsonSchemaDefinition(schema: Record<string, unknown>): SchemaDefinitionIssue[] {
  const issues: SchemaDefinitionIssue[] = [];
  checkDefinitionNode(schema, [], issues, 0);
  return issues;
}

function pointerFor(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function pushIssue(
  issues: SchemaDefinitionIssue[],
  path: ReadonlyArray<string | number>,
  keyword: string,
  kind: SchemaDefinitionIssue["kind"],
  message: string,
): void {
  issues.push({ path: [...path], pointer: pointerFor(path), keyword, kind, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkDefinitionNode(
  schema: Record<string, unknown>,
  path: Array<string | number>,
  issues: SchemaDefinitionIssue[],
  depth: number,
): void {
  if (depth > MAX_DEFINITION_DEPTH) {
    pushIssue(
      issues,
      path,
      "(depth)",
      "malformed",
      `schema nesting exceeds the depth limit of ${MAX_DEFINITION_DEPTH}`,
    );
    return;
  }

  for (const keyword of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) {
      const hint = UNSUPPORTED_KEYWORD_HINTS.get(keyword);
      pushIssue(
        issues,
        [...path, keyword],
        keyword,
        "unsupported",
        `keyword "${keyword}" is not enforced by the workflow schema subset — the schema would silently not ` +
          `constrain what it looks like it constrains${hint ? `; ${hint}` : ""}`,
      );
    }
  }

  const declared = schema.type;
  if (declared !== undefined) {
    const names = Array.isArray(declared) ? declared : [declared];
    if (names.length === 0) {
      pushIssue(issues, [...path, "type"], "type", "malformed", `"type" must name at least one type`);
    }
    for (const [index, name] of names.entries()) {
      const namePath = Array.isArray(declared) ? [...path, "type", index] : [...path, "type"];
      if (typeof name !== "string") {
        pushIssue(issues, namePath, "type", "malformed", `"type" must be a string or an array of strings`);
      } else if (!KNOWN_TYPE_NAMES.has(name)) {
        pushIssue(
          issues,
          namePath,
          "type",
          "malformed",
          `unknown type ${JSON.stringify(name)} (valid types: ${[...KNOWN_TYPE_NAMES].join(", ")})`,
        );
      }
    }
  }

  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    pushIssue(issues, [...path, "enum"], "enum", "malformed", `"enum" must be a non-empty array of allowed values`);
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      pushIssue(issues, [...path, "pattern"], "pattern", "malformed", `"pattern" must be a regular-expression string`);
    } else {
      const screened = screenPattern(schema.pattern);
      if (!screened.ok) {
        pushIssue(
          issues,
          [...path, "pattern"],
          "pattern",
          "malformed",
          `"pattern" ${JSON.stringify(schema.pattern)} ${screened.reason}`,
        );
      }
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) {
      pushIssue(
        issues,
        [...path, keyword],
        keyword,
        "malformed",
        `"${keyword}" must be a non-empty array of schema objects`,
      );
      continue;
    }
    branches.forEach((branch, index) => {
      if (isPlainObject(branch)) {
        checkDefinitionNode(branch, [...path, keyword, index], issues, depth + 1);
      } else {
        pushIssue(
          issues,
          [...path, keyword, index],
          keyword,
          "malformed",
          `"${keyword}[${index}]" must be a schema object`,
        );
      }
    });
  }

  if (schema.not !== undefined) {
    if (isPlainObject(schema.not)) {
      checkDefinitionNode(schema.not, [...path, "not"], issues, depth + 1);
    } else {
      pushIssue(issues, [...path, "not"], "not", "malformed", `"not" must be a schema object`);
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string")) {
      pushIssue(
        issues,
        [...path, "required"],
        "required",
        "malformed",
        `"required" must be an array of property-name strings`,
      );
    }
  }

  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      pushIssue(
        issues,
        [...path, "properties"],
        "properties",
        "malformed",
        `"properties" must be an object mapping property names to schemas`,
      );
    } else {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (isPlainObject(propSchema)) {
          checkDefinitionNode(propSchema, [...path, "properties", key], issues, depth + 1);
        } else {
          pushIssue(
            issues,
            [...path, "properties", key],
            "properties",
            "malformed",
            `property ${JSON.stringify(key)} must be a schema object`,
          );
        }
      }
    }
  }

  if (schema.items !== undefined) {
    if (isPlainObject(schema.items)) {
      checkDefinitionNode(schema.items, [...path, "items"], issues, depth + 1);
    } else if (Array.isArray(schema.items)) {
      pushIssue(
        issues,
        [...path, "items"],
        "items",
        "unsupported",
        `tuple-form "items" (an array of schemas) is not enforced by the workflow schema subset — use a single schema object`,
      );
    } else {
      pushIssue(issues, [...path, "items"], "items", "malformed", `"items" must be a schema object`);
    }
  }

  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    if (isPlainObject(schema.additionalProperties)) {
      pushIssue(
        issues,
        [...path, "additionalProperties"],
        "additionalProperties",
        "unsupported",
        `schema-form "additionalProperties" is not enforced by the workflow schema subset — only "additionalProperties: false" is`,
      );
    } else {
      pushIssue(
        issues,
        [...path, "additionalProperties"],
        "additionalProperties",
        "malformed",
        `"additionalProperties" must be a boolean (only "false" is enforced)`,
      );
    }
  }

  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      pushIssue(issues, [...path, keyword], keyword, "malformed", `"${keyword}" must be a non-negative integer`);
    }
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      pushIssue(issues, [...path, keyword], keyword, "malformed", `"${keyword}" must be a finite number`);
    }
  }
}

// ── `pattern` screening (ReDoS guard) ───────────────────────────────────────
//
// See the file header's "`pattern` and ReDoS" section for the guarantee. The
// screen parses the pattern into atoms so it can reason about WHICH
// subexpression a quantifier applies to; it never executes the pattern.

type ScreenedPattern =
  | {
      ok: true;
      regex: RegExp;
      /**
       * Choice points the accepted pattern contains — its WORK BOUND. Every
       * one of them is proven to be resolved by the input (see
       * {@link findUnsafeConstruct}), so this counts the places a backtracking
       * engine could branch at all, capped at
       * {@link JSON_SCHEMA_MAX_PATTERN_CHOICE_POINTS}.
       */
      choicePoints: number;
    }
  | { ok: false; reason: string };

interface PatternAtom {
  kind: "char" | "class" | "escape" | "dot" | "anchor" | "group";
  /** Source text of the atom WITHOUT its quantifier (used for character-set probing). */
  source: string;
  /** Alternation branches, for a group atom. */
  branches?: PatternAtom[][];
  quantifier?: { min: number; max: number };
  /**
   * A lookaround group (`(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`): its body is
   * still screened, but it CONSUMES NOTHING, so every length/character-set
   * question about it must answer "zero-width" rather than describing the
   * body. Modelling it as if it consumed its body would let the screen believe
   * a boundary is forced when it is not.
   */
  zeroWidth?: true;
}

/** Codepoints probed to approximate an atom's character set (ASCII + two non-ASCII representatives). */
const PROBE_CODEPOINTS: number[] = [...Array.from({ length: 128 }, (_, i) => i), 0xe9, 0x4e2d];

/**
 * Memoized screen results. Bounded: at
 * {@link PATTERN_CACHE_LIMIT} entries the cache is cleared wholesale (an
 * evaluation never depends on the cache surviving).
 */
const patternCache = new Map<string, ScreenedPattern>();
const PATTERN_CACHE_LIMIT = 512;

/**
 * Screen and compile a `pattern`. Total: parses the pattern source in one
 * left-to-right pass (bounded by {@link JSON_SCHEMA_MAX_PATTERN_LENGTH}) and
 * probes each single-character atom against a fixed alphabet. Never matches
 * anything.
 */
export function screenPattern(source: string): ScreenedPattern {
  const cached = patternCache.get(source);
  if (cached) return cached;
  const result = screenPatternUncached(source);
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
  patternCache.set(source, result);
  return result;
}

function screenPatternUncached(source: string): ScreenedPattern {
  if (source.length > JSON_SCHEMA_MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `is longer than the ${JSON_SCHEMA_MAX_PATTERN_LENGTH}-character limit` };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch (cause) {
    return { ok: false, reason: `is not a valid regular expression: ${cause instanceof Error ? cause.message : ""}` };
  }
  const parsed = parsePattern(source);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const unsafe = findUnsafeConstruct(parsed.branches);
  if (unsafe) return { ok: false, reason: unsafe };
  const choicePoints = countChoicePoints(parsed.branches);
  if (choicePoints > JSON_SCHEMA_MAX_PATTERN_CHOICE_POINTS) {
    return {
      ok: false,
      reason:
        `contains ${choicePoints} variable-length or multi-branch subexpressions, above the ` +
        `${JSON_SCHEMA_MAX_PATTERN_CHOICE_POINTS}-choice-point budget — simplify it`,
    };
  }
  return { ok: true, regex, choicePoints };
}

function parsePattern(source: string): { ok: true; branches: PatternAtom[][] } | { ok: false; reason: string } {
  let i = 0;
  let failure: string | null = null;

  const fail = (reason: string): null => {
    failure ??= reason;
    i = source.length;
    return null;
  };

  const parseQuantifier = (): PatternAtom["quantifier"] => {
    const ch = source[i];
    let quantifier: { min: number; max: number } | undefined;
    if (ch === "*") {
      i++;
      quantifier = { min: 0, max: Number.POSITIVE_INFINITY };
    } else if (ch === "+") {
      i++;
      quantifier = { min: 1, max: Number.POSITIVE_INFINITY };
    } else if (ch === "?") {
      i++;
      quantifier = { min: 0, max: 1 };
    } else if (ch === "{") {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
      if (!match) return undefined; // a literal "{" — JS treats it as a character
      i += match[0].length;
      const min = Number.parseInt(match[1] as string, 10);
      const max = match[2] === undefined ? min : match[3] ? Number.parseInt(match[3], 10) : Number.POSITIVE_INFINITY;
      quantifier = { min, max };
    }
    // A trailing "?" (lazy) or "+" (not JS, but harmless) modifies the quantifier.
    if (quantifier && (source[i] === "?" || source[i] === "+")) i++;
    return quantifier;
  };

  const parseAtom = (depth: number): PatternAtom | null => {
    const start = i;
    const ch = source[i] as string;
    let atom: PatternAtom;
    if (ch === "(") {
      if (depth >= MAX_PATTERN_GROUP_DEPTH) return fail(`nests groups more than ${MAX_PATTERN_GROUP_DEPTH} deep`);
      i++;
      let zeroWidth = false;
      if (source[i] === "?") {
        const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][A-Za-z0-9_$]*>)/.exec(source.slice(i));
        if (!prefix) return fail(`uses an unsupported group prefix`);
        zeroWidth = /^\?(?:=|!|<=|<!)$/.test(prefix[0]);
        i += prefix[0].length;
      }
      // `parseAlternation` is a hoisted function declaration below — mutual recursion.
      const branches = parseAlternation(depth + 1);
      if (failure !== null) return null;
      if (source[i] !== ")") return fail(`has an unbalanced "("`);
      i++;
      atom = { kind: "group", source: source.slice(start, i), branches };
      if (zeroWidth) atom.zeroWidth = true;
    } else if (ch === "[") {
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++; // a leading "]" is a literal member
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      if (source[i] !== "]") return fail(`has an unterminated character class "["`);
      i++;
      atom = { kind: "class", source: source.slice(start, i) };
    } else if (ch === "\\") {
      if (i + 1 >= source.length) return fail(`ends with a dangling "\\"`);
      // A backreference makes an atom's language depend on what an earlier
      // group captured, which no character-set analysis can model — the screen
      // fails CLOSED rather than reason about `(a+)\1`.
      const escaped = source[i + 1] as string;
      if ((escaped >= "1" && escaped <= "9") || (escaped === "k" && source[i + 2] === "<")) {
        return fail(`uses a backreference (\\${escaped}), which cannot be screened for safe matching`);
      }
      i += 2;
      atom = { kind: "escape", source: source.slice(start, i) };
    } else if (ch === ".") {
      i++;
      atom = { kind: "dot", source: "." };
    } else if (ch === "^" || ch === "$") {
      i++;
      atom = { kind: "anchor", source: ch };
    } else if (ch === "*" || ch === "+" || ch === "?") {
      return fail(`has a quantifier with nothing to repeat`);
    } else {
      i++;
      atom = { kind: "char", source: ch };
    }
    const quantifier = parseQuantifier();
    if (quantifier) atom.quantifier = quantifier;
    return atom;
  };

  function parseAlternation(depth: number): PatternAtom[][] {
    const branches: PatternAtom[][] = [];
    let current: PatternAtom[] = [];
    while (i < source.length) {
      const ch = source[i];
      if (ch === ")") break;
      if (ch === "|") {
        i++;
        branches.push(current);
        current = [];
        continue;
      }
      const atom = parseAtom(depth);
      if (!atom) break;
      current.push(atom);
    }
    branches.push(current);
    return branches;
  }

  const branches = parseAlternation(0);
  if (failure !== null) return { ok: false, reason: failure };
  if (i < source.length) return { ok: false, reason: `has an unbalanced ")"` };
  return { ok: true, branches };
}

/** True when the quantifier admits a variable number of repetitions (the source of ambiguity). */
function isVariablyRepeated(atom: PatternAtom): boolean {
  return atom.quantifier !== undefined && atom.quantifier.max > atom.quantifier.min;
}

/** True when the atom can consume nothing (an optional quantifier, an anchor, an empty-able group). */
function canMatchEmpty(atom: PatternAtom): boolean {
  if (atom.kind === "anchor" || atom.zeroWidth) return true;
  if (atom.quantifier && atom.quantifier.min === 0) return true;
  if (atom.branches) return atom.branches.some((branch) => branch.every(canMatchEmpty));
  return false;
}

/**
 * How many characters the atom can consume, as `[min, max]` (`max` may be
 * `Infinity`). Used through {@link atomLengthVaries}: an atom whose consumed
 * length is FIXED ends at a position the input already determines, so the
 * boundary between it and whatever follows needs no further proof.
 */
function atomLengthRange(atom: PatternAtom): { min: number; max: number } {
  let base: { min: number; max: number };
  if (atom.kind === "anchor" || atom.zeroWidth) base = { min: 0, max: 0 };
  else if (atom.branches) {
    if (atom.branches.length === 0) base = { min: 0, max: 0 };
    else {
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (const branch of atom.branches) {
        const range = branchLengthRange(branch);
        min = Math.min(min, range.min);
        max = Math.max(max, range.max);
      }
      base = { min, max };
    }
  } else base = { min: 1, max: 1 };
  const quantifier = atom.quantifier;
  if (!quantifier) return base;
  // Guard `0 * Infinity`, which is NaN: an atom that consumes nothing still
  // consumes nothing however many times it repeats.
  return {
    min: base.min === 0 ? 0 : base.min * quantifier.min,
    max: base.max === 0 ? 0 : base.max * quantifier.max,
  };
}

function branchLengthRange(branch: PatternAtom[]): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const atom of branch) {
    const range = atomLengthRange(atom);
    min += range.min;
    max += range.max;
  }
  return { min, max };
}

/** True when the atom can consume two different numbers of characters — a boundary the input must force. */
function atomLengthVaries(atom: PatternAtom): boolean {
  const { min, max } = atomLengthRange(atom);
  return min !== max;
}

/**
 * Characters the atom can consume FIRST (`side: "first"`) or LAST
 * (`side: "last"`). `null` = unknown, which every caller treats as
 * "overlaps everything" — the screen never guesses in the permissive
 * direction.
 */
function edgeCharSet(atom: PatternAtom, side: "first" | "last"): Set<number> | null {
  if (atom.kind === "anchor" || atom.zeroWidth) return new Set(); // zero-width: consumes nothing
  if (atom.branches) {
    const union = new Set<number>();
    for (const branch of atom.branches) {
      const set = branchEdgeCharSet(branch, side);
      if (!set) return null;
      for (const codepoint of set) union.add(codepoint);
    }
    return union;
  }
  let probe: RegExp;
  try {
    probe = new RegExp(`^(?:${atom.source})$`);
  } catch {
    return null;
  }
  const set = new Set<number>();
  for (const codepoint of PROBE_CODEPOINTS) {
    if (probe.test(String.fromCodePoint(codepoint))) set.add(codepoint);
  }
  return set;
}

/** Edge character set of a whole sequence: walk inward past atoms that can consume nothing. */
function branchEdgeCharSet(branch: PatternAtom[], side: "first" | "last"): Set<number> | null {
  const ordered = side === "first" ? branch : [...branch].reverse();
  const union = new Set<number>();
  for (const atom of ordered) {
    const set = edgeCharSet(atom, side);
    if (!set) return null;
    for (const codepoint of set) union.add(codepoint);
    if (!canMatchEmpty(atom) && set.size > 0) break;
  }
  return union;
}

/** The outermost atom on one side of a sequence, skipping zero-width anchors. */
function edgeAtom(branch: PatternAtom[], side: "first" | "last"): PatternAtom | undefined {
  const ordered = side === "first" ? branch : [...branch].reverse();
  return ordered.find((atom) => atom.kind !== "anchor");
}

function setsOverlap(a: Set<number> | null, b: Set<number> | null): boolean {
  if (!a || !b) return true; // unknown shape — assume the worst
  for (const codepoint of a) {
    if (b.has(codepoint)) return true;
  }
  return false;
}

/** The exact character set of an atom consuming EXACTLY one character, or `null` for anything else. */
function singleCharSet(atom: PatternAtom): Set<number> | null {
  if (atom.quantifier || atom.branches || atom.kind === "anchor") return null;
  const set = edgeCharSet(atom, "first");
  // An empty set means "matches no single character" — a zero-width escape
  // like `\b`, which distinguishes nothing. Treat it as unknown.
  return set && set.size > 0 ? set : null;
}

/**
 * True when NO string can be matched by both branches, PROVEN one of three
 * ways (any failure to prove is reported as "not disjoint" — the screen never
 * guesses in the permissive direction):
 *
 *   1. the branches cannot even start with the same character (`(\d+|none)`);
 *   2. walking both branches in lockstep reaches single-character atoms whose
 *      sets are disjoint (`(cat|car)` — same first two characters, different
 *      third);
 *   3. one branch runs out while the other must still consume a character
 *      (`(a|aa)`), so no single string satisfies both.
 *
 * Two branches that are NOT provably disjoint make the group AMBIGUOUS: some
 * input matches it two ways, and each such group multiplies the search space a
 * backtracking engine explores. `(a|a)` and `(?:aa|aa)` are the pure cases.
 */
function branchesProvablyDisjoint(a: PatternAtom[], b: PatternAtom[]): boolean {
  if (!setsOverlap(branchEdgeCharSet(a, "first"), branchEdgeCharSet(b, "first"))) return true;
  for (let k = 0; ; k++) {
    const left = a[k];
    const right = b[k];
    if (!left && !right) return false; // identical shapes all the way down
    if (!left) return branchLengthRange(b.slice(k)).min >= 1;
    if (!right) return branchLengthRange(a.slice(k)).min >= 1;
    const leftSet = singleCharSet(left);
    const rightSet = singleCharSet(right);
    if (!leftSet || !rightSet) return false; // a variable-length atom — lockstep breaks down
    if (!setsOverlap(leftSet, rightSet)) return true;
  }
}

/**
 * The reason a repeated group's body is AMBIGUOUS (can match one string two
 * ways, which is what makes the repetition backtrack), or `null` when the
 * repetition is deterministic. Three sources, all rejected:
 *   - a body that can match the empty string (`(a*)*`);
 *   - alternation branches that can start with the same character (`(a|ab)+`),
 *     since the branch choice is then not forced by the input;
 *   - a body whose leading and trailing characters overlap while one of those
 *     ends is itself variably repeated (`(a+)+`, `(ba+a)+`) — the repetition
 *     boundary is then not forced by the input.
 * `(foo|bar)+`, `(\.\d+)*` and `(ab+)+` are all deterministic and pass.
 */
function ambiguousRepeatedBody(atom: PatternAtom): string | null {
  const branches = atom.branches ?? [];
  for (const branch of branches) {
    if (branch.length === 0 || branch.every(canMatchEmpty)) return `can match the empty string`;
  }
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const left = branchEdgeCharSet(branches[i] as PatternAtom[], "first");
      const right = branchEdgeCharSet(branches[j] as PatternAtom[], "first");
      if (setsOverlap(left, right)) return `has alternatives that can start with the same character`;
    }
  }
  for (const branch of branches) {
    const first = edgeAtom(branch, "first");
    const last = edgeAtom(branch, "last");
    if (!first || !last) continue;
    if (!isVariablyRepeated(first) && !isVariablyRepeated(last)) continue;
    if (setsOverlap(branchEdgeCharSet(branch, "last"), branchEdgeCharSet(branch, "first"))) {
      return `can start and end with the same character while repeating`;
    }
  }
  return null;
}

/**
 * Choice points in the tree: atoms whose consumed length can vary, plus each
 * group offering more than one alternative. See
 * {@link JSON_SCHEMA_MAX_PATTERN_CHOICE_POINTS}.
 */
function countChoicePoints(branches: PatternAtom[][]): number {
  let total = 0;
  for (const branch of branches) {
    for (const atom of branch) {
      if (atomLengthVaries(atom)) total++;
      if (atom.branches) {
        if (atom.branches.length > 1) total++;
        total += countChoicePoints(atom.branches);
      }
    }
  }
  return total;
}

/**
 * Walk state for {@link findUnsafeConstruct}.
 *
 * `budget.tolerated` is the ONE unforced boundary the screen allows across the
 * whole pattern (see the carve-out below); it is global rather than per-branch
 * precisely because two such boundaries MULTIPLY — `^\[.*\]$` is linear,
 * `^\[.*\]x\[.*\]y$` is quadratic, and a chain of them is `O(nᵏ)`.
 * `insideRepeat` disables the carve-out entirely, since a tolerated boundary
 * inside a repeated group is re-explored on every iteration.
 */
interface ScreenWalk {
  /** Shared by every nested walk of one screen, so sibling groups cannot each spend it. */
  budget: { tolerated: number };
  insideRepeat: boolean;
}

/** The reason `branches` is unsafe, or `null` when the whole tree passes the screen. */
function findUnsafeConstruct(
  branches: PatternAtom[][],
  walk: ScreenWalk = { budget: { tolerated: 0 }, insideRepeat: false },
): string | null {
  for (const branch of branches) {
    for (let index = 0; index < branch.length; index++) {
      const atom = branch[index] as PatternAtom;
      if (atom.quantifier) {
        const { max } = atom.quantifier;
        if (Number.isFinite(max) && max > MAX_PATTERN_REPEAT) {
          return `repeats a subexpression more than ${MAX_PATTERN_REPEAT} times`;
        }
        if (atom.branches) {
          const ambiguity = ambiguousRepeatedBody(atom);
          if (ambiguity) {
            return (
              `repeats a group whose body ${ambiguity} (${atom.source}) — that construct backtracks ` +
              `exponentially; rewrite it so each repetition is forced by the input (e.g. a character class)`
            );
          }
        }
      }
      // AMBIGUOUS ALTERNATION (any group, quantified or not). A group whose
      // branches can match the same text is a choice the input never resolves.
      // Repeating such a group TEXTUALLY is the same exponential search as
      // quantifying it, so this check may NOT be conditioned on a quantifier.
      const branchList = atom.branches ?? [];
      for (let i = 0; i < branchList.length; i++) {
        for (let j = i + 1; j < branchList.length; j++) {
          if (!branchesProvablyDisjoint(branchList[i] as PatternAtom[], branchList[j] as PatternAtom[])) {
            return (
              `has a group (${atom.source}) whose alternatives can match the same text — the choice is not ` +
              `forced by the input, so repeating the group backtracks exponentially; make the branches distinguishable`
            );
          }
        }
      }

      // UNFORCED BOUNDARY. If the atom's length can vary, the position where
      // it ends is chosen by the engine, not by the input — UNLESS the
      // characters it can end on are disjoint from the characters that may
      // follow it. `rest` walks past anything that can consume nothing, so an
      // optional neighbour cannot hide the real successor. Testing the LEFT
      // atom alone (rather than requiring BOTH neighbours to be repeats) is
      // what catches sequentially repeated ambiguous groups, `(a|aa)(a|aa)…`.
      if (atomLengthVaries(atom)) {
        const rest = branch.slice(index + 1);
        if (setsOverlap(edgeCharSet(atom, "last"), branchEdgeCharSet(rest, "first"))) {
          // CARVE-OUT. One unforced boundary is only a LINEAR cost when
          // everything after it is fixed-length: each of the at-most-|subject|
          // split points is then verified in constant work, and nothing
          // downstream can multiply by it. That is the `^\[.*\]$` / `^".*"$`
          // idiom. Budgeted globally at one, and disabled under repetition —
          // see {@link ScreenWalk}.
          const tail = branchLengthRange(rest);
          const linear = tail.min === tail.max && !walk.insideRepeat && walk.budget.tolerated < 1;
          if (!linear) {
            return (
              `lets a variable-length subexpression (${atom.source}${atom.quantifier ? "…" : ""}) run into the ` +
              `characters that can follow it — the split point is not forced by the input, so matching ` +
              `backtracks super-linearly; separate them with a character the repeat cannot match`
            );
          }
          walk.budget.tolerated++;
        }
      }

      if (atom.branches) {
        const repeated = walk.insideRepeat || (atom.quantifier !== undefined && atom.quantifier.max > 1);
        const nested = findUnsafeConstruct(atom.branches, { budget: walk.budget, insideRepeat: repeated });
        if (nested) return nested;
      }
    }
  }
  return null;
}

type JsonTypeName = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function typeOf(value: unknown): JsonTypeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    default:
      return "object";
  }
}

function matchesType(actual: JsonTypeName, expected: string): boolean {
  if (expected === actual) return true;
  // JSON Schema: every integer is also a number.
  return expected === "number" && actual === "integer";
}

/**
 * Evaluation state. `budget` is SHARED by every nested/branch evaluation of one
 * {@link validateJsonSchemaSubset} call, so combinator branching cannot buy
 * more work than the whole call is allowed; `errors` is per-branch (a
 * combinator evaluates its branches into a scratch list).
 */
interface EvalCtx {
  errors: string[];
  budget: { nodes: number; exceeded: boolean };
  depth: number;
}

/** Evaluate `schema` against `value` in a scratch error list, sharing the caller's budget. */
function branchErrors(value: unknown, schema: Record<string, unknown>, path: string, ctx: EvalCtx): string[] {
  const errors: string[] = [];
  validateNode(value, schema, path, { errors, budget: ctx.budget, depth: ctx.depth + 1 });
  return errors;
}

/** The schemas of a combinator keyword, or `[]` when the keyword is absent/malformed (permissive). */
function combinatorBranches(schema: Record<string, unknown>, keyword: string): Record<string, unknown>[] {
  const raw = schema[keyword];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject);
}

/** First error of each failing branch, truncated — enough to act on without dumping every branch. */
function summarizeBranchFailures(failures: Array<{ index: number; errors: string[] }>): string {
  const shown = failures.slice(0, 3).map((f) => `${f.index + 1}: ${f.errors[0] ?? "no match"}`);
  if (failures.length > shown.length) shown.push(`…${failures.length - shown.length} more`);
  return shown.join("; ");
}

function validateCombinators(value: unknown, schema: Record<string, unknown>, path: string, ctx: EvalCtx): void {
  for (const branch of combinatorBranches(schema, "allOf")) {
    // `allOf` failures ARE the value's failures — surface them verbatim.
    ctx.errors.push(...branchErrors(value, branch, path, ctx));
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = combinatorBranches(schema, keyword);
    if (branches.length === 0) continue;
    const failures: Array<{ index: number; errors: string[] }> = [];
    const matched: number[] = [];
    branches.forEach((branch, index) => {
      const errors = branchErrors(value, branch, path, ctx);
      if (errors.length === 0) matched.push(index + 1);
      else failures.push({ index, errors });
    });
    if (matched.length === 0) {
      ctx.errors.push(
        `${path}: value matches none of the ${branches.length} "${keyword}" schemas (${summarizeBranchFailures(failures)})`,
      );
    } else if (keyword === "oneOf" && matched.length > 1) {
      ctx.errors.push(
        `${path}: value matches ${matched.length} "oneOf" schemas (branches ${matched.join(", ")}); exactly one must match`,
      );
    }
  }

  const not = schema.not;
  if (isPlainObject(not) && branchErrors(value, not, path, ctx).length === 0) {
    ctx.errors.push(`${path}: value must not match the "not" schema`);
  }
}

/**
 * Apply a screened `pattern` to a string. A pattern the screen rejects, or a
 * subject too long to match safely, is an ERROR — the constraint the author
 * wrote is never silently skipped (see the file header's ReDoS guarantee).
 */
function validatePattern(value: string, pattern: string, path: string, errors: string[]): void {
  const screened = screenPattern(pattern);
  if (!screened.ok) {
    errors.push(`${path}: pattern ${JSON.stringify(pattern)} cannot be evaluated safely — it ${screened.reason}`);
    return;
  }
  if (value.length > JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH) {
    errors.push(
      `${path}: string is ${value.length} characters, above the ${JSON_SCHEMA_MAX_PATTERN_INPUT_LENGTH}-character ` +
        `limit for "pattern" matching`,
    );
    return;
  }
  if (!screened.regex.test(value)) {
    errors.push(`${path}: string does not match pattern ${JSON.stringify(pattern)}`);
  }
}

function validateNode(value: unknown, schema: Record<string, unknown>, path: string, ctx: EvalCtx): void {
  const errors = ctx.errors;
  if (ctx.depth > MAX_VALIDATION_DEPTH) {
    errors.push(`${path}: schema nesting exceeds the depth limit of ${MAX_VALIDATION_DEPTH}`);
    return;
  }
  if (ctx.budget.nodes <= 0) {
    // Fail CLOSED: a truncated evaluation never returns "valid" — the wrapper
    // turns the exhausted budget into a top-level error.
    ctx.budget.exceeded = true;
    return;
  }
  ctx.budget.nodes--;

  const actual = typeOf(value);

  const declared = schema.type;
  if (typeof declared === "string" || Array.isArray(declared)) {
    const expected = (Array.isArray(declared) ? declared : [declared]).filter(
      (t): t is string => typeof t === "string",
    );
    if (expected.length > 0 && !expected.some((t) => matchesType(actual, t))) {
      errors.push(`${path}: expected type ${expected.join(" | ")}, got ${actual}`);
      return; // type mismatch makes the remaining constraints meaningless
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = schema.enum;
    if (!allowed.some((candidate) => candidate === value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
      return;
    }
  }

  // Combinators are type-agnostic, so they run BEFORE the per-type branches
  // below (each of which returns). A schema with no combinator keyword is
  // untouched by this call.
  validateCombinators(value, schema, path, ctx);

  if (actual === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") validatePattern(value, schema.pattern, path, errors);
    return;
  }

  if ((actual === "number" || actual === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} is above maximum ${schema.maximum}`);
    }
    return;
  }

  if (actual === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: array has fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: array has more than maxItems ${schema.maxItems}`);
    }
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((element, index) => {
        validateNode(element, items as Record<string, unknown>, `${path}[${index}]`, {
          errors,
          budget: ctx.budget,
          depth: ctx.depth + 1,
        });
      });
    }
    return;
  }

  if (actual === "object" && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : undefined;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        // `Object.hasOwn`, not `key in record`: a required key satisfied only by
        // an inherited prototype member (e.g. "toString", "constructor") is NOT
        // present on the value itself, so `{}` must fail `required: ["toString"]`.
        if (typeof key === "string" && !Object.hasOwn(record, key)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (!Object.hasOwn(record, key)) continue;
        if (propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)) {
          validateNode(record[key], propSchema as Record<string, unknown>, `${path}.${key}`, {
            errors,
            budget: ctx.budget,
            depth: ctx.depth + 1,
          });
        }
      }
    }

    // `additionalProperties: false` closes the object to exactly its declared
    // `properties`. This MUST run even when no `properties` object is present:
    // `{ type: "object", additionalProperties: false }` admits only `{}`. Use
    // `Object.hasOwn` so an inherited key name (e.g. "toString") on the empty
    // property set is not mistaken for a declared property.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!properties || !Object.hasOwn(properties, key)) {
          errors.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
        }
      }
    }
  }
}
