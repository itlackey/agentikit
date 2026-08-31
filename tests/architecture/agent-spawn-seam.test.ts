/**
 * Architecture seam test — `runAgent` is the single agent CLI entry point.
 *
 * Locks v1 spec §9.7 (LLM/agent boundary) and §12 (agent CLI integration).
 * Issue #222.
 *
 * The test exercises the documented `runAgent` interface without
 * spawning a real binary. Every agent-CLI integration in akm passes
 * through this seam; if the shape changes, callers break.
 *
 * Specifically locked:
 *   • `runAgent` is exported from `src/integrations/agent/spawn.ts`
 *     and re-exported from `src/integrations/agent/index.ts`.
 *   • `AgentRunResult` carries the documented envelope.
 *   • `AgentFailureReason` is the discriminated union
 *     `"timeout" | "spawn_failed" | "non_zero_exit" | "parse_error"`.
 *   • Captured stdio captures stdout/stderr; interactive stdio inherits
 *     the parent's streams (no captured strings).
 *   • A per-call `timeoutMs` override forces a `timeout` reason.
 */
import { describe, expect, test } from "bun:test";
import type { SpawnedSubprocess, SpawnFn } from "../../src/core/subprocess";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentFailureReason } from "../../src/integrations/agent/spawn";
import { runAgent } from "../../src/integrations/agent/spawn";

const KNOWN_FAILURE_REASONS: ReadonlySet<AgentFailureReason> = new Set([
  "timeout",
  "spawn_failed",
  "non_zero_exit",
  "parse_error",
]);

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "seam-test-agent",
    bin: "seam-test-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeSpawn(stdout: string, stderr: string, exitCode: number): { spawn: SpawnFn; calls: number } {
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(stderr),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
  return {
    spawn,
    get calls() {
      return calls;
    },
  };
}

function makeFakeTimerFns() {
  type TimerHandle = {
    id: number;
    cb: () => void;
    cleared: boolean;
    unrefCalled: boolean;
    unref?: () => void;
  };
  const timers: TimerHandle[] = [];
  let nextId = 1;
  const setTimeoutFn = ((cb: () => void): TimerHandle => {
    const handle: TimerHandle = {
      id: nextId++,
      cb,
      cleared: false,
      unrefCalled: false,
      unref() {
        handle.unrefCalled = true;
      },
    };
    timers.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((handle: TimerHandle): void => {
    const timer = timers.find((t) => t === handle);
    if (timer) timer.cleared = true;
  }) as unknown as typeof clearTimeout;
  return { timers, setTimeoutFn, clearTimeoutFn };
}

describe("`runAgent` seam (v1 spec §9.7, §12.2)", () => {
  test("`runAgent` is exported from the low-level spawn module", () => {
    expect(typeof runAgent).toBe("function");
  });

  // REMOVED (DUP-03, 0.9.8 stabilization): "captured-stdio success returns
  // `ok: true` with stdout/stderr strings" duplicated
  // tests/agent/agent-spawn.test.ts:103 ("returns ok:true with stdout/stderr
  // on exit 0") — same captured-stdio success path, same assertions. That
  // suite still covers it.

  test("interactive-stdio mode does not capture stdout/stderr into the result", async () => {
    // Build a spawn that records the stdio options it was given. The
    // contract: when stdio is "interactive", stdout/stderr default to
    // "inherit", which the wrapper must not try to read from.
    let observed: { stdin?: string; stdout?: string; stderr?: string } | undefined;
    const spawn: SpawnFn = (_cmd, options) => {
      observed = {
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      };
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: null,
        stderr: null,
        stdin: null,
        kill: () => undefined,
      };
    };
    const result = await runAgent(makeProfile({ stdio: "interactive" }), "hi", { spawn });
    expect(observed?.stdout).toBe("inherit");
    expect(observed?.stderr).toBe("inherit");
    expect(observed?.stdin).toBe("inherit");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  // REMOVED (DUP-03, 0.9.8 stabilization): "failure-reason discriminated
  // union covers exactly the documented vocabulary" duplicated the
  // spawn_failed / non_zero_exit / parse_error cases already exercised by
  // tests/agent/agent-spawn.test.ts:123, :113, :220. The type-level pin
  // (that AgentFailureReason is exactly this 4-member union) is still
  // covered below by "`AgentFailureReason` union from the barrel matches
  // the documented vocabulary".

  // REMOVED (DUP-03, 0.9.8 stabilization): "timeout override produces
  // `reason: 'timeout'` deterministically" duplicated
  // tests/agent/agent-spawn.test.ts:166 ("kills the subprocess and reports
  // `timeout`") — same fake-timer-driven timeout path, same assertions.
  // That suite still covers it; this suite's remaining timer tests below
  // cover the seam's unique value (that captured/non-zero-exit paths also
  // clear their internal timers, not just the timeout path).

  test("captured-mode success clears internal timers instead of leaving them live", async () => {
    const fake = fakeSpawn("agent-output", "agent-stderr", 0);
    const { timers, setTimeoutFn, clearTimeoutFn } = makeFakeTimerFns();
    const result = await runAgent(makeProfile(), "hello", {
      spawn: fake.spawn,
      timeoutMs: 10,
      setTimeoutFn,
      clearTimeoutFn,
    });
    expect(result.ok).toBe(true);
    expect(timers.length).toBe(3);
    expect(timers.every((t) => t.cleared)).toBe(true);
  });

  test("captured-mode non-zero exit also clears internal timers", async () => {
    const fake = fakeSpawn("", "oops", 7);
    const { timers, setTimeoutFn, clearTimeoutFn } = makeFakeTimerFns();
    const result = await runAgent(makeProfile(), undefined, {
      spawn: fake.spawn,
      timeoutMs: 10,
      setTimeoutFn,
      clearTimeoutFn,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_zero_exit");
    expect(timers.length).toBe(3);
    expect(timers.every((t) => t.cleared)).toBe(true);
  });

  test("`AgentFailureReason` union from the barrel matches the documented vocabulary", () => {
    // Compile-time + runtime: assigning each known reason string to the
    // exported type pins the union shape. If the union narrows or
    // widens, this block fails to compile (the runtime arm just
    // mirrors the same set so the test reads end-to-end).
    const reasons: AgentFailureReason[] = ["timeout", "spawn_failed", "non_zero_exit", "parse_error"];
    expect(new Set(reasons)).toEqual(KNOWN_FAILURE_REASONS as Set<AgentFailureReason>);
  });
});
