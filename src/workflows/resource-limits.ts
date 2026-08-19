// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EXECUTION_MAX_TIMEOUT_MS } from "../execution/limits";

export const WORKFLOW_MAX_PLAN_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_MAX_SOURCE_BYTES = 1024 * 1024;
export const WORKFLOW_MAX_STEPS = 256;
export const WORKFLOW_MAX_ENGINES = 64;
export const WORKFLOW_MAX_PARAMS = 128;
export const WORKFLOW_MAX_ROUTE_BRANCHES = 256;
export const WORKFLOW_MAX_INSTRUCTION_BYTES = 256 * 1024;
export const WORKFLOW_MAX_SCHEMA_BYTES = 256 * 1024;
export const WORKFLOW_MAX_EXTRA_PARAMS_BYTES = 64 * 1024;
export const WORKFLOW_MAX_JSON_DEPTH = 64;
export const WORKFLOW_MAX_MAP_EXPANSION = 10_000;
/** Max declared `inputs:` reference strings on one unit/map step. */
export const WORKFLOW_MAX_INPUTS = 64;

// ── Dispatch-significant bounds shared across validation layers ──────────────
//
// Defined ONCE here so the three enforcement layers cannot drift:
//   1. the parser (`../parser.ts`) — line-anchored authoring-time errors,
//   2. the published JSON Schema (`schemas/akm-workflow.json`) — mirrored
//      `maximum`/`pattern`/`maxLength` values, pinned against these constants
//      by `tests/integration/workflows/schema-drift.test.ts`,
//   3. the strict frozen-plan decoder (`./ir/schema.ts`) — the corruption
//      gate for persisted plans.
// A bound enforced only by the decoder surfaces as a terse, unlocated
// "Invalid frozen workflow plan" at `workflow run` — after lint and
// `workflow create` already said the document was fine.

/** Max per-step map fan-out concurrency (also the run-level concurrency ceiling). */
export const WORKFLOW_MAX_CONCURRENCY = 64;
/** Max evaluator-optimizer gate loops per step. */
export const WORKFLOW_MAX_GATE_LOOPS = 100;
/** Max retry attempts per unit. */
export const WORKFLOW_MAX_RETRIES = 100;
/** Max timeout in milliseconds (setTimeout's 32-bit signed ceiling: 2^31-1, ~24.8 days). */
export const WORKFLOW_MAX_TIMEOUT_MS = EXECUTION_MAX_TIMEOUT_MS;
/** Engine names: lowercase dash-separated runs of letters/digits, starting with a letter. */
export const WORKFLOW_ENGINE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const WORKFLOW_MAX_ENGINE_NAME_LENGTH = 63;

// ── exec (shell) unit bounds ─────────────────────────────────────────────────

/**
 * Max entries in an exec unit's `command:` argv array. Generous for a real
 * command line, small enough that a corrupted plan cannot ask the OS to spawn
 * a megabyte of arguments.
 */
export const WORKFLOW_MAX_EXEC_ARGV = 64;
/** Max UTF-8 bytes of ONE argv entry (well under every platform's ARG_MAX per-arg limit). */
export const WORKFLOW_MAX_EXEC_ARG_BYTES = 4096;
/** Max characters of an exec unit's relative `cwd:`. */
export const WORKFLOW_MAX_EXEC_CWD_LENGTH = 1024;
/**
 * Max entries in an exec unit's `pass_env:` list.
 *
 * `pass_env` is the "one or two more toolchain variables" escape hatch, not a
 * second way to spell `inherit_env:` — a workflow reaching for more than this
 * many names wants full inheritance and should say so where a reviewer can see
 * it.
 */
export const WORKFLOW_MAX_EXEC_PASS_ENV = 32;
/**
 * Grammar for an env var NAME in `pass_env:`. Matches the frozen-plan
 * `envPassthrough` grammar in `ir/schema.ts` so both allowlist surfaces accept
 * exactly the same identifiers.
 */
export const WORKFLOW_ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Default wall-clock timeout for an exec unit that declares no `timeout:` and
 * inherits no document `defaults.timeout`.
 *
 * 10 minutes matches `DEFAULT_LLM_TIMEOUT_MS`. Unlike an agent harness (which
 * owns its own lifetime, hence `DEFAULT_AGENT_TIMEOUT_MS === null`), a shell
 * command has NO lifetime discipline of its own: an unbounded default would let
 * a hung `npm install` or an interactive prompt wedge a workflow run forever.
 * Authors who genuinely need an unbounded command write `timeout: none`.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/**
 * Max BYTES of ONE captured pipe an exec unit RETAINS in memory (stdout and
 * stderr are retained separately).
 *
 * This is a RETENTION cap, not a permission to run. Without it the capture is
 * bounded only by the command's exit or the wall timeout, so a command that
 * writes continuously (`yes`, a verbose test loop) grows a string in the akm
 * process until the host runs out of memory — and the default budget gives it
 * ten minutes to do so. What the cap buys is a BOUND where there was none: the
 * retained prefix is promoted into the unit's outcome text and every outcome is
 * held until the step reduces, so the worst case is (units in the STEP × this
 * cap) rather than unbounded — the step's width, not the in-flight width, is
 * what sizes it, up to {@link WORKFLOW_MAX_MAP_EXPANSION}.
 *
 * On reaching the cap the reader switches to DRAIN-AND-DISCARD: it keeps
 * pulling from the pipe (so the child never blocks on backpressure) and stops
 * RETAINING. The command therefore runs to completion and its real exit code
 * stands — a passing-but-chatty test suite is no longer failed over log volume.
 * What overflow costs is honesty about the artifact, and that is paid two ways
 * in `exec/exec-unit.ts`:
 *
 *   - no declared `output:` schema → the unit succeeds and its artifact carries
 *     an unmistakable {@link WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER} block naming
 *     the total and retained byte counts, so truncated text can never be
 *     mistaken for the whole output;
 *   - a declared `output:` schema → the unit fails `exec_output_limit`, because
 *     validating a truncated JSON prefix is meaningless and promoting it would
 *     corrupt every downstream reference. That is the residual failure the cap
 *     genuinely justifies.
 *
 * 8 MiB is deliberately generous — 8× the whole-row evidence cap
 * ({@link WORKFLOW_MAX_EVIDENCE_JSON_BYTES}), so any output that could survive
 * persistence intact fits many times over, and an ordinary full test/build log
 * is nowhere near it.
 */
export const WORKFLOW_MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Marker stamped on an exec artifact that was RETAINED ONLY IN PART because the
 * command wrote past {@link WORKFLOW_MAX_EXEC_OUTPUT_BYTES}.
 *
 * Deliberately ugly and unique, exactly like `WORKFLOW_EVIDENCE_TRUNCATED_MARKER`
 * (`runtime/runs.ts`) — the same idiom for the same reason: a truncated value
 * must NEVER be mistakable for a complete one by a downstream
 * `steps.<id>.output` reference, by a gate judge, by `akm workflow status`, or
 * by a human reading the row. The artifact is TEXT here rather than a JSON
 * value, so the marker is appended as a trailing block instead of replacing the
 * value with an envelope: the retained prefix is still genuinely useful (it is
 * the head of a real log), and the block says exactly how much is missing.
 */
export const WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER = "__akm_exec_output_truncated__";

// ── exec context environment: PER-PLATFORM spawn ceilings ────────────────────
//
// The `AKM_*` context check exists to convert an INEVITABLE raw `E2BIG` /
// `CreateProcess` failure into an actionable akm error naming the variable, its
// size and the limit. It therefore tracks the ceiling of the platform the run is
// actually on: applying the smallest supported platform's ceiling everywhere
// would fail spawns Linux and macOS would have accepted — a tripwire, not a
// guard.

/** The spawn ceilings that apply to one platform's `AKM_*` context environment. */
export interface ExecContextLimits {
  /** Max UTF-8 bytes of one `AKM_*` variable. */
  readonly perVarBytes: number;
  /** Max UTF-8 bytes of all `AKM_*` variables combined. */
  readonly totalBytes: number;
  /** Human-readable citation of where the two numbers come from, for the error message. */
  readonly source: string;
}

// Per-var: Win32 `SetEnvironmentVariable` caps one variable at 32 767 UTF-16
// code units; measuring UTF-8 bytes is conservative in the right direction.
// Total: akm's own share of the `CreateProcess` `lpEnvironment` block, which it
// shares with the allowlist, the unit's `env:` bindings and the argv.
const EXEC_CONTEXT_LIMITS_WIN32: ExecContextLimits = {
  perVarBytes: 32_767,
  totalBytes: 64_000,
  source: "Windows caps one environment variable at 32 767 characters (SetEnvironmentVariable)",
};

// Per-var: 75% of Linux's `MAX_ARG_STRLEN` (32 pages = 131 072 bytes), leaving
// margin for the name, `=`, NUL and the kernel's own accounting — the guard must
// never reject a spawn the platform would have accepted.
// Total: half of macOS's 256 KiB `ARG_MAX` (the tightest supported total), so
// the other half remains for the argv, the allowlist and the `env:` bindings.
const EXEC_CONTEXT_LIMITS_POSIX: ExecContextLimits = {
  perVarBytes: 96 * 1024,
  totalBytes: 128 * 1024,
  source:
    "Linux caps one argv/environ string at MAX_ARG_STRLEN (32 pages = 131 072 bytes) and macOS caps argv+environ at ARG_MAX (256 KiB)",
};

/**
 * The `AKM_*` context ceilings for THIS platform (or an explicitly named one,
 * which is how the tests drive both branches deterministically).
 */
export function execContextLimits(platform: string = process.platform): ExecContextLimits {
  return platform === "win32" ? EXEC_CONTEXT_LIMITS_WIN32 : EXEC_CONTEXT_LIMITS_POSIX;
}

/**
 * Max characters of the per-unit human diagnostic — the `error`/stderr text
 * journaled on a failed unit row and rendered by `akm workflow status --units`.
 *
 * ONE constant for the write side (`exec/native-executor.ts`, which clips before
 * journaling) and the read side (`runtime/runs.ts`, which clips whatever a row
 * already holds), so a diagnostic can never be stored larger than the surface
 * that displays it. Long enough for a real stack trace or a compiler's error
 * block; short enough that a runaway command cannot turn the journal into its
 * log file.
 */
export const WORKFLOW_UNIT_DIAGNOSTIC_CLIP = 2_000;

/**
 * Truncate to `max` chars with an ellipsis marker.
 *
 * Lives with the bounds rather than with either caller: the write side
 * (`exec/step-work.ts`) and the read side (`runtime/runs.ts`) clip against the
 * same constants, and `runtime/runs.ts` cannot take the helper from
 * `exec/step-work.ts` — that module imports `runtime/runs.ts`.
 */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Persistence bounds ───────────────────────────────────────────────────────

/**
 * Max serialized size of one `workflow_run_steps.evidence_json` row value.
 *
 * The promoted step artifact (`evidence.output`) is deliberately NOT clipped
 * when it is built — gates judge the full artifact and downstream
 * `steps.<id>.output` references need it intact — but a `collect`
 * reducer over a fan-out bounded only by {@link WORKFLOW_MAX_MAP_EXPANSION}
 * (10 000 units, each contributing up to a full unit result) would otherwise
 * write an unbounded blob into a single SQLite row. Persistence is therefore
 * bounded here, at the write boundary, by
 * `clipStepEvidenceForPersistence` (`runtime/runs.ts`), which replaces
 * oversized values with an explicitly-marked truncation envelope rather than
 * silently shortening them.
 *
 * 1 MiB is deliberately generous: it is 4× the per-instruction cap and half the
 * whole-plan cap, so no realistic authored workflow reaches it, while a runaway
 * fan-out is still bounded to something SQLite and `akm workflow status` can
 * handle.
 */
export const WORKFLOW_MAX_EVIDENCE_JSON_BYTES = 1024 * 1024;

/** Chars of the original value retained (as a marked preview) in a truncation envelope. */
export const WORKFLOW_EVIDENCE_TRUNCATION_PREVIEW_CHARS = 1000;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}
