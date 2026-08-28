// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Code-review finding C: `akm migrate status`/`apply` orchestrates two
 * subprocess generations (`src/commands/migrate-cli.ts`) and used to default
 * a generation's status to `"current"` whenever it had no parseable plan —
 * including when the child was killed by a signal (`runMigrationTool`
 * coerces `spawnSync`'s `status: null` to `1`, the same numeric value as
 * `EXIT_CODES.GENERAL`, the tool's own legitimate "blocked" exit code) or
 * printed truncated/malformed JSON. That silently reported a crashed
 * generation as "nothing to migrate" at exit 0 — fail OPEN on a tool the PR
 * explicitly advertises as fail-closed ("blocked-not-guessed").
 *
 * `resolveGenerationStatus` is the unit under test: it must fail CLOSED
 * (`"blocked"`, with an explanatory blocker) for a non-SUCCESS call with no
 * parseable plan, while leaving every previously-correct case (a parsed
 * plan's own status; a legitimate SUCCESS-with-no-plan default of
 * `"current"`) unchanged.
 */

import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "../../src/cli/shared";
import { type MigrateToolCall, resolveGenerationStatus } from "../../src/commands/migrate-cli";

describe("resolveGenerationStatus", () => {
  test("a parsed plan's own status passes through verbatim, whatever the exit status", () => {
    const call: MigrateToolCall = { status: EXIT_CODES.GENERAL, plan: { status: "ready" } };
    expect(resolveGenerationStatus(call, "gen")).toEqual({ status: "ready" });
  });

  test("SUCCESS with no plan on stdout is a legitimate 'nothing to report' -> current", () => {
    const call: MigrateToolCall = { status: EXIT_CODES.SUCCESS };
    expect(resolveGenerationStatus(call, "gen")).toEqual({ status: "current" });
  });

  // The regression: a killed/crashed child (or truncated/malformed stdout)
  // exits non-SUCCESS with NO parseable plan. Previously this silently
  // resolved to "current" (nothing to migrate); it must now fail closed.
  test("non-SUCCESS with no plan (a crashed or signal-killed child) fails CLOSED to blocked, not current", () => {
    const call: MigrateToolCall = { status: EXIT_CODES.GENERAL };
    const resolved = resolveGenerationStatus(call, "task-v2-to-v3");
    expect(resolved.status).toBe("blocked");
    expect(resolved.error).toBeDefined();
    expect(resolved.error).toContain("task-v2-to-v3");
    expect(resolved.error).toContain(String(EXIT_CODES.GENERAL));
  });

  test("the null->1 coercion `runMigrationTool` applies to a signal-killed child's spawnSync status is exactly this non-SUCCESS-no-plan case", () => {
    // `runMigrationTool`: `status: result.status ?? 1` — a `spawnSync` call
    // killed by a signal reports `status: null`, coerced to 1, which is
    // `EXIT_CODES.GENERAL` — indistinguishable, by number alone, from the
    // migrator's own legitimate "blocked" exit code.
    expect(1).toBe(EXIT_CODES.GENERAL);
    const killedChildCall: MigrateToolCall = { status: 1 };
    expect(resolveGenerationStatus(killedChildCall, "gen").status).toBe("blocked");
  });
});
