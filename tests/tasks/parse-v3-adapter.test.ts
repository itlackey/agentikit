// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P1b's v3-to-model adapter (spec
 * docs/plans/specs/p1b-model-extraction.md §1.1 D4, §3).
 *
 * `src/tasks/source/parse-v3-adapter.ts` does not exist on disk yet — this is
 * P1b Lane A writing the test-first contract ahead of implementation. The
 * module is loaded through a NON-LITERAL dynamic-import path (`const
 * ADAPTER_MODULE: string = "..."`), matching this same phase's Lane B
 * (`tests/tasks/prepare-split.test.ts`) and the established
 * `tests/workflows/environment-v4-red.test.ts` convention, so this file stays
 * `bunx tsc --noEmit` clean before the implementation lands while every test
 * below reports its own missing-implementation failure at `bun test` runtime.
 *
 * `parseTaskV3Yaml`/`TaskV3SourceDocument` (src/tasks/source-v3.ts) DO exist
 * today and are imported statically and for real — the adapter is additive
 * (spec §3.1: "NO new parsing, no new validation, no source-syntax change"),
 * so this file exercises the REAL parser on the REAL fixtures and only the
 * adapter step is dynamically loaded.
 *
 * DESIGN DECISIONS this file fixes ahead of implementation (the same
 * reasoning as tests/tasks/model-contracts.test.ts's header applies here;
 * summarized where it affects the adapter specifically):
 *
 *  1. Exported name: `taskDefinitionFromV3(document, identity)`.
 *  2. Signature: `parseTaskV3Yaml`'s OWN output (`TaskV3SourceDocument`)
 *     carries no task-owned ref — only `source.path` (the file it was parsed
 *     from). A task's qualified ref depends on which BUNDLE owns it, which is
 *     caller context the adapter cannot derive without becoming impure
 *     (bundle resolution is IO). So the adapter takes a second parameter,
 *     `identity: Readonly<{ref: string}>`, supplied by the caller — exactly
 *     how `prepareTaskV3Execution` already takes `context.taskId`/
 *     `context.taskRef` for the same reason (`src/tasks/runtime-v3.ts:108-110`).
 *     This file's fixture loop supplies a synthetic `tasks/<fixture-id>` ref
 *     per case and asserts it is threaded through UNCHANGED — proving the
 *     adapter does not (cannot) derive it internally.
 *  3. `TaskDefinition.target.kind` vocabulary is "command" | "script" |
 *     "workflow" | "shell" — reusing D8's NEW result vocabulary
 *     (p1b-model-extraction.md §1.3/§5.3: "command" replaces "prompt",
 *     "shell"/"script" replace the old collapsed "command") rather than v3's
 *     own uses/run split, since this model layer and D8 land in the SAME
 *     phase and the task brief's own wording ("target kind/ref") uses this
 *     vocabulary. `commands/<ref>` and `akm/command`(builtin)/`github-action`
 *     `uses:` kinds are out of scope here: no fixture in
 *     tests/fixtures/execution-contracts/tasks/v3-migration/ exercises
 *     builtin-command or github-action targets, so this file does not pin how
 *     the adapter handles them.
 *  4. `TaskExecutionDefaults.timeout` carries the RAW authored value
 *     (`akm.timeout`, e.g. `"5m"`), NOT normalized to milliseconds — the
 *     adapter's job is "no new parsing, no new validation" (§3.1); millisecond
 *     normalization (`normalizeTimeout`/`parseDuration`) already lives in the
 *     `prepare/` layer (Lane B, moving body-intact from `runtime-v3.ts`) and
 *     duplicating it here would be exactly the drift the extraction exists to
 *     avoid.
 *  5. `TaskScheduleBinding.enabled` broadcasts the v3 document's single
 *     `akm.enabled` flag (default true when absent, `!== false`, matching
 *     `TaskV3PreparedBase.enabled`'s existing convention at
 *     `runtime-v3.ts:242`) onto every schedule entry — v3 has no per-entry
 *     enabled concept. `source`/`ordinal` (v3's OWN `TaskV3ScheduleBinding`
 *     provenance fields, spec §3.3) are dropped — the model's
 *     `TaskScheduleBinding` is `{cron, enabled}` only, exact per spec.
 *
 * Fixture coverage: every one of the 8 fixtures in
 * tests/fixtures/execution-contracts/tasks/v3-migration/manifest.json is
 * loaded, parsed for real, and adapted; a `FIXTURE_EXPECTATIONS` table below
 * pins the per-fixture expected TaskDefinition shape. A manifest fixture
 * without a matching table entry fails loudly (`expectationFor`) rather than
 * being silently skipped, so a future fixture addition cannot go unnoticed.
 * One supplementary inline (non-fixture-file) document covers
 * engine/model/description/enabled:false, which none of the 8 manifest
 * fixtures happen to set.
 *
 * Purity (spec §3.2 ratchet — "src/tasks/model/** and
 * src/tasks/source/parse-v3-adapter.ts may import only types and pure
 * helpers") is checked here via a text-level import scan across all four
 * Lane A source files, per the task brief ("adapter purity ... a text-level
 * import scan in the test is acceptable, mirroring
 * tests/architecture/diagnostic-codes.test.ts style").
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { TaskV3SourceDocument } from "../../src/tasks/source-v3";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURES_DIR = path.join(ROOT, "tests/fixtures/execution-contracts/tasks/v3-migration");

// ── The not-yet-existing adapter module, loaded non-literally (see header) ──

type TaskDefinitionTargetShape =
  | { readonly kind: "command"; readonly ref: string }
  | { readonly kind: "script"; readonly ref: string }
  | { readonly kind: "workflow"; readonly ref: string; readonly params: Readonly<Record<string, unknown>> }
  | { readonly kind: "shell"; readonly command: string; readonly shell?: string };

interface TaskExecutionDefaultsShape {
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly timeout?: string | number | null;
  readonly redact: readonly string[];
  readonly env: Readonly<Record<string, string | number | boolean>>;
}

interface TaskScheduleBindingShape {
  readonly cron: string;
  readonly enabled: boolean;
}

interface TaskDefinitionShape {
  readonly ref: string;
  readonly source: Readonly<{ path: string }>;
  readonly name?: string;
  readonly description?: string;
  readonly target: TaskDefinitionTargetShape;
  readonly execution: TaskExecutionDefaultsShape;
  readonly scheduleBindings: readonly TaskScheduleBindingShape[];
}

type TaskDefinitionFromV3Fn = (
  document: TaskV3SourceDocument,
  identity: Readonly<{ ref: string }>,
) => TaskDefinitionShape;

interface AdapterModule {
  readonly taskDefinitionFromV3: TaskDefinitionFromV3Fn;
}

const ADAPTER_MODULE: string = "../../src/tasks/source/parse-v3-adapter";

async function adapterModule(): Promise<AdapterModule> {
  return (await import(ADAPTER_MODULE)) as AdapterModule;
}

// ── Fixture table (spec §3, task brief: "maps every fixture in ─────────────
// ── tests/fixtures/execution-contracts/tasks/v3-migration/") ───────────────

interface ManifestFixture {
  readonly id: string;
  readonly file: string;
}

function loadManifestFixtures(): readonly ManifestFixture[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as { readonly fixtures: readonly ManifestFixture[] };
  return parsed.fixtures;
}

interface FixtureExpectation {
  readonly id: string;
  readonly target: TaskDefinitionTargetShape;
  readonly scheduleBindings: readonly TaskScheduleBindingShape[];
  readonly execution: TaskExecutionDefaultsShape;
  readonly name: string;
}

// Hand-derived from each fixture's YAML (read tests/fixtures/execution-contracts/
// tasks/v3-migration/*.yml) against the CURRENT src/tasks/source-v3.ts grammar —
// not copied from manifest.json's own "expected" block, which describes the RAW
// parseTaskV3Yaml output for a *different* future consumer (the v3->v4
// migrator) and knows nothing about TaskDefinition's shape.
const FIXTURE_EXPECTATIONS: readonly FixtureExpectation[] = [
  {
    id: "trigger-akm-schedule",
    target: { kind: "command", ref: "commands/release-notes" },
    scheduleBindings: [{ cron: "0 6 * * *", enabled: true }],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - akm.schedule trigger",
  },
  {
    id: "trigger-on-schedule",
    target: { kind: "command", ref: "commands/release-notes" },
    scheduleBindings: [{ cron: "30 9 * * 2", enabled: true }],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - on.schedule trigger",
  },
  {
    id: "trigger-on-workflow-dispatch-manual",
    target: { kind: "command", ref: "commands/release-notes" },
    scheduleBindings: [],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - manual dispatch-only trigger",
  },
  {
    id: "target-command",
    target: { kind: "command", ref: "commands/publish-changelog" },
    scheduleBindings: [{ cron: "15 4 * * 1", enabled: true }],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - command target",
  },
  {
    id: "target-run-shell",
    target: { kind: "shell", command: "akm index --full", shell: "bash" },
    scheduleBindings: [{ cron: "15 4 * * 1", enabled: true }],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - run shell target",
  },
  {
    id: "target-script",
    target: { kind: "script", ref: "scripts/nightly-cleanup.sh" },
    scheduleBindings: [{ cron: "15 4 * * 1", enabled: true }],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - script target",
  },
  {
    id: "target-workflow",
    target: { kind: "workflow", ref: "workflows/nightly-report", params: { channel: "release" } },
    scheduleBindings: [{ cron: "15 4 * * 1", enabled: true }],
    execution: { redact: [], env: {} },
    name: "v3 migration fixture - workflow target",
  },
  {
    id: "options-env-timeout-redact",
    target: { kind: "shell", command: "akm index --full" },
    scheduleBindings: [{ cron: "15 4 * * 1", enabled: true }],
    execution: {
      timeout: "5m",
      redact: ["CONTRACT_FIXTURE_TOKEN"],
      env: { MODE: "safe", RETRIES: 3, DRY_RUN: true },
    },
    name: "v3 migration fixture - env, timeout, and redact options",
  },
];

function expectationFor(id: string): FixtureExpectation {
  const found = FIXTURE_EXPECTATIONS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`No adapter expectation authored in this test for manifest fixture "${id}" — add one above.`);
  }
  return found;
}

function refFor(fixture: ManifestFixture): string {
  return `tasks/${fixture.id}`;
}

function parseFixture(fixture: ManifestFixture): TaskV3SourceDocument {
  const filePath = path.join(FIXTURES_DIR, fixture.file);
  return parseTaskV3Yaml({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
}

interface LoadedCase {
  readonly fixture: ManifestFixture;
  readonly expectation: FixtureExpectation;
  readonly document: TaskV3SourceDocument;
  readonly definition: TaskDefinitionShape;
}

async function loadAllCases(): Promise<readonly LoadedCase[]> {
  const { taskDefinitionFromV3 } = await adapterModule();
  return loadManifestFixtures().map((fixture) => {
    const document = parseFixture(fixture);
    const definition = taskDefinitionFromV3(document, { ref: refFor(fixture) });
    return { fixture, expectation: expectationFor(fixture.id), document, definition };
  });
}

describe("taskDefinitionFromV3 — every tests/fixtures/execution-contracts/tasks/v3-migration/ fixture (P1b spec §3)", () => {
  // Canary: if manifest.json gains/loses a fixture without a matching update
  // here, this fails first with a clear count mismatch rather than a
  // confusing per-property diff below.
  test("the manifest has exactly the 8 fixtures this table covers", () => {
    expect(loadManifestFixtures()).toHaveLength(8);
    expect(FIXTURE_EXPECTATIONS).toHaveLength(8);
  });

  test("maps target kind/ref (or the shell command text) for every fixture", async () => {
    const cases = await loadAllCases();
    for (const { fixture, expectation, definition } of cases) {
      expect(definition.target, fixture.id).toEqual(expectation.target);
    }
  });

  test("maps schedule bindings (cron + enabled) for every fixture, frozen", async () => {
    const cases = await loadAllCases();
    for (const { fixture, expectation, definition } of cases) {
      expect(definition.scheduleBindings, fixture.id).toEqual(expectation.scheduleBindings);
      expect(Object.isFrozen(definition.scheduleBindings), fixture.id).toBe(true);
      for (const binding of definition.scheduleBindings) {
        expect(Object.isFrozen(binding), `${fixture.id} binding ${binding.cron}`).toBe(true);
      }
    }
  });

  test("maps execution defaults (engine/model/timeout/redact/env) for every fixture", async () => {
    const cases = await loadAllCases();
    for (const { fixture, expectation, definition } of cases) {
      expect(definition.execution.engine, fixture.id).toBe(expectation.execution.engine);
      expect(definition.execution.model, fixture.id).toBe(expectation.execution.model);
      expect(definition.execution.timeout, fixture.id).toBe(expectation.execution.timeout);
      expect(definition.execution.redact, fixture.id).toEqual(expectation.execution.redact);
      expect(definition.execution.env, fixture.id).toEqual(expectation.execution.env);
    }
  });

  test("maps source identity (path) and preserves the caller-supplied ref for every fixture", async () => {
    const cases = await loadAllCases();
    for (const { fixture, document, definition } of cases) {
      expect(definition.source, fixture.id).toEqual({ path: document.source.path });
      // Proves the adapter threads the caller-supplied ref through rather
      // than deriving it (design decision 2) — parseTaskV3Yaml's own output
      // carries no task-owned ref for the adapter to derive one from.
      expect(definition.ref, fixture.id).toBe(refFor(fixture));
    }
  });

  test("preserves the authored name for every fixture (none of these 8 set akm.description)", async () => {
    const cases = await loadAllCases();
    for (const { fixture, expectation, definition } of cases) {
      expect(definition.name, fixture.id).toBe(expectation.name);
      expect(definition.description, fixture.id).toBeUndefined();
    }
  });

  test("never throws for any fixture parseTaskV3Yaml accepted (manifest.json's own invariant)", async () => {
    const { taskDefinitionFromV3 } = await adapterModule();
    for (const fixture of loadManifestFixtures()) {
      const document = parseFixture(fixture);
      expect(() => taskDefinitionFromV3(document, { ref: refFor(fixture) }), fixture.id).not.toThrow();
    }
  });
});

// ── Supplementary: fields no manifest fixture happens to set ───────────────

describe("taskDefinitionFromV3 — fields no manifest fixture sets (supplementary, inline v3 document)", () => {
  test("preserves akm.description, akm.engine, akm.model, and broadcasts akm.enabled: false onto scheduleBindings", async () => {
    const { taskDefinitionFromV3 } = await adapterModule();
    const filePath = path.join(FIXTURES_DIR, "inline-supplementary-case.yml");
    const yaml = [
      "version: 3",
      "name: supplementary adapter coverage",
      "uses: commands/example",
      "akm:",
      '  schedule: "*/5 * * * *"',
      "  enabled: false",
      "  description: adapter coverage for fields no manifest fixture sets",
      "  engine: claude",
      "  model: claude-sonnet-5",
      "",
    ].join("\n");
    const document = parseTaskV3Yaml({ yaml, filePath });
    const definition = taskDefinitionFromV3(document, { ref: "tasks/supplementary" });

    expect(definition.target).toEqual({ kind: "command", ref: "commands/example" });
    expect(definition.description).toBe("adapter coverage for fields no manifest fixture sets");
    expect(definition.execution.engine).toBe("claude");
    expect(definition.execution.model).toBe("claude-sonnet-5");
    expect(definition.scheduleBindings).toEqual([{ cron: "*/5 * * * *", enabled: false }]);
  });
});

// ── Purity ratchet (spec §3.2) — text-level import scan across all four ────
// ── Lane A source files, mirroring tests/architecture/diagnostic-codes.test.ts ──

const MODEL_DEFINITION_FILE = path.join(ROOT, "src/tasks/model/definition.ts");
const MODEL_INVOCATION_FILE = path.join(ROOT, "src/tasks/model/invocation.ts");
const MODEL_SCHEDULE_FILE = path.join(ROOT, "src/tasks/model/schedule.ts");
const ADAPTER_FILE = path.join(ROOT, "src/tasks/source/parse-v3-adapter.ts");

// Spec §3.2's forbidden list. node:path and node:crypto are explicitly
// PERMITTED ("pure string/hash helpers") and deliberately absent here.
const FORBIDDEN_BARE_SPECIFIERS = new Set([
  "fs",
  "node:fs",
  "child_process",
  "node:child_process",
  "os",
  "node:os",
  "http",
  "node:http",
  "https",
  "node:https",
]);
const FORBIDDEN_PATH_SUBSTRINGS = [
  "/storage/",
  "core/state-db",
  "core/logs-db",
  "/sources/",
  "/integrations/",
  "/llm/",
  "/indexer/",
];

interface ModuleScan {
  readonly staticSpecifiers: readonly string[];
  readonly hasDynamicImportOrRequire: boolean;
}

/** Static import/re-export specifiers (top-level only — imports cannot nest) plus a whole-tree scan for dynamic `import(...)`/`require(...)` (which CAN nest inside a function). */
function scanModule(filePath: string): ModuleScan {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const staticSpecifiers: string[] = [];
  let hasDynamicImportOrRequire = false;
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) hasDynamicImportOrRequire = true;
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") hasDynamicImportOrRequire = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { staticSpecifiers, hasDynamicImportOrRequire };
}

function forbiddenSpecifier(specifier: string): boolean {
  if (FORBIDDEN_BARE_SPECIFIERS.has(specifier)) return true;
  return FORBIDDEN_PATH_SUBSTRINGS.some((needle) => specifier.includes(needle));
}

describe("purity ratchet — src/tasks/model/** and src/tasks/source/parse-v3-adapter.ts (P1b spec §3.2)", () => {
  const files: ReadonlyArray<readonly [label: string, filePath: string]> = [
    ["src/tasks/model/definition.ts", MODEL_DEFINITION_FILE],
    ["src/tasks/model/invocation.ts", MODEL_INVOCATION_FILE],
    ["src/tasks/model/schedule.ts", MODEL_SCHEDULE_FILE],
    ["src/tasks/source/parse-v3-adapter.ts", ADAPTER_FILE],
  ];

  for (const [label, filePath] of files) {
    test(`${label} imports no fs/db/network/storage/integration module and contains no dynamic import or require`, () => {
      const scan = scanModule(filePath);
      const offending = scan.staticSpecifiers.filter(forbiddenSpecifier);
      expect(offending, label).toEqual([]);
      expect(scan.hasDynamicImportOrRequire, label).toBe(false);
    });
  }
});
