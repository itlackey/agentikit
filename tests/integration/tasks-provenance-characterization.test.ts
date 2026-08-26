// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization — task-runner provenance stamping (AKM_EVENT_SOURCE) —
 * AMENDED IN P1b (F-1) per docs/plans/specs/p1b-model-extraction.md §5.2/§6.
 *
 * Pins the behavior of the three task-runner dispatch arms around
 * AKM_EVENT_SOURCE — the stamp that lets nested `akm` usage be attributed to
 * scheduled machine traffic rather than direct user demand — plus the
 * `resolveUsageEventSource` default table those arms feed into.
 *
 * See docs/plans/specs/p0-invariants.md rows P-05, P-06, P-07, R-07, and
 * p1b-model-extraction.md §1.2 (D5), §5.2 (F-1 implementation), and §6 (the
 * AUTHORIZED-FLIPS table). P-06 and the base P-07 table are UNCHANGED —
 * still load-bearing after P1b. P-05 is RECLASSIFIED (D5 always scheduled the
 * global process.env stamp for replacement; the mechanism flips, the
 * preserved CONTRACT — in-process execution and usage recording still
 * observe "task", no cross-run leakage, child-env stamping (P-06) unchanged,
 * pre-set ambient values still win — does not). R-07 FLIPS to the fixed
 * behavior: a prompt/command task run now stamps AKM_EVENT_SOURCE into the
 * dispatched engine's child env and records nested usage as "task".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ConfigError } from "../../src/core/errors";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveUsageEventSource, type UsageEventSource } from "../../src/indexer/usage/usage-events";
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

/**
 * The recorded `usage_events` rows, narrowed to the columns R-07's flip
 * cares about. Used to assert nested usage is attributed through the
 * EXPLICIT dispatch-option path (§5.2 point 3) rather than a bare
 * `resolveUsageEventSource()` read of an (unmutated) ambient env.
 */
function queryUsageEventRows(): Array<{ event_type: string; entry_ref: string | null; source: string }> {
  const db = openStateDatabase();
  try {
    return db.prepare("SELECT event_type, entry_ref, source FROM usage_events ORDER BY id").all() as Array<{
      event_type: string;
      entry_ref: string | null;
      source: string;
    }>;
  } finally {
    db.close();
  }
}

describe("P-06 — native shell/script arm sets AKM_EVENT_SOURCE only in the child env", () => {
  test("P-06 — a shell (run:) task's child observes AKM_EVENT_SOURCE=task while the parent stays unset", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("shell-provenance", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();

    const result = await runTask("shell-provenance", { bundleDir: storage.stashDir, bundleName: "fixture" });

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

    const result = await runTask("script-provenance", { bundleDir: storage.stashDir, bundleName: "fixture" });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=task");
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });

  test("P-06 — a pre-set, more-specific AKM_EVENT_SOURCE is inherited into the child untouched", async () => {
    // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
    writeTask("shell-provenance-preset", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));

    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      runTask("shell-provenance-preset", { bundleDir: storage.stashDir, bundleName: "fixture" }),
    );

    expect(result.status).toBe("completed");
    // `AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? "task"` — an already
    // more-specific ambient value wins over the "task" default in the child.
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=improve");
  });
});

describe("P-05 (RECLASSIFIED — F-1) — workflow arm never mutates global process.env.AKM_EVENT_SOURCE; eventSource threads explicitly", () => {
  // FLIP (F-1, spec docs/plans/specs/p1b-model-extraction.md §6, row
  // "tests/integration/tasks-provenance-characterization.test.ts:138 | P-05 |
  // FLIP (mechanism reclassified). New assertions: process.env.AKM_EVENT_SOURCE
  // is undefined before, during (observed from inside the injected
  // runWorkflowStepsImpl), and after; the in-process run observes event source
  // "task" through the explicit path; an exec-unit child of the run still
  // observes AKM_EVENT_SOURCE=task.": D5 deletes the global process.env stamp
  // and its `finally` restore (runner.ts:534-535,:552-555) outright. The
  // workflow arm now passes the resolved event source into runWorkflowSteps
  // via a new optional `eventSource` option instead — this test observes that
  // option from inside the injected runWorkflowStepsImpl, the narrowest seam
  // available at the task-runner boundary this file pins. Whether an
  // exec-unit child of a REAL (non-injected) run still observes
  // AKM_EVENT_SOURCE=task from that option is exercised at the workflow-exec
  // layer (run-workflow.ts / step-work.ts / exec-unit.ts), not re-proven here.
  test('P-05 — process.env.AKM_EVENT_SOURCE is never written for an in-process workflow run; the run observes "task" through the explicit eventSource option', async () => {
    writeTask("wf-provenance", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    let observedDuring: string | undefined;
    let observedEventSourceOption: string | undefined;

    const result = await runTask("wf-provenance", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      runWorkflowStepsImpl: (async (options: {
        target: string;
        params?: Record<string, unknown>;
        eventSource?: string;
      }) => {
        observedDuring = process.env.AKM_EVENT_SOURCE;
        observedEventSourceOption = options.eventSource;
        return completedWorkflowRun("run-wf-provenance", options.target, options.params ?? {});
      }) as never,
    });

    expect(result.status).toBe("completed");
    // The explicit path carries the resolved source — no global stamp needed.
    expect(observedEventSourceOption).toBe("task");
    // Never mutated — before, during, or after.
    expect(observedDuring).toBeUndefined();
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    expect(Object.hasOwn(process.env, "AKM_EVENT_SOURCE")).toBe(false);
  });

  // FLIP (F-1, spec §6, row "…:165 P-05 — a pre-set, more-specific
  // AKM_EVENT_SOURCE survives … untouched | P-05 | PRESERVED contract,
  // strengthened assertion: ambient improve still observed in-process and in
  // children; additionally assert process.env was never written (no set, no
  // delete).": the precedence rule (D5 clause d / spec §5.2) is preserved —
  // an explicit provenance value is only a FALLBACK, so a recognized ambient
  // value still wins over the default "task" in the explicit option too.
  test("P-05 — a pre-set, more-specific AKM_EVENT_SOURCE still wins over the workflow arm's default, in-process and in the explicit option", async () => {
    writeTask("wf-provenance-preset", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    let observedDuring: string | undefined;
    let observedEventSourceOption: string | undefined;

    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      runTask("wf-provenance-preset", {
        bundleDir: storage.stashDir,
        bundleName: "fixture",
        runWorkflowStepsImpl: (async (options: {
          target: string;
          params?: Record<string, unknown>;
          eventSource?: string;
        }) => {
          observedDuring = process.env.AKM_EVENT_SOURCE;
          observedEventSourceOption = options.eventSource;
          return completedWorkflowRun("run-wf-provenance-preset", options.target, options.params ?? {});
        }) as never,
      }),
    );

    expect(result.status).toBe("completed");
    // Ambient wins over the "task" default — in-process observation …
    expect(observedDuring).toBe("improve");
    // … and in the explicit option threaded to runWorkflowSteps.
    expect(observedEventSourceOption).toBe("improve");
  });

  // FLIP (F-1, spec §6, row "…:191 P-05 — restoration happens on the
  // throwing path too | P-05 | FLIP (reclassified). There is nothing to
  // restore: assert the throwing path leaves process.env.AKM_EVENT_SOURCE
  // untouched — never set, never deleted — and that the thrown failure still
  // surfaces unchanged.": the re-throw of a ConfigError out of runWorkflowTask
  // (runner.ts's `if (e instanceof AkmError && e.kind === "config") throw e;`)
  // is unrelated production logic and stays unchanged — only the removed
  // env-restore side of the `finally` block is asserted differently.
  test("P-05 — process.env.AKM_EVENT_SOURCE stays untouched on the throwing path too, and the thrown failure still surfaces unchanged", async () => {
    writeTask("wf-provenance-throws", 'version: 3\nuses: workflows/noop\nakm:\n  schedule: "@daily"\n');
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    let observedDuring: string | undefined;
    let observedEventSourceOption: string | undefined;

    // A ConfigError from the orchestrator is the one failure runWorkflowTask
    // re-throws (rather than swallowing into a "failed" result), so it is the
    // cleanest way to exercise the `finally` block on an ACTUAL throw out of
    // runTask, not merely a caught-and-reported failure.
    await expect(
      runTask("wf-provenance-throws", {
        bundleDir: storage.stashDir,
        bundleName: "fixture",
        runWorkflowStepsImpl: (async (options: { eventSource?: string }) => {
          // Observe BEFORE throwing — otherwise an "unset" pre-state and an
          // "unset" post-state are indistinguishable from the option never
          // having been threaded at all (i.e. this would still pass if F-1's
          // explicit-path threading were dropped from the error branch).
          observedDuring = process.env.AKM_EVENT_SOURCE;
          observedEventSourceOption = options.eventSource;
          throw new ConfigError("synthetic workflow engine failure for P-05");
        }) as never,
      }),
    ).rejects.toThrow("synthetic workflow engine failure for P-05");

    // The explicit path still carried "task" right up to the throw …
    expect(observedEventSourceOption).toBe("task");
    // … and there was nothing to restore: process.env was never set.
    expect(observedDuring).toBeUndefined();
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });
});

describe("P-05 real-orchestrator coverage — an exec-unit child of a workflow-task run driven by the REAL runWorkflowSteps", () => {
  // Test-review finding: every P-05 assertion above observes an INJECTED
  // runWorkflowStepsImpl — strictly ABOVE the real orchestrator — and the
  // comment on the describe block above explicitly defers proving that an
  // exec-unit child of a REAL (non-injected) run still observes
  // AKM_EVENT_SOURCE=task to "the workflow-exec layer (run-workflow.ts /
  // step-work.ts / exec-unit.ts)". No such test existed anywhere in the
  // suite (only nine files mention AKM_EVENT_SOURCE at all, and
  // tests/integration/workflows/exec-unit.test.ts — the file that DOES drive
  // real exec units — mentions neither AKM_EVENT_SOURCE nor eventSource), so
  // it is pinned here directly instead of deferred again. This is exactly
  // the regression P-05 exists to catch (spec §5.2(2): "silently dropping
  // the child stamp is an unauthorized behavior change").
  //
  // No `runWorkflowStepsImpl` is passed to runTask() below, so runner.ts's
  // default (`options.runWorkflowStepsImpl ?? runWorkflowSteps`) drives the
  // REAL production runWorkflowSteps -> scheduler -> native executor ->
  // exec-unit chain. The workflow's one step is `uses: scripts/<ref>`
  // (native dispatch: directScript() -> runExecUnit()), which needs no LLM
  // engine at all — the spawned child is a genuine subprocess whose only job
  // is writing its own observed AKM_EVENT_SOURCE to a marker file. The
  // marker lives at an absolute path under storage.root (OUTSIDE stashDir,
  // so indexing never touches it), which sidesteps needing to know the shape
  // of a workflow unit's persisted result/evidence just to read its output.
  //
  // TODAY (pre-P1b) this already passes: runner.ts:534-535's global stamp
  // plus the pre-existing AKM_EVENT_SOURCE entry on
  // EXEC_DEFAULT_ENV_PASSTHROUGH/COMMON_SPAWN_ENV_PASSTHROUGH
  // (core/spawn-env.ts, exec-unit.ts:129-142) already produce it end to end
  // — this is characterization of CURRENT behavior, not a flip. The point of
  // pinning it is what P1b must reproduce: once F-1 deletes the global
  // mutation, the new explicit eventSource thread (spec §5.2 point 2:
  // run-workflow.ts -> step-work.ts -> exec-unit.ts childEnv) must keep this
  // test green, or the escape hatch of §5.2(2) must be taken and recorded in
  // the Review log instead of silently shipping the drop.
  function markerPath(root: string): string {
    return path.join(root, "event-source-marker.txt");
  }

  function writeEchoSourceWorkflow(root: string, marker: string): void {
    fs.writeFileSync(
      path.join(root, "scripts", "echo-source-to-marker.sh"),
      `#!/bin/sh\nprintf 'AKM_EVENT_SOURCE=%s' "\${AKM_EVENT_SOURCE:-<unset>}" > ${shellWord(marker)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "workflows", "echo-source.yml"),
      [
        "name: Echo source",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: run-script",
        "        uses: scripts/echo-source-to-marker.sh",
        "",
      ].join("\n"),
    );
  }

  test("ambient AKM_EVENT_SOURCE unset: a real workflow run's exec-unit child still observes AKM_EVENT_SOURCE=task", async () => {
    const marker = markerPath(storage.root);
    writeEchoSourceWorkflow(storage.stashDir, marker);
    writeTask("wf-real-exec-unit", 'version: 3\nuses: workflows/echo-source\nakm:\n  schedule: "@daily"\n');
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();

    const result = await runTask("wf-real-exec-unit", { bundleDir: storage.stashDir, bundleName: "fixture" });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(marker, "utf8")).toBe("AKM_EVENT_SOURCE=task");
    // Never mutated on the parent side either — before, during, or after.
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });

  test("a pre-set ambient AKM_EVENT_SOURCE: a real workflow run's exec-unit child observes AKM_EVENT_SOURCE=improve (ambient wins)", async () => {
    const marker = markerPath(storage.root);
    writeEchoSourceWorkflow(storage.stashDir, marker);
    writeTask("wf-real-exec-unit-preset", 'version: 3\nuses: workflows/echo-source\nakm:\n  schedule: "@daily"\n');
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      runTask("wf-real-exec-unit-preset", { bundleDir: storage.stashDir, bundleName: "fixture" }),
    );

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(marker, "utf8")).toBe("AKM_EVENT_SOURCE=improve");
  });
});

describe("B-10 / spec §9 acceptance grep — process.env.AKM_EVENT_SOURCE is written nowhere in src/", () => {
  // Test-review finding: every provenance assertion in this file (and in
  // tasks-provenance-context.test.ts) observes process.env from inside an
  // INJECTED seam — strictly ABOVE the real orchestrator — so nothing pinned
  // spec §9's own acceptance grep that the global mutation is actually GONE
  // from src/, as opposed to merely unreachable from the seams these tests
  // happen to inject. An implementation that deletes runner.ts:534-535/
  // :552-555 and re-introduces the identical stamp+finally-restore one layer
  // BELOW the injection seam (e.g. inside the real runWorkflowSteps /
  // step-work.ts / exec-unit.ts path) would satisfy every other assertion in
  // this file while leaving B-10 ("never written") false. Mirrors spec §9
  // verbatim:
  //   rg "process\.env\.AKM_EVENT_SOURCE\s*=" src/    → zero hits
  //   rg "delete process\.env\.AKM_EVENT_SOURCE" src/ → zero hits
  // Same file-walk style as the purity ratchet in
  // tests/tasks/parse-v3-adapter.test.ts:423 (recursive src/**/*.ts walk,
  // per-file scan, named offenders on failure) — regex-based rather than
  // AST-based here because the acceptance criterion itself IS a regex grep.
  const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

  function walkTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...walkTsFiles(full));
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) results.push(full);
    }
    return results;
  }

  function offendersMatching(pattern: RegExp): string[] {
    return walkTsFiles(SRC_ROOT)
      .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_ROOT, file).replace(/\\/g, "/"));
  }

  test("no file under src/ assigns process.env.AKM_EVENT_SOURCE", () => {
    expect(offendersMatching(/process\.env\.AKM_EVENT_SOURCE\s*=/)).toEqual([]);
  });

  test("no file under src/ deletes process.env.AKM_EVENT_SOURCE", () => {
    expect(offendersMatching(/delete process\.env\.AKM_EVENT_SOURCE/)).toEqual([]);
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

  // NEW (F-1, spec docs/plans/specs/p1b-model-extraction.md §6, row "…:221 /
  // …:236 (P-07 table + default-env case) | P-07 | UNCHANGED, must stay
  // green. Add new cases for the fallback argument: explicit fallback used
  // only when ambient is unset/"", ambient always wins; garbage ambient still
  // "unknown".": resolveUsageEventSource gains a second, explicit `fallback`
  // argument (default "user", reproducing the table above byte-for-byte for
  // every existing single-argument call site) so the workflow and
  // command/prompt arms can pass provenance.eventSource ("task") instead of
  // relying on the hardcoded "user" default.
  test.each([
    [{ AKM_EVENT_SOURCE: undefined }, "task", "task"],
    [{ AKM_EVENT_SOURCE: "" }, "task", "task"],
    [{ AKM_EVENT_SOURCE: "improve" }, "task", "improve"],
    [{ AKM_EVENT_SOURCE: "totally-unrecognized-value" }, "task", "unknown"],
    [{ AKM_EVENT_SOURCE: undefined }, "audit", "audit"],
  ] as const)("P-07 — the new fallback argument: AKM_EVENT_SOURCE=%p with fallback %p resolves to %p", (env, fallback, expected) => {
    expect(resolveUsageEventSource(env, fallback as UsageEventSource)).toBe(expected);
  });
});

describe('R-07 (FIXED — F-1) — prompt/command arm now stamps AKM_EVENT_SOURCE and records nested usage as "task"', () => {
  // FLIP (F-1, spec docs/plans/specs/p1b-model-extraction.md §6, row "…:244
  // R-07 — a prompt-target task run never sets AKM_EVENT_SOURCE … | R-07 |
  // FLIP to fixed behavior. (a) process.env.AKM_EVENT_SOURCE still undefined
  // before/during/after — unchanged; (b) inverts: the dispatched engine env
  // DOES carry AKM_EVENT_SOURCE="task"; (c) inverts: the usage recorded for
  // the dispatch carries source "task", asserted through the explicit path
  // (dispatch option / recorded usage-event row), not by a bare
  // resolveUsageEventSource() reading an unmutated ambient env.":
  // runPreparedCommandTask now threads the provenance context's eventSource
  // both into the dispatched engine's child env (matching the native arm,
  // P-06) and into dispatchPreparedCommandInvocation's new eventSource
  // option (command-execution.ts:443), so the recorded usage_events row
  // carries "task" instead of the P-07 default "user" this row's P0 pin was
  // built to expose.
  //
  // A STORED command ref (`uses: commands/notify`) is used here rather than
  // the P0 pin's inline `with: {content: …}` fixture, because
  // recordIndexedShowUsage() is a no-op for an inline command — it has no
  // indexed source ref to attribute — so assertion (c) needs a real,
  // indexed, consumed ref to produce a row at all.
  test('R-07 — a prompt-target task run stamps the dispatched engine env and records nested usage as "task"', async () => {
    fs.writeFileSync(path.join(storage.stashDir, "commands", "notify.md"), "Notify the team.\n", "utf8");
    writeTask(
      "prompt-provenance",
      ["version: 3", "uses: commands/notify", "akm:", '  schedule: "@daily"', "  engine: opencode", ""].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const seed = openStateDatabase();
    seed.exec("DELETE FROM usage_events");
    seed.close();
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();

    let observedDuringProcessEnv: string | undefined;
    let observedChildEnv: Record<string, string> | undefined;

    const fakeRunAgent: FakeRunAgent = async (...args) => {
      const options = args[2] as { env?: Record<string, string> } | undefined;
      // (a) the parent's process.env, observed from INSIDE the dispatched
      // engine call — the narrowest seam available for this arm.
      observedDuringProcessEnv = process.env.AKM_EVENT_SOURCE;
      // (b) the env bag the runner actually handed to the dispatched engine.
      observedChildEnv = options?.env;
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    };

    const result = await runTask("prompt-provenance", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      runAgentImpl: fakeRunAgent,
    });

    expect(result.status).toBe("completed");
    // (a) unchanged: the parent's process.env is never touched, at any point.
    expect(observedDuringProcessEnv).toBeUndefined();
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    // (b) inverts the P0 pin: the dispatched engine env now carries the stamp.
    expect(observedChildEnv).toMatchObject({ AKM_EVENT_SOURCE: "task" });
    // (c) inverts the P0 pin: the recorded usage_events row for the consumed
    // command ref carries source "task" — proven through the explicit
    // dispatch-option / recorded-row path, not a bare resolveUsageEventSource()
    // read of an (unmutated) ambient env.
    expect(queryUsageEventRows()).toEqual([
      { event_type: "show", entry_ref: "fixture//commands/notify", source: "task" },
    ]);
  });
});

describe("F-3 (spec §5.4/§9) — RunTaskOptions.bundleDir REPLACES stashDir; the legacy key is not an alias", () => {
  // Test-review finding: every RunTaskOptions construction site ABOVE in this
  // file was just renamed stashDir -> bundleDir (mechanical substitution,
  // §5.4), matching tests/integration/tasks-legacy-vocabulary-characterization.test.ts's
  // R-09 pin and this phase's two brand-new files
  // (tests/integration/tasks-provenance-context.test.ts,
  // tests/integration/tasks-result-vocabulary.test.ts). But a rename applied
  // consistently across every CALL SITE does not by itself prove the OLD key
  // stopped being read: an implementation that adds `bundleDir` while still
  // honoring `stashDir` as a fallback alias would make every test in this
  // phase's suite pass — including the R-09 canary, whose only asserted
  // observable is the resolved ref string, not the option name used to reach
  // it — while leaving spec §9's "RunTaskOptions.bundleDir replaces stashDir"
  // unmet. So this pins the RUNTIME contract directly: a stashDir-ONLY
  // options object (no bundleDir at all) must not resolve the task.
  //
  // The cast to `never` on the whole options object is deliberate (mirrors
  // this phase's established convention, e.g.
  // tests/integration/tasks-provenance-context.test.ts's `} as never` on its
  // RunTaskOptions literals) — this is a RUNTIME pin, not a compile-time one:
  // it must keep compiling (and failing for the right reason) both before
  // this phase's implementation lands (when `stashDir` is still the ONLY real
  // field, so runTask would actually resolve the task and this test's
  // "rejects" expectation is what makes it red today) and after (when a
  // CORRECT bundleDir-only implementation makes the same call fail because
  // `bundleDir` is undefined — see src/tasks/runner.ts:154-165 at head, where
  // an unresolved owner throws NotFoundError before the try/catch boundary,
  // i.e. before any mutation, so the call REJECTS rather than resolving to a
  // "failed" TaskRunResult).
  test("a stashDir-only options object (no bundleDir) does not resolve the task — the rename is a replacement, not an addition", async () => {
    writeTask("stashdir-only-rejects", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));

    const legacyKeyOnly = { stashDir: storage.stashDir, bundleName: "fixture" } as never;

    await expect(runTask("stashdir-only-rejects", legacyKeyOnly)).rejects.toThrow();
  });
});
