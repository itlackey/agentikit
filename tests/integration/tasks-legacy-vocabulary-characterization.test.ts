// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization — task-history "legacy vocabulary" write-side inventory.
 *
 * Pins the CURRENT (inverted) `target_kind` strings the task runner persists
 * to `task_history` per prepared arm, the shape each round-trips back to via
 * `readTaskHistory()`, and the "stash" bundle-name fallback used when no
 * bundle is configured anywhere.
 *
 * See docs/plans/specs/p0-invariants.md rows R-08 and R-09. Nothing here is
 * fixed — R-08 pins a known vocabulary INVERSION (flips in P1b) and R-09 pins
 * a legacy literal (flips in P1b/P4b).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../src/core/state-db";
import type { SpawnFn } from "../../src/core/subprocess";
import { getTaskHistory, upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { readTaskHistory, runTask } from "../../src/tasks/runner";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;
let workflowsDir: string;
let scriptsDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  workflowsDir = path.join(storage.stashDir, "workflows");
  scriptsDir = path.join(storage.stashDir, "scripts");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(workflowsDir, { recursive: true });
  // Reused verbatim from tests/integration/tasks-runner.test.ts, which already
  // proves this exact fixture compiles as a runnable workflow target.
  fs.writeFileSync(
    path.join(workflowsDir, "noop.md"),
    "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n",
    "utf8",
  );
  // Deliberately NO `defaultBundle` here: R-09's whole point is the fallback
  // that fires when NEITHER options.bundleName NOR config.defaultBundle names
  // one. Every other test in this file passes `bundleName: "fixture"`
  // explicitly, so it does not depend on this key either.
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    semanticSearchMode: "off",
    engines: { opencode: { kind: "agent", platform: "opencode" } },
    defaults: { engine: "opencode" },
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Crib of tests/integration/tasks-runtime-v3-runner.test.ts's `completedSpawn`. */
function completedSpawn(exitCode: number): ReturnType<SpawnFn> {
  return {
    exitCode,
    exited: Promise.resolve(exitCode),
    stdout: closedStream(),
    stderr: closedStream(),
    stdin: null,
    kill() {},
  };
}

/** The RAW stored `target_kind` string for a task's most recent history row. */
function storedTargetKind(taskId: string): string | null | undefined {
  const db = openStateDatabase();
  try {
    return getTaskHistory(db, taskId)?.target_kind;
  } finally {
    db.close();
  }
}

describe("R-08 — legacy vocabulary: stored target_kind strings + read-back shape", () => {
  test('R-08 — a prepared workflow target stores target_kind "workflow" and reads back { kind: "workflow", ref }', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    writeTask("arm-workflow", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');

    const result = await runTask("arm-workflow", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      runWorkflowStepsImpl: (async ({ target, params = {} }: { target: string; params?: Record<string, unknown> }) => ({
        run: {
          id: "run-arm-workflow",
          workflowRef: target,
          workflowTitle: "Noop",
          status: "completed" as const,
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:00:00Z",
          currentStepId: null,
        },
        executed: [],
      })) as never,
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "workflow", ref: "fixture//workflows/noop" });
    expect(storedTargetKind("arm-workflow")).toBe("workflow");
    expect(readTaskHistory({ id: "arm-workflow" })[0]?.target).toEqual({
      kind: "workflow",
      ref: "fixture//workflows/noop",
    });
  });

  test('R-08 — a prepared command (agent/LLM) target stores target_kind "prompt" — the INVERTED name — and reads back { kind: "prompt", engine }', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    writeTask(
      "arm-command",
      [
        "version: 3",
        "uses: akm/command",
        "with:",
        "  content: say hi",
        "akm:",
        '  schedule: "@daily"',
        "  engine: opencode",
        "",
      ].join("\n"),
    );

    const result = await runTask("arm-command", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      runAgentImpl: (async () => ({ ok: true, exitCode: 0, stdout: "hi", stderr: "", durationMs: 1 })) as never,
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "prompt", engine: "opencode" });
    // DEFECT (R-08): a prepared COMMAND target — an agent/LLM dispatch — is
    // persisted under the string "prompt", not "command".
    expect(storedTargetKind("arm-command")).toBe("prompt");
    expect(readTaskHistory({ id: "arm-command" })[0]?.target).toEqual({ kind: "prompt", engine: "opencode" });
  });

  test('R-08 — a prepared shell (run:) target stores target_kind "command" — the INVERTED name — and reads back { kind: "command" } with cmd dropped', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    writeTask("arm-shell", 'version: 3\nrun: printf ok\nshell: sh\nakm:\n  schedule: "@daily"\n');

    const result = await runTask("arm-shell", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn: () => completedSpawn(0),
    });

    expect(result.status).toBe("completed");
    // The freshly-returned result still carries `cmd` …
    expect(result.target).toEqual({ kind: "command", cmd: ["sh", "-c", "printf ok"] });
    // DEFECT (R-08): a prepared SHELL target is persisted under the string
    // "command" — the same string a prepared SCRIPT target uses below, even
    // though the two arms are otherwise distinguishable.
    expect(storedTargetKind("arm-shell")).toBe("command");
    // … but metadata_json never records `cmd`, so the round trip through
    // history drops it: the read-back shape is the bare { kind: "command" }.
    expect(readTaskHistory({ id: "arm-shell" })[0]?.target).toEqual({ kind: "command" });
  });

  test('R-08 — a prepared script target ALSO stores target_kind "command" (same string as shell) and reads back { kind: "command" }', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    fs.writeFileSync(path.join(scriptsDir, "arm-script.sh"), "#!/bin/sh\nprintf ok\n");
    writeTask("arm-script", 'version: 3\nuses: scripts/arm-script.sh\nakm:\n  schedule: "@daily"\n');

    const result = await runTask("arm-script", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn: () => completedSpawn(0),
    });

    expect(result.status).toBe("completed");
    expect(result.target.kind).toBe("command");
    // Shell and script are indistinguishable in history — both store "command"
    // (the exact same string pinned for the shell arm above).
    expect(storedTargetKind("arm-script")).toBe("command");
    expect(readTaskHistory({ id: "arm-script" })[0]?.target).toEqual({ kind: "command" });
  });

  test('R-08 — a null or unrecognized stored target_kind reads back as { kind: "unknown" }', () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const baseRow = {
      status: "completed",
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:00:00.000Z",
      failed_at: null,
      log_path: null,
      target_ref: null,
      metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 1, detail: null }),
    };
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, { ...baseRow, task_id: "arm-null-kind", target_kind: null });
      upsertTaskHistory(db, { ...baseRow, task_id: "arm-unrecognized-kind", target_kind: "bogus-legacy-value" });
    } finally {
      db.close();
    }

    expect(readTaskHistory({ id: "arm-null-kind" })[0]?.target).toEqual({ kind: "unknown" });
    expect(readTaskHistory({ id: "arm-unrecognized-kind" })[0]?.target).toEqual({ kind: "unknown" });
  });
});

describe('R-09 — bundleName fallback resolves to the literal "stash" bundle', () => {
  test('R-09 — with no options.bundleName and no config.defaultBundle, the qualified ref resolves against bundle "stash"', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    writeTask("arm-fallback", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    const captured: string[] = [];

    const result = await runTask("arm-fallback", {
      stashDir: storage.stashDir,
      // No bundleName. The shared beforeEach config also declares no
      // defaultBundle — the exact precondition this row names.
      runWorkflowStepsImpl: (async ({ target, params = {} }: { target: string; params?: Record<string, unknown> }) => {
        captured.push(target);
        return {
          run: {
            id: "run-arm-fallback",
            workflowRef: target,
            workflowTitle: "Noop",
            status: "completed" as const,
            params,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            completedAt: "2025-01-01T00:00:00Z",
            currentStepId: null,
          },
          executed: [],
        };
      }) as never,
    });

    expect(result.status).toBe("completed");
    // Asserted via the resulting ref STRING only — never via the `bundleName`/
    // `stashDir` option identifiers themselves (R-09: the option key is
    // renamed in a later phase, and a test asserting on the key would fail
    // for the wrong reason).
    expect(captured).toEqual(["stash//workflows/noop"]);
    expect(result.target).toEqual({ kind: "workflow", ref: "stash//workflows/noop" });
    expect(readTaskHistory({ id: "arm-fallback" })[0]?.target).toEqual({
      kind: "workflow",
      ref: "stash//workflows/noop",
    });
  });
});
