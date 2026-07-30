// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-test for the X4 repository-owns-SQL boundary guard
 * (`scripts/lint-repository-sql.ts`).
 *
 * Pins three things together: (1) the live `src/` tree is clean — registry and
 * workflow-runtime never reach into DB internals, and no raw state-table SQL
 * survives outside the repository boundary — so the ratchet baseline is 0;
 * (2) the `db-owner-import` / `db-open-call` rules actually fire on the
 * inversions they are meant to prevent (direct DB-owner import + direct
 * database open), so they can never silently degrade into a no-op; and (3) the
 * `state-table-sql` rule (#672 part 2) fires on raw `asset_salience` /
 * `asset_outcome` SQL anywhere under `src/` except the repository directory
 * and the migrations file, while leaving prose/comments alone.
 */

import { describe, expect, test } from "bun:test";
import { lintContent, lintRepositorySql } from "../../scripts/lint-repository-sql";

describe("lint-repository-sql (X4 boundary ratchet)", () => {
  test("the live src tree has zero repository-boundary violations", () => {
    const violations = lintRepositorySql();
    if (violations.length > 0) {
      throw new Error(
        `repository-boundary violations:\n${violations.map((v) => `${v.file}:${v.line} [${v.ruleId}]`).join("\n")}`,
      );
    }
    expect(violations.length).toBe(0);
  });

  test("flags a direct DB-owner import in a guarded subsystem", () => {
    const v = lintContent(
      "src/registry/providers/example.ts",
      'import { openExistingDatabase } from "../../../indexer/db/db";',
    );
    expect(v.map((x) => x.ruleId)).toContain("db-owner-import");
  });

  test("flags a direct state-db import in workflow runtime", () => {
    const v = lintContent("src/workflows/runtime/example.ts", 'import { withStateDb } from "../../../core/state-db";');
    expect(v.map((x) => x.ruleId)).toContain("db-owner-import");
  });

  test("flags a direct database open in a guarded subsystem", () => {
    const v = lintContent("src/registry/providers/example.ts", "const db = openIndexDatabase();");
    expect(v.map((x) => x.ruleId)).toContain("db-open-call");
  });

  test("does NOT flag db-owner-import/db-open-call outside guarded subsystems, but DOES flag state-table SQL there", () => {
    // Command/indexer modules legitimately open index.db and import DB owners —
    // only registry + workflow-runtime are guarded for those two rules.
    const cmd = lintContent("src/commands/improve/preparation.ts", "const db = openExistingDatabase();");
    expect(cmd.length).toBe(0);

    // The state-table-sql rule (#672 part 2) covers this file, though: raw
    // asset_salience/asset_outcome SQL is guarded everywhere under src/ except
    // src/storage/repositories/** and the migrations file — "unguarded" for
    // the first two rules no longer means "immune from every rule".
    const stateTableSql = lintContent(
      "src/commands/improve/preparation.ts",
      'db.prepare("SELECT * FROM asset_salience WHERE asset_ref = ?").get(ref);',
    );
    expect(stateTableSql.map((x) => x.ruleId)).toContain("state-table-sql");
  });

  test("does NOT flag prose mentioning the names in comments/strings", () => {
    const v = lintContent(
      "src/registry/providers/example.ts",
      "// registry must not call openExistingDatabase or import indexer/db directly\nconst note = 'openIndexDatabase';",
    );
    expect(v.length).toBe(0);
  });

  test("flags raw asset_salience SQL under src/commands/improve/", () => {
    const v = lintContent(
      "src/commands/improve/example.ts",
      'db.prepare("SELECT * FROM asset_salience WHERE asset_ref = ?").get(ref);',
    );
    expect(v.map((x) => x.ruleId)).toContain("state-table-sql");
  });

  test("flags raw asset_outcome SQL under src/commands/health/", () => {
    const v = lintContent(
      "src/commands/health/example.ts",
      "db.prepare(`SELECT outcome_score FROM asset_outcome WHERE asset_ref = ?`).get(ref);",
    );
    expect(v.map((x) => x.ruleId)).toContain("state-table-sql");
  });

  test("does NOT flag the identical asset_salience SQL inside src/storage/repositories/", () => {
    const v = lintContent(
      "src/storage/repositories/salience-repository.ts",
      'db.prepare("SELECT * FROM asset_salience WHERE asset_ref = ?").get(ref);',
    );
    expect(v.length).toBe(0);
  });

  test("does NOT flag state-table DDL in src/core/state/migrations.ts", () => {
    const v = lintContent(
      "src/core/state/migrations.ts",
      "CREATE TABLE IF NOT EXISTS asset_outcome (asset_ref TEXT PRIMARY KEY);",
    );
    expect(v.length).toBe(0);
  });

  test("does NOT flag asset_salience/asset_outcome mentioned only in prose/comments", () => {
    const v = lintContent(
      "src/commands/improve/example.ts",
      [
        "// asset_outcome is updated by the WS-2 outcome loop.",
        "/** state.db :: asset_salience is the canonical store. */",
        "const x = 1;",
      ].join("\n"),
    );
    expect(v.length).toBe(0);
  });
});
