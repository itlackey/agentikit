// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import {
  createLockPayload,
  type LockOwnership,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../core/file-lock";
import { tryAcquireMaintenanceBarrier } from "../core/maintenance-barrier";
import { getDbPath, getIndexWriterLockPath } from "../core/paths";

const INDEX_WRITER_LOCK_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const INDEX_WRITER_WAIT_MS = 100;
const DEFAULT_INDEX_WRITER_MAX_WAIT_MS = 10 * 60 * 1000;

const leaseContext = new AsyncLocalStorage<Set<string>>();

export interface IndexWriterLease {
  lockPath: string;
  release: () => void;
}

interface AcquireIndexWriterLeaseOptions {
  mode?: "wait" | "try";
  purpose: string;
  signal?: AbortSignal;
  maxWaitMs?: number;
  onWait?: (info: { waitedMs: number }) => void;
  onAcquired?: (info: { waitedMs: number }) => void;
}

function buildPayload(purpose: string): string {
  return createLockPayload({
    purpose,
    dbPath: getDbPath(),
    startedAt: new Date().toISOString(),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("index writer wait aborted");
}

function createLease(lockPath: string, ownership: LockOwnership): IndexWriterLease {
  const exitHandler = () => releaseLock(ownership);
  process.on("exit", exitHandler);
  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      process.off("exit", exitHandler);
      releaseLock(ownership);
    },
  };
}

function tryAcquireIndexWriterLease(lockPath: string, purpose: string): IndexWriterLease | undefined {
  while (true) {
    const releaseBarrier = tryAcquireMaintenanceBarrier();
    if (!releaseBarrier) return undefined;
    try {
      const ownership = tryAcquireLockSync(lockPath, buildPayload(purpose));
      if (ownership) return createLease(lockPath, ownership);

      const probe = probeLock(lockPath, { staleAfterMs: INDEX_WRITER_LOCK_STALE_AFTER_MS });
      if (probe.state !== "stale" || !reclaimStaleLock(lockPath, probe)) return undefined;
    } finally {
      releaseBarrier();
    }
  }
}

export async function acquireIndexWriterLease(
  options: AcquireIndexWriterLeaseOptions,
): Promise<IndexWriterLease | undefined> {
  const mode = options.mode ?? "wait";
  const lockPath = getIndexWriterLockPath();
  const startedAt = Date.now();
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_INDEX_WRITER_MAX_WAIT_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let lastWaitNoticeMs = 0;

  while (true) {
    throwIfAborted(options.signal);

    const lease = tryAcquireIndexWriterLease(lockPath, options.purpose);
    if (lease) {
      options.onAcquired?.({ waitedMs: Date.now() - startedAt });
      return lease;
    }
    if (mode === "try") return undefined;

    // Held by another live process. Time out only *after* a real acquisition
    // attempt, so a caller with maxWaitMs:0 still gets one chance at a free lock
    // instead of throwing before it ever tries.
    if (maxWaitMs >= 0 && Date.now() - startedAt >= maxWaitMs) {
      throw new Error(`timed out waiting for index writer lease for ${options.purpose}`);
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs - lastWaitNoticeMs >= 15000) {
      options.onWait?.({ waitedMs });
      lastWaitNoticeMs = waitedMs;
    }
    await delay(INDEX_WRITER_WAIT_MS);
  }
}

export async function withIndexWriterLease<T>(
  options: AcquireIndexWriterLeaseOptions,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = getIndexWriterLockPath();
  const inherited = leaseContext.getStore();
  if (inherited?.has(lockPath)) return run();

  const context = inherited ?? new Set<string>();
  const execute = async (): Promise<T> => {
    const lease = await acquireIndexWriterLease(options);
    if (!lease) throw new Error(`index writer lease unavailable for ${options.purpose}`);
    context.add(lockPath);
    try {
      return await run();
    } finally {
      context.delete(lockPath);
      lease.release();
    }
  };
  return inherited ? execute() : leaseContext.run(context, execute);
}

/** Asset writes and index rebuilds share one lease so scans cannot publish stale snapshots. */
export function withAssetMutationLease<T>(purpose: string, run: () => Promise<T>): Promise<T> {
  return withIndexWriterLease({ purpose }, run);
}

/** Synchronous asset-write boundary over the same interprocess lease. */
export function withAssetMutationLeaseSync<T>(purpose: string, run: () => T): T {
  const lockPath = getIndexWriterLockPath();
  const inherited = leaseContext.getStore();
  if (inherited?.has(lockPath)) return run();

  const context = inherited ?? new Set<string>();
  const execute = (): T => {
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lease: IndexWriterLease | undefined;
    while (!lease) {
      lease = tryAcquireIndexWriterLease(lockPath, purpose);
      if (!lease) {
        if (Date.now() - startedAt >= DEFAULT_INDEX_WRITER_MAX_WAIT_MS) {
          throw new Error(`timed out waiting for index writer lease for ${purpose}`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INDEX_WRITER_WAIT_MS);
      }
    }
    context.add(lockPath);
    try {
      return run();
    } finally {
      context.delete(lockPath);
      lease.release();
    }
  };
  return inherited ? execute() : leaseContext.run(context, execute);
}

export function probeIndexWriterLease() {
  return probeLock(getIndexWriterLockPath(), { staleAfterMs: INDEX_WRITER_LOCK_STALE_AFTER_MS });
}
