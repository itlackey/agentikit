// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serialize `fn` behind every task previously enqueued under `key`: an
 * in-process keyed promise chain (Bun is single-threaded, so this is a
 * sufficient — and free — admission control for per-key mutual exclusion).
 *
 * `chains` is the caller's own module-state map, so independent subsystems
 * (the unit-writer's per-database write queue, the worktree module's per-repo
 * git lock) never share chains. A failed task rejects its OWN caller but
 * never wedges the chain, and a drained tail deletes its map entry so a
 * long-lived process does not retain one settled promise per key it ever
 * touched.
 */
export function serializeByKey<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve();
  const run = tail.then(() => fn());
  // Keep the chain alive regardless of individual outcomes.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  // If another task was enqueued in the meantime the map now holds ITS tail,
  // and this check leaves it alone.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

/**
 * Maps over items concurrently with a pool size limit.
 * Uses Promise.allSettled semantics — one failure does not cancel others.
 *
 * Cooperative cancellation (P0.5 seam for the workflow scheduler): when
 * `opts.signal` aborts, workers stop CLAIMING new items — in-flight `fn`
 * calls run to completion (pass the same signal into `fn`'s own work to
 * preempt those too). Unclaimed items stay `undefined` in the result,
 * indistinguishable from individual failures by design: callers already
 * treat `undefined` as "no result".
 *
 * A thrown `fn` is SWALLOWED (its slot stays `undefined`) — a caller that
 * must report failure detail, or distinguish "threw" from "never claimed",
 * catches inside `fn` and returns an explicit outcome value instead. This is
 * the OPPOSITE of {@link serializeByKey} above, whose failures reject their
 * own caller.
 */
export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 1,
  opts?: { signal?: AbortSignal },
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (opts?.signal?.aborted) return;
      const i = nextIndex++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch {
        // individual failure: leave undefined, caller checks
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
