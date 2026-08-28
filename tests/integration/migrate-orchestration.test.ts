// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `src/commands/migrate-cli.ts`'s two-generation orchestration
 * (`runMigrateSubcommand`), driven through the real wrapped
 * `akm migrate status`/`apply` CLI (`tests/_helpers/cli.ts`'s `runCliCapture`,
 * the same harness `tests/integration/migrate-format.test.ts` uses).
 *
 * `tests/integration/migrate-format.test.ts` already covers the ALL-SUCCESS
 * combined-plan shape (a "ready" generation-1-only scenario). This file
 * covers the branches that need a genuinely BLOCKED generation, which the
 * real standalone migrator only produces from specifically-shaped invalid
 * task files — a real subprocess crash (the "hard failure" branch) is not
 * reliably producible black-box through file content alone. `runMigrationTool`
 * (`src/commands/migration-tool.ts`) is the ONE seam between `migrate-cli.ts`
 * and the real `spawnSync` subprocess call; overriding it through
 * `migrate-cli.ts`'s `_setRunMigrationToolForTests` seam (via
 * `tests/_helpers/seams.ts`, so restoration is automatic) gives deterministic
 * control over each generation's exit status/plan while still driving
 * `runMigrateSubcommand` through the real citty-dispatched `migrate status`/
 * `migrate apply` commands — i.e. this proves the ORCHESTRATION logic
 * (`worstStatus`, the blockers-array merge, the combined exit code, and the
 * hard-failure-abort guard), not the standalone migrator's own per-file
 * classification (already covered by `tests/migrate/task-v3-to-v4.test.ts`
 * and the real subprocess path in `migrate-format.test.ts`).
 */

import { expect, test } from "bun:test";
import { EXIT_CODES } from "../../src/cli/shared";
import { _setRunMigrationToolForTests } from "../../src/commands/migrate-cli";
import { overrideSeam } from "../_helpers/seams";

type FakeCall = { readonly status: number; readonly plan?: Record<string, unknown> };
type FakeRouter = (args: readonly string[]) => FakeCall;

let router: FakeRouter = () => ({ status: EXIT_CODES.SUCCESS });
const calls: string[][] = [];

function installMigrationToolSeam(): void {
  overrideSeam(_setRunMigrationToolForTests, async (args: readonly string[]) => {
    calls.push([...args]);
    const call = router(args);
    return { status: call.status, stdout: call.plan ? JSON.stringify(call.plan) : "", stderr: "" };
  });
}

/** Gen 1 is invoked with `["status"]`/`["apply", ...]`; gen 2 with `["task-v4-status"]`/`["task-v4-apply", ...]`. */
function isGenTwo(args: readonly string[]): boolean {
  return args[0] === "task-v4-status" || args[0] === "task-v4-apply";
}

test("a blocked generation 1 alone still runs generation 2, and the combined plan reports blocked with the general exit code", async () => {
  installMigrationToolSeam();
  calls.length = 0;
  router = (args) =>
    isGenTwo(args)
      ? { status: EXIT_CODES.SUCCESS, plan: { status: "current", taskV4Migration: { changed: 0 } } }
      : {
          status: EXIT_CODES.GENERAL,
          plan: { status: "blocked", blockers: ["nightly.yml: invalid-v2-task"], taskV3Migration: { blocked: 1 } },
        };

  const { runCliCapture } = await import("../_helpers/cli");
  const result = await runCliCapture(["migrate", "status"]);

  // Both generations ran — a blocked generation 1 does not stop generation 2.
  expect(calls).toEqual([["status"], ["task-v4-status"]]);
  expect(result.code, result.stderr).toBe(EXIT_CODES.GENERAL);
  const combined = JSON.parse(result.stdout);
  expect(combined.status).toBe("blocked");
  expect(combined.blockers).toEqual(["nightly.yml: invalid-v2-task"]);
});

test("a blocked generation 2 alone (generation 1 current) still reports the combined plan as blocked with the general exit code", async () => {
  installMigrationToolSeam();
  calls.length = 0;
  router = (args) =>
    isGenTwo(args)
      ? {
          status: EXIT_CODES.GENERAL,
          plan: { status: "blocked", blockers: ["legacy.yml: invalid-v3-task"], taskV4Migration: { blocked: 1 } },
        }
      : { status: EXIT_CODES.SUCCESS, plan: { status: "current", taskV3Migration: { changed: 0 } } };

  const { runCliCapture } = await import("../_helpers/cli");
  const result = await runCliCapture(["migrate", "status"]);

  expect(calls).toEqual([["status"], ["task-v4-status"]]);
  expect(result.code, result.stderr).toBe(EXIT_CODES.GENERAL);
  const combined = JSON.parse(result.stdout);
  expect(combined.status).toBe("blocked");
  expect(combined.blockers).toEqual(["legacy.yml: invalid-v3-task"]);
});

test("both generations blocked: worstStatus stays blocked (not overwritten) and BOTH generations' blockers merge into one array", async () => {
  installMigrationToolSeam();
  calls.length = 0;
  router = (args) =>
    isGenTwo(args)
      ? {
          status: EXIT_CODES.GENERAL,
          plan: { status: "blocked", blockers: ["gen2-file.yml: invalid-v3-task"], taskV4Migration: { blocked: 1 } },
        }
      : {
          status: EXIT_CODES.GENERAL,
          plan: { status: "blocked", blockers: ["gen1-file.yml: invalid-v2-task"], taskV3Migration: { blocked: 1 } },
        };

  const { runCliCapture } = await import("../_helpers/cli");
  const result = await runCliCapture(["migrate", "apply", "--dry-run"]);

  expect(result.code, result.stderr).toBe(EXIT_CODES.GENERAL);
  const combined = JSON.parse(result.stdout);
  expect(combined.status).toBe("blocked");
  // Both generations' blockers survive the merge — neither is dropped or
  // overwritten by the other (row B-32's "blockers-array merge").
  expect(combined.blockers).toEqual(["gen1-file.yml: invalid-v2-task", "gen2-file.yml: invalid-v3-task"]);
});

test("a HARD failure in generation 1 (neither SUCCESS nor the blocked/GENERAL code) aborts before generation 2 ever runs", async () => {
  installMigrationToolSeam();
  calls.length = 0;
  router = (args) =>
    isGenTwo(args)
      ? // If the guard were broken and generation 2 ran anyway, it would
        // report a normal SUCCESS/current result here — a passing test would
        // then hide the regression. Asserting `calls` below is what actually
        // proves generation 2 was never invoked, not just that its result
        // was ignored.
        { status: EXIT_CODES.SUCCESS, plan: { status: "current" } }
      : { status: EXIT_CODES.CONFIG };

  const { runCliCapture } = await import("../_helpers/cli");
  const result = await runCliCapture(["migrate", "status"]);

  expect(calls).toEqual([["status"]]);
  expect(result.code, result.stderr).toBe(EXIT_CODES.CONFIG);
  // The orchestrator aborted before ever printing a combined plan.
  expect(result.stdout.trim()).toBe("");
});

test("a HARD failure in generation 2 (generation 1 succeeded) surfaces generation 2's own exit code, not a combined plan", async () => {
  installMigrationToolSeam();
  calls.length = 0;
  router = (args) =>
    isGenTwo(args)
      ? { status: EXIT_CODES.CONFIG }
      : { status: EXIT_CODES.SUCCESS, plan: { status: "current", taskV3Migration: { changed: 0 } } };

  const { runCliCapture } = await import("../_helpers/cli");
  const result = await runCliCapture(["migrate", "status"]);

  // Generation 2 DOES run — only a generation-1 hard failure skips it.
  expect(calls).toEqual([["status"], ["task-v4-status"]]);
  expect(result.code, result.stderr).toBe(EXIT_CODES.CONFIG);
  expect(result.stdout.trim()).toBe("");
});
