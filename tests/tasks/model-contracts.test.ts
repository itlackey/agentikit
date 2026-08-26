// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P1b's `src/tasks/model/**` package (spec
 * docs/plans/specs/p1b-model-extraction.md §1.1 D4 module map, §3.1).
 *
 * None of `src/tasks/model/definition.ts`, `src/tasks/model/invocation.ts`, or
 * `src/tasks/model/schedule.ts` exist on disk yet — this is P1b's Lane A
 * writing the test-first contract ahead of implementation, exactly as
 * `tests/workflows/environment-v4-red.test.ts` and `tests/tasks/prepare-split.test.ts`
 * (this same phase's Lane B) already do. Runtime module(s) are loaded through
 * a NON-LITERAL dynamic-import path (`const ..._MODULE: string = "..."`) so
 * this file stays `bunx tsc --noEmit` clean before the implementation lands,
 * while every test below reports its own missing-implementation failure at
 * `bun test` runtime instead of one opaque "cannot find module" collection
 * error. A literal `import(...)` specifier or a static `import type` against
 * a not-yet-existing file would ALSO fail under `tsc`, which is why neither
 * is used here (mirrors the two sibling files above, not the older
 * `tests/execution/target-ref.test.ts` P1a convention, which accepted that
 * tsc cost).
 *
 * DESIGN DECISIONS this file fixes ahead of implementation (the spec's D4
 * module-map row gives field NAMES loosely — "TaskDefinition {ref, source
 * identity, name?, description?, target, execution defaults,
 * scheduleBindings}" — without pinning exact TS shapes, because this type is
 * genuinely new, not extracted from an existing implementation). Recorded
 * here so a reviewer can diff intent against whatever lands:
 *
 *  1. Only `definition.ts` gets a runtime, validating, freezing constructor
 *     (`createTaskDefinition`) — the spec's table row for it alone carries
 *     "+ its validation"; the `invocation.ts`/`schedule.ts` rows do not. Both
 *     of those two are therefore treated as PURE TYPE modules with no runtime
 *     export, checked below only by (a) an export-presence text scan (real
 *     ENOENT-then-AST red, not a vacuous self-check) and (b) indirectly,
 *     through `TaskScheduleBinding`-shaped entries that a real
 *     `createTaskDefinition` call actually produces and freezes.
 *  2. `TaskDefinition` carries NO top-level `enabled` field — the D4 field
 *     list is verbatim/binding and does not list one, and my directive's own
 *     "execution defaults (engine/model/timeout/redact/env)" enumeration
 *     doesn't carry it either. `enabled` lives ONLY on each
 *     `TaskScheduleBinding` (`{cron, enabled}`, spec §1.1/§3.3, exact) —
 *     broadcasting the v3 document's single `akm.enabled` flag onto every
 *     schedule entry, since v3's `on.schedule[].{cron}` has no per-entry
 *     enabled concept (`src/tasks/source-v3.ts:612`, `checkKeys(entry,
 *     ["cron"], ...)`).
 *  3. Malformed-input rejection uses `UsageError` (never a bare `Error`/
 *     `TypeError`) with code `INVALID_FLAG_VALUE` — the task's own
 *     non-negotiables require `UsageError`/`ConfigError` on user paths, and
 *     `INVALID_FLAG_VALUE` is `UsageError`'s own default code
 *     (`src/core/errors.ts`), used throughout `src/tasks/**`'s existing
 *     validation. P1b's spec authorizes no NEW `UsageErrorCode` member for
 *     model validation (unlike P1a's D7), so no new code is assumed. Exact
 *     message text is intentionally NOT pinned (the spec gives no message
 *     template to pin, unlike e.g. P1a's target-ref.ts).
 *
 * `src/tasks/model/**` purity (no fs/db/subprocess imports, spec §3.2) is
 * exercised in tests/tasks/parse-v3-adapter.test.ts, which owns the
 * text-level import-scan convention for this phase's Lane A per the task
 * brief ("adapter purity ... mirroring tests/architecture/diagnostic-codes.test.ts
 * style") and additionally covers these three model files there so the
 * ratchet has real coverage without duplicating the AST scanner in both
 * files.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { UsageError } from "../../src/core/errors";

const ROOT = path.resolve(import.meta.dir, "../..");
const MODEL_INVOCATION_FILE = path.join(ROOT, "src/tasks/model/invocation.ts");
const MODEL_SCHEDULE_FILE = path.join(ROOT, "src/tasks/model/schedule.ts");

// ── The not-yet-existing definition.ts module, loaded non-literally ────────
// ── (see file header) ───────────────────────────────────────────────────────

type TaskDefinitionTargetDraft =
  | { readonly kind: "command"; readonly ref: string }
  | { readonly kind: "script"; readonly ref: string }
  | { readonly kind: "workflow"; readonly ref: string; readonly params: Readonly<Record<string, unknown>> }
  | { readonly kind: "shell"; readonly command: string; readonly shell?: string };

interface TaskExecutionDefaultsDraft {
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly timeout?: string | number | null;
  readonly redact: readonly string[];
  readonly env: Readonly<Record<string, string | number | boolean>>;
}

interface TaskScheduleBindingDraft {
  readonly cron: string;
  readonly enabled: boolean;
}

interface TaskDefinitionDraft {
  readonly ref: string;
  readonly source: Readonly<{ path: string }>;
  readonly name?: string;
  readonly description?: string;
  readonly target: TaskDefinitionTargetDraft;
  readonly execution: TaskExecutionDefaultsDraft;
  readonly scheduleBindings: readonly TaskScheduleBindingDraft[];
}

type CreateTaskDefinitionFn = (input: TaskDefinitionDraft) => TaskDefinitionDraft;

interface DefinitionModule {
  readonly createTaskDefinition: CreateTaskDefinitionFn;
}

const DEFINITION_MODULE: string = "../../src/tasks/model/definition";

async function definitionModule(): Promise<DefinitionModule> {
  return (await import(DEFINITION_MODULE)) as DefinitionModule;
}

/** Capture a synchronous throw once, so a code/type pin never re-invokes the function under test. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function validDraft(): TaskDefinitionDraft {
  return {
    ref: "tasks/nightly",
    source: { path: "/bundle/tasks/nightly.yml" },
    name: "Nightly maintenance",
    description: "Runs nightly maintenance jobs.",
    target: { kind: "workflow", ref: "workflows/nightly-report", params: { channel: "release" } },
    execution: {
      engine: "claude",
      model: "claude-sonnet-5",
      timeout: "5m",
      redact: ["TOKEN"],
      env: { MODE: "safe", RETRIES: 3, DRY_RUN: true },
    },
    scheduleBindings: [
      { cron: "0 6 * * *", enabled: true },
      { cron: "30 9 * * 2", enabled: false },
    ],
  };
}

describe("createTaskDefinition — construction and deep freezing (src/tasks/model/definition.ts, P1b spec §1.1/§3.1)", () => {
  test("constructs a well-formed TaskDefinition, preserves every field, and freezes it at every level", async () => {
    const { createTaskDefinition } = await definitionModule();
    const definition = createTaskDefinition(validDraft());

    expect(definition.ref).toBe("tasks/nightly");
    expect(definition.source).toEqual({ path: "/bundle/tasks/nightly.yml" });
    expect(definition.name).toBe("Nightly maintenance");
    expect(definition.description).toBe("Runs nightly maintenance jobs.");
    expect(definition.target).toEqual({
      kind: "workflow",
      ref: "workflows/nightly-report",
      params: { channel: "release" },
    });
    expect(definition.execution).toEqual({
      engine: "claude",
      model: "claude-sonnet-5",
      timeout: "5m",
      redact: ["TOKEN"],
      env: { MODE: "safe", RETRIES: 3, DRY_RUN: true },
    });
    expect(definition.scheduleBindings).toEqual([
      { cron: "0 6 * * *", enabled: true },
      { cron: "30 9 * * 2", enabled: false },
    ]);

    // "Object.isFrozen where the spec promises freezing" — every level a
    // caller could otherwise mutate through, mirroring the deep-freeze-at-
    // each-level convention already used throughout src/tasks/runtime-v3.ts
    // (base(), environmentSnapshot(), etc.) and src/execution/source.ts.
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.source)).toBe(true);
    expect(Object.isFrozen(definition.target)).toBe(true);
    expect(Object.isFrozen(definition.execution)).toBe(true);
    expect(Object.isFrozen(definition.execution.redact)).toBe(true);
    expect(Object.isFrozen(definition.execution.env)).toBe(true);
    expect(Object.isFrozen(definition.scheduleBindings)).toBe(true);
    const [first, second] = definition.scheduleBindings;
    if (!first || !second) throw new Error("expected two schedule bindings");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  test("defaults absent optional fields without fabricating values (minimal shell definition)", async () => {
    const { createTaskDefinition } = await definitionModule();
    const definition = createTaskDefinition({
      ref: "tasks/minimal",
      source: { path: "/bundle/tasks/minimal.yml" },
      target: { kind: "shell", command: "printf ok" },
      execution: { redact: [], env: {} },
      scheduleBindings: [],
    });

    expect(definition.name).toBeUndefined();
    expect(definition.description).toBeUndefined();
    expect(definition.target).toEqual({ kind: "shell", command: "printf ok" });
    expect(definition.execution.engine).toBeUndefined();
    expect(definition.execution.model).toBeUndefined();
    expect(definition.execution.timeout).toBeUndefined();
    expect(definition.execution.redact).toEqual([]);
    expect(definition.execution.env).toEqual({});
    expect(definition.scheduleBindings).toEqual([]);
    expect(Object.isFrozen(definition.scheduleBindings)).toBe(true);
  });

  test("each of the four target kinds round-trips through construction unchanged", async () => {
    const { createTaskDefinition } = await definitionModule();
    const targets: readonly TaskDefinitionTargetDraft[] = [
      { kind: "command", ref: "commands/review" },
      { kind: "script", ref: "scripts/build.sh" },
      { kind: "workflow", ref: "workflows/release", params: {} },
      { kind: "shell", command: "printf ok", shell: "bash" },
    ];
    for (const target of targets) {
      const definition = createTaskDefinition({ ...validDraft(), target });
      expect(definition.target, target.kind).toEqual(target);
    }
  });
});

describe("createTaskDefinition — invariant validation rejects malformed definitions (P1b spec §1.1 D4, 'its validation')", () => {
  const MALFORMED_CASES: ReadonlyArray<{ readonly label: string; readonly build: () => unknown }> = [
    { label: "empty ref", build: () => ({ ...validDraft(), ref: "" }) },
    {
      label: "missing ref",
      build: () => {
        const { ref: _omit, ...rest } = validDraft();
        return rest;
      },
    },
    {
      label: "unrecognized target kind",
      build: () => ({ ...validDraft(), target: { kind: "bogus", ref: "x" } }),
    },
    {
      label: "workflow target missing params",
      build: () => ({ ...validDraft(), target: { kind: "workflow", ref: "workflows/x" } }),
    },
    {
      label: "schedule binding with empty cron",
      build: () => ({ ...validDraft(), scheduleBindings: [{ cron: "", enabled: true }] }),
    },
    {
      label: "schedule binding with non-boolean enabled",
      build: () => ({ ...validDraft(), scheduleBindings: [{ cron: "0 6 * * *", enabled: "yes" }] }),
    },
    {
      label: "execution.redact not an array",
      build: () => ({ ...validDraft(), execution: { ...validDraft().execution, redact: "TOKEN" } }),
    },
  ];

  test("rejects every malformed shape with UsageError code INVALID_FLAG_VALUE (see file header, design decision 3)", async () => {
    const { createTaskDefinition } = await definitionModule();
    for (const { label, build } of MALFORMED_CASES) {
      const error = thrown(() => createTaskDefinition(build() as unknown as TaskDefinitionDraft));
      expect(error, label).toBeInstanceOf(UsageError);
      expect((error as UsageError).code, label).toBe("INVALID_FLAG_VALUE");
    }
  });
});

// ── invocation.ts / schedule.ts — pure type modules (design decision 1) ────
// ── Nothing runtime to dynamically import (types are erased at compile ─────
// ── time), so coverage here is a text-level export-presence scan: real ─────
// ── ENOENT-then-AST red today, real "does it export the right name" green ──
// ── once implemented — not a self-authored literal that would pass ─────────
// ── trivially regardless of what the module actually contains. ─────────────

function isExportedDeclaration(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** True when `filePath` has a top-level `export interface <name>` or `export type <name>`. */
function exportsTypeNamed(filePath: string, name: string): boolean {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  source.forEachChild((node) => {
    if (!isExportedDeclaration(node)) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = true;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) found = true;
  });
  return found;
}

describe("model/schedule.ts and model/invocation.ts — pure type exports (P1b spec §1.1, design decision 1)", () => {
  test("schedule.ts exports the TaskScheduleBinding type ({cron, enabled} per spec §1.1/§3.3, exact)", () => {
    expect(exportsTypeNamed(MODEL_SCHEDULE_FILE, "TaskScheduleBinding")).toBe(true);
  });

  test("invocation.ts exports TaskInvocation and the D5 ExecutionProvenanceContext type", () => {
    expect(exportsTypeNamed(MODEL_INVOCATION_FILE, "TaskInvocation")).toBe(true);
    // D5 (p1b-model-extraction.md §1.2/§5.2, verbatim): ExecutionProvenanceContext
    // = Readonly<{eventSource: "user"|"task"; scheduled: boolean}>. The runtime
    // factory lives in run/provenance.ts (Lane C, §5.1) — this file only needs
    // the bare type to exist here.
    expect(exportsTypeNamed(MODEL_INVOCATION_FILE, "ExecutionProvenanceContext")).toBe(true);
  });

  // Not pinned here: TaskInvocation's exact field shape (taskRef/caller/overrides)
  // and the "schedule"/"workflow" caller variants' extra fields, which the spec
  // itself leaves as "..." (unspecified). Doing so would require either a static
  // `import type` against a not-yet-existing file (breaks the tsc-clean
  // convention this file follows, see header) or a locally-declared shape that
  // references nothing in the real module (a vacuous self-check). Once
  // invocation.ts exists and something else in this phase (D5's
  // run/provenance.ts, Lane C) statically imports TaskInvocation/
  // ExecutionProvenanceContext, tsc pins the real shape for free.
});
