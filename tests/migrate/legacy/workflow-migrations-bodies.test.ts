// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk-8 WI-8.3 — the frozen `{ id, checksum, up }` migration BODIES copy
 * (`scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts`, plan §3.3 / §8.2).
 *
 * Two groups, mirroring `workflow-migrations-frozen.test.ts`:
 *
 *   1. **Self-containment** — the bodies module imports NOTHING from
 *      `src/workflows/` (it must survive that directory's WI-8.3 deletion);
 *      its only `src/` import is the shared migration engine.
 *   2. **Checksum pin** — each frozen body's computed `migrationChecksum`
 *      EQUALS the corresponding `WORKFLOW_MIGRATIONS_CHECKSUMS` entry, id for
 *      id, in order. Because the checksum snapshot was itself pinned to the
 *      (now-deleted) live `WORKFLOW_MIGRATIONS` array in WI-8.1, this
 *      transitively proves the frozen bodies are byte-faithful to that array.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  FROZEN_WORKFLOW_BASE_SCHEMA_DDL,
  FROZEN_WORKFLOW_MIGRATIONS,
} from "../../../scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies";
import { WORKFLOW_MIGRATIONS_CHECKSUMS } from "../../../scripts/akm-migrate/migrate/legacy/workflow-migrations-frozen";
import { migrationChecksum } from "../../../src/storage/engines/sqlite-migrations";

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

describe("workflow-migrations-bodies — checksum pin to the frozen ledger", () => {
  test("each frozen body's checksum equals its WORKFLOW_MIGRATIONS_CHECKSUMS entry, in order", () => {
    const computed = FROZEN_WORKFLOW_MIGRATIONS.map((m) => ({ id: m.id, checksum: migrationChecksum(m) }));
    expect(FROZEN_WORKFLOW_MIGRATIONS.map(({ id, checksum }) => ({ id, checksum }))).toEqual(computed);
    expect(computed).toEqual(WORKFLOW_MIGRATIONS_CHECKSUMS.map((e) => ({ id: e.id, checksum: e.checksum })));
  });

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
