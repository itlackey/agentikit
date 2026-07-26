// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-write-source-chokepoint.ts
 *
 * Enforces the write-policy choke point documented in
 * `docs/architecture/architecture.md`: "Writes go through one helper:
 * `src/core/write-source.ts`. This is the only place in the codebase that
 * branches on `source.kind`."
 *
 * Until now that invariant was PROSE ONLY, and it drifted: consolidation and
 * proposal publication grew `if (target.source.kind === "git")` branches that
 * put Git-specific write behavior in command modules. The fix was to expose
 * kind-neutral wrappers (`captureWriteTargetPathSnapshot`,
 * `publishWriteTargetTransaction`) that absorb the guard the way
 * `commitWriteTargetBoundary` and `captureGitPublication` already did. This
 * guard stops the branching from regrowing.
 *
 * What is flagged: comparing a write target's `source.kind` against a string
 * literal — `target.source.kind === "git"`, `prepared.source.kind !==
 * 'filesystem'`. That is *behavior selection* on a provider kind. The pattern
 * is anchored on `source.` so the many unrelated discriminated-union tags
 * spelled `.kind` in this codebase (cron fields, workflow IR nodes, engine
 * `llm`/`agent`, `journal.kind`, runner kinds) are not swept in.
 *
 * What is NOT flagged: recording or comparing a kind for identity, e.g.
 * `targetKind: target.source.kind` or `payload.targetKind !== target.source.kind`.
 * Those persist and validate transaction identity rather than choosing a code
 * path, and removing them would weaken the transaction-rebinding guard.
 * Comments and string literals are stripped before matching, so prose that
 * merely mentions the pattern does not trip the guard.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found (or internal error)
 *
 * Usage:
 *   bun scripts/lint-write-source-chokepoint.ts
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");

/**
 * The ONLY file permitted to branch on a provider `kind`. Relative to the repo
 * root, POSIX separators. This allowlist must NOT grow — if a command needs
 * kind-specific behavior, add a kind-neutral wrapper to write-source.ts
 * instead, following `commitWriteTargetBoundary` / `captureGitPublication` /
 * `publishWriteTargetTransaction`.
 */
const BOUNDARY_FILES: ReadonlySet<string> = new Set(["src/core/write-source.ts"]);

/**
 * `source.kind` compared against a string literal — i.e. branching on a WRITE
 * TARGET's provider kind. Anchored on `source.` so the many unrelated
 * discriminated-union tags spelled `.kind` in this codebase (cron field kinds,
 * workflow IR node kinds, engine `llm`/`agent` kinds, fs-txn `journal.kind`,
 * runner kinds) are not swept in. Write targets always reach the provider kind
 * as `source.kind`, via `target.source.kind` / `prepared.source.kind` /
 * `writeTarget.source.kind` / a destructured `source`.
 */
const KIND_BRANCH = /\bsource\.kind\s*(?:===|!==|==|!=)\s*["'`]/;

/** Strip comments and string literals so only real code is matched. */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out += "  ";
        i += 2;
      } else if (c === "/" && c2 === "*") {
        state = "block";
        out += "  ";
        i += 2;
      } else if (c === "'") {
        state = "sq";
        out += c;
        i += 1;
      } else if (c === '"') {
        state = "dq";
        out += c;
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        out += c;
        i += 1;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    // Inside a string literal: keep the delimiters (so `=== "` still matches
    // the opening quote) but blank the body, and honour escapes.
    const closing = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (c === "\\") {
      out += "  ";
      i += 2;
      continue;
    }
    if (c === closing) {
      state = "code";
      out += c;
      i += 1;
      continue;
    }
    out += c === "\n" ? "\n" : " ";
    i += 1;
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

const violations: Violation[] = [];
for (const file of walk(srcDir)) {
  const rel = path.relative(repoRoot, file).replaceAll(path.sep, "/");
  if (BOUNDARY_FILES.has(rel)) continue;
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.includes("source.kind")) continue;
  const stripped = stripCommentsAndStrings(raw).split("\n");
  const rawLines = raw.split("\n");
  for (let i = 0; i < stripped.length; i++) {
    const subject = stripped[i];
    if (subject !== undefined && KIND_BRANCH.test(subject)) {
      violations.push({ file: rel, line: i + 1, text: (rawLines[i] ?? "").trim() });
    }
  }
}

if (violations.length > 0) {
  console.error("lint-write-source-chokepoint: provider-kind branching outside src/core/write-source.ts\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}`);
  }
  console.error(
    "\nWrites branch on `source.kind` in exactly one place: src/core/write-source.ts.\n" +
      "Add a kind-neutral wrapper there instead (see commitWriteTargetBoundary,\n" +
      "captureGitPublication, captureWriteTargetPathSnapshot, publishWriteTargetTransaction)\n" +
      "and call it from the command layer.",
  );
  process.exit(1);
}

console.log("lint-write-source-chokepoint: OK — provider-kind branching is confined to src/core/write-source.ts");
