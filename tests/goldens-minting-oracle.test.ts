// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: the `deriveCanonicalAssetNameFromStashRoot` minting oracle
 * (WI-0b.3c, chunk-0b brief, `docs/design/execution/chunk-0b/anchors.md`
 * Section C — def `asset-spec.ts:338-353`).
 *
 * `deriveCanonicalAssetNameFromStashRoot(assetType, stashRoot, filePath)` has
 * exactly two branches (asset-spec.ts:343-352):
 *
 *   1. **canonical-typeRoot** — `relPath`'s first path segment equals the
 *      type's canonical dir (`TYPE_DIRS[assetType]`, e.g. `"agents"`); the
 *      effective `typeRoot` is `stashRoot/<firstSegment>`, so the derived
 *      name is relative to the type dir (matches a normally-installed
 *      asset).
 *   2. **fallback** — the first segment does NOT match; `typeRoot` falls
 *      back to the bare `stashRoot` itself, so the derived name preserves
 *      the FULL relative path from the stash root (matches an installed
 *      asset living under a custom top-level dir — the function's own
 *      doc-comment example, `tools/agents/svelte-file-editor`).
 *
 * Both branches delegate to `ASSET_SPECS[assetType].toCanonicalName`, so the
 * exact output also depends on each type's own name-shaping rule (the same
 * per-type function goldens-recognition-placement.test.ts pins in the
 * reverse direction via `toAssetPath`). This suite is pure-function-only —
 * `toCanonicalName` never touches the filesystem for any of the 13 types
 * (confirmed by reading every implementation in `asset-spec.ts`), so all
 * `stashRoot`/`filePath` inputs below are synthetic literal POSIX strings;
 * no sandbox or real files are needed for the pure-function half of this
 * golden.
 *
 * This is the oracle Chunk 8's full-table re-key pass leans on (anchors.md:
 * "the second [call site] is the exact oracle Chunk 8's re-key will lean
 * on") — thoroughness across both branches, for all 13
 * `ASSET_SPECS_INTERNAL` types, is the point.
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) for
 * `tests/fixtures/goldens/minting/oracle.json`.
 */

import { describe, expect, test } from "bun:test";
import { deriveCanonicalAssetNameFromStashRoot } from "../src/core/asset/asset-placement";
import { expectGolden } from "./_helpers/golden";

const GOLDEN_PATH = "tests/fixtures/goldens/minting/oracle.json";
const HEAD_SHA = "ff7ee5975e915c11d3799cdf5454c8bc494a304b";

/** Synthetic, non-existent, fixed literal stash root — the function never touches fs. */
const SYNTHETIC_STASH_ROOT = "/stash";

interface MintingCase {
  type: string;
  label: string;
  /** Path relative to SYNTHETIC_STASH_ROOT (stash-relative, POSIX). */
  relFilePath: string;
  expected: string | undefined;
}

// Two canonical + two fallback cases per type (plus a handful of documented
// extra branches) computed against SYNTHETIC_STASH_ROOT. Hand-derived from
// reading every ASSET_SPECS_INTERNAL.toCanonicalName implementation
// (asset-spec.ts) -- asserted below BEFORE being folded into the golden, so
// a wrong hand-derivation fails loudly rather than silently freezing.
const CASES: MintingCase[] = [
  // skill -- directory-based canonical name (dirname of the resolved path).
  { type: "skill", label: "canonical", relFilePath: "skills/example-skill/SKILL.md", expected: "example-skill" },
  {
    type: "skill",
    label: "fallback",
    // The function's own doc-comment example (asset-spec.ts:350).
    relFilePath: "tools/agents/svelte-file-editor/SKILL.md",
    expected: "tools/agents/svelte-file-editor",
  },
  // command / agent / knowledge / lesson / fact / memory share markdownSpec.
  { type: "command", label: "canonical", relFilePath: "commands/example-command.md", expected: "example-command" },
  {
    type: "command",
    label: "fallback",
    relFilePath: "tools/commands/example-command.md",
    expected: "tools/commands/example-command",
  },
  { type: "agent", label: "canonical", relFilePath: "agents/example-agent.md", expected: "example-agent" },
  {
    type: "agent",
    label: "fallback",
    relFilePath: "tools/agents/example-agent.md",
    expected: "tools/agents/example-agent",
  },
  {
    type: "knowledge",
    label: "canonical",
    relFilePath: "knowledge/example-knowledge.md",
    expected: "example-knowledge",
  },
  {
    type: "knowledge",
    label: "fallback",
    relFilePath: "docs/knowledge/example-knowledge.md",
    expected: "docs/knowledge/example-knowledge",
  },
  // workflow -- markdownSpec-like, but workflow-format-unification (spec §3)
  // shrinks WORKFLOW_EXTENSIONS to [".md"] only (the YAML workflow *program*
  // is deleted as a distinct on-disk format). A non-.md extension is no
  // longer stripped -- it passes through as part of the canonical name.
  { type: "workflow", label: "canonical", relFilePath: "workflows/example-workflow.md", expected: "example-workflow" },
  {
    type: "workflow",
    label: "canonicalNonMdExtensionKept",
    relFilePath: "workflows/example-workflow.yaml",
    expected: "example-workflow.yaml",
  },
  {
    type: "workflow",
    label: "fallback",
    relFilePath: "installed/workflows/example-workflow.md",
    expected: "installed/workflows/example-workflow",
  },
  {
    type: "workflow",
    label: "fallbackNonMdExtensionKept",
    relFilePath: "installed/workflows/example-workflow.yaml",
    expected: "installed/workflows/example-workflow.yaml",
  },
  // script -- identity join, extension is PART of the canonical name.
  { type: "script", label: "canonical", relFilePath: "scripts/example-script.sh", expected: "example-script.sh" },
  {
    type: "script",
    label: "fallback",
    relFilePath: "tools/scripts/example-script.sh",
    expected: "tools/scripts/example-script.sh",
  },
  // memory -- markdownSpec; .derived.md twin only strips the trailing .md.
  { type: "memory", label: "canonical", relFilePath: "memories/example-memory.md", expected: "example-memory" },
  {
    type: "memory",
    label: "canonicalDerivedTwin",
    relFilePath: "memories/example-memory.derived.md",
    expected: "example-memory.derived",
  },
  {
    type: "memory",
    label: "fallback",
    relFilePath: "tools/memories/example-memory.md",
    expected: "tools/memories/example-memory",
  },
  // env -- ".env" -> "default" alias; "<name>.env" -> "<name>".
  { type: "env", label: "canonicalDefault", relFilePath: "env/.env", expected: "default" },
  { type: "env", label: "canonicalNamed", relFilePath: "env/staging.env", expected: "staging" },
  { type: "env", label: "fallback", relFilePath: "tools/env/staging.env", expected: "tools/env/staging" },
  {
    type: "env",
    label: "fallbackDefault",
    relFilePath: "tools/env/.env",
    expected: "tools/env/default",
  },
  // secret -- identity join, no extension logic, arbitrary nesting.
  { type: "secret", label: "canonical", relFilePath: "secrets/example-secret", expected: "example-secret" },
  {
    type: "secret",
    label: "canonicalNested",
    relFilePath: "secrets/team/deploy.key",
    expected: "team/deploy.key",
  },
  {
    type: "secret",
    label: "fallback",
    relFilePath: "tools/secrets/example-secret",
    expected: "tools/secrets/example-secret",
  },
  // lesson -- markdownSpec.
  { type: "lesson", label: "canonical", relFilePath: "lessons/example-lesson.md", expected: "example-lesson" },
  {
    type: "lesson",
    label: "fallback",
    relFilePath: "tools/lessons/example-lesson.md",
    expected: "tools/lessons/example-lesson",
  },
  // task -- strips trailing .yml only.
  { type: "task", label: "canonical", relFilePath: "tasks/example-task.yml", expected: "example-task" },
  {
    type: "task",
    label: "fallback",
    relFilePath: "tools/tasks/example-task.yml",
    expected: "tools/tasks/example-task",
  },
  // session -- markdownSpec, always nested under a harness dir in practice.
  {
    type: "session",
    label: "canonical",
    relFilePath: "sessions/harness-a/example-session.md",
    expected: "harness-a/example-session",
  },
  {
    type: "session",
    label: "fallback",
    relFilePath: "tools/sessions/harness-a/example-session.md",
    expected: "tools/sessions/harness-a/example-session",
  },
  // fact -- markdownSpec, optionally nested under a category dir.
  { type: "fact", label: "canonical", relFilePath: "facts/meta/example-fact.md", expected: "meta/example-fact" },
  {
    type: "fact",
    label: "fallback",
    relFilePath: "tools/facts/meta/example-fact.md",
    expected: "tools/facts/meta/example-fact",
  },
];

function runCase(c: MintingCase): string | undefined {
  const filePath = `${SYNTHETIC_STASH_ROOT}/${c.relFilePath}`;
  return deriveCanonicalAssetNameFromStashRoot(c.type, SYNTHETIC_STASH_ROOT, filePath);
}

// ── 1. Pure-function assertions (pre-capture sanity) ────────────────────────

describe("deriveCanonicalAssetNameFromStashRoot: canonical-typeRoot + fallback branches, all 13 types (WI-0b.3c)", () => {
  for (const c of CASES) {
    test(`${c.type} / ${c.label}: ${c.relFilePath} -> ${c.expected}`, () => {
      expect(runCase(c)).toBe(c.expected);
    });
  }

  test("every type is covered by at least one canonical-branch and one fallback-branch case", () => {
    const types = new Set(CASES.map((c) => c.type));
    // wiki retired in chunk 4 (no longer a placement type) → 13 minted types.
    expect(types.size).toBe(13);
    for (const type of types) {
      const hasCanonical = CASES.some((c) => c.type === type && c.label.startsWith("canonical"));
      const hasFallback = CASES.some((c) => c.type === type && c.label === "fallback");
      expect(hasCanonical, `${type} missing a canonical-branch case`).toBe(true);
      expect(hasFallback, `${type} missing a fallback-branch case`).toBe(true);
    }
  });
});

// ── 2. Golden fixture capture ────────────────────────────────────────────────
//
// Re-derives every case independently of the assertion blocks above so
// capture never depends on bun:test's within-file execution order.

describe("golden fixture: deriveCanonicalAssetNameFromStashRoot minting oracle (WI-0b.3c)", () => {
  test("golden fixture: minting/oracle.json", () => {
    const pureFunction: Record<string, Record<string, { relFilePath: string; name: string | undefined }>> = {};
    for (const c of CASES) {
      pureFunction[c.type] ??= {};
      pureFunction[c.type]![c.label] = { relFilePath: c.relFilePath, name: runCase(c) };
    }

    expectGolden(GOLDEN_PATH, {
      scenario:
        "deriveCanonicalAssetNameFromStashRoot minting oracle: canonical-typeRoot + fallback branches for all 13 minted asset types (WI-0b.3c, asset-spec.ts:338-353)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "pureFunction: keyed by [type][label] -> {relFilePath (relative to a synthetic, non-existent /stash " +
          "literal -- the function is pure, no fs access), name (the derived canonical name, or undefined)}. Every " +
          'type has a "canonical" (first path segment matches TYPE_DIRS[type]) and a "fallback" (custom ' +
          "top-level dir, e.g. the function's own doc-comment example tools/agents/svelte-file-editor) case; " +
          "several types carry extra documented branches (workflow's non-.md-extension-kept behavior, memory's " +
          ".derived.md twin, env's \"default\" alias in both branches, secret's nested-name identity join).",
        "FROZEN behavior-parity oracle (D0b-1/D0b-3): this is the exact function Chunk 8's full-table re-key pass " +
          "leans on (anchors.md Section C) -- Chunk 2's format adapters and Chunk 8's re-key must reproduce both " +
          "branches byte-for-byte.",
        "RE-BASELINED (workflow-format-unification, driver-side test port, reBaselineChunk 4): WORKFLOW_EXTENSIONS " +
          'shrinks to [".md"] only (spec §3 -- the YAML workflow *program* is deleted as a distinct on-disk ' +
          "format), so workflowSpec.toCanonicalName no longer strips a .yaml/.yml extension. Renamed workflow's " +
          '"canonicalYaml" case to "canonicalNonMdExtensionKept" (expected name now KEEPS the .yaml extension: ' +
          '"example-workflow.yaml", not "example-workflow"); the "fallback" case switched to a .md relFilePath ' +
          'so it stays a pure fallback-branch pin, and a new "fallbackNonMdExtensionKept" case documents the same ' +
          "extension-kept behavior in the fallback branch. Every other type/case is byte-identical.",
      ],
      pureFunction,
    });
  });
});
