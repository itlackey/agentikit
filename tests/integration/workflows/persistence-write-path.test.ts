// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serializeByKey } from "../../../src/core/concurrent";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { borrowScopedStateDb, openScopedStateDbCount } from "../../../src/core/state-db-scope";
import {
  withWorkflowRunsConnection,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { enqueueUnitWrite } from "../../../src/workflows/exec/unit-writer";
import { WORKFLOW_MAX_EVIDENCE_JSON_BYTES } from "../../../src/workflows/resource-limits";
import {
  clipStepEvidenceForPersistence,
  completeWorkflowStep,
  getWorkflowStatus,
  WORKFLOW_EVIDENCE_TRUNCATED_MARKER,
} from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { freezeWorkflow, seedWorkflowRun, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * Persistence / write-path regressions for the workflow journal:
 *
 *   A. Connection reuse — a `withWorkflowRunsConnection` scope lends ONE
 *      state.db handle to every `withWorkflowRunsRepo` call inside it, and
 *      always closes it (success, failure, or throw). No handle leak.
 *   B. Writer-queue scoping — the serialized unit-write chain is keyed per
 *      DATABASE PATH, so unrelated databases never queue behind each other,
 *      while a wide concurrent fan-out against ONE database still produces
 *      exactly one correct terminal row per unit.
 *   C. Evidence bound — `evidence_json` is capped at
 *      {@link WORKFLOW_MAX_EVIDENCE_JSON_BYTES} and an over-cap value is stored
 *      as an unmistakably-marked truncation envelope, never as a silently
 *      shortened value that reads like complete data.
 *   D. …and that bound is a PERSISTENCE bound only: the invocation that
 *      produced an over-cap artifact still feeds the complete value to its own
 *      later steps, while a run resumed from the truncated row refuses to
 *      dispatch against it and says truncation is why.
 */

let storage: IsolatedAkmStorage;

const RUN_ID = "44444444-4444-4444-8444-444444444444";
const PLAN = freezeWorkflow(`---
type: workflow
steps:
  - id: step-1
---

## step-1

instructions
`);

function seedRun(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    seedWorkflowRun(db, {
      runId: RUN_ID,
      steps: [{ stepId: "step-1", stepTitle: "Do the thing" }],
      checkinArmedAt: new Date().toISOString(),
    });
    storeFrozenWorkflowPlan(db, RUN_ID, PLAN);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  seedRun(getStateDbPath());
});

afterEach(() => storage.cleanup());

// ── A. connection reuse ──────────────────────────────────────────────────────

describe("state.db connection scope", () => {
  test("every repo call inside a scope shares ONE connection, and the scope closes it", async () => {
    expect(openScopedStateDbCount()).toBe(0);

    await withWorkflowRunsConnection(async () => {
      // Force the lazy open, then prove reuse by visibility of an UNCOMMITTED
      // row: only the connection that opened the transaction can see it. A
      // second, independent connection in WAL mode never would.
      const scoped = borrowScopedStateDb();
      if (!scoped) throw new Error("expected an ambient scoped state.db handle inside the connection scope");
      expect(borrowScopedStateDb()).toBe(scoped);
      expect(openScopedStateDbCount()).toBe(1);

      scoped.exec("BEGIN IMMEDIATE");
      try {
        scoped.prepare("UPDATE workflow_runs SET workflow_title = 'Uncommitted' WHERE id = ?").run(RUN_ID);
        const seen = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(seen?.workflow_title).toBe("Uncommitted");
        // Many repo calls, still one handle.
        await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
        await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(openScopedStateDbCount()).toBe(1);
      } finally {
        scoped.exec("ROLLBACK");
      }
    });

    // Handle released with the scope, and the uncommitted change left no trace.
    expect(openScopedStateDbCount()).toBe(0);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
    expect(row?.workflow_title).toBe("Demo");
  });

  test("a throw inside the scope still releases the connection", async () => {
    await expect(
      withWorkflowRunsConnection(async () => {
        await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(openScopedStateDbCount()).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(openScopedStateDbCount()).toBe(0);
  });

  test("nesting joins the outer scope instead of opening a second handle", async () => {
    await withWorkflowRunsConnection(async () => {
      const outer = borrowScopedStateDb();
      await withWorkflowRunsConnection(async () => {
        expect(borrowScopedStateDb()).toBe(outer);
        expect(openScopedStateDbCount()).toBe(1);
      });
      // The inner scope must NOT have closed the outer scope's handle.
      expect(openScopedStateDbCount()).toBe(1);
      const run = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
      expect(run?.id).toBe(RUN_ID);
    });
    expect(openScopedStateDbCount()).toBe(0);
  });

  test("repo calls outside a scope keep owning (and closing) their own connection", async () => {
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getRunById(RUN_ID)?.id).toBe(RUN_ID);
    });
    expect(openScopedStateDbCount()).toBe(0);
  });
});

// ── B. writer-queue scoping + fan-out correctness ────────────────────────────

describe("unit writer queue", () => {
  test("chains are keyed per database path — unrelated databases do not queue behind each other", async () => {
    // The per-key separation belongs to `serializeByKey`, which is what
    // `enqueueUnitWrite` calls with the live state.db path; exercise it on its
    // own chain map rather than asking the wrapper to write somewhere it never
    // writes in production.
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocked = serializeByKey(chains, "/tmp/does-not-exist/a.db", async () => {
      await gate;
      order.push("a");
    });
    const independent = serializeByKey(chains, "/tmp/does-not-exist/b.db", async () => {
      order.push("b");
    });

    await independent;
    // "b" drained while "a" is still parked ⇒ the chains are genuinely separate.
    expect(order).toEqual(["b"]);
    release();
    await blocked;
    expect(order).toEqual(["b", "a"]);
  });

  test("writes sharing one database path stay strictly ordered", async () => {
    // Every call keys on the live state.db path — the isolated one this suite
    // installs — so all 12 share a chain, which is the production shape.
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        enqueueUnitWrite(async () => {
          await new Promise((resolve) => setTimeout(resolve, (12 - i) % 4));
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  test("a wide concurrent fan-out journals exactly one correct terminal row per unit", async () => {
    const UNITS = 64;
    await withWorkflowRunsConnection(async () => {
      await Promise.all(
        Array.from({ length: UNITS }, async (_, i) => {
          const unitId = `review:${i}`;
          const startedAt = new Date(1_700_000_000_000 + i).toISOString();
          const claimHolder = `direct:${unitId}`;

          const attempt = await enqueueUnitWrite(() =>
            withWorkflowRunsRepo((repo) =>
              repo.reserveUnitAttempt({
                runId: RUN_ID,
                unitId,
                stepId: "step-1",
                nodeId: "review.unit",
                parentUnitId: "step-1.map",
                phase: "unit",
                runner: "sdk",
                engine: "test-agent",
                model: null,
                inputHash: `hash-${i}`,
                now: startedAt,
                claimHolder,
                claimExpiresAt: new Date(Date.parse(startedAt) + 90_000).toISOString(),
                leaseMode: "direct",
              }),
            ),
          );
          // Interleave the units against each other on purpose.
          await new Promise((resolve) => setTimeout(resolve, i % 5));

          const finished = await enqueueUnitWrite(() =>
            withWorkflowRunsRepo((repo) =>
              repo.finishUnitAttempt({
                runId: RUN_ID,
                unitId,
                attempt: attempt.attempt.attempt,
                dispatchId: attempt.attempt.dispatch_id,
                claimHolder,
                status: "completed",
                resultJson: JSON.stringify({ index: i }),
                tokens: i,
                failureReason: null,
                finishedAt: new Date(1_700_000_100_000 + i).toISOString(),
              }),
            ),
          );
          expect(finished).toBe(true);
        }),
      );
    });

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
    expect(rows).toHaveLength(UNITS);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    for (const row of rows) {
      const index = Number(row.unit_id.slice("review:".length));
      expect(row.input_hash).toBe(`hash-${index}`);
      expect(JSON.parse(row.result_json as string)).toEqual({ index });
      expect(row.tokens).toBe(index);
    }
    expect(openScopedStateDbCount()).toBe(0);
  }, 30_000);
});

// ── C. evidence persistence bound ────────────────────────────────────────────

function bigOutput(entries: number): string[] {
  return Array.from({ length: entries }, (_, i) => `${"x".repeat(512)}#${i}`);
}

describe("evidence_json persistence bound", () => {
  test("under-cap evidence is persisted verbatim", () => {
    const evidence = { output: ["a", "b"], units: [{ unitId: "u1", ok: true }] };
    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(clipped.truncatedKeys).toEqual([]);
    expect(JSON.parse(clipped.json as string)).toEqual(evidence);
  });

  test("an over-cap promoted artifact is replaced by a marked truncation envelope under the cap", () => {
    const evidence = { output: bigOutput(4000), units: [{ unitId: "u1", ok: true }] };
    const raw = JSON.stringify(evidence);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);

    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(clipped.truncatedKeys).toEqual(["output"]);
    expect(Buffer.byteLength(clipped.json as string, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);

    const parsed = JSON.parse(clipped.json as string) as Record<string, Record<string, unknown>>;
    // The truncated value is unmistakable: it is NOT an array any more, it
    // carries the marker key, and it says the data is unrecoverable.
    expect(Array.isArray(parsed.output)).toBe(false);
    expect(parsed.output?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    expect(parsed.output?.originalBytes).toBe(Buffer.byteLength(JSON.stringify(evidence.output), "utf8"));
    expect(parsed.output?.limitBytes).toBe(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);
    expect(String(parsed.output?.reason)).toContain("cannot be recovered");
    // Untouched siblings survive intact.
    expect(parsed.units).toEqual(evidence.units as never);
    // The caller's in-memory object is NOT mutated — gates and the live step
    // result keep the complete artifact.
    expect(evidence.output).toHaveLength(4000);
  });

  test("truncation is bounded even when every key is oversized", () => {
    const evidence: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) evidence[`k${i}`] = bigOutput(1000);
    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(Buffer.byteLength(clipped.json as string, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);
    expect(clipped.truncatedKeys.length).toBeGreaterThan(0);
    const parsed = JSON.parse(clipped.json as string) as Record<string, Record<string, unknown>>;
    for (const key of clipped.truncatedKeys) {
      expect(parsed[key]?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    }
  });

  test("replacement order follows UTF-8 bytes, not UTF-16 length", () => {
    // `ascii` is the LONGER string in code units but the SMALLER one in bytes;
    // `cjk` is 3 bytes per char. Ordering by `.length` would sacrifice `ascii`
    // first, leave the row still over cap, and then destroy `cjk` too —
    // replacing only `cjk` is enough.
    const evidence = { ascii: "a".repeat(400_000), cjk: "漢".repeat(350_000) };
    expect(evidence.ascii.length).toBeGreaterThan(evidence.cjk.length);
    expect(Buffer.byteLength(JSON.stringify(evidence.cjk), "utf8")).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(evidence.ascii), "utf8"),
    );

    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(clipped.truncatedKeys).toEqual(["cjk"]);
    expect(Buffer.byteLength(clipped.json as string, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);
    const parsed = JSON.parse(clipped.json as string) as Record<string, unknown>;
    expect(parsed.ascii).toBe(evidence.ascii);
  });

  test("the row is under cap at every cap, whatever the running size bookkeeping predicts", () => {
    // The loop tracks the row size arithmetically to avoid re-serializing the
    // whole object once per replaced key, but that total is only an estimate —
    // `ghost` is charged the "null" the sort used while `JSON.stringify` OMITS
    // it, so replacing `ghost` adds bytes the estimate never counted. Whatever
    // the bookkeeping predicts, the row that comes back must fit the cap.
    const evidence: Record<string, unknown> = {
      ascii: "a".repeat(9_000),
      cjk: "漢".repeat(4_000),
      nested: { rows: Array.from({ length: 300 }, (_, i) => ({ i, text: "λ".repeat(20) })) },
      ghost: undefined,
      tiny: "t",
    };
    const rawBytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
    for (let cap = 1_200; cap < rawBytes; cap += 149) {
      const clipped = clipStepEvidenceForPersistence(evidence, cap);
      const parsed = JSON.parse(clipped.json as string) as Record<string, unknown>;
      // The whole-object marker is the bounded last resort — it is a fixed size
      // and so is exempt from the cap it could not meet.
      if (parsed[WORKFLOW_EVIDENCE_TRUNCATED_MARKER] === true) continue;
      expect(Buffer.byteLength(clipped.json as string, "utf8")).toBeLessThanOrEqual(cap);
      // Every replaced key really is an envelope, and no other key was touched.
      for (const key of clipped.truncatedKeys) {
        expect((parsed[key] as Record<string, unknown>)[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
      }
      expect(clipped.truncatedKeys.length).toBeGreaterThan(0);
    }
  });

  test("a tiny cap still yields a single whole-object marker rather than an oversized row", () => {
    const clipped = clipStepEvidenceForPersistence({ output: bigOutput(4), units: [] }, 64);
    const parsed = JSON.parse(clipped.json as string) as Record<string, unknown>;
    expect(parsed[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    expect(parsed.preview).toBeUndefined();
  });

  test("completeWorkflowStep persists the bounded form and status reads it back marked", async () => {
    const evidence = { output: bigOutput(4000), units: [{ unitId: "u1", ok: true }] };
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "did the thing",
      evidence,
      summaryJudge: null,
    });

    const stored = await withWorkflowRunsRepo((repo) => repo.getStep(RUN_ID, "step-1"));
    expect(stored?.evidence_json).toBeTruthy();
    expect(Buffer.byteLength(stored?.evidence_json as string, "utf8")).toBeLessThanOrEqual(
      WORKFLOW_MAX_EVIDENCE_JSON_BYTES,
    );

    const status = await getWorkflowStatus(RUN_ID);
    const readBack = status.workflow.steps[0]?.evidence as Record<string, Record<string, unknown>> | undefined;
    expect(readBack?.output?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    // A downstream `${{ steps.step-1.output.<path> }}` reference now resolves
    // against a marker object, so it fails loudly instead of silently reading a
    // partial array.
    expect(Array.isArray(readBack?.output)).toBe(false);
    expect(readBack?.units).toEqual(evidence.units as never);
  });
});

// ── D. the row bound never reaches the LIVE run ──────────────────────────────

const FLOW_RUN_ID = "55555555-5555-4555-8555-555555555555";

/** Wide + long enough that `produce`'s promoted array alone blows the 1 MiB row cap. */
const CHUNK_COUNT = 20;
const CHUNK_CHARS = 60_000;

/** Distinct per index — content-derived unit identity rejects duplicate items. */
function chunkText(index: number): string {
  return `${"c".repeat(CHUNK_CHARS - 4)}#${String(index).padStart(3, "0")}`;
}

const FLOW_PLAN = freezeWorkflow(`---
type: workflow
params:
  chunks: { type: array }
steps:
  - id: produce
    map:
      over: params.chunks
  - id: consume
    map:
      over: steps.produce.output
---

## produce

Emit the chunk.

## consume

Handle the chunk.
`);

function seedFlowRun(): void {
  const db = openStateDatabase(getStateDbPath());
  try {
    seedWorkflowRun(db, {
      runId: FLOW_RUN_ID,
      params: { chunks: Array.from({ length: CHUNK_COUNT }, (_, i) => `seed-${i}`) },
      steps: [{ stepId: "produce" }, { stepId: "consume" }],
      checkinArmedAt: new Date().toISOString(),
    });
    storeFrozenWorkflowPlan(db, FLOW_RUN_ID, FLOW_PLAN);
  } finally {
    db.close();
  }
}

describe("evidence_json bound vs. the live run", () => {
  test("a step promoting more than the cap still feeds the NEXT step the complete value", async () => {
    seedFlowRun();
    const consumePrompts: string[] = [];
    const result = await runWorkflowSteps({
      target: FLOW_RUN_ID,
      dispatcher: async (request) => {
        if (request.stepId === "consume") {
          consumePrompts.push(request.prompt);
          return { ok: true, text: "handled" };
        }
        // Each `produce` unit emits the chunk for its own fan-out index.
        const index = /^## Item \(index (\d+)\)$/m.exec(request.prompt)?.[1];
        return { ok: true, text: chunkText(Number(index)) };
      },
      summaryJudge: null,
    });

    expect(result.done).toBe(true);
    // The whole promoted array reached `consume` — every unit got its own
    // complete 60k-char item, not a truncation envelope (which is not even an
    // array, so the fan-out would have failed to resolve at all).
    expect(consumePrompts).toHaveLength(CHUNK_COUNT);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      expect(consumePrompts.some((prompt) => prompt.includes(chunkText(i)))).toBe(true);
    }

    // …and the row is STILL bounded: the cap did its job on persistence only.
    const stored = await withWorkflowRunsRepo((repo) => repo.getStep(FLOW_RUN_ID, "produce"));
    expect(Buffer.byteLength(stored?.evidence_json as string, "utf8")).toBeLessThanOrEqual(
      WORKFLOW_MAX_EVIDENCE_JSON_BYTES,
    );
    const persisted = JSON.parse(stored?.evidence_json as string) as Record<string, Record<string, unknown>>;
    expect(persisted.output?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
  }, 60_000);

  test("an UNREFERENCED bulk step alongside a referenced one does not disturb the live value", async () => {
    // The live-evidence map is filtered at SET time by the frozen plan's
    // reference surface: `noise` is named by nobody and is not retained, while
    // `produce` is named by `consume` and must still arrive COMPLETE. Both
    // steps blow the row cap, so only the in-memory value can carry it.
    const MIXED_PLAN = freezeWorkflow(`---
type: workflow
params:
  chunks: { type: array }
steps:
  - id: noise
  - id: produce
    map:
      over: params.chunks
  - id: consume
    map:
      over: steps.produce.output
---

## noise

Emit bulk nobody reads.

## produce

Emit the chunk.

## consume

Handle the chunk.
`);
    const db = openStateDatabase(getStateDbPath());
    try {
      seedWorkflowRun(db, {
        runId: FLOW_RUN_ID,
        params: { chunks: Array.from({ length: CHUNK_COUNT }, (_, i) => `seed-${i}`) },
        steps: [{ stepId: "noise" }, { stepId: "produce" }, { stepId: "consume" }],
        checkinArmedAt: new Date().toISOString(),
      });
      storeFrozenWorkflowPlan(db, FLOW_RUN_ID, MIXED_PLAN);
    } finally {
      db.close();
    }

    const consumePrompts: string[] = [];
    const result = await runWorkflowSteps({
      target: FLOW_RUN_ID,
      dispatcher: async (request) => {
        if (request.stepId === "noise") return { ok: true, text: "n".repeat(WORKFLOW_MAX_EVIDENCE_JSON_BYTES + 1) };
        if (request.stepId === "consume") {
          consumePrompts.push(request.prompt);
          return { ok: true, text: "handled" };
        }
        const index = /^## Item \(index (\d+)\)$/m.exec(request.prompt)?.[1];
        return { ok: true, text: chunkText(Number(index)) };
      },
      summaryJudge: null,
    });

    expect(result.done).toBe(true);
    expect(consumePrompts).toHaveLength(CHUNK_COUNT);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      expect(consumePrompts.some((prompt) => prompt.includes(chunkText(i)))).toBe(true);
    }
    // Both rows are bounded — the unreferenced step completed exactly as before.
    for (const stepId of ["noise", "produce"]) {
      const stored = await withWorkflowRunsRepo((repo) => repo.getStep(FLOW_RUN_ID, stepId));
      expect(stored?.status).toBe("completed");
      const persisted = JSON.parse(stored?.evidence_json as string) as Record<string, Record<string, unknown>>;
      expect(persisted.output?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    }
  }, 60_000);

  test("a run resumed from a truncated row fails the referencing step by NAMING truncation", async () => {
    seedFlowRun();
    // The rows a previous invocation would have left behind: `produce`
    // completed, its promoted artifact replaced by the truncation envelope.
    const truncated = clipStepEvidenceForPersistence({
      units: [],
      itemCount: CHUNK_COUNT,
      output: Array.from({ length: CHUNK_COUNT }, (_, i) => chunkText(i)),
    });
    expect(truncated.truncatedKeys).toContain("output");
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare(
        `UPDATE workflow_run_steps SET status = 'completed', summary = 'produced', evidence_json = ?, completed_at = ?
           WHERE run_id = ? AND step_id = 'produce'`,
      ).run(truncated.json, new Date().toISOString(), FLOW_RUN_ID);
      db.prepare("UPDATE workflow_runs SET current_step_id = 'consume' WHERE id = ?").run(FLOW_RUN_ID);
    } finally {
      db.close();
    }

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: FLOW_RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "handled" };
      },
      summaryJudge: null,
    });

    // Nothing ran on destroyed data, and the failure says WHY.
    expect(dispatches).toBe(0);
    expect(result.executed[0]?.ok).toBe(false);
    expect(result.executed[0]?.summary).toContain("steps.produce.output");
    expect(result.executed[0]?.summary).toContain("was NOT persisted");
    expect(result.executed[0]?.summary).toContain("truncation marker");
    const status = await getWorkflowStatus(FLOW_RUN_ID);
    expect(status.workflow.steps[1]?.status).toBe("failed");
  }, 30_000);
});
