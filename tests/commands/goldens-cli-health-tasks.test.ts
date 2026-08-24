// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-07 (Chunk 0a — brief §11, R4): CLI output baselines for the Chunk 9
 * sweep, families B (`akm health` json/text/md/html + exit codes + repeated
 * `--windows`) and C (`akm task` command family incl. the config-bypass
 * `tasks run` path).
 *
 * See `tests/commands/goldens-cli-output.test.ts` for the shared design
 * notes (grammar-agnostic encoding, `runCliCapture`, designation policy).
 * This file extends, and does not duplicate, `tests/health-command.test.ts`
 * (`akm health CLI exit code` / `--group-by run` describe blocks) and
 * `tests/commands/tasks-cli-envelope.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmHealth } from "../../src/commands/health";
import { buildHealthHtmlReplacements } from "../../src/commands/health/html-report";
import type { AkmImproveResult } from "../../src/commands/improve/improve";
import { openStateDatabase } from "../../src/core/state-db";
import { recordImproveRun } from "../../src/storage/repositories/improve-runs-repository";
import { upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { runCliCapture } from "../_helpers/cli";
import { expectGolden } from "../_helpers/golden";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { HEALTH_WINDOW_A_NAME, HEALTH_WINDOW_B_NAME, TASK_TRUE_ID } from "../fixtures/goldens/cli/fixture-refs";

let storage: IsolatedAkmStorage;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCliCapture(args);
}

function fixtureImproveResult(partial: Record<string, unknown>): AkmImproveResult {
  return {
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions: [],
    ...partial,
  } as unknown as AkmImproveResult;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// Family B — akm health
// ─────────────────────────────────────────────────────────────────────────

describe("family B — akm health", () => {
  test("health — json + text, empty state.db (pass)", async () => {
    const json = await runCli(["health", "--format=json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("pass");

    const text = await runCli(["health", "--format=text"]);
    expect(text.code).toBe(0);

    expectGolden("tests/fixtures/goldens/cli/b-health-json-text.json", {
      json: { exitCode: json.code, stdoutKeys: Object.keys(parsed).sort(), status: parsed.status },
      text: { exitCode: text.code, stdoutNonEmpty: text.stdout.length > 0 },
    });
  });

  test("health --group-by run --format=md", async () => {
    const db = openStateDatabase();
    try {
      const now = Date.now();
      const startedAt = new Date(now - 60_000).toISOString();
      const completedAt = new Date(now - 30_000).toISOString();
      upsertTaskHistory(db, {
        task_id: "akm-improve",
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt,
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 30_000, detail: null }),
      });
      recordImproveRun(db, {
        id: "b-run-gb",
        startedAt,
        completedAt,
        stashDir: storage.stashDir,
        dryRun: false,
        strategy: "default",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureImproveResult({ actions: [] }),
      });
    } finally {
      db.close();
    }
    const result = await runCli(["health", "--since", "7d", "--group-by", "run", "--format=md"]);
    expect(result.code).toBe(0);
    expectGolden(
      "tests/fixtures/goldens/cli/b-health-group-by-run-md.json",
      { exitCode: result.code, stdoutScrubbed: result.stdout },
      { stash: storage.stashDir, data: storage.dataDir },
    );
  });

  test("health --window-compare 24h --format=md", async () => {
    const result = await runCli(["health", "--window-compare", "24h", "--format=md"]);
    expect(result.code).toBe(0);
    expectGolden(
      "tests/fixtures/goldens/cli/b-health-window-compare-md.json",
      { exitCode: result.code, stdoutScrubbed: result.stdout },
      { stash: storage.stashDir, data: storage.dataDir },
    );
  });

  test("health — repeated --windows (parseAllFlagValues, cli.ts:371)", async () => {
    const now = Date.now();
    const sinceA = new Date(now - 3 * 3600_000).toISOString();
    const sinceB = new Date(now - 1 * 3600_000).toISOString();
    const result = await runCli([
      "health",
      "--windows",
      `name=${HEALTH_WINDOW_A_NAME},since=${sinceA}`,
      "--windows",
      `name=${HEALTH_WINDOW_B_NAME},since=${sinceB}`,
      "--format=json",
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { windows?: Array<{ name: string }> };
    expect(Array.isArray(parsed.windows)).toBe(true);
    expect(parsed.windows?.map((w) => w.name)).toEqual([HEALTH_WINDOW_A_NAME, HEALTH_WINDOW_B_NAME]);
    expectGolden("tests/fixtures/goldens/cli/b-health-repeated-windows.json", {
      exitCode: result.code,
      windowNames: parsed.windows?.map((w) => w.name),
      stdoutKeys: Object.keys(parsed).sort(),
    });
  });

  test("health --report --format=html — structural markers + buildHealthHtmlReplacements key-set (never bytes)", async () => {
    // The full report is a DATA flag: the bespoke template fires on the
    // report-shaped result, not on the format (bare `--format html` renders
    // the plain check generically).
    const out = path.join(storage.root, "health.html");
    const result = await runCli(["health", "--report", "--format", "html", "--output", out]);
    expect([0, 4]).toContain(result.code);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toMatch(/%%[A-Z_]+%%/);

    // Unit-level: the token-builder's key-set, never the rendered HTML bytes.
    const healthResult = akmHealth({});
    const replacements = buildHealthHtmlReplacements(healthResult, { window: "24h", compare: "24h", proposals: [] });

    expectGolden("tests/fixtures/goldens/cli/b-health-html.json", {
      cliExitCode: result.code,
      structuralMarkers: {
        hasDoctype: html.includes("<!DOCTYPE html>"),
        hasTitle: /<title>/.test(html),
        chartIds: [
          "chartWallTime",
          "chartPhases",
          "chartStash",
          "chartConsOutput",
          "chartSuccess",
          "chartLint",
          "chartDistill",
        ].filter((id) => html.includes(`id="${id}"`)),
      },
      replacementKeys: Object.keys(replacements).sort(),
    });
  });

  test("health — exit 1 (fail) and exit 4 (warn) fixtures", async () => {
    // fail: a task_history row referencing a log_path that does not exist on
    // disk forces the deterministic `task-log-backing` hardCheck to fail.
    const failDb = openStateDatabase();
    try {
      upsertTaskHistory(failDb, {
        task_id: "b-missing-log-task",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: path.join(storage.root, "definitely-missing.log"),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 5,
          detail: { exitCode: 1 },
          engine: "opencode",
        }),
      });
    } finally {
      failDb.close();
    }
    const fail = await runCli(["health", "--format=json"]);
    expect(fail.code).toBe(1);
    const failJson = JSON.parse(fail.stdout) as { status: string };
    expect(failJson.status).toBe("fail");

    // warn: an "active" task row older than ACTIVE_RUN_WARN_MS (15m) trips the
    // deterministic `active-runs` hardCheck to warn (never a hard failure).
    const warnStorage = withIsolatedAkmStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    const warnDb = openStateDatabase();
    try {
      upsertTaskHistory(warnDb, {
        task_id: "b-stuck-active-task",
        status: "active",
        started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        completed_at: null,
        failed_at: null,
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 0, detail: null, engine: null }),
      });
    } finally {
      warnDb.close();
    }
    const warn = await runCli(["health", "--format=json"]);
    warnStorage.cleanup();
    expect(warn.code).toBe(4);
    const warnJson = JSON.parse(warn.stdout) as { status: string };
    expect(warnJson.status).toBe("warn");

    expectGolden("tests/fixtures/goldens/cli/b-health-fail-warn-exit.json", {
      fail: { exitCode: fail.code, status: failJson.status },
      warn: { exitCode: warn.code, status: warnJson.status },
    });
  });

  test("health — a deterministic advisory warning sets overall warn and exit 4", async () => {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "b-advisory-failing-task",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 5,
          detail: { exitCode: 1 },
          engine: "opencode",
        }),
      });
    } finally {
      db.close();
    }

    const direct = akmHealth({ since: "7d" });
    expect(direct.hardChecks.some((check) => check.status === "warn" || check.status === "fail")).toBe(false);
    expect(direct.advisories.find((check) => check.name === "task-fail-rate")).toMatchObject({
      kind: "deterministic",
      status: "warn",
    });
    expect(direct).toMatchObject({ ok: true, status: "warn" });

    const cli = await runCli(["health", "--since", "7d", "--format=json"]);
    expect(cli.code).toBe(4);
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, status: "warn" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Family C — akm task
// ─────────────────────────────────────────────────────────────────────────

function writeTrueTask(): void {
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "tasks", `${TASK_TRUE_ID}.yml`),
    ["version: 3", 'run: "true"', "akm:", '  schedule: "@daily"', "  enabled: true", ""].join("\n"),
  );
}

describe("family C — akm task", () => {
  test("tasks run maps a command task's non-zero status to akm failure exit 1", async () => {
    const id = "golden-false";
    fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", `${id}.yml`),
      ["version: 3", 'run: "exit 7"', "akm:", '  schedule: "@daily"', "  enabled: true", ""].join("\n"),
    );

    const run = await runCli(["task", "run", id, "--format=json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).result.detail.exitCode).toBe(7);
  });

  test("tasks run / history / doctor — command-type task running `true`", async () => {
    writeTrueTask();

    const run = await runCli(["task", "run", "--format", "json", TASK_TRUE_ID]);
    expect(run.code).toBe(0);
    const runJson = JSON.parse(run.stdout) as { result: Record<string, unknown> };
    expect(runJson.result.status).toBe("completed");

    const history = await runCli(["task", "history", "--format=json"]);
    expect(history.code).toBe(0);

    const doctor = await withEnv({ BUN_TEST: "1" }, () => runCli(["task", "doctor", "--format=json"]));
    expect(doctor.code).toBe(0);
    const doctorJson = JSON.parse(doctor.stdout) as Record<string, unknown>;
    if (doctorJson.remediation !== undefined) expect(doctorJson.remediation).toBe("akm task sync --rebind");

    expectGolden(
      "tests/fixtures/goldens/cli/c-tasks-family.json",
      {
        run: {
          exitCode: run.code,
          stdoutKeys: Object.keys(runJson).sort(),
          resultKeys: Object.keys(runJson.result).sort(),
          resultStatus: runJson.result.status,
        },
        history: { exitCode: history.code, stdoutKeys: Object.keys(JSON.parse(history.stdout)).sort() },
        doctor: {
          exitCode: doctor.code,
          stdoutKeys: Object.keys(doctorJson)
            .filter((key) => key !== "remediation")
            .sort(),
        },
      },
      { stash: storage.stashDir, data: storage.dataDir },
    );
  });

  test("tasks run <id> — invalid config fails before task-history mutation", async () => {
    writeTrueTask();
    // A v3 run must resolve and prepare its execution boundary before it
    // reserves durable history. A malformed config therefore fails closed.
    const configPath = path.join(storage.configDir, "akm", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json");

    const run = await runCli(["task", "run", TASK_TRUE_ID, "--format=json"]);
    expect(run.code).toBe(78);
    const failure = JSON.parse(run.stderr) as { code?: string };
    expect(failure.code).toBe("INVALID_CONFIG_FILE");

    expectGolden("tests/fixtures/goldens/cli/c-tasks-run-config-bypass.json", {
      exitCode: run.code,
      errorCode: failure.code,
    });
  });
});
