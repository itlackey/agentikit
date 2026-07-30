// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-6.3a — unit contract for the unified filesystem-transaction engine
 * (src/core/fs-txn.ts): journal home/format, durable phase progression,
 * rollback-vs-roll-forward dispatch at the kind's commit point, engine safety
 * fences, cleanup sweeping, and cross-namespace journal listing.
 *
 * Domain kinds (proposal accept/revert/reject, consolidate) get their
 * semantics pinned by their own suites + the frozen outcome oracles; this
 * suite exercises the ENGINE with synthetic kinds only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  advanceTxn,
  beginTxn,
  cleanupTxn,
  isCommittedPhase,
  type JournaledFileChange,
  listTxnJournals,
  recoverTxnsForRoot,
  registerTxnKind,
  TXN_SWEEP_GRACE_MS,
  type Txn,
  type TxnJournal,
  txnNamespaceDir,
} from "../../src/core/fs-txn";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshRoot(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

/** Register a synthetic 4-phase kind recording rollback/finalize calls. */
function registerRecordingKind(kind: string, calls: string[]): void {
  registerTxnKind<{ label: string }>(kind, {
    phases: ["prepared", "files-published", "state-persisted", "committed"],
    commitPhase: "files-published",
    rollback(txn) {
      calls.push(`rollback:${txn.journal.payload.label}`);
    },
    finalize(txn) {
      calls.push(`finalize:${txn.journal.payload.label}@${txn.journal.phase}`);
      if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
      if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
    },
  });
}

function change(root: string, rel: string): JournaledFileChange {
  return { path: path.join(root, rel), op: "update", beforeHash: "b".repeat(64), afterHash: "a".repeat(64) };
}

describe("fs-txn engine core", () => {
  test("beginTxn writes the journal at the initial phase under the one home", () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-begin", calls);
    const txn = beginTxn({
      kind: "test-kind-begin",
      root,
      changes: [change(root, "lessons/a.md")],
      payload: { label: "t1" },
    });

    expect(txn.dir.startsWith(txnNamespaceDir(root))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<{ label: string }>;
    expect(onDisk.kind).toBe("test-kind-begin");
    expect(onDisk.phase).toBe("prepared");
    expect(onDisk.root).toBe(path.resolve(root));
    expect(onDisk.payload.label).toBe("t1");
    expect(onDisk.changes).toHaveLength(1);
    cleanupTxn(txn.dir);
  });

  test("advanceTxn durably records phases and refuses unknown phases", () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-advance", []);
    const txn = beginTxn({ kind: "test-kind-advance", root, changes: [], payload: { label: "t2" } });

    advanceTxn(txn, "files-published");
    expect(txn.journal.phase).toBe("files-published");
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<unknown>;
    expect(onDisk.phase).toBe("files-published");
    // No leftover .tmp — the write is rename-committed.
    expect(fs.existsSync(`${txn.journalPath}.tmp`)).toBe(false);

    expect(() => advanceTxn(txn, "not-a-phase")).toThrow(/Unknown phase/);
    cleanupTxn(txn.dir);
  });

  test("recovery rolls BACK journals before the commit point and FORWARD from it", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-recover", calls);

    const rollbackMe = beginTxn({ kind: "test-kind-recover", root, changes: [], payload: { label: "rb" } });
    void rollbackMe; // stays at "prepared" — before the commit point

    const forwardMe = beginTxn({ kind: "test-kind-recover", root, changes: [], payload: { label: "fw" } });
    advanceTxn(forwardMe, "files-published");

    const doneAlready = beginTxn({ kind: "test-kind-recover", root, changes: [], payload: { label: "done" } });
    advanceTxn(doneAlready, "committed");

    const recovered = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(3);
    expect(calls.sort()).toEqual(["finalize:fw@files-published", "rollback:rb"]);
    // Every transaction dir is swept after recovery.
    const nsDir = txnNamespaceDir(root);
    expect(fs.existsSync(nsDir)).toBe(false);
  });

  test("isCommittedPhase respects the kind's commit point", () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-commitpoint", []);
    const txn = beginTxn({ kind: "test-kind-commitpoint", root, changes: [], payload: { label: "cp" } });
    expect(isCommittedPhase(txn.journal)).toBe(false);
    advanceTxn(txn, "files-published");
    expect(isCommittedPhase(txn.journal)).toBe(true);
    cleanupTxn(txn.dir);
  });

  test("recovery refuses journals whose changes escape the root", async () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-fence", []);
    const txn = beginTxn({
      kind: "test-kind-fence",
      root,
      changes: [{ path: "/etc/passwd", op: "update", beforeHash: null, afterHash: null }],
      payload: { label: "evil" },
    });
    void txn;
    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/outside its root/);
  });

  test("recovery refuses journals bound to a different root", async () => {
    const root = freshRoot();
    const other = freshRoot();
    registerRecordingKind("test-kind-foreign", []);
    const txn = beginTxn({ kind: "test-kind-foreign", root: other, changes: [], payload: { label: "x" } });
    // Copy the foreign journal into root's namespace to simulate corruption.
    const dir = path.join(txnNamespaceDir(root), txn.journal.transactionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(txn.journalPath, path.join(dir, "journal.json"));
    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/different root/);
    cleanupTxn(txn.dir);
    cleanupTxn(dir);
  });

  // ── unknown-kind sweep (0.9.0: `akm mv` and its `kind:"mv"` handler are
  //    gone; an rc-era leftover journal must never brick a recovery scan) ──

  /**
   * Fabricate a journal for a kind that has NO registered handler, in `root`'s
   * namespace. `ageMs` backdates the transaction dir so the caller can place it
   * either side of TXN_SWEEP_GRACE_MS.
   */
  function fabricateUnknownKindTxnDir(root: string, kind: string, ageMs: number): string {
    const dir = path.join(txnNamespaceDir(root), `unknown-${kind}`);
    fs.mkdirSync(dir, { recursive: true });
    const journal: TxnJournal<{ label: string }> = {
      version: 1,
      kind,
      phase: "some-retired-phase",
      transactionId: path.basename(dir),
      root: path.resolve(root),
      changes: [],
      decidedAt: new Date().toISOString(),
      payload: { label: "rc-era-leftover" },
    };
    fs.writeFileSync(path.join(dir, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, stamp, stamp);
    return dir;
  }

  test("a stale journal of an UNREGISTERED kind is swept, not thrown on", async () => {
    const root = freshRoot();
    const dir = fabricateUnknownKindTxnDir(root, "mv", TXN_SWEEP_GRACE_MS + 60_000);

    const recovered = await recoverTxnsForRoot(root);
    // Nothing was recovered (no handler could roll it back or forward) …
    expect(recovered).toHaveLength(0);
    // … and the unrecoverable directory is gone rather than fencing the scan.
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("an unregistered-kind journal does not block recovery of a KNOWN-kind sibling", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-sweep-sibling", calls);
    const known = beginTxn({ kind: "test-kind-sweep-sibling", root, changes: [], payload: { label: "live" } });
    advanceTxn(known, "files-published");
    const stale = fabricateUnknownKindTxnDir(root, "mv", TXN_SWEEP_GRACE_MS + 60_000);

    const recovered = await recoverTxnsForRoot(root);
    expect(recovered.map((j) => j.kind)).toEqual(["test-kind-sweep-sibling"]);
    expect(calls).toEqual(["finalize:live@files-published"]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(known.dir)).toBe(false);
  });

  test("a FRESH unregistered-kind journal inside the grace window is left alone", async () => {
    const root = freshRoot();
    // A live kind whose registrar this process simply has not imported yet
    // looks identical to a retired one; the grace period is what tells them
    // apart, so a just-written journal must survive the scan untouched.
    const dir = fabricateUnknownKindTxnDir(root, "not-yet-imported-kind", 0);

    const recovered = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "journal.json"))).toBe(true);
    cleanupTxn(dir);
  });

  test("the unknown-kind sweep runs even when a filter excludes the journal", async () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-sweep-filtered", []);
    const dir = fabricateUnknownKindTxnDir(root, "mv", TXN_SWEEP_GRACE_MS + 60_000);

    // A narrowly-filtered caller (the shape every pre-0.9.0 mv hook used) must
    // still clear garbage no handler can ever recover.
    const recovered = await recoverTxnsForRoot(root, (j) => j.kind === "test-kind-sweep-filtered");
    expect(recovered).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("directories without a journal are swept; kind-filtered listing works", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-list", calls);
    const txn = beginTxn({ kind: "test-kind-list", root, changes: [], payload: { label: "l1" } });
    void txn;
    // A junk dir with no journal.json — backdated past the sweep grace
    // window (fresh journal-less dirs are a sibling beginTxn window and are
    // deliberately NOT swept).
    const junkDir = path.join(txnNamespaceDir(root), "junk-no-journal");
    fs.mkdirSync(junkDir, { recursive: true });
    const past = new Date(Date.now() - 600_000);
    fs.utimesSync(junkDir, past, past);

    const listed = listTxnJournals((j) => j.kind === "test-kind-list");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.payload).toEqual({ label: "l1" });

    // filter narrows recovery: nothing matches → nothing rolled back/swept.
    const none = await recoverTxnsForRoot(root, (j) => j.kind === "something-else");
    expect(none).toHaveLength(0);
    expect(fs.existsSync(txn.journalPath)).toBe(true);

    const all = await recoverTxnsForRoot(root);
    expect(all).toHaveLength(1);
    expect(calls).toEqual(["rollback:l1"]);
    expect(fs.existsSync(path.join(txnNamespaceDir(root), "junk-no-journal"))).toBe(false);
  });

  test("a finalize crash leaves the journal at its recorded phase for re-entry", async () => {
    const root = freshRoot();
    let crashOnce = true;
    const calls: string[] = [];
    registerTxnKind<{ label: string }>("test-kind-crashy", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        calls.push("rollback");
      },
      finalize(txn: Txn<{ label: string }>) {
        if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
        if (crashOnce) {
          crashOnce = false;
          throw new Error("simulated crash between steps");
        }
        if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
      },
    });
    const txn = beginTxn({ kind: "test-kind-crashy", root, changes: [], payload: { label: "c" } });
    advanceTxn(txn, "files-published");

    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/simulated crash/);
    // Journal survived at the phase the crash interrupted.
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<unknown>;
    expect(onDisk.phase).toBe("state-persisted");

    const second = await recoverTxnsForRoot(root);
    expect(second).toHaveLength(1);
    expect(fs.existsSync(txn.journalPath)).toBe(false);
    expect(calls).toEqual([]);
  });
});
