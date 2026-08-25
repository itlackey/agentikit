// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization — task-runner provenance stamping (AKM_EVENT_SOURCE).
 *
 * Pins the CURRENT behavior of the three task-runner dispatch arms around
 * AKM_EVENT_SOURCE — the stamp that lets nested `akm` usage be attributed to
 * scheduled machine traffic rather than direct user demand — plus the
 * `resolveUsageEventSource` default table those arms feed into.
 *
 * See docs/plans/specs/p0-invariants.md rows P-05, P-06, P-07, R-07. Nothing
 * here is fixed: R-07 pins a known DEFECT (the prompt/command arm never
 * stamps at all), scheduled to flip in P1b.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ConfigError } from "../../src/core/errors";
import { resolveUsageEventSource } from "../../src/indexer/usage/usage-events";
import type { AgentRunResult } from "../../src/integrations/agent";
import { runTask } from "../../src/tasks/runner";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

type FakeRunAgent = (...args: unknown[]) => Promise<AgentRunResult>;

let storage: IsolatedAkmStorage;
let tasksDir: string;
let workflowsDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  workflowsDir = path.join(storage.stashDir, "workflows");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(workflowsDir, { recursive: true });
  // Reused verbatim from tests/integration/tasks-runner.test.ts, which already
  // proves this exact fixture compiles as a runnable workflow target.
  fs.writeFileSync(
    path.join(workflowsDir, "noop.md"),
    "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n",
    "utf8",
  );
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
    engines: { opencode: { kind: "agent", platform: "opencode" } },
    defaults: { engine: "opencode" },
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Crib of tests/integration/tasks-runner.test.ts's `shellTask` helper. */
function shellTask(command: readonly string[]): string {
  const run = command.map((value) => shellWord(value)).join(" ");
  return stringifyYaml({ version: 3, run, akm: { schedule: "@daily", enabled: true } });
}

function completedWorkflowRun(id: string, target: string, params: Record<string, unknown>) {
  return {
    run: {
      id,
      workflowRef: target,
      workflowTitle: "Noop",
      status: "completed" as const,
      params,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: "2025-01-01T00:00:00Z",
      currentStepId: null,
    },
    executed: [],
  };
}

/** Inline "script" whose only job is to echo its own AKM_EVENT_SOURCE. */
const ECHO_SOURCE_SNIPPET = "console.log('AKM_EVENT_SOURCE=' + (process.env.AKM_EVENT_SOURCE ?? '<unset>'))";

describe("P-06 — native shell/script arm sets AKM_EVENT_SOURCE only in the child env", () => {
  test("P-06 — a shell (run:) task's child observes AKM_EVENT_SOURCE=task while the parent stays unset", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("shell-provenance", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();

    const result = await runTask("shell-provenance", { stashDir: storage.stashDir, bundleName: "fixture" });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=task");
    // process.env was never mutated — before, during (proved by the child's own
    // echoed observation above), or after.
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });

  test("P-06 — a script (uses: scripts/…) task's child observes AKM_EVENT_SOURCE=task while the parent stays unset", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    fs.writeFileSync(
      path.join(storage.stashDir, "scripts", "echo-source.sh"),
      '#!/bin/sh\nprintf "AKM_EVENT_SOURCE=%s" "$AKM_EVENT_SOURCE"\n',
    );
    writeTask("script-provenance", 'version: 3\nuses: scripts/echo-source.sh\nakm:\n  schedule: "@daily"\n');

    const result = await runTask("script-provenance", { stashDir: storage.stashDir, bundleName: "fixture" });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=task");
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });

  test("P-06 — a pre-set, more-specific AKM_EVENT_SOURCE is inherited into the child untouched", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("shell-provenance-preset", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));

    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      runTask("shell-provenance-preset", { stashDir: storage.stashDir, bundleName: "fixture" }),
    );

    expect(result.status).toBe("completed");
    // `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? "task"` — an already
    // more-specific ambient value wins over the "task" default in the child.
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=improve");
  });
});

describe("P-05 — workflow arm stamps and restores global process.env.AKM_EVENT_SOURCE", () => {
  test('P-05 — an unset AKM_EVENT_SOURCE becomes "task" for the duration of an in-process workflow run, then is deleted', async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("wf-provenance", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    let observedDuring: string | undefined;

    const result = await runTask("wf-provenance", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      // Narrowest injectable seam: observe the global stamp from INSIDE the
      // run, then let production's own `finally` restore it (per the P-05
      // harness note in docs/plans/specs/p0-invariants.md — never set/leave
      // AKM_EVENT_SOURCE by hand outside a sandbox helper).
      runWorkflowStepsImpl: (async ({ target, params = {} }: { target: string; params?: Record<string, unknown> }) => {
        observedDuring = process.env.AKM_EVENT_SOURCE;
        return completedWorkflowRun("run-wf-provenance", target, params);
      }) as never,
    });

    expect(result.status).toBe("completed");
    expect(observedDuring).toBe("task");
    // Restored — and since it was unset before, restoration means fully
    // deleted, not merely set back to an empty string.
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    expect(Object.hasOwn(process.env, "AKM_EVENT_SOURCE")).toBe(false);
  });

  test("P-05 — a pre-set, more-specific AKM_EVENT_SOURCE survives the workflow arm untouched", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("wf-provenance-preset", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    let observedDuring: string | undefined;

    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      runTask("wf-provenance-preset", {
        stashDir: storage.stashDir,
        bundleName: "fixture",
        runWorkflowStepsImpl: (async ({
          target,
          params = {},
        }: {
          target: string;
          params?: Record<string, unknown>;
        }) => {
          observedDuring = process.env.AKM_EVENT_SOURCE;
          return completedWorkflowRun("run-wf-provenance-preset", target, params);
        }) as never,
      }),
    );

    expect(result.status).toBe("completed");
    expect(observedDuring).toBe("improve");
  });

  test("P-05 — restoration happens on the throwing path too", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("wf-provenance-throws", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    let observedDuring: string | undefined;

    // A ConfigError from the orchestrator is the one failure runWorkflowTask
    // re-throws (rather than swallowing into a "failed" result), so it is the
    // cleanest way to exercise the `finally` restore on an ACTUAL throw out of
    // runTask, not merely a caught-and-reported failure.
    await expect(
      runTask("wf-provenance-throws", {
        stashDir: storage.stashDir,
        bundleName: "fixture",
        runWorkflowStepsImpl: (async () => {
          // Observe the stamp BEFORE throwing — otherwise an "unset" pre-state
          // and an "unset" post-state are indistinguishable from the stamp
          // never having been applied at all (i.e. this would still pass if
          // the workflow-arm stamp were dropped from the error path).
          observedDuring = process.env.AKM_EVENT_SOURCE;
          throw new ConfigError("synthetic workflow engine failure for P-05");
        }) as never,
      }),
    ).rejects.toThrow("synthetic workflow engine failure for P-05");

    expect(observedDuring).toBe("task");
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });
});

describe("P-07 — resolveUsageEventSource's provenance default table", () => {
  test.each([
    [undefined, "user"],
    ["", "user"],
    ["user", "user"],
    ["improve", "improve"],
    ["task", "task"],
    ["audit", "audit"],
    ["unknown", "unknown"],
    ["totally-unrecognized-value", "unknown"],
  ] as const)("P-07 — AKM_EVENT_SOURCE=%p resolves to %p", (raw, expected) => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    expect(resolveUsageEventSource({ AKM_EVENT_SOURCE: raw })).toBe(expected);
  });

  test("P-07 — defaults to reading process.env when no env argument is given", () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    expect(resolveUsageEventSource()).toBe("user");
  });
});

describe("R-07 — prompt/command arm DEFECT: AKM_EVENT_SOURCE is never stamped anywhere (fixed in P1b)", () => {
  test('R-07 — a prompt-target task run never sets AKM_EVENT_SOURCE, so resolveUsageEventSource() observed from inside it returns "user"', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    writeTask(
      "prompt-provenance",
      [
        "version: 3",
        "uses: akm/command",
        "with:",
        "  content: keep this prompt short",
        "akm:",
        '  schedule: "@daily"',
        "  engine: opencode",
        "",
      ].join("\n"),
    );
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();

    let observedDuringProcessEnv: string | undefined;
    let observedResolvedSource: string | undefined;
    let observedChildEnv: Record<string, string> | undefined;

    const fakeRunAgent: FakeRunAgent = async (...args) => {
      const options = args[2] as { env?: Record<string, string> } | undefined;
      // (a) the parent's process.env, observed from INSIDE the dispatched
      // engine call — the narrowest seam available for this arm.
      observedDuringProcessEnv = process.env.AKM_EVENT_SOURCE;
      // (c) resolveUsageEventSource(), observed from the very same seam.
      observedResolvedSource = resolveUsageEventSource();
      // (b) the env bag the runner actually handed to the dispatched engine.
      observedChildEnv = options?.env;
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    };

    const result = await runTask("prompt-provenance", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      runAgentImpl: fakeRunAgent,
    });

    expect(result.status).toBe("completed");
    // (a) the parent's process.env is never touched, at any point of the run.
    expect(observedDuringProcessEnv).toBeUndefined();
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    // (b) the dispatched engine env lacks it entirely — not even present as an
    // inherited "unset" placeholder key.
    expect(observedChildEnv).toBeDefined();
    expect(Object.hasOwn(observedChildEnv ?? {}, "AKM_EVENT_SOURCE")).toBe(false);
    // (c) the row's whole reason to exist: resolveUsageEventSource(), observed
    // from inside the very same arm, defaults the absent stamp to "user" — a
    // scheduled prompt task's nested akm usage records as direct human demand.
    // fixed in P1b.
    expect(observedResolvedSource).toBe("user");
  });
});
