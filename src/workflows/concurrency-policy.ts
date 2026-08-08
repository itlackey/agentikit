// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isIP } from "node:net";
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

// ── Loopback classification ──────────────────────────────────────────────────
//
// Everything above turns on ONE question: does this endpoint name a model
// server running on THIS machine? A host is loopback when it is `localhost` or
// a `*.localhost` name (RFC 6761 §6.3), anywhere in `127.0.0.0/8`, an
// unspecified address (`0.0.0.0` / `::` — a client connecting there reaches
// local loopback), IPv6 `::1`, or the dotted IPv4-mapped spelling of a
// `127.0.0.0/8` address (`::ffff:127.0.0.1`). Address shapes are validated by
// `node:net`'s `isIP`, so a near-miss NAME like `127.0.0.1.evil.com` is remote.
//
// The check is purely syntactic — no DNS, no interface list — so freeze
// produces the same plan on a laptop, on CI, and on a machine with no network.
// Ambiguity resolves toward LOOPBACK: misclassifying a local server as remote
// freezes width 4 and causes the hard failure this policy exists to prevent
// (one loaded model, reload thrash, HTTP 500); the reverse only costs
// throughput. The remedy in either direction is one line of config:
// `engines.<name>.concurrency`.

/**
 * The IPv4-mapped IPv6 spellings of `127.0.0.0/8`: the dotted form, whose
 * capture is validated by `isIP`, and the hex form `::ffff:7fxx:xxxx`. Both are
 * needed because WHATWG `URL` re-serializes `[::ffff:127.0.0.1]` to the hex
 * form, so an endpoint written the dotted way arrives here as hex.
 */
const IPV4_MAPPED_IPV6 = /^::ffff:(?:([\d.]+)|7f[\da-f]{2}:[\da-f]{1,4})$/;
/** IPv6 groups before the last one, all of which must be zero (or elided). */
const ZERO_GROUP = /^0+$/;
/** The last IPv6 group of `::` / `::1`, in any zero-padding. */
const LOOPBACK_LAST_GROUP = /^0*[01]?$/;

/**
 * True when `host` — a URL host component, with or without IPv6 brackets —
 * names this machine WITHOUT resolving anything.
 *
 * Not recognized: the IPv4-compatible form (`::127.0.0.1`), and any NAME that
 * merely resolves to loopback.
 *
 * Exported for the boundary-case table in
 * `tests/workflows/concurrency-defaults.test.ts`, which has to reach the host
 * predicate directly: several of its cases (a bare `""`, a malformed literal
 * like `1::2::3`) cannot round-trip through a URL without changing meaning.
 */
export function isLoopbackHost(host: string): boolean {
  // Strip IPv6 brackets (`URL.hostname` keeps them) and the DNS root label. An
  // empty host (`new URL("localhost:1234")` parses as scheme `localhost:` with
  // no host) has nothing to judge, so it fails safe like an unparseable one.
  const name = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (name === "" || name === "localhost" || name.endsWith(".localhost")) return true;
  const mapped = IPV4_MAPPED_IPV6.exec(name);
  if (mapped) {
    const quad = mapped[1];
    // The hex branch already matched 127.x in the pattern; the dotted one still
    // needs `isIP` so `::ffff:127.0.0.256` stays remote.
    return quad === undefined || (isIP(quad) === 4 && quad.startsWith("127."));
  }
  const version = isIP(name);
  if (version === 4) return name.startsWith("127.") || name === "0.0.0.0";
  if (version !== 6) return false;
  const groups = name.split(":");
  const last = groups.pop() ?? "";
  return groups.every((group) => group === "" || ZERO_GROUP.test(group)) && LOOPBACK_LAST_GROUP.test(last);
}

/** True when `endpoint` points at this machine (see {@link isLoopbackHost}). */
export function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    return isLoopbackHost(new URL(endpoint).hostname);
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
