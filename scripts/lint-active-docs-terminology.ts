// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-active-docs-terminology.ts
 *
 * akm's current terminology for "a source of assets" is "bundle" (the
 * distributable package name, `.stash.json` lockfile filename, and the
 * `itlackey/akm-stash` repo name are the only surviving literal "stash"
 * spellings — see docs/architecture/akm-core-principles.md). Historical
 * material (CHANGELOG, docs/migration/, docs/posts/, docs/plans/) is
 * exempt by policy: it intentionally preserves old commands/terminology as
 * a historical record. This script is a ratchet over the ACTIVE, current-
 * behavior doc surface only: it fails if prose there still teaches "stash"
 * instead of "bundle".
 *
 *   bun scripts/lint-active-docs-terminology.ts
 *
 * Scanned (active doc surfaces):
 *   - README.md
 *   - .github/README.npm.md
 *   - docs/README.md
 *   - docs/guides/**\/*.md
 *   - docs/reference/**\/*.md
 *   - docs/architecture/**\/*.md (except the file below)
 *   - docs/agents/**\/*.md
 *   - docs/maintainers/**\/*.md
 *
 * Explicitly skipped even though it lives under a scanned root — each is a
 * dated, point-in-time engineering artifact (a review, a close-out record, a
 * landed plan's retrospective), not current-state prose; verified by reading
 * each file's own self-description before adding it here:
 *   - docs/architecture/specs/0.9.0-docs-code-drift-register.md — a
 *     point-in-time drift register whose entries are historical text about
 *     what drifted, not current-state prose.
 *   - docs/architecture/specs/0.9.0-public-api-issue-backlog.md and
 *     docs/architecture/specs/0.9.0-release-surface-review.md —
 *     docs/architecture/README.md itself files these under "Historical
 *     review registers (0.9.0 release-review audit trail, kept for
 *     provenance, not normative going forward)" alongside the drift
 *     register above.
 *   - docs/architecture/specs/0.9.0-open-items-register.md — self-described
 *     as the "Close-out record for the three-phase 0.9.0 release-review
 *     cleanup program," whose per-item detail lives in the three registers
 *     above.
 *   - docs/architecture/specs/reviews/**  — dated, per-reviewer critique
 *     documents ("Critical Review — ... v7", "Reviewer #1 of 3", citing an
 *     exact branch/commit) — a review audit trail, not living reference.
 *   - docs/architecture/specs/di-seams-plan.md — a completed refactor plan
 *     whose only additions since landing are a retrospective "Implementation
 *     note (added later)"; the plan body itself describes a past state.
 *   - docs/architecture/akm-architecture-decision-history.md — self-labeled
 *     "Non-normative companion to the architecture specification" recording
 *     *how* past decisions were reached, ADR-style — a decision journal, the
 *     architecture-docs analogue of CHANGELOG.md.
 *
 * Always skipped (historical/generated/vendor surfaces):
 *   - CHANGELOG.md, docs/migration/**, docs/posts/**, docs/plans/**,
 *     tests/**, node_modules/**, dist/**
 *
 * What counts as a violation:
 *   - The word "stash" and its inflections "stashes"/"stashed"/"stashing"
 *     (case-insensitive, matched at word boundaries so it never fires on a
 *     larger identifier like `scoreStash`) appearing as PROSE.
 *
 * What is allowlisted (not flagged) even though it contains "stash":
 *   - The literal strings "itlackey/akm-stash", "akm-stash",
 *     "akm bundle add github:itlackey/akm-stash", the code identifier
 *     "scoreStash", the CLI flag value "personal-stash" (incl.
 *     "--policy personal-stash"), and the literal filename ".stash.json" —
 *     these are proper names / literal identifiers, not terminology choices.
 *   - Any "stash" that falls inside a markdown link's destination
 *     `](...)` or inside a path-shaped token (contains a `/`) — a doc
 *     linking to or naming a file that happens to have "stash" in its path
 *     is not a prose terminology violation. (If such a path is actually
 *     dead, that is a broken-link problem for a different lint, not this
 *     one.)
 *   - Any "stash" inside a single-backtick inline-code span (`` `...` ``)
 *     — this generalizes the same principle already established by the
 *     ".stash.json" and "scoreStash" allowlist entries above (both are
 *     inline-code-flavored literal tokens): backtick-quoted text in these
 *     docs is source-verified code — an actual TS identifier, CLI flag,
 *     env var, DB column, or file path (`StashEntryScope`, `$STASH`,
 *     `stash_dir`, `stash-cli.ts`, ...) that is still genuinely spelled
 *     "stash" in the codebase today. Renaming it in prose would invent a
 *     false fact, not fix a stale one — see the repo-wide GROUNDING rule.
 *     Fenced code blocks (```...```) are exempt the same way.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Explicit single files, relative to REPO_ROOT. */
const SCAN_FILES = ["README.md", ".github/README.npm.md", "docs/README.md"];

/** Directories walked recursively for *.md, relative to REPO_ROOT. */
const SCAN_DIRS = ["docs/guides", "docs/reference", "docs/architecture", "docs/agents", "docs/maintainers"];

/** Individually-justified file exclusions within an otherwise-scanned dir — see module doc. */
const SKIP_FILES = new Set([
  "docs/architecture/specs/0.9.0-docs-code-drift-register.md",
  "docs/architecture/specs/0.9.0-public-api-issue-backlog.md",
  "docs/architecture/specs/0.9.0-release-surface-review.md",
  "docs/architecture/specs/0.9.0-open-items-register.md",
  "docs/architecture/specs/di-seams-plan.md",
  "docs/architecture/akm-architecture-decision-history.md",
]);
/** Directory prefix exclusions within an otherwise-scanned dir — see module doc. */
const SKIP_DIR_INFIXES = ["docs/architecture/specs/reviews/"];

/** Directory/file roots never scanned, regardless of the roots above. */
const SKIP_DIR_PREFIXES = ["docs/migration/", "docs/posts/", "docs/plans/", "tests/", "node_modules/", "dist/"];
const SKIP_EXACT_FILES = new Set(["CHANGELOG.md"]);

/** Literal strings allowlisted verbatim wherever they occur in a line. */
const ALLOWLISTED_LITERALS = [
  "akm bundle add github:itlackey/akm-stash",
  "itlackey/akm-stash",
  "akm-stash",
  "--policy personal-stash",
  "personal-stash",
  "scoreStash",
  ".stash.json",
];

const STASH_WORD_RE = /\bstash(?:e[ds]|ing)?\b/gi;

interface Violation {
  file: string;
  line: number;
  matched: string;
}

function isSkipped(rel: string): boolean {
  if (SKIP_EXACT_FILES.has(rel)) return true;
  if (SKIP_FILES.has(rel)) return true;
  if (SKIP_DIR_INFIXES.some((infix) => rel.startsWith(infix))) return true;
  return SKIP_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function walkMarkdown(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
}

function collectFiles(): string[] {
  const abs: string[] = [];
  for (const f of SCAN_FILES) {
    const full = path.join(REPO_ROOT, f);
    if (fs.existsSync(full)) abs.push(full);
  }
  for (const d of SCAN_DIRS) walkMarkdown(path.join(REPO_ROOT, d), abs);

  const rels = abs.map((full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/")).filter((rel) => !isSkipped(rel));
  return Array.from(new Set(rels)).sort();
}

/** Spans (as [start, end) into `line`) that are exempt from the "stash" check. */
function protectedSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];

  // 1. Explicit literal allowlist — protect every occurrence verbatim.
  for (const literal of ALLOWLISTED_LITERALS) {
    let from = 0;
    while (true) {
      const idx = line.indexOf(literal, from);
      if (idx === -1) break;
      spans.push([idx, idx + literal.length]);
      from = idx + literal.length;
    }
  }

  // 2. Markdown link destinations: `](...)`.
  const linkRe = /\]\(([^)]*)\)/g;
  for (const m of line.matchAll(linkRe)) {
    const destStart = m.index + 2; // skip past "]("
    const destEnd = destStart + (m[1]?.length ?? 0);
    spans.push([destStart, destEnd]);
  }

  // 3. Path- or filename-shaped tokens: a contiguous non-whitespace run that
  // either contains a "/" (a path) or is a bare filename ending in a known
  // extension (e.g. a markdown link's TEXT reproducing its own destination
  // filename, like `[stash-organization-conventions.md](stash-organization-conventions.md)`
  // — the same "it's a literal filename, not a terminology choice" rationale
  // as the ".stash.json" allowlist entry above, generalized instead of
  // hand-listing every such filename).
  // Allows an optional trailing `:123` / `:123-456` / `:123,456` line-ref
  // suffix — this codebase's own citation convention for source file:line
  // pointers (e.g. `stash-cli.ts:169-223`), still a literal filename.
  const FILENAME_RE = /^[A-Za-z0-9_.-]+\.(md|json|ts|tsx|js|jsx|yml|yaml|py|sh|lock|txt)(:[0-9,-]+)?$/i;
  const tokenRe = /\S+/g;
  for (const m of line.matchAll(tokenRe)) {
    const token = m[0];
    const trimmed = token.replace(/^[[(]+/, "").replace(/[\])},.]+$/, "");
    if (token.includes("/") || FILENAME_RE.test(trimmed)) {
      spans.push([m.index, m.index + token.length]);
    }
  }

  // 3b. Same filename check, but for a markdown link's bracketed TEXT
  // (`[stash-organization-conventions.md](...)`) — the "/"-or-extension
  // token scan above never sees this in isolation because `\S+` swallows
  // the whole `[text](dest)` run as one token with no internal whitespace.
  const linkTextRe = /\[([^\]]+)\]/g;
  for (const m of line.matchAll(linkTextRe)) {
    const text = m[1] ?? "";
    if (FILENAME_RE.test(text)) {
      const textStart = m.index + 1; // skip past "["
      spans.push([textStart, textStart + text.length]);
    }
  }

  // 4. Single-backtick inline-code spans: `` `...` `` — see module doc.
  const backtickRe = /`([^`]+)`/g;
  for (const m of line.matchAll(backtickRe)) {
    spans.push([m.index, m.index + m[0].length]);
  }

  return spans;
}

function isProtected(start: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([s, e]) => start >= s && end <= e);
}

function scanFile(rel: string, text: string, violations: Violation[]): void {
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue; // the fence marker line itself is never prose
    }
    if (inFence) continue; // fenced code blocks are source-verified code, not prose
    const spans = protectedSpans(line);
    for (const m of line.matchAll(STASH_WORD_RE)) {
      const start = m.index;
      const end = start + m[0].length;
      if (isProtected(start, end, spans)) continue;
      violations.push({ file: rel, line: i + 1, matched: line.trim() });
    }
  }
}

function main(): void {
  const files = collectFiles();
  const violations: Violation[] = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    scanFile(rel, text, violations);
  }

  if (violations.length === 0) {
    process.stdout.write(
      `lint-active-docs-terminology: OK - 0 "stash" terminology violations found across ${files.length} active doc file(s).\n`,
    );
    return;
  }

  process.stderr.write(
    `lint-active-docs-terminology: FAIL - ${violations.length} "stash" terminology violation(s) found in active docs (use "bundle" instead).\n`,
  );
  let lastFile = "";
  for (const v of violations) {
    if (v.file !== lastFile) {
      process.stderr.write(`\n${v.file}\n`);
      lastFile = v.file;
    }
    process.stderr.write(`  line ${v.line}: ${v.matched}\n`);
  }
  process.exitCode = 1;
}

main();
