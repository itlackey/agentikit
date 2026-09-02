// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `src/commands/migrate-cli.ts`'s two-generation orchestration — the branches
 * that need a genuinely BLOCKED or hard-failed generation, which the real
 * standalone migrator only reaches from specifically-shaped invalid task files
 * or an actual subprocess crash, neither reliably producible black-box through
 * file content alone. `tests/integration/migrate-format.test.ts` already covers
 * the ALL-SUCCESS combined-plan shape through the real subprocess, and
 * `tests/commands/migrate-cli-status-resolution.test.ts` covers
 * `resolveGenerationStatus`'s own fail-closed rule.
 *
 * The orchestration is split so neither half needs a module-level test seam:
 *
 * - `combineMigrationPlans` is PURE, so the combined-plan rules (the
 *   `worstStatus` rollup, the blockers merge and its ORDER, and each
 *   generation's fail-closed contribution) are proved from plain values.
 * - `runMigrateSubcommand` takes its subprocess runner as a PARAMETER, so the
 *   two genuinely effectful decisions — whether generation 2 runs at all, and
 *   the process exit code — are proved by handing it a stand-in directly.
 *   Nothing process-wide is mutated, so there is nothing to restore and no
 *   ordering coupling with any other test.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODES } from "../src/cli/shared";
import {
  combineMigrationPlans,
  type MigrateToolCall,
  type RunMigrationTool,
  runMigrateSubcommand,
} from "../src/commands/migrate-cli";
import { resetConfigCache } from "../src/core/config/config";
import { initOutputMode, resetOutputMode } from "../src/output/context";
import { sandboxXdgConfigHome } from "./_helpers/sandbox";

type FakeCall = { readonly status: number; readonly plan?: Record<string, unknown> };

/** Gen 1 is invoked with `["status"]`/`["apply", ...]`; gen 2 with `["task-v4-status"]`/`["task-v4-apply", ...]`. */
function isGenTwo(args: readonly string[]): boolean {
  return args[0] === "task-v4-status" || args[0] === "task-v4-apply";
}

/**
 * A stand-in for `runMigrationTool`, recording every generation's argv so a
 * test can assert which generations actually ran.
 */
function fakeRunner(router: (args: readonly string[]) => FakeCall): {
  runTool: RunMigrationTool;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runTool: async (args: readonly string[]) => {
      calls.push([...args]);
      const call = router(args);
      return { status: call.status, stdout: call.plan ? JSON.stringify(call.plan) : "", stderr: "" };
    },
  };
}

const priorExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = priorExitCode;
  resetOutputMode();
});

/**
 * `output()` reads the process-level output mode, which the real entry point
 * initializes at startup. Initialize it the same way and capture what the
 * command prints, so these tests still assert the ACTUAL printed envelope
 * rather than only the orchestrator's return path.
 */
function capturePrintedPlan(): { read: () => Record<string, unknown>; restore: () => void } {
  initOutputMode(["--format", "json"]);
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(" "));
  });
  return {
    read: () => JSON.parse(lines.join("\n")) as Record<string, unknown>,
    restore: () => spy.mockRestore(),
  };
}

// ── The pure combined-plan rules ─────────────────────────────────────────────

test("a blocked generation contributes its blockers and drives the combined status to blocked", () => {
  const combined = combineMigrationPlans(
    {
      status: EXIT_CODES.GENERAL,
      plan: { status: "blocked", blockers: ["nightly.yml: invalid-v2-task"], taskV3Migration: { blocked: 1 } },
    },
    { status: EXIT_CODES.SUCCESS, plan: { status: "current", taskV4Migration: { changed: 0 } } },
  );

  expect(combined.status).toBe("blocked");
  expect(combined.blockers).toEqual(["nightly.yml: invalid-v2-task"]);
  expect(combined.taskV3Migration).toEqual({ blocked: 1 });
  expect(combined.taskV4Migration).toEqual({ changed: 0 });
});

test("both generations blocked merge their blockers in generation order", () => {
  const combined = combineMigrationPlans(
    { status: EXIT_CODES.GENERAL, plan: { status: "blocked", blockers: ["gen1-file.yml: invalid-v2-task"] } },
    { status: EXIT_CODES.GENERAL, plan: { status: "blocked", blockers: ["gen2-file.yml: invalid-v3-task"] } },
  );

  expect(combined.status).toBe("blocked");
  expect(combined.blockers).toEqual(["gen1-file.yml: invalid-v2-task", "gen2-file.yml: invalid-v3-task"]);
});

test("a ready generation beside a current one rolls up to ready, not current", () => {
  const combined = combineMigrationPlans(
    { status: EXIT_CODES.SUCCESS, plan: { status: "current" } },
    { status: EXIT_CODES.SUCCESS, plan: { status: "ready" } },
  );

  expect(combined.status).toBe("ready");
  expect(combined.blockers).toEqual([]);
});

test("a non-SUCCESS generation that printed no plan is reported blocked, never current — fail closed", () => {
  const crashed: MigrateToolCall = { status: EXIT_CODES.GENERAL };
  const combined = combineMigrationPlans(crashed, {
    status: EXIT_CODES.SUCCESS,
    plan: { status: "current" },
  });

  expect(combined.status).toBe("blocked");
  expect(combined.blockers).toHaveLength(1);
  expect(combined.blockers[0]).toContain("task-v2-to-v3");
  expect(combined.blockers[0]).toContain("without printing a plan");
});

test("a generation's own resolution error precedes its reported blockers in the merge", () => {
  const combined = combineMigrationPlans(
    { status: EXIT_CODES.GENERAL },
    { status: EXIT_CODES.GENERAL, plan: { status: "blocked", blockers: ["gen2-file.yml: invalid-v3-task"] } },
  );

  expect(combined.blockers).toHaveLength(2);
  expect(combined.blockers[0]).toContain("task-v2-to-v3");
  expect(combined.blockers[1]).toBe("gen2-file.yml: invalid-v3-task");
});

// ── The two effectful decisions ──────────────────────────────────────────────

test("a blocked generation 1 alone still runs generation 2, and exits with the general code", async () => {
  const { runTool, calls } = fakeRunner((args) =>
    isGenTwo(args)
      ? { status: EXIT_CODES.SUCCESS, plan: { status: "current", taskV4Migration: { changed: 0 } } }
      : { status: EXIT_CODES.GENERAL, plan: { status: "blocked", blockers: ["nightly.yml: invalid-v2-task"] } },
  );

  const printed = capturePrintedPlan();
  try {
    await runMigrateSubcommand("migrate-status", ["status"], ["task-v4-status"], runTool);
  } finally {
    printed.restore();
  }

  expect(calls).toEqual([["status"], ["task-v4-status"]]);
  expect(process.exitCode).toBe(EXIT_CODES.GENERAL);
  const combined = printed.read();
  expect(combined.status).toBe("blocked");
  expect(combined.blockers).toEqual(["nightly.yml: invalid-v2-task"]);
});

test("a hard failure in generation 1 aborts generation 2 and surfaces that generation's exit code", async () => {
  const { runTool, calls } = fakeRunner(() => ({ status: EXIT_CODES.CONFIG }));

  await runMigrateSubcommand("migrate-status", ["status"], ["task-v4-status"], runTool);

  // Generation 1 never got to look at a stable tree, so generation 2 must not run.
  expect(calls).toEqual([["status"]]);
  expect(process.exitCode).toBe(EXIT_CODES.CONFIG);
});

test("a hard failure in generation 2 surfaces its exit code after generation 1 ran", async () => {
  const { runTool, calls } = fakeRunner((args) =>
    isGenTwo(args) ? { status: EXIT_CODES.CONFIG } : { status: EXIT_CODES.SUCCESS, plan: { status: "current" } },
  );

  await runMigrateSubcommand("migrate-status", ["status"], ["task-v4-status"], runTool);

  expect(calls).toEqual([["status"], ["task-v4-status"]]);
  expect(process.exitCode).toBe(EXIT_CODES.CONFIG);
});

test("apply threads --dry-run into both generations", async () => {
  const { runTool, calls } = fakeRunner(() => ({ status: EXIT_CODES.SUCCESS, plan: { status: "current" } }));

  const printed = capturePrintedPlan();
  try {
    await runMigrateSubcommand("migrate-apply", ["apply", "--dry-run"], ["task-v4-apply", "--dry-run"], runTool);
  } finally {
    printed.restore();
  }

  expect(calls).toEqual([
    ["apply", "--dry-run"],
    ["task-v4-apply", "--dry-run"],
  ]);
  expect(printed.read().status).toBe("current");
});

// ── The lift must run before anything that loads config ──────────────────────
//
// A config still carrying legacy `extraParams` keys fails `loadConfig` closed,
// and that error names `akm migrate apply` as the remedy. But the orchestrator
// resolves the stash dir (a config load) and the task migrator loads config
// too, so the remedy used to die on the very error it exists to clear --
// leaving an operator with no reachable way forward.

/** Write a config whose only fault is a liftable legacy extraParams key. */
function writeLegacyExtraParamsConfig(configHome: string): string {
  const configPath = path.join(configHome, "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      engines: {
        "my-llm": {
          kind: "llm",
          endpoint: "https://example.com/v1/chat/completions",
          model: "test-model",
          extraParams: { temperature: 0.7 },
        },
      },
    }),
  );
  return configPath;
}

test("migrate apply lifts a legacy extraParams config even though loading that config fails closed", async () => {
  const sandbox = sandboxXdgConfigHome();
  const configPath = writeLegacyExtraParamsConfig(sandbox.dir);
  resetConfigCache();
  // The task migrator loads config itself, so it must not run until the lift
  // has already cleared the key. Record what was on disk at call time.
  const extraParamsAtToolCall: unknown[] = [];
  const { runTool } = fakeRunner(() => {
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      engines: { "my-llm": { extraParams?: unknown } };
    };
    extraParamsAtToolCall.push(onDisk.engines["my-llm"].extraParams);
    return { status: EXIT_CODES.SUCCESS, plan: { status: "current" } };
  });

  const printed = capturePrintedPlan();
  let written: { engines: { "my-llm": { temperature?: number; extraParams?: unknown } } };
  try {
    await runMigrateSubcommand("migrate-apply", ["apply"], ["task-v4-apply"], runTool);
    written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } finally {
    printed.restore();
    resetConfigCache();
    sandbox.cleanup();
  }
  expect(written.engines["my-llm"].temperature).toBe(0.7);
  expect(written.engines["my-llm"].extraParams).toBeUndefined();
  // Both generations must have seen an already-lifted config on disk.
  expect(extraParamsAtToolCall).toEqual([undefined, undefined]);
});

test("migrate status names the pending lift as the blocker instead of dying on the config it describes", async () => {
  const sandbox = sandboxXdgConfigHome();
  writeLegacyExtraParamsConfig(sandbox.dir);
  resetConfigCache();
  const { runTool, calls } = fakeRunner(() => ({ status: EXIT_CODES.SUCCESS, plan: { status: "current" } }));

  const printed = capturePrintedPlan();
  let plan: Record<string, unknown>;
  try {
    await runMigrateSubcommand("migrate-status", ["status"], ["task-v4-status"], runTool);
    plan = printed.read();
  } finally {
    printed.restore();
    resetConfigCache();
    sandbox.cleanup();
  }

  expect(plan.status).toBe("blocked");
  expect(plan.blockers).toEqual(["engines.my-llm.extraParams.temperature -> engines.my-llm.temperature"]);
  expect(process.exitCode).toBe(EXIT_CODES.GENERAL);
  // Nothing that loads config should have been reached.
  expect(calls).toEqual([]);
});
