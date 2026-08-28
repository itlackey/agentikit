// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization — task-history "legacy vocabulary" write-side inventory
 * — AMENDED IN P1b (F-2, F-3) per docs/plans/specs/p1b-model-extraction.md
 * §5.3 (result vocabulary), §5.4 (renames), §6 (the AUTHORIZED-FLIPS table).
 *
 * Pins the `target_kind` strings the task runner persists to `task_history`
 * per prepared arm, the shape each round-trips back to via
 * `readTaskHistory()` (both for NEW rows and for LEGACY rows written before
 * the vocabulary re-code), and the "stash" bundle-name fallback used when no
 * bundle is configured anywhere.
 *
 * See docs/plans/specs/p0-invariants.md rows R-08 and R-09. R-08's INVERSION
 * is fixed here (D8): prepared `command` (agent/LLM) now stores "command",
 * prepared `shell`/`script` become distinguishable ("shell"/"script"), and a
 * LEGACY row (no `targetVocab` marker) reads back mapped to the new
 * vocabulary — see `tests/integration/tasks-result-vocabulary.test.ts` for
 * the marker itself and the CLI-visible round trip. R-09's fallback VALUE is
 * unchanged; only the `RunTaskOptions` option key renames (`stashDir` ->
 * `bundleDir`), per every `runTask(...)` call in this file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../src/core/state-db";
import type { SpawnFn } from "../../src/core/subprocess";
import { getTaskHistory, upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { runTask } from "../../src/tasks/run/run-task";
import { readTaskHistory } from "../../src/tasks/run/task-history";
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
    writeTask("arm-workflow", 'version: 4\nuses: workflows/noop\nschedule:\n  - cron: "@daily"\n');

    const result = await runTask("arm-workflow", {
      bundleDir: storage.stashDir,
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

  // FLIP (F-2, spec docs/plans/specs/p1b-model-extraction.md §6, row "…:127
  // (command/agent stores "prompt") | R-08 | FLIP: stores "command"; reads
  // back {kind:"command", engine}.": D8's result-vocabulary re-code — a
  // prepared COMMAND (agent/LLM) target now stores the un-inverted string
  // "command" (formerly the confusingly-named "prompt").
  test('R-08 — a prepared command (agent/LLM) target stores target_kind "command" and reads back { kind: "command", engine }', async () => {
    writeTask(
      "arm-command",
      [
        "version: 4",
        "uses: akm/command",
        "with:",
        "  content: say hi",
        "schedule:",
        '  - cron: "@daily"',
        "engine: opencode",
        "",
      ].join("\n"),
    );

    const result = await runTask("arm-command", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      runAgentImpl: (async () => ({ ok: true, exitCode: 0, stdout: "hi", stderr: "", durationMs: 1 })) as never,
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "command", engine: "opencode" });
    // FIXED (D8): a prepared COMMAND target — an agent/LLM dispatch — is now
    // persisted under its own name, "command", not the former "prompt".
    expect(storedTargetKind("arm-command")).toBe("command");
    expect(readTaskHistory({ id: "arm-command" })[0]?.target).toEqual({ kind: "command", engine: "opencode" });
  });

  // FLIP (F-2, spec §6, row "…:157 (shell stores "command") | R-08 | FLIP:
  // stores "shell"; reads back {kind:"shell"}.": D8's re-code gives the
  // native shell arm its own name instead of the former borrowed "command".
  test('R-08 — a prepared shell (run:) target stores target_kind "shell" and reads back { kind: "shell" } with cmd dropped', async () => {
    writeTask("arm-shell", 'version: 4\nrun: printf ok\nshell: sh\nschedule:\n  - cron: "@daily"\n');

    const result = await runTask("arm-shell", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn: () => completedSpawn(0),
    });

    expect(result.status).toBe("completed");
    // The freshly-returned result still carries `cmd` …
    expect(result.target).toEqual({ kind: "shell", cmd: ["sh", "-c", "printf ok"] });
    // FIXED (D8): a prepared SHELL target is now persisted under its own
    // string, "shell" — no longer sharing "command" with the script arm below.
    expect(storedTargetKind("arm-shell")).toBe("shell");
    // … but metadata_json never records `cmd`, so the round trip through
    // history drops it: the read-back shape is the bare { kind: "shell" }.
    expect(readTaskHistory({ id: "arm-shell" })[0]?.target).toEqual({ kind: "shell" });
  });

  // FLIP (F-2, spec §6, row "…:179 (script stores "command", "same string as
  // shell") | R-08 | FLIP: stores "script"; reads back {kind:"script"}. The
  // test's premise that shell and script are indistinguishable in history is
  // now false — rewrite the assertion and the comment.": shell and script get
  // distinct strings under D8; this test's whole premise (shared string)
  // flips to its opposite.
  test('R-08 — a prepared script target stores its OWN target_kind "script" (distinguishable from shell) and reads back { kind: "script" }', async () => {
    fs.writeFileSync(path.join(scriptsDir, "arm-script.sh"), "#!/bin/sh\nprintf ok\n");
    writeTask("arm-script", 'version: 4\nuses: scripts/arm-script.sh\nschedule:\n  - cron: "@daily"\n');

    const result = await runTask("arm-script", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn: () => completedSpawn(0),
    });

    expect(result.status).toBe("completed");
    expect(result.target.kind).toBe("script");
    // FIXED (D8): shell and script are now DISTINGUISHABLE in history — script
    // stores "script", not the "command" string the shell arm stores above.
    expect(storedTargetKind("arm-script")).toBe("script");
    expect(readTaskHistory({ id: "arm-script" })[0]?.target).toEqual({ kind: "script" });
  });

  // UNCHANGED, must stay green (F-2, spec §6, row "…:198 (null / unrecognized
  // -> {kind: "unknown"}) | R-08 | UNCHANGED, must stay green."): the
  // null/unrecognized -> unknown mapping and the workflow null-ref fallback
  // are unaffected by D8. The former "arm-prompt-no-engine" row's ASSERTION
  // flips below (same **NEW legacy-read test** row of the flips table) — a
  // legacy "prompt" row (no targetVocab marker) now reads back mapped to the
  // new vocabulary, {kind:"command", engine}, not the old {kind:"prompt",…}.
  test('R-08 — a null or unrecognized stored target_kind reads back as { kind: "unknown" }; the workflow null-ref fallback is unaffected by D8', () => {
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
      // R-08's read-boundary null fallbacks (flip phase P1b, both preserved):
      // `ref` falls back to "" when target_ref is null, and `engine` is null
      // when metadata omits it. baseRow already satisfies both preconditions
      // (target_ref: null; metadata_json carries no "engine" key), so only
      // target_kind varies here. Neither row carries a targetVocab marker —
      // both are LEGACY rows, read through the §5.3 legacy-mapping table.
      upsertTaskHistory(db, { ...baseRow, task_id: "arm-workflow-null-ref", target_kind: "workflow" });
      upsertTaskHistory(db, { ...baseRow, task_id: "arm-prompt-no-engine", target_kind: "prompt" });
    } finally {
      db.close();
    }

    expect(readTaskHistory({ id: "arm-null-kind" })[0]?.target).toEqual({ kind: "unknown" });
    expect(readTaskHistory({ id: "arm-unrecognized-kind" })[0]?.target).toEqual({ kind: "unknown" });
    expect(readTaskHistory({ id: "arm-workflow-null-ref" })[0]?.target).toEqual({ kind: "workflow", ref: "" });
    // FLIP: a legacy (unmarked) "prompt" row now maps to "command", not
    // "prompt" — the null-engine fallback itself is unchanged.
    expect(readTaskHistory({ id: "arm-prompt-no-engine" })[0]?.target).toEqual({ kind: "command", engine: null });
  });

  // NEW (F-2, spec §6, "**NEW** legacy-read tests (same file) | R-08 | Rows
  // written without the marker map: 'prompt'->{kind:'command',engine} (engine
  // null when absent), 'command'->{kind:'shell'}, 'workflow'->{kind:'workflow',
  // ref: row.target_ref ?? ''}, null/garbage->{kind:'unknown'}.": the
  // null/garbage and workflow-null-ref halves of that table are already
  // covered above (unaffected by D8); this test covers the two halves that
  // DO change meaning under the marker — a legacy "command" row now reads as
  // "shell" (never "command", which is reserved for the NEW vocabulary's
  // agent/LLM arm), and a legacy "prompt" row WITH an engine in its metadata
  // carries that engine through the new mapping rather than dropping it.
  test("R-08 — legacy (unmarked) rows read back mapped to the new vocabulary: command -> shell, prompt -> command (engine preserved)", () => {
    const baseRow = {
      status: "completed",
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:00:00.000Z",
      failed_at: null,
      log_path: null,
      target_ref: null,
    };
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "arm-command-legacy",
        target_kind: "command",
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 1, detail: null }),
      });
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "arm-prompt-legacy-with-engine",
        target_kind: "prompt",
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 1, detail: null, engine: "opencode" }),
      });
    } finally {
      db.close();
    }

    expect(readTaskHistory({ id: "arm-command-legacy" })[0]?.target).toEqual({ kind: "shell" });
    expect(readTaskHistory({ id: "arm-prompt-legacy-with-engine" })[0]?.target).toEqual({
      kind: "command",
      engine: "opencode",
    });
  });
});

describe('R-09 — bundleName fallback resolves to the literal "stash" bundle', () => {
  // FLIP (F-3, spec docs/plans/specs/p1b-model-extraction.md §6, row
  // "tests/integration/tasks-legacy-vocabulary-characterization.test.ts:232
  // (R-09) | R-09 | UPDATE FOR THE OPTION KEY ONLY (stashDir: -> bundleDir:).
  // The asserted resolved ref (stash//tasks/<id>) must not change.": VALUE-
  // preserving rename of RunTaskOptions.stashDir -> bundleDir. Only the
  // option key below changes — every assertion, including the resolved ref
  // string, is byte-identical to the P0 pin.
  test('R-09 — with no options.bundleName and no config.defaultBundle, the qualified ref resolves against bundle "stash"', async () => {
    writeTask("arm-fallback", 'version: 4\nuses: workflows/noop\nschedule:\n  - cron: "@daily"\n');
    const captured: string[] = [];

    const result = await runTask("arm-fallback", {
      bundleDir: storage.stashDir,
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
