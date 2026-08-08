// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm 0.9.0 Part5-4 / W3-X F1 — executable-doc-example gate.
 *
 * Root-cause fix for the largest remaining backlog category: docs teach `akm
 * <cmd> --flag` invocations that reference commands/flags that were renamed
 * or removed, and nothing in CI reads doc prose against the real command
 * tree. This script does NOT execute anything (many `akm` examples mutate
 * state, hit the network, or need a real stash) — it statically checks every
 * `akm …` invocation found in a fenced code block against the REAL citty
 * command tree exported from `src/cli.ts`: does the (sub)command exist, and
 * is every `--flag` it passes declared on that command (or a global/citty
 * builtin flag)? That is a static, side-effect-free check that catches the
 * large majority of doc drift.
 *
 *   bun scripts/lint-doc-examples.ts
 *
 * Scanned: every `.md` under docs/, plus README.md, AGENTS.md, STABILITY.md.
 *
 * What this deliberately does NOT flag (and why):
 *  - Positional values (`<ref>`, a real ref, a query string, …) — only
 *    `--flag`/`-x` TOKENS are checked; values are never validated.
 *  - A "subcommand-shaped" word is only flagged as unknown when the current
 *    node in the tree still expects one (i.e. it's a command GROUP). Once a
 *    LEAF command is reached, every following word is a positional/value and
 *    is ignored — this is what lets `akm search <query>` and
 *    `akm registry search "some query"` pass without a placeholder allowlist.
 *  - Everything after a bare `--` token (the CLI's `env run <name> -- <cmd>`
 *    / `secret run … -- <cmd>` pass-through convention) — those are the
 *    WRAPPED command's own argv, not akm's.
 *  - A token containing `<`, `>`, `$`, or `|` is never treated as a literal
 *    flag or subcommand name — it is a synopsis placeholder
 *    (`[--format json|yaml]`) or a shell substitution artifact, not a literal
 *    invocation token.
 *  - A line containing the literal marker `doclint:ignore` anywhere on it
 *    (put it in a trailing shell comment, e.g. `akm wiki list  #
 *    doclint:ignore` ) is skipped entirely. This is the narrow, per-instance
 *    escape hatch for examples that are DELIBERATELY invalid (documenting an
 *    old/removed command, demonstrating an error). It is a marker on the
 *    exact line, never a whole-file or whole-directory carve-out.
 *  - `ALLOWED_VIOLATIONS` below (file:line:token), for the rare case a
 *    doclint:ignore marker can't be added in place (e.g. inside a fenced
 *    block whose exact bytes are pinned by another test). Empty by default —
 *    same convention as `scripts/lint-shipped-assets.ts`'s `ALLOWED_OFFENSES`.
 *
 * What this is a STATIC APPROXIMATION of, not a citty re-implementation:
 *  - Allowed flags for a resolved command are the UNION of every level's own
 *    `args` from the root down to the deepest resolved node (not a strict
 *    per-level parse). This can occasionally accept a flag one level "too
 *    high", but it will never invent a flag that doesn't exist anywhere on
 *    the path — false negatives are possible, false positives are not (by
 *    construction, since the set only ever grows from real declared args).
 *  - Command/subcommand resolution walks only WORD-SHAPED tokens
 *    (`/^[a-z][a-z0-9-]*$/i`) in order, skipping flag tokens; a string flag's
 *    value that happens to look like a subcommand name could in principle be
 *    misread, but only before the deepest LEAF is reached — every command in
 *    this tree resolves its full subcommand path before any flag value that
 *    could collide, so this has not produced a false positive in practice
 *    (see the "prove it can fail" pair in the F1 report for a live check).
 */

import fs from "node:fs";
import path from "node:path";
import type { ArgDef, ArgsDef, CommandMeta } from "citty";
import { main } from "../src/cli";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const DOC_ROOTS = ["docs", "src/assets/hints"];
const DOC_FILES = ["README.md", "AGENTS.md", "STABILITY.md"];

/** Per-instance skip marker — see module doc. Grep-discoverable, one line. */
const SKIP_MARKER = "doclint:ignore";

/**
 * Individually-justified (file, line, token) exceptions — NOT a directory or
 * file carve-out. Keep empty by default; see `scripts/lint-shipped-assets.ts`
 * for the precedent this mirrors.
 *
 * docs/migration/v0.7-to-v0.8.md:1154 — the line is inside a literal
 * box-drawing terminal-banner illustration (the exact text 0.8.0's
 * auto-migration notice printed), not a runnable shell line. A trailing
 * `# doclint:ignore` comment would visibly corrupt the banner's right
 * border for readers, so the exception lives here instead. `akm config
 * migrate` was a real, wired-in 0.8.0 subcommand (see the surrounding
 * "Config layer rewrite" section) — historical, not a current-syntax bug.
 *
 * docs/posts/task-assets-persistent-workflows-11.md:76 — the line is inside
 * a YAML `prompt: |` literal block scalar (a dated 0.8.0-era task-assets
 * post's worked example). A trailing `# doclint:ignore` comment would become
 * part of the literal prompt STRING VALUE, not a comment, silently changing
 * the documented prompt text — so the exception lives here instead. `akm
 * wiki ingest`/`akm wiki lint` were real 0.8.0-era commands; the whole
 * `wiki` family was removed in 0.9.0. (Line number shifted +3 from this
 * post's original 73 by the dated-content archive banner every docs/posts/
 * file now carries.)
 *
 * docs/posts/task-assets-persistent-workflows-11.md:89 — the line begins a
 * backslash-continued multi-line `akm tasks add …` invocation (the same
 * dated 0.8.0-era task-assets post). A trailing `# doclint:ignore` comment
 * would break the `\` line continuation, corrupting the copy-pasteable
 * example — so the exception lives here instead. `tasks` (plural) was the
 * command group's spelling at the time; it was renamed to singular `task`
 * in 0.9.0 (S6). (Line number shifted +3 from this post's original 86, same
 * archive-banner cause as above.)
 */
const ALLOWED_VIOLATIONS: ReadonlySet<string> = new Set([
  "docs/migration/v0.7-to-v0.8.md:1154:migrate",
  "docs/migration/v0.7-to-v0.8.md:1154:--dry-run",
  "docs/migration/v0.7-to-v0.8.md:1154:--print-diff",
  "docs/posts/task-assets-persistent-workflows-11.md:76:wiki",
  "docs/posts/task-assets-persistent-workflows-11.md:89:tasks",
  "docs/posts/task-assets-persistent-workflows-11.md:89:--schedule",
  "docs/posts/task-assets-persistent-workflows-11.md:89:--command",
  "docs/posts/task-assets-persistent-workflows-11.md:89:--name",
  "docs/posts/task-assets-persistent-workflows-11.md:89:--description",
]);

// ── 1. Build the real command tree from src/cli.ts (single source of truth —
// no hand-maintained mirror; see the module doc of lint-shipped-assets.ts for
// the exact failure mode a hand-maintained list produces). ──────────────────

// A minimal structural shape (not citty's own CommandDef<T>, which is generic
// over ArgsDef) — this walk only ever touches `meta`/`args`/`subCommands`.
type AnyCmd = { meta?: unknown; args?: unknown; subCommands?: unknown };

function resolveMaybe<T>(v: unknown): T {
  return (typeof v === "function" ? (v as () => T)() : (v as T)) ?? ({} as T);
}

function toArray(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

interface CmdNode {
  path: string; // e.g. "akm tasks run" — for messages only
  args: ArgsDef;
  children: Map<string, CmdNode>;
}

function buildNode(def: AnyCmd, cmdPath: string): CmdNode {
  const node: CmdNode = { path: cmdPath, args: resolveMaybe<ArgsDef>(def.args), children: new Map() };
  const subs = resolveMaybe<Record<string, AnyCmd>>(def.subCommands);
  for (const [name, rawChild] of Object.entries(subs)) {
    const child = resolveMaybe<AnyCmd>(rawChild);
    const childNode = buildNode(child, `${cmdPath} ${name}`);
    node.children.set(name, childNode);
    const meta = resolveMaybe<CommandMeta>(child.meta);
    for (const alias of toArray(meta.alias)) node.children.set(alias, childNode);
  }
  return node;
}

const ROOT = buildNode(main as AnyCmd, "akm");

// citty accepts these on every command regardless of declared args.
const ALWAYS_ALLOWED_FLAGS = new Set(["help", "h", "version", "v"]);
const WORD_SHAPED = /^[a-z][a-z0-9-]*$/i;

function collectArgMap(chain: CmdNode[]): Map<string, ArgDef> {
  const map = new Map<string, ArgDef>();
  for (const node of chain) {
    for (const [key, def] of Object.entries(node.args)) {
      if (def.type === "positional") continue;
      map.set(key, def);
      for (const alias of toArray((def as { alias?: string | string[] }).alias)) map.set(alias, def);
    }
  }
  return map;
}

function isAllowedFlag(name: string, allowed: Map<string, ArgDef>): boolean {
  if (ALWAYS_ALLOWED_FLAGS.has(name) || allowed.has(name)) return true;
  // citty's built-in `--no-<bool>` negation (strips `no-`, negates the rest).
  const base = name.startsWith("no-") ? name.slice(3) : undefined;
  return base !== undefined && allowed.get(base)?.type === "boolean";
}

/** Walk WORD-SHAPED tokens (in order) down the tree; report the first token that looks like a subcommand but isn't one, while a subcommand is still expected. */
function resolveChain(words: string[]): { chain: CmdNode[]; badToken?: string } {
  const chain: CmdNode[] = [ROOT];
  let node = ROOT;
  for (const w of words) {
    const child = node.children.get(w);
    if (child) {
      chain.push(child);
      node = child;
      continue;
    }
    if (node.children.size > 0 && WORD_SHAPED.test(w)) return { chain, badToken: w };
    break;
  }
  return { chain };
}

// ── 2. Extract fenced code blocks and `akm …` invocations from markdown. ────

interface Violation {
  file: string;
  line: number;
  token: string;
  message: string;
}

function extractFences(text: string): { startLine: number; lines: string[] }[] {
  const raw = text.split("\n");
  const blocks: { startLine: number; lines: string[] }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]!.match(/^\s*(`{3,}|~{3,})/);
    if (!m) continue;
    const fenceChar = m[1]![0]!;
    const fenceLen = m[1]!.length;
    const body: string[] = [];
    const startLine = i + 2;
    i++;
    while (i < raw.length && !new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`).test(raw[i]!)) {
      body.push(raw[i]!);
      i++;
    }
    blocks.push({ startLine, lines: body });
  }
  return blocks;
}

/** Truncate at the first unquoted `#` preceded by start-of-line or whitespace. */
function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i);
  }
  return text;
}

/**
 * Split a logical shell line into segments at command substitution
 * open/close, `&&`, `||`, `;`, and `|` — but ONLY outside quotes, so a
 * pipe/paren INSIDE a quoted `akm remember "... | bash"` string (a real
 * example in the docs) is not mistaken for a shell operator and torn apart.
 */
function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    if (!inSingle && !inDouble) {
      if (text.startsWith("$(", i) || text.startsWith("&&", i) || text.startsWith("||", i)) {
        segments.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (text[i] === ")" || text[i] === ";" || text[i] === "|") {
        segments.push(cur);
        cur = "";
        continue;
      }
    }
    const c = text[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    cur += c;
  }
  segments.push(cur);
  return segments;
}

const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g;
function cleanToken(t: string): string {
  return t.replace(/^[[({]+/, "").replace(/[\])},.]+$/, "");
}

function checkInvocation(file: string, line: number, tokens: string[], violations: Violation[]): void {
  const akmIdx = tokens.indexOf("akm");
  if (akmIdx === -1) return;
  let rest = tokens
    .slice(akmIdx + 1)
    .map(cleanToken)
    .filter((t) => t.length > 0);
  const passthrough = rest.indexOf("--"); // `env run <name> -- <wrapped cmd>`: stop before it
  if (passthrough !== -1) rest = rest.slice(0, passthrough);

  const isPlaceholder = (t: string) => /[<>$|]/.test(t);
  // Build the word list used for command/subcommand path resolution: skip
  // flag tokens AND, when a flag has no `=value` attached, the token right
  // after it too (its space-separated value) — otherwise `--format json`
  // leaves `json` looking exactly like an attempted (bogus) subcommand. This
  // over-skips for a bare boolean flag directly followed by a real
  // positional (`--fix search`), but that only loses a check, it never
  // invents a false "unknown subcommand" — same false-negatives-over-false-
  // positives bias as the rest of this resolver.
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith("-")) {
      if (!t.includes("=") && i + 1 < rest.length && !rest[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (!isPlaceholder(t)) words.push(t);
  }
  const { chain, badToken } = resolveChain(words);
  const record = (token: string, message: string) => {
    const key = `${file}:${line}:${token}`;
    if (!ALLOWED_VIOLATIONS.has(key)) violations.push({ file, line, token, message });
  };
  if (badToken !== undefined) {
    const parentPath = chain[chain.length - 1]!.path;
    record(badToken, `unknown subcommand \`${badToken}\` under \`${parentPath}\``);
  }

  const allowed = collectArgMap(chain);
  const dynamicWorkflowParams = chain[chain.length - 1]?.path === "akm workflow run";
  for (const t of rest) {
    if (!t.startsWith("-") || t === "-" || t === "--" || isPlaceholder(t)) continue;
    const bare = (t.startsWith("--") ? t.slice(2) : t.slice(1)).split("=")[0];
    if (!bare || isAllowedFlag(bare, allowed)) continue;
    // Match the runtime's deliberately dynamic namespace: unknown long flags
    // on `workflow run` are exact declared workflow parameters, validated
    // against the frozen plan before a run is created. Short flags stay strict.
    if (dynamicWorkflowParams && t.startsWith("--")) continue;
    record(t, `unknown flag \`${t}\` for \`${chain[chain.length - 1]!.path}\``);
  }
}

function processBlock(file: string, startLine: number, rawLines: string[], violations: Violation[]): void {
  const lines = rawLines.map(stripComment);
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    const lineNo = startLine + i;
    // Check the SKIP_MARKER against the RAW (pre-stripComment) line, not the
    // stripped one: the marker is documented to live in a trailing shell
    // comment (`akm wiki list  # doclint:ignore`), but stripComment() cuts
    // the line at the first unquoted `#` — checking the already-stripped
    // text would silently discard the marker along with the rest of the
    // comment and never match, breaking the documented escape hatch.
    let skip = rawLines[i]!.includes(SKIP_MARKER);
    while (text.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      i++;
      if (rawLines[i]!.includes(SKIP_MARKER)) skip = true;
      text = `${text.trimEnd().slice(0, -1)} ${lines[i]!.trim()}`;
    }
    if (skip) continue;
    for (const segment of splitSegments(text)) {
      const trimmed = segment.trim().replace(/^\$ /, ""); // shell-prompt prefix
      const tokens = trimmed.match(TOKEN_RE) ?? [];
      checkInvocation(file, lineNo, tokens, violations);
    }
  }
}

// ── 3. Walk the doc surfaces and run it. ─────────────────────────────────────

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

function main_(): void {
  const files: string[] = [];
  for (const root of DOC_ROOTS) walkMarkdown(path.join(REPO_ROOT, root), files);
  for (const f of DOC_FILES) {
    const abs = path.join(REPO_ROOT, f);
    if (fs.existsSync(abs)) files.push(abs);
  }

  const violations: Violation[] = [];
  for (const abs of files.sort()) {
    const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
    const text = fs.readFileSync(abs, "utf8");
    for (const block of extractFences(text)) processBlock(rel, block.startLine, block.lines, violations);
  }

  if (violations.length === 0) {
    process.stdout.write("lint-doc-examples: OK - 0 doc-example violations found.\n");
    return;
  }
  process.stderr.write(
    `lint-doc-examples: FAIL - ${violations.length} doc-example violation(s) against the real \`akm\` command tree.\n`,
  );
  let lastFile = "";
  for (const v of violations) {
    if (v.file !== lastFile) {
      process.stderr.write(`\n${v.file}\n`);
      lastFile = v.file;
    }
    process.stderr.write(`  line ${v.line}: ${v.message}\n`);
  }
  process.exitCode = 1;
}

main_();
