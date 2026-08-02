// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk-8 WI-8.3 — the frozen `{ id, up }` migration bodies
 * (`scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts`, plan §3.3 / §8.2).
 *
 * The bodies module imports nothing from `src/workflows/` so it survives that
 * directory's deletion. Its ordered IDs are the workflow ledger contract.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  FROZEN_WORKFLOW_BASE_SCHEMA_DDL,
  FROZEN_WORKFLOW_MIGRATIONS,
} from "../../../scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies";

const BODIES_PATH = path.resolve(
  __dirname,
  "../../../scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts",
);

describe("workflow-migrations-bodies — self-containment", () => {
  test("imports nothing from src/workflows/ and only the shared engine from src/", () => {
    const source = fs.readFileSync(BODIES_PATH, "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*src\/workflows\//);
    expect(source.match(/from\s+["'][^"']*src\//g)).toEqual(['from "../../../../src/']);
  });
});

describe("workflow-migrations-bodies — frozen ledger", () => {
  test("exactly the 10 pre-cutover ids, 001 through 010, unique and ordered", () => {
    const ids = FROZEN_WORKFLOW_MIGRATIONS.map((m) => m.id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids[0]).toBe("001-add-scope-key");
    expect(ids[9]).toBe("010-ir-v3-engine");
    for (const [index, id] of ids.entries()) {
      expect(id.startsWith(String(index + 1).padStart(3, "0"))).toBe(true);
    }
  });

  test("the base schema DDL creates the two baseline tables idempotently", () => {
    expect(FROZEN_WORKFLOW_BASE_SCHEMA_DDL).toContain("CREATE TABLE IF NOT EXISTS workflow_runs");
    expect(FROZEN_WORKFLOW_BASE_SCHEMA_DDL).toContain("CREATE TABLE IF NOT EXISTS workflow_run_steps");
  });
});
