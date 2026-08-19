import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { claudeAdapter } from "../../../src/core/adapter/adapters/claude-adapter";
import { opencodeAdapter } from "../../../src/core/adapter/adapters/opencode-adapter";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { createResolvedCommand } from "../../../src/execution/resolved-request";
import { renderMarkdownExecutionSource } from "../../../src/execution/source";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import {
  assertFixtureBytesUnchanged,
  captureFixtureBytes,
  EXECUTION_CONTRACT_FIXTURES,
  sha256Utf8,
} from "../../_helpers/execution-contracts";

const NATIVE_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "native");

const cases: Array<{
  adapter: BundleAdapter;
  adapterId: "akm" | "claude" | "opencode";
  kind: "command" | "persona";
  file: string;
}> = [
  { adapter: akmAdapter, adapterId: "akm", kind: "command", file: "commands/contract-review.md" },
  { adapter: akmAdapter, adapterId: "akm", kind: "persona", file: "agents/contract-reviewer.md" },
  { adapter: claudeAdapter, adapterId: "claude", kind: "command", file: "commands/contract-review.md" },
  { adapter: claudeAdapter, adapterId: "claude", kind: "persona", file: "agents/contract-reviewer.md" },
  { adapter: opencodeAdapter, adapterId: "opencode", kind: "command", file: "commands/contract-review.md" },
  { adapter: opencodeAdapter, adapterId: "opencode", kind: "persona", file: "agents/contract-reviewer.md" },
];

function render(testCase: (typeof cases)[number]) {
  const root = path.join(NATIVE_ROOT, testCase.adapterId);
  const component: BundleComponent = {
    id: `fixture-${testCase.adapterId}`,
    adapter: testCase.adapterId,
    root,
    writable: false,
  };
  const file = buildFileContext(root, path.join(root, testCase.file));
  const source = testCase.adapter.renderExecutionSource?.(component, file);
  if (!source) throw new Error(`${testCase.adapterId}:${testCase.file} did not render an execution source`);
  return { root, file, source };
}

function renderCase(adapterId: (typeof cases)[number]["adapterId"], kind: (typeof cases)[number]["kind"]) {
  const testCase = cases.find((candidate) => candidate.adapterId === adapterId && candidate.kind === kind);
  if (!testCase) throw new Error(`missing execution source case: ${adapterId}:${kind}`);
  return render(testCase).source;
}

describe("adapter-rendered execution sources", () => {
  test("AKM, Claude, and OpenCode return body-only command/persona records with exact identity", () => {
    const before = captureFixtureBytes(NATIVE_ROOT);
    for (const testCase of cases) {
      const { file, source } = render(testCase);
      const raw = fs.readFileSync(file.absPath, "utf8");
      const conceptId = testCase.file.replace(/\.md$/, "");

      expect(source.kind, `${testCase.adapterId}:${testCase.file}`).toBe(testCase.kind);
      expect(source.content).toContain("# Contract review");
      expect(source.content).not.toStartWith("---");
      expect(source.content).not.toContain("description:");
      expect(source.identity).toEqual({
        ref: `fixture-${testCase.adapterId}//${conceptId}`,
        bundle: `fixture-${testCase.adapterId}`,
        adapter: testCase.adapterId,
        file: testCase.file,
        hash: sha256Utf8(raw),
      });
      expect(Object.hasOwn(source, "raw")).toBe(false);
      expect(Object.hasOwn(source, "frontmatter")).toBe(false);
    }
    assertFixtureBytesUnchanged(NATIVE_ROOT, before);
  });

  test("translates common defaults and retains only explicit owner-keyed native extensions", () => {
    const akmCommand = renderCase("akm", "command");
    const akmPersona = renderCase("akm", "persona");
    const claudeCommand = renderCase("claude", "command");
    const claudePersona = renderCase("claude", "persona");
    const opencodeCommand = renderCase("opencode", "command");
    const opencodePersona = renderCase("opencode", "persona");

    expect(akmCommand.defaults).toEqual({ agent: "agents/contract-reviewer", model: "fixture-balanced" });
    expect(akmPersona.defaults).toEqual({ model: "fixture-balanced", tools: ["read", "grep"] });
    expect(claudeCommand.defaults).toEqual({
      engine: "fixture-agent",
      model: "fixture-balanced",
      tools: "Read, Grep",
      timeout: "45s",
    });
    expect(claudeCommand.extensions).toEqual({ claude: { argumentHint: "<target>" } });
    expect(claudePersona.defaults).toEqual({
      engine: "fixture-agent",
      model: "fixture-balanced",
      tools: "Read, Grep",
      timeout: "45s",
    });
    expect(opencodeCommand.defaults).toEqual({
      agent: "contract-reviewer",
      model: "fixture-balanced",
      tools: { read: true, grep: true },
    });
    expect(opencodePersona.defaults).toEqual({
      engine: "fixture-agent",
      model: "fixture-balanced",
      inference: { temperature: 0 },
      tools: { read: true, grep: true, write: false },
      timeout: "45s",
    });
    expect(opencodePersona.extensions).toEqual({ opencode: { mode: "subagent" } });
  });

  test("construction rejects an unrendered structural lookalike", () => {
    const rawLookalike = {
      kind: "command",
      content: "---\ndescription: leaked frontmatter\n---\nDo work.",
      defaults: {},
      identity: {
        ref: "fixture//commands/raw",
        bundle: "fixture",
        adapter: "akm",
        file: "commands/raw.md",
        hash: "0".repeat(64),
      },
    };
    expect(() => createResolvedCommand({ source: rawLookalike as never, content: rawLookalike.content })).toThrow(
      /adapter-rendered command source/i,
    );

    expect(() =>
      renderMarkdownExecutionSource({
        kind: "command",
        raw: "---\ndescription: unterminated\nDo work.",
        identity: {
          ref: "fixture//commands/unterminated",
          bundle: "fixture",
          adapter: "akm",
          file: "commands/unterminated.md",
        },
      }),
    ).toThrow(/frontmatter/i);
  });
});
