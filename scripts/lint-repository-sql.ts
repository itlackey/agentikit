// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-repository-sql.ts  (X4)
 *
 * Architectural fitness function for the "repository owns the SQL" boundary.
 *
 * The registry and workflow-runtime subsystems must reach persistent storage
 * ONLY through `src/storage/repositories/**` — never by importing a DB-owner
 * module (`indexer/db`, `core/state-db`, `core/state/*`) or opening a database
 * directly. Both subsystems previously bypassed repositories to hit index.db
 * directly (registry providers `static-index.ts`/`skills-sh.ts`, and
 * `workflows/runtime/runs.ts`), and the registry path has a documented
 * cache-correctness regression history. R3 (registry cache → repository) and
 * D5 (WorkflowDocuments reader) removed those inversions; this guard ratchets
 * them shut so they cannot regrow.
 *
 * Scope for `db-owner-import` / `db-open-call` is intentionally NARROW. Raw
 * SQL legitimately lives in many other modules (health, indexer,
 * usage-telemetry, the improve read-side, …) and the codebase does NOT funnel
 * all SQL through one repository directory — so a blanket "no SQL outside
 * repositories" rule would be a large status-quo allowlist, not a real
 * boundary. Those two rules enforce only the boundary that was actually
 * inverted and actually regressed.
 *
 * A third rule, `state-table-sql` (#672 part 2), is scoped differently and
 * much more broadly: raw SQL naming the `asset_salience` / `asset_outcome`
 * state.db tables is guarded EVERYWHERE under `src/` except
 * `src/storage/repositories/**` (their new home,
 * salience-repository.ts / outcome-repository.ts) and
 * `src/core/state/migrations.ts` (schema DDL, not application read/write
 * SQL — migrations are append-only history and are never refactored to use
 * a repository). Unlike the first two rules, a widened `GUARDED_PREFIXES`
 * would not express this: `salience.ts` and `outcome-loop.ts` take `db`
 * parameters and import no DB-owner module, so they pass the first two rules
 * today with their SQL fully intact — unlike `db-owner-import`/`db-open-call`,
 * this is a raw-SQL-content rule, not an import/open-call rule, so it needs
 * its own pattern and its own scope predicate (`isStateTableSqlScope` below),
 * not just a wider prefix list.
 *
 * Comments and string literals are stripped before matching (except for rules
 * that opt into `keepStrings`, which need to see string content — import
 * specifiers and SQL text both live inside string literals), so prose that
 * merely mentions these names does not trip any rule — only real code does.
 *
 * Exit codes: 0 — clean; 1 — violations (or internal error).
 * Usage: bun scripts/lint-repository-sql.ts
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");

/**
 * Subsystems that must use repositories rather than DB internals. POSIX-relative
 * directory prefixes. Add a new boundary here only when its inversions are
 * already cleared (the guard must stay at 0 violations).
 *
 * Scope for `db-owner-import` and `db-open-call` ONLY — the `state-table-sql`
 * rule (#672 part 2) has its own, much broader scope; see
 * `isStateTableSqlScope` below. Left unchanged by #672 part 2 on purpose.
 */
const GUARDED_PREFIXES: readonly string[] = ["src/registry/", "src/workflows/runtime/"];

/**
 * `state-table-sql` scope (#672 part 2): applies everywhere under `src/`
 * except these directory prefixes …
 */
const STATE_TABLE_SQL_EXCLUDED_PREFIXES: readonly string[] = ["src/storage/repositories/"];

/** … and except these exact files (POSIX-relative to repo root). */
const STATE_TABLE_SQL_EXCLUDED_FILES: readonly string[] = ["src/core/state/migrations.ts"];

/** Scope predicate for the original two rules: registry + workflow-runtime only. */
function isGuardedPrefix(rel: string): boolean {
  return GUARDED_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * Scope predicate for `state-table-sql`: everywhere under `src/` except the
 * repository directory (the new home for this SQL) and the migrations file
 * (schema DDL, append-only, never behind a repository).
 */
function isStateTableSqlScope(rel: string): boolean {
  if (!rel.startsWith("src/")) return false;
  if (STATE_TABLE_SQL_EXCLUDED_FILES.includes(rel)) return false;
  return !STATE_TABLE_SQL_EXCLUDED_PREFIXES.some((p) => rel.startsWith(p));
}

interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
  /** Match against string-preserving text (for import-specifier / SQL-text rules). */
  keepStrings?: boolean;
  /**
   * Which files this rule applies to, given a repo-relative POSIX path.
   * Defaults to `isGuardedPrefix` (the original two rules' scope) when absent.
   */
  appliesTo?: (rel: string) => boolean;
}

const RULES: readonly Rule[] = [
  {
    id: "db-owner-import",
    // import ... from "…/indexer/db…" | "…/core/state-db" | "…/core/state/…"
    pattern: /from\s*["'][^"']*(?:indexer\/db|core\/state-db|core\/state\/)[^"']*["']/,
    message:
      "imports a DB-owner module directly — go through src/storage/repositories/** instead (repository-owns-SQL boundary)",
    keepStrings: true,
  },
  {
    id: "db-open-call",
    pattern:
      /\b(?:openExistingDatabase|openIndexDatabase|openStateDatabase|openManagedDatabase)\s*\(|\bnew\s+Database\s*\(/,
    message:
      "opens a database directly — registry/workflow-runtime code must query through a repository in src/storage/repositories/**",
  },
  {
    id: "state-table-sql",
    // Raw SQL (or any code) naming the asset_salience / asset_outcome tables.
    pattern: /\basset_salience\b|\basset_outcome\b/,
    message:
      "raw SQL names a state-table (asset_salience/asset_outcome) outside src/storage/repositories/** — move the query behind salience-repository.ts / outcome-repository.ts (repository-owns-SQL boundary, #672)",
    keepStrings: true,
    appliesTo: isStateTableSqlScope,
  },
];

function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "schemas") continue;
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Strip comments + (optionally) string contents, preserving line numbers. */
function stripCommentsAndStrings(src: string, keepStrings = false): string {
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
        out += keepStrings ? c : " ";
        i += 1;
      } else if (c === '"') {
        state = "dq";
        out += keepStrings ? c : " ";
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        out += keepStrings ? c : " ";
        i += 1;
      } else {
        out += c;
        i += 1;
      }
    } else if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += "\n";
      } else out += " ";
      i += 1;
    } else if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    } else {
      const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
      if (c === "\\") {
        out += keepStrings ? src.slice(i, i + 2) : "  ";
        i += 2;
      } else if (c === quote) {
        state = "code";
        out += keepStrings ? c : " ";
        i += 1;
      } else {
        out += keepStrings || c === "\n" ? c : " ";
        i += 1;
      }
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  ruleId: string;
  message: string;
  snippet: string;
}

/** Pure matcher: lint one file's content given its repo-relative POSIX path. */
export function lintContent(rel: string, raw: string): Violation[] {
  // Each rule has its own scope (appliesTo, default isGuardedPrefix). Skip the
  // (relatively expensive) comment/string stripping entirely when NO rule
  // could possibly apply to this file.
  const applicableRules = RULES.filter((rule) => (rule.appliesTo ?? isGuardedPrefix)(rel));
  if (applicableRules.length === 0) return [];

  const noStrings = stripCommentsAndStrings(raw, false).split("\n");
  const withStrings = stripCommentsAndStrings(raw, true).split("\n");
  const rawLines = raw.split("\n");

  const violations: Violation[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    for (const rule of applicableRules) {
      const subject = rule.keepStrings ? withStrings[i] : noStrings[i];
      if (subject !== undefined && rule.pattern.test(subject)) {
        violations.push({
          file: rel,
          line: i + 1,
          ruleId: rule.id,
          message: rule.message,
          snippet: rawLines[i]!.trim(),
        });
      }
    }
  }
  return violations;
}

function lintFile(filePath: string): Violation[] {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  return lintContent(rel, fs.readFileSync(filePath, "utf-8"));
}

export function lintRepositorySql(): Violation[] {
  const out: Violation[] = [];
  for (const f of collectTs(srcDir)) out.push(...lintFile(f));
  return out;
}

export { GUARDED_PREFIXES, lintFile };

if (import.meta.main) {
  const violations = lintRepositorySql();
  if (violations.length === 0) {
    console.log(
      "lint-repository-sql: OK — registry + workflow-runtime reach storage only through src/storage/repositories, " +
        "and no raw asset_salience/asset_outcome SQL lives outside it",
    );
    process.exit(0);
  }
  console.error(
    `lint-repository-sql: ${violations.length} violation(s) — DB internals reached outside the repository boundary\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.ruleId}]`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.snippet}`);
    console.error("");
  }
  process.exit(1);
}
