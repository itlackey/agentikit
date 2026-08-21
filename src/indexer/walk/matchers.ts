// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in asset matchers for the akm file classification system.
 *
 * Each private `classifyBy*` function encapsulates the classification logic for
 * one heuristic. The public `*Matcher` exports compose those facts into the
 * `MatchResult` shape expected by the rest of the indexer.
 */

import { SCRIPT_EXTENSIONS } from "../../core/recognition-util";
import { presentationFor } from "../../core/type-presentation";
import type { FileContext, MatchResult } from "./file-context";

export type PathFileContext = Omit<FileContext, "content" | "frontmatter" | "stat">;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MatchFact {
  type: string;
  specificity: number;
  meta?: Record<string, unknown>;
}

interface DirTypeRule {
  dir: string;
  type: MatchFact["type"];
  test: (ext: string, fileName: string) => boolean;
}

// ---------------------------------------------------------------------------
// Private data
// ---------------------------------------------------------------------------

const DIR_TYPE_MAP: DirTypeRule[] = [
  {
    dir: "scripts",
    type: "script",
    test: (ext) => SCRIPT_EXTENSIONS.has(ext),
  },
  {
    dir: "commands",
    type: "command",
    test: (ext) => ext === ".md",
  },
  {
    dir: "agents",
    type: "agent",
    test: (ext) => ext === ".md",
  },
  {
    dir: "knowledge",
    type: "knowledge",
    test: (ext) => ext === ".md",
  },
  {
    // R-045 / Q-18 second half (owner ruling 11) — stash-resident `instruction`
    // assets live under `instructions/`, mirroring the `knowledge` rule. This
    // is a walker discovery rule for FILES ON DISK under a stash's
    // `instructions/` dir; it is unrelated to the adapter-emitted root
    // CLAUDE.md/AGENTS.md instruction docs (`tool-dir-shared.ts`), which are
    // synthesized by format-family adapters, carry `ownsPresentation: true`,
    // and never pass through this matcher at all.
    dir: "instructions",
    type: "instruction",
    test: (ext) => ext === ".md",
  },
  {
    dir: "workflows",
    type: "workflow",
    test: (ext) => ext === ".md" || ext === ".yml",
  },
  {
    dir: "memories",
    type: "memory",
    test: (ext) => ext === ".md",
  },
  {
    dir: "lessons",
    type: "lesson",
    test: (ext) => ext === ".md",
  },
  {
    dir: "env",
    type: "env",
    test: (_, fileName) => fileName === ".env" || fileName.endsWith(".env"),
  },
  {
    dir: "secrets",
    type: "secret",
    // Any regular file under secrets/ is a secret value, except the lock and
    // sensitive-marker sidecars. The whole file is the value (no extension or
    // body parsing — see the secret-file renderer + indexer guards).
    test: (_, fileName) => !fileName.endsWith(".lock") && !fileName.endsWith(".sensitive"),
  },
  {
    dir: "tasks",
    type: "task",
    // Tasks migrated from `.md` to `.yml` in 0.8.0 (commit 031c659f updated
    // the placement specs, renderers, and the task-linter, but missed this
    // matcher — tasks/*.yml were unrecognized until this fix).
    test: (ext) => ext === ".yml",
  },
  {
    // #561 — agent session assets live under `sessions/<harness>/<id>.md`.
    // classifyByDirectory walks every ancestor dir, so a nested file still
    // matches the `sessions` rule. Without this entry the file falls through
    // to classifyBySmartMd and is mistyped as `knowledge`.
    dir: "sessions",
    type: "session",
    test: (ext) => ext === ".md",
  },
  {
    // Durable stash-level facts live under `facts/<category>/<name>.md`.
    // classifyByDirectory walks every ancestor dir, so nested category
    // subdirs still match. Without this entry a fact file would fall through
    // to classifyBySmartMd and be mistyped as `knowledge`.
    dir: "facts",
    type: "fact",
    test: (ext) => ext === ".md",
  },
];

const COMMAND_PLACEHOLDER_RE = /\$ARGUMENTS|\$[123]\b/;
const SMART_MD_FACTS = {
  workflow: { type: "workflow", specificity: 19 },
  toolsAgent: { type: "agent", specificity: 20 },
  command: { type: "command", specificity: 18 },
  modelAgent: { type: "agent", specificity: 8 },
  knowledge: { type: "knowledge", specificity: 5 },
} as const satisfies Record<string, MatchFact>;

// Files that should never be treated as the typed asset for the surrounding
// directory (e.g. `workflows/README.md` is documentation, not a workflow).
// Lower-cased and matched case-insensitively against `ctx.fileName`. They are
// still indexable — falling through to `classifyBySmartMd` typically routes
// them to the generic `knowledge` type.
const TYPED_DIR_DOC_FILES = new Set(["readme.md"]);

function isTypedDirDocFile(fileName: string): boolean {
  return TYPED_DIR_DOC_FILES.has(fileName.toLowerCase());
}

function isNestedSkillResource(ctx: FileContext): boolean {
  return ctx.ancestorDirs[0] === "skills" && ctx.ancestorDirs.length > 1 && ctx.fileName !== "SKILL.md";
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function matchDirectoryHint(dirName: string, ctx: FileContext, specificity: number): MatchFact | null {
  if (dirName === "skills" && ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity };
  }

  for (const rule of DIR_TYPE_MAP) {
    if (rule.dir === dirName && rule.test(ctx.ext, ctx.fileName)) {
      // Skip `README.md` (case-insensitive) so `workflows/README.md`,
      // `agents/README.md`, etc. are not parsed as the typed asset and don't
      // trip the workflow/agent metadata validators. They still get indexed
      // as `knowledge` via the smart-md matcher.
      if (isTypedDirDocFile(ctx.fileName)) return null;
      return { type: rule.type, specificity };
    }
  }

  return null;
}

function classifyByExtension(ctx: FileContext): MatchFact | null {
  if (ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity: 25 };
  }

  if (SCRIPT_EXTENSIONS.has(ctx.ext)) {
    return { type: "script", specificity: 3 };
  }

  return null;
}

function classifyByDirectory(ctx: FileContext): MatchFact | null {
  if (isNestedSkillResource(ctx)) return null;
  for (const dir of ctx.ancestorDirs) {
    const result = matchDirectoryHint(dir, ctx, 10);
    if (result) return result;
  }
  return null;
}

function classifyByParentDirHint(ctx: FileContext): MatchFact | null {
  const { parentDir, ext, fileName } = ctx;

  if (isNestedSkillResource(ctx)) return null;

  if (parentDir === "skills" && (fileName === "SKILL.md" || ext === ".md")) {
    return { type: "skill", specificity: 15 };
  }

  return matchDirectoryHint(parentDir, ctx, 15);
}

function classifyBySmartMd(ctx: FileContext): MatchFact | null {
  if (ctx.ext !== ".md") return null;

  // Never read the body of a file under secrets/ — the whole file is the
  // secret value. The directory matcher classifies it as `secret` without
  // touching content; bailing here keeps classifyBySmartMd from calling
  // ctx.content()/frontmatter() on secret material.
  if (ctx.ancestorDirs.includes("secrets")) return null;

  // README.md is documentation, never a workflow/agent/command even when the
  // body shape would otherwise classify (e.g. step-list inside a project
  // README under workflows/). Fall straight through to `knowledge`.
  if (isTypedDirDocFile(ctx.fileName)) {
    return SMART_MD_FACTS.knowledge;
  }

  const body = ctx.content();
  const fm = ctx.frontmatter();

  // Recognition is frontmatter `type: workflow` or residence under `workflows/`
  // (workflow-format-unification, spec §2.5) — no content sniffing. The
  // directory rule is `classifyByDirectory`/`classifyByParentDirHint`'s job;
  // this only catches a workflow living OUTSIDE `workflows/` that still
  // declares its type explicitly.
  if (fm && fm.type === "workflow") {
    return SMART_MD_FACTS.workflow;
  }

  if (fm) {
    // `tools` is the one authoring key for an agent's tool grant. Recognition
    // covers only the key the renderer honors.
    if ("tools" in fm) {
      return SMART_MD_FACTS.toolsAgent;
    }

    if ("agent" in fm) {
      return SMART_MD_FACTS.command;
    }
  }

  if (COMMAND_PLACEHOLDER_RE.test(body)) {
    return SMART_MD_FACTS.command;
  }

  if (fm && "model" in fm) {
    return SMART_MD_FACTS.modelAgent;
  }

  return SMART_MD_FACTS.knowledge;
}

// ---------------------------------------------------------------------------
// Adapter: MatchFact → MatchResult
// ---------------------------------------------------------------------------

function toMatchResult(ctx: FileContext, classify: (ctx: FileContext) => MatchFact | null): MatchResult | null {
  const fact = classify(ctx);
  return fact ? matchResultForFact(fact) : null;
}

function matchResultForFact(fact: MatchFact): MatchResult | null {
  // Renderer name resolved via TYPE_PRESENTATION (core leaf), so matchers.ts
  // carries no edge into the taxonomy SCC (chunk-3 cutover enabler).
  // TYPE_PRESENTATION.renderer is the single source of truth for renderer names.
  const renderer = presentationFor(fact.type).renderer;
  if (!renderer) return null;
  return {
    type: fact.type,
    specificity: fact.specificity,
    renderer,
    ...(fact.meta ? { meta: fact.meta } : {}),
  };
}

/**
 * Every smart-Markdown result possible from path fields alone. The actual
 * classifier above returns only facts from this shared table, so owner
 * discovery can conservatively model a byte request without reading bytes.
 */
export function smartMdPathCandidates(ctx: PathFileContext): MatchResult[] {
  if (ctx.ext !== ".md" || ctx.ancestorDirs.includes("secrets")) return [];
  const facts = isTypedDirDocFile(ctx.fileName)
    ? [SMART_MD_FACTS.knowledge]
    : [
        SMART_MD_FACTS.workflow,
        SMART_MD_FACTS.toolsAgent,
        SMART_MD_FACTS.command,
        SMART_MD_FACTS.modelAgent,
        SMART_MD_FACTS.knowledge,
      ];
  return facts.flatMap((fact) => {
    const result = matchResultForFact(fact);
    return result ? [result] : [];
  });
}

// ---------------------------------------------------------------------------
// Public matchers (API unchanged)
// ---------------------------------------------------------------------------

export function extensionMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByExtension);
}

export function directoryMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByDirectory);
}

export function parentDirHintMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByParentDirHint);
}

export function smartMdMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyBySmartMd);
}

// The four matcher functions above are consumed directly by the akm adapter's
// synchronous `recognizeMatch()` (`core/adapter/adapters/akm-adapter.ts`, which
// holds the same registration-order array for tie-breaking). The chunk-3 cutover
// removed the file-context matcher registry, so there is no `registerBuiltinMatchers`
// glue any more — recognition is adapter-driven, not registry-driven.
