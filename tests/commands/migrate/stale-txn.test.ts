// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate status`/`apply` for the stash root's stale durable-transaction
 * journals — the counterpart to dead-residue.test.ts's dead-`.akm/*`-path
 * coverage. `findStaleTxnEntries` is read-only; `recoverStaleTxns` is the
 * opt-in action `akm migrate apply` invokes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { findStaleTxnEntries, recoverStaleTxns } from "../../../src/commands/migrate/stale-txn";
import { advanceTxn, beginTxn, registerTxnKind } from "../../../src/core/fs-txn";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshStash(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

/** Register a synthetic 3-phase kind recording rollback/finalize calls. */
function registerRecordingKind(kind: string, calls: string[]): void {
  registerTxnKind<{ label: string }>(kind, {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback(txn) {
      calls.push(`rollback:${txn.journal.payload.label}`);
    },
    finalize(txn) {
      calls.push(`finalize:${txn.journal.payload.label}`);
      if (txn.journal.phase === "files-published") advanceTxn(txn, "committed");
    },
  });
}

describe("migrate stale-txn detection and recovery", () => {
  test("reports nothing when no journals exist for the stash root", () => {
    const stashDir = freshStash();
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("finds a journal left behind under the stash root's namespace", () => {
    const stashDir = freshStash();
    registerRecordingKind("test-stale-status", []);
    beginTxn({ kind: "test-stale-status", root: stashDir, changes: [], payload: { label: "left-behind" } });

    const entries = findStaleTxnEntries(stashDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("test-stale-status");
    expect(entries[0]?.phase).toBe("prepared");
  });

  test("a journal bound to a DIFFERENT root is not reported", () => {
    const stashDir = freshStash();
    const otherStash = makeStashDir();
    disposers.push(otherStash);
    registerRecordingKind("test-stale-other-root", []);
    beginTxn({ kind: "test-stale-other-root", root: otherStash.dir, changes: [], payload: { label: "elsewhere" } });

    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("apply recovers a journal before its commit point (rollback) and clears it from status", async () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerRecordingKind("test-stale-apply-rollback", calls);
    beginTxn({ kind: "test-stale-apply-rollback", root: stashDir, changes: [], payload: { label: "rb" } });

    const recovered = await recoverStaleTxns(stashDir);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("test-stale-apply-rollback");
    expect(calls).toEqual(["rollback:rb"]);
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("apply recovers a journal at/after its commit point (finalize)", async () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerRecordingKind("test-stale-apply-finalize", calls);
    const txn = beginTxn({ kind: "test-stale-apply-finalize", root: stashDir, changes: [], payload: { label: "fw" } });
    advanceTxn(txn, "files-published");

    const recovered = await recoverStaleTxns(stashDir);

    expect(recovered).toHaveLength(1);
    expect(calls).toEqual(["finalize:fw"]);
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });
});
