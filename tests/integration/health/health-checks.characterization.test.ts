import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { appendEvent } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// Characterization net for WS9 (#490): pins the FULL ordered hardChecks +
// advisories structure of `akmHealth` — names, order, kind, status,
// confidence, and message — so the registry refactor can be proven
// byte-identical. Volatile substrings (timings, absolute paths) are not part
// of the assertion; the check identity/order/status/message contract is.
//
// This snapshot is intentionally exhaustive about ORDER because the registry
// design must preserve emission order exactly.

let storage: IsolatedAkmStorage;
const extraTempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  extraTempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of extraTempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Project a check to the stable identity fields (drop evidence which carries
// timings/paths; messages with embedded counts are stable for the seeded data).
function project(check: HealthCheckResult) {
  return {
    name: check.name,
    kind: check.kind,
    status: check.status,
    confidence: check.confidence,
    message: check.message,
  };
}

function findCheck(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected a check named ${name}`);
  return found;
}

describe("health checks characterization (WS9)", () => {
  test("empty stash: full ordered check structure is stable", () => {
    const result = withEnvSync({ PATH: "" }, () => akmHealth({ since: "7d" }));

    expect(result.hardChecks.map(project)).toEqual([
      {
        name: "state-db-schema",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "state.db opened and required tables are present.",
      },
      {
        name: "state-db-round-trip",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "state.db append/read round-trip succeeded.",
      },
      {
        name: "task-history-read",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: findCheck(result.hardChecks, "task-history-read").message,
      },
      {
        name: "task-log-backing",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "Every task_history log_path resolved on disk.",
      },
      {
        name: "active-runs",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "No active task runs exceeded the stale threshold.",
      },
      {
        name: "default-engine",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No default engine is configured.",
      },
      {
        name: "model-map-files",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "Installed model defaults are valid; no optional user models.json is present.",
      },
      {
        name: "selected-model-aliases",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No configured engines select a model.",
      },
      {
        name: "default-llm-engine",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No default LLM engine is configured.",
      },
      {
        name: "configured-engines",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No engines are explicitly configured.",
      },
      {
        name: "active-improve-strategy",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: findCheck(result.hardChecks, "active-improve-strategy").message,
      },
    ]);

    expect(result.advisories.map(project)).toEqual([
      {
        name: "collapse-churn-detector",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message:
          "No detector cycle rows yet — the collapse/churn detector runs only on improve cycles where consolidate did work.",
      },
      {
        // 08 surfaces: the default config ships one enabled registry, so the
        // egress eyeball-diff advisory emits even in an empty sandbox.
        name: "egress-endpoints",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message:
          "1 remote endpoint(s) in the effective config (registries/sources/LLM/embedding) — review the evidence list for unexpected destinations.",
      },
      {
        name: "task-fail-rate",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        // Message embeds the volatile `since` ISO; identity/order pinned here.
        message: findCheck(result.advisories, "task-fail-rate").message,
      },
      {
        name: "session-extraction",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "Session extraction not active (feature disabled or no harness available).",
      },
      {
        name: "pool-saturation",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "Pool saturation: no extract activity in the window — no signal.",
      },
      {
        name: "auto-accept-validation",
        kind: "heuristic",
        status: "pass",
        confidence: "low",
        message: "Auto-accept gate did not run (disabled or no proposals above threshold).",
      },
      {
        name: "stale-txn-journals",
        kind: "deterministic",
        status: "pass",
        confidence: "high",
        message: "No stale transaction journals found.",
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pass");
    expect(result.schemaVersion).toBe(3);
    expect("sessionLogAdvisories" in result).toBe(false);
  });

  test("seeded failure stash: ordered structure with a hard fail + advisory warn", () => {
    const logDir = makeTempDir("akm-healthchar-logs-");
    const db = openStateDatabase();
    try {
      // One completed prompt task with a resolvable log, one failed prompt task
      // with a MISSING log -> task-log-backing fails, agentFailureRate > 0.
      upsertTaskHistory(db, {
        task_id: "ok-task",
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: null,
        log_path: (() => {
          const p = path.join(logDir, "ok.log");
          fs.writeFileSync(p, "ok");
          return p;
        })(),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 10,
          detail: { exitCode: 0 },
          engine: "opencode",
        }),
      });
      upsertTaskHistory(db, {
        task_id: "failed-task",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: path.join(logDir, "missing.log"),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 20,
          detail: { exitCode: 2, reason: "non_zero_exit", error: "boom" },
          engine: "opencode",
        }),
      });
    } finally {
      db.close();
    }

    appendEvent({ eventType: "improve_invoked", ref: "improve:all:all", metadata: { dryRun: false } });

    const result = akmHealth({ since: "7d" });

    // Order + identity of hard checks is unchanged even with a fail present.
    expect(result.hardChecks.map((c) => c.name)).toEqual([
      "state-db-schema",
      "state-db-round-trip",
      "task-history-read",
      "task-log-backing",
      "active-runs",
      "default-engine",
      "model-map-files",
      "selected-model-aliases",
      "default-llm-engine",
      "configured-engines",
      "active-improve-strategy",
    ]);
    expect(result.advisories.map((c) => c.name)).toEqual([
      "collapse-churn-detector",
      "egress-endpoints",
      "task-fail-rate",
      "session-extraction",
      "pool-saturation",
      "auto-accept-validation",
      "stale-txn-journals",
    ]);

    const logBacking = findCheck(result.hardChecks, "task-log-backing");
    expect(logBacking.status).toBe("fail");
    expect(logBacking.message).toBe("1 task log(s) referenced in task_history are missing.");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("fail");
    expect("sessionLogAdvisories" in result).toBe(false);
  });
});

// Regression (P1b Lane C code review, spec §5.3 D8): agentFailureRate's row
// filter was left on the pre-F-2 vocabulary ("prompt") after the D8 re-code
// moved the agent/LLM arm's stored target_kind to "command" + a metadata
// targetVocab:2 marker. Unfixed, the metric silently read 0 for every new
// agent/LLM task run — see src/commands/health/improve-metrics.ts's
// isAgentTaskHistoryRow, which src/commands/health.ts and
// src/commands/health/windows.ts both now use.
describe("agentFailureRate — D8 vocabulary-aware (marker-based) row filter", () => {
  test("a NEW marked agent/LLM ('command' + targetVocab:2) failure is counted; a legacy unmarked 'command' (shell/script) failure is not", () => {
    const db = openStateDatabase();
    try {
      // Completed NEW-vocabulary agent/LLM row: denominator only.
      upsertTaskHistory(db, {
        task_id: "agent-ok",
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: null,
        log_path: null,
        target_kind: "command",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 10,
          detail: { exitCode: 0 },
          engine: "opencode",
          targetVocab: 2,
        }),
      });
      // Failed NEW-vocabulary agent/LLM row: numerator + denominator. This is
      // the row the pre-fix "prompt"-only filter silently dropped to 0.
      upsertTaskHistory(db, {
        task_id: "agent-failed",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: null,
        target_kind: "command",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 10,
          detail: { exitCode: 1, reason: "non_zero_exit", error: "boom" },
          engine: "opencode",
          targetVocab: 2,
        }),
      });
      // Failed LEGACY row: unmarked "command" is the pre-P1b native
      // shell/script arm, not agent/LLM — must be excluded entirely (neither
      // numerator nor denominator), or it would silently pollute the rate.
      upsertTaskHistory(db, {
        task_id: "legacy-shell-failed",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: null,
        target_kind: "command",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 10,
          detail: { exitCode: 2, reason: "non_zero_exit", error: "boom" },
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "7d" });

    // 1 failure / 2 agent/LLM rows — the legacy shell row is excluded from
    // both the numerator and the denominator, not just the numerator.
    expect(result.metrics.agentFailureRate).toBe(0.5);
  });

  test("a legacy unmarked 'prompt' failure (pre-P1b agent/LLM row) is still counted", () => {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "legacy-prompt-failed",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 10,
          detail: { exitCode: 1, reason: "non_zero_exit", error: "boom" },
          engine: "opencode",
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "7d" });

    expect(result.metrics.agentFailureRate).toBe(1);
  });
});
