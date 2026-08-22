// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration RED contract for durable-v4 environment materialization.
 *
 * A v4 resume consumes the frozen descriptor without workflow/config/index
 * rediscovery. When actual dispatch is necessary, the entire environment is
 * materialized and revalidated before any attempt reservation, event, or
 * child dispatch. Every current live value is scrubbed before any durable or
 * human-facing surface can observe it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { _setWarnSinkForTests, type WarnSinkForTests } from "../../../src/core/warn";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import {
  executeStepPlan,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../../src/workflows/exec/native-executor";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import { canonicalJson } from "../../../src/workflows/ir/plan-hash";
import type { IrStepPlan } from "../../../src/workflows/ir/schema";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const RUN_ID = "88888888-8888-4888-8888-888888888888";
const WORKFLOW_REF = "alpha//workflows/environment-runtime";
const SECRET = "github_pat_environment_v4_runtime_01234567890123456789";

let storage: IsolatedAkmStorage;
let warnings: Array<{ level: string; args: unknown[] }>;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  warnings = [];
  const sink: WarnSinkForTests = (level, args) => warnings.push({ level, args });
  _setWarnSinkForTests(sink);
});

afterEach(() => {
  _setWarnSinkForTests();
  storage.cleanup();
});

function write(relative: string, bytes: string): string {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

function secretToken(name: string): string {
  return `\${secret:${name}}`;
}

function owner(envFile: string) {
  const realRoot = fs.realpathSync(storage.stashDir);
  const rootStat = fs.statSync(realRoot, { bigint: true });
  return {
    bundle: "alpha",
    adapter: "akm",
    requestedRoot: path.resolve(storage.stashDir),
    realRoot,
    rootPhysicalIdentity: rootStat.ino === 0n ? `path:${realRoot}` : `inode:${rootStat.dev}:${rootStat.ino}`,
    requestedPath: path.resolve(envFile),
    realPath: fs.realpathSync(envFile),
    relativePath: "env/prod.env",
  };
}

function v4Step(envFile: string): IrStepPlan {
  const exec = { command: ["/bin/sh", "-lc", "printf safe"], timeoutMs: 30_000 };
  const cwdIdentity = {
    requestedRoot: storage.stashDir,
    realRoot: fs.realpathSync(storage.stashDir),
    rootDevice: "7",
    rootInode: "100",
    requestedCwd: storage.stashDir,
    realCwd: fs.realpathSync(storage.stashDir),
    cwdDevice: "7",
    cwdInode: "100",
  };
  const environment = [
    {
      kind: "env-ref",
      ref: "alpha//env/prod",
      owner: owner(envFile),
      keys: ["API_TOKEN", "LOG_LEVEL"],
      secretNames: ["deploy-token"],
      precedence: 0,
    },
  ];
  const contentHash = Bun.CryptoHasher.hash(
    "sha256",
    `akm.workflow.shell.v1\0${canonicalJson({ exec, environment, cwdIdentity })}`,
    "hex",
  );
  return {
    stepId: "run",
    title: "run",
    sequenceIndex: 0,
    root: {
      kind: "unit",
      id: "run",
      instructions: "Run with the current authorized environment values.",
      templating: "verbatim",
      exec,
      frozenTarget: { kind: "shell", contentHash, cwdIdentity },
      environment,
      onError: "fail",
      isolation: "none",
    },
    gate: { kind: "gate", id: "run.gate", stepId: "run", criteria: [], maxLoops: 1, judge: null },
  } as unknown as IrStepPlan;
}

function seedRun(): void {
  const db = openStateDatabase(getStateDbPath());
  try {
    const now = "2026-08-22T12:00:00.000Z";
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, ?, 'dir:v1:environment-runtime', NULL, 'environment runtime', 'active', '{}', 'run', ?, ?)`,
    ).run(RUN_ID, WORKFLOW_REF, now, now);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'run', 'run', 'instructions', NULL, 0, 'pending')`,
    ).run(RUN_ID);
  } finally {
    db.close();
  }
}

function stateSnapshot(): string {
  const db = openStateDatabase(getStateDbPath());
  try {
    const rows = {
      runs: db.prepare("SELECT * FROM workflow_runs ORDER BY id").all(),
      steps: db.prepare("SELECT * FROM workflow_run_steps ORDER BY run_id, sequence_index").all(),
      units: db.prepare("SELECT * FROM workflow_run_units ORDER BY run_id, unit_id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY id").all(),
    };
    return canonicalJson(rows);
  } finally {
    db.close();
  }
}

function scanStateFilesFor(needle: string): string[] {
  const dbPath = getStateDbPath();
  const directory = path.dirname(dbPath);
  const prefix = path.basename(dbPath);
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .filter((name) => fs.readFileSync(path.join(directory, name)).includes(Buffer.from(needle)))
    .sort();
}

async function seedCompleted(step: IrStepPlan): Promise<void> {
  const work = computeStepWorkList(step, {
    runId: RUN_ID,
    params: {},
    stepOutputs: {},
    engines: {},
  });
  if (!work.ok) throw new Error(work.error);
  const unit = work.list.units[0];
  if (!unit) throw new Error("fixture requires one work unit");
  const now = "2026-08-22T12:01:00.000Z";
  await withWorkflowRunsRepo((repo) => {
    repo.insertUnit({
      runId: RUN_ID,
      unitId: unit.unitId,
      stepId: "run",
      nodeId: unit.nodeId,
      parentUnitId: null,
      phase: null,
      runner: unit.runner,
      engine: null,
      model: null,
      inputHash: unit.inputHash,
      startedAt: now,
    });
    repo.finishUnit({
      runId: RUN_ID,
      unitId: unit.unitId,
      status: "completed",
      resultJson: JSON.stringify("reused frozen result"),
      tokens: null,
      failureReason: null,
      finishedAt: now,
    });
  });
}

describe("v4 environment preflight and no-reread runtime", () => {
  test("a changed key/token contract fails before reservation, events, or dispatch and leaves SQLite byte-for-byte logical state unchanged", async () => {
    const envFile = write("env/prod.env", `LOG_LEVEL=info\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    write("secrets/deploy-token", SECRET);
    const step = v4Step(envFile);
    seedRun();

    // Value rotation is allowed; topology expansion is not. This injected key
    // was never authorized by the frozen exact key-name set.
    fs.writeFileSync(
      envFile,
      `LOG_LEVEL=current\nAPI_TOKEN=${secretToken("deploy-token")}\nUNFROZEN_KEY=must-not-enter-child\n`,
      { mode: 0o600 },
    );
    const before = stateSnapshot();
    let dispatches = 0;
    const result = await executeStepPlan(step, {
      runId: RUN_ID,
      workflowRef: WORKFLOW_REF,
      params: {},
      evidence: {},
      engines: {},
      workDir: storage.stashDir,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not dispatch" };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/environment|key|token|preflight|changed/i);
    expect(dispatches).toBe(0);
    expect(stateSnapshot()).toBe(before);
  });

  test("materializes current values for final dispatch, then scrubs plan/DB/status/events/warnings/stdout/stderr", async () => {
    const envFile = write("env/prod.env", `LOG_LEVEL=old\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    write("secrets/deploy-token", SECRET);
    const step = v4Step(envFile);
    seedRun();

    // Same owner, same exact keys and token topology, new values: the one
    // authorized live-value change a durable resume may observe.
    fs.writeFileSync(envFile, `API_TOKEN=Bearer ${secretToken("deploy-token")}\nLOG_LEVEL=current\n`, { mode: 0o600 });
    let dispatchedRequest: UnitDispatchRequest | undefined;
    const dispatcher = async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      dispatchedRequest = request;
      return {
        ok: false,
        text: `stdout=${SECRET}`,
        error: `stderr=${SECRET}`,
        failureReason: `provider-${SECRET}`,
        sessionId: `session-${SECRET}`,
      };
    };
    const result = await executeStepPlan(step, {
      runId: RUN_ID,
      workflowRef: WORKFLOW_REF,
      params: {},
      evidence: {},
      engines: {},
      workDir: storage.stashDir,
      dispatcher,
    });
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
    const status = await getWorkflowStatus(RUN_ID, { includeUnits: true });
    const db = openStateDatabase(getStateDbPath());
    let events: unknown;
    try {
      events = db.prepare("SELECT event_type, ref, metadata_json FROM events ORDER BY id").all();
    } finally {
      db.close();
    }
    const surfaces = JSON.stringify({
      plan: step,
      result,
      rows,
      status,
      events,
      warnings,
    });

    expect(dispatchedRequest?.env).toEqual({ API_TOKEN: `Bearer ${SECRET}`, LOG_LEVEL: "current" });
    expect(dispatchedRequest?.sensitiveValues).toEqual(expect.arrayContaining([SECRET, `Bearer ${SECRET}`, "current"]));
    expect(surfaces).not.toContain(SECRET);
    expect(surfaces).toContain("[REDACTED]");
    expect(scanStateFilesFor(SECRET)).toEqual([]);
  });

  test("a fully journaled v4 step resumes after workflow/env/config/index deletion without any rediscovery or dispatch", async () => {
    const workflowFile = write("workflows/environment-runtime.md", "workflow authored bytes\n");
    const envFile = write("env/prod.env", `LOG_LEVEL=old\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const secretFile = write("secrets/deploy-token", SECRET);
    const step = v4Step(envFile);
    seedRun();
    await seedCompleted(step);

    fs.unlinkSync(workflowFile);
    fs.unlinkSync(envFile);
    fs.unlinkSync(secretFile);
    const configPath = path.join(storage.configDir, "akm", "config.json");
    fs.writeFileSync(configPath, "{ invalid config that must not be read", "utf8");
    fs.writeFileSync(path.join(storage.cacheDir, "index.db"), "invalid index that must not be read", "utf8");

    let dispatches = 0;
    const before = stateSnapshot();
    const result = await executeStepPlan(step, {
      runId: RUN_ID,
      workflowRef: WORKFLOW_REF,
      params: {},
      evidence: {},
      engines: {},
      workDir: storage.stashDir,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not dispatch" };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.units.map((unit) => unit.text)).toEqual(["reused frozen result"]);
    expect(dispatches).toBe(0);
    expect(stateSnapshot()).toBe(before);
  });
});
