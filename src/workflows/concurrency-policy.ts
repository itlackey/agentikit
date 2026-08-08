// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import { WORKFLOW_MAX_CONCURRENCY } from "./resource-limits";

/**
 * Run-level ceiling on `workflow.maxConcurrency`. It is deliberately the SAME
 * value the frozen-plan decoder enforces on `execution.maxConcurrency` and on
 * per-step `map.concurrency` — a clamp above the decoder's bound would freeze
 * plans the decoder then rejects — so it reads the single shared constant
 * (`./resource-limits`) rather than repeating the literal.
 */
export const WORKFLOW_MAX_CONCURRENCY_CEILING = WORKFLOW_MAX_CONCURRENCY;

export function cpuDerivedUnitConcurrency(cpuCount = os.cpus()?.length ?? 4): number {
  return Math.min(16, Math.max(1, cpuCount - 2));
}

export function clampMaxConcurrency(value: number): number {
  return Math.min(WORKFLOW_MAX_CONCURRENCY_CEILING, Math.max(1, Math.floor(value)));
}

/** Resolve and freeze the engine-wide cap once when a workflow run starts. */
export function workflowMaxConcurrency(configured?: number, cpuCount = os.cpus()?.length ?? 4): number {
  return configured === undefined ? cpuDerivedUnitConcurrency(cpuCount) : clampMaxConcurrency(configured);
}

// ── Fan-out defaults ─────────────────────────────────────────────────────────
//
// Four independent limits clamp a `map` step's real width, and the effective
// value is their minimum:
//
//   1. the step's own `map.concurrency`            (this file's default below)
//   2. the run's frozen `execution.maxConcurrency` ({@link workflowMaxConcurrency})
//   3. the selected LLM engine's frozen concurrency ({@link defaultLlmEngineConcurrency})
//   4. the CURRENT host's CPU safety cap           ({@link cpuDerivedUnitConcurrency})
//
// (1) and (3) both defaulted to 1 before 0.9.1, which made every fan-out serial
// unless the author opted in at BOTH layers — so (2) and (4), the limits that
// actually encode machine capacity, never bound anything. The defaults below
// replace those two 1s. They are deliberately modest rather than "as wide as
// the host allows": a `map` is independent by construction, but its units call
// out to rate-limited providers and RAM-hungry agent processes, so the value
// that a plan freezes should be one a laptop and a CI box can both survive.

/**
 * Default width of a `map` step that declares no `concurrency:` (0.9.1+).
 *
 * 4 is chosen over the host cap on purpose. It is a real, predictable speedup
 * (4× on any fan-out longer than four items) while staying below
 * {@link cpuDerivedUnitConcurrency} on every machine with ≥6 cores, so the
 * frozen number — not the host — is what an author reasons about, and a plan
 * frozen on a 32-core CI box behaves the same when it resumes on a laptop.
 *
 * Overridable in both directions:
 *   - per step: `map.concurrency: <n>` (an explicit `1` still means serial),
 *   - per install: `workflow.defaultMapConcurrency` — set it to `1` to restore
 *     the pre-0.9.1 serial default for every workflow at once.
 */
export const DEFAULT_MAP_CONCURRENCY = 4;

/**
 * Default `engines.<name>.concurrency` for an LLM engine on a LOOPBACK
 * endpoint. Stays at 1, matching `getDefaultLlmConcurrency`
 * (`src/indexer/indexer.ts`) and AGENTS.md's "lowest common denominator — a
 * slow local model on a single-threaded server" rule. A local model server
 * (LM Studio, Ollama) holds ONE loaded model; parallel inference triggers
 * reload thrash and HTTP 500s, which is a hard failure, not a slow one.
 */
export const DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY = 1;

/**
 * Default `engines.<name>.concurrency` for an LLM engine on a REMOTE endpoint.
 *
 * Deliberately equal to {@link DEFAULT_MAP_CONCURRENCY} so this limit does not
 * silently re-serialize a fan-out the author already asked for: the step's own
 * `concurrency:` stays the number that decides. Indexing's remote default is a
 * lower 2 because indexing fans out implicitly over the whole stash; a
 * workflow `map` is an explicit, bounded, author-declared fan-out, and four
 * concurrent completions sit far inside any hosted provider's entry tier.
 * Rate-limited installs set `engines.<name>.concurrency` to pin their own.
 */
export const DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY = 4;

/** True when `endpoint` points at this machine (loopback or `*.localhost`). */
export function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    // URL.hostname keeps IPv6 brackets ("[::1]") — strip them so the loopback
    // comparison actually matches.
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    // An unparseable endpoint is treated as local: guessing "remote" here would
    // widen the pool on exactly the configs we understand least.
    return true;
  }
}

/**
 * Concurrency to freeze for an LLM engine. An explicit
 * `engines.<name>.concurrency` always wins (clamped into the decoder's
 * `[1, 64]` range so a fat-fingered config cannot freeze an unloadable plan);
 * otherwise the endpoint decides.
 */
export function defaultLlmEngineConcurrency(endpoint: string | undefined, configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured)) return clampMaxConcurrency(configured);
  return isLoopbackEndpoint(endpoint) ? DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY : DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY;
}

/**
 * Width to freeze for a `map` step that declared no `concurrency:`. `configured`
 * is `workflow.defaultMapConcurrency`; unset means {@link DEFAULT_MAP_CONCURRENCY}.
 * An explicit `map.concurrency` never reaches this function — the caller keeps
 * "author wrote 1" distinguishable from "author wrote nothing".
 */
export function defaultMapConcurrency(configured?: number): number {
  return configured === undefined || !Number.isFinite(configured)
    ? DEFAULT_MAP_CONCURRENCY
    : clampMaxConcurrency(configured);
}
