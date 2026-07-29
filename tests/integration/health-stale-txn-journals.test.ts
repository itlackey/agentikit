import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../src/commands/health";
import type { HealthCheckResult } from "../../src/commands/health/types";
import { getDataDir } from "../../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// Item 4: `akm health` had zero visibility into leftover `$DATA/txn` journal
// dirs (stranded durable-transaction state seen twice in a real 0.9
// recovery). This pins the new `stale-txn-journals` advisory: it fires when a
// journal older than the sweeper's grace period is found, survives a corrupt
// journal.json (reported as "unreadable" rather than throwing), and stays
// quiet for a journal young enough to plausibly belong to a running op.

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function findCheck(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected an advisory named ${name}`);
  return found;
}

/** Write a $DATA/txn/<ns>/<id>/journal.json and backdate its mtime by `ageMs`. */
function writeJournalFile(name: string, content: string, ageMs: number): void {
  const dir = path.join(getDataDir(), "txn", "ns-a", name);
  fs.mkdirSync(dir, { recursive: true });
  const journalPath = path.join(dir, "journal.json");
  fs.writeFileSync(journalPath, content);
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(journalPath, past, past);
}

const VALID_JOURNAL = JSON.stringify({
  version: 1,
  kind: "proposal-accept",
  phase: "prepared",
  transactionId: "txn-1",
  root: "/tmp/does-not-matter",
  changes: [],
  decidedAt: new Date().toISOString(),
  payload: {},
});

describe("stale-txn-journals advisory (item 4)", () => {
  test("passes with no signal when $DATA/txn does not exist", () => {
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const advisory = findCheck(result.advisories, "stale-txn-journals");
    expect(advisory.status).toBe("pass");
    expect(advisory.evidence?.count).toBe(0);
  });

  test("fires when a journal is older than the sweep grace period", () => {
    writeJournalFile("txn-old", VALID_JOURNAL, 10 * 60_000); // 10 minutes old
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const advisory = findCheck(result.advisories, "stale-txn-journals");
    expect(advisory.status).toBe("warn");
    expect(advisory.evidence?.count).toBe(1);
    expect(advisory.evidence?.unreadable).toBe(0);
    expect(advisory.message).toContain("1 stale transaction journal(s)");
    expect(advisory.message).toContain("v0.9.0-troubleshooting.md");
  });

  test("stays quiet for a journal younger than the grace period (plausibly still running)", () => {
    writeJournalFile("txn-fresh", VALID_JOURNAL, 60_000); // 1 minute old
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const advisory = findCheck(result.advisories, "stale-txn-journals");
    expect(advisory.status).toBe("pass");
    expect(advisory.evidence?.count).toBe(0);
  });

  test("survives an unreadable/corrupt journal and counts it separately", () => {
    writeJournalFile("txn-good", VALID_JOURNAL, 10 * 60_000);
    writeJournalFile("txn-corrupt", "{ not valid json", 10 * 60_000);
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const advisory = findCheck(result.advisories, "stale-txn-journals");
    expect(advisory.status).toBe("warn");
    expect(advisory.evidence?.count).toBe(2);
    expect(advisory.evidence?.unreadable).toBe(1);
    expect(advisory.message).toContain("1 unreadable");
  });
});
