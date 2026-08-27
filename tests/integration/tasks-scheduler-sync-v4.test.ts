// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Test-review remediation (spec docs/plans/specs/p2a-task-source-v4.md §5.2,
 * D2-N6, B-38) for the finding recorded against
 * docs/plans/specs/p2a-task-source-v4.md:501: B-07 ("a `version: 4` task with
 * no `schedule:` parses, contributes ZERO scheduler bindings, records ZERO
 * failures, and emits no diagnostic through `akm task sync`") had no test
 * anywhere, even though §9 names it as an explicit acceptance bullet. This
 * file is deliberately NEW and separate from
 * tests/integration/tasks-scheduler-sync-v3.test.ts, which §7/F-4 require to
 * stay byte-unchanged.
 *
 * Structure mirrors tests/integration/tasks-scheduler-sync-v3.test.ts exactly
 * (the `root()`/`write()`/`planSchedulerSync()` helpers and the
 * `SchedulerSyncPlanInput` shape) — only the fixtures and assertions differ.
 *
 * RED today: `src/tasks/scheduler-sync.ts:480`'s `compileTaskSources` calls
 * `parseTaskV3Yaml` directly (not yet routed through the not-yet-existing
 * `parseTaskSource`, spec §3.6). Feeding it a `version: 4` document therefore
 * fails v3's OWN `version must be exactly 3.` check today, which
 * `compileTaskSources`'s per-source `try/catch` turns into exactly ONE
 * `failures` entry — so `prepareSchedulerSyncSourceSet` REJECTS today (the
 * opposite of B-07's "zero failures"), and every test below is red for
 * exactly that reason until Implement routes this call site.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { schedulerNativeBindingId } from "../../src/tasks/scheduler-binding";
import {
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncPlanInput,
} from "../../src/tasks/scheduler-sync";
import { overrideSeam } from "../_helpers/seams";

async function planSchedulerSync(input: SchedulerSyncPlanInput) {
  return finalizeSchedulerSyncPlan(input, await prepareSchedulerSyncSourceSet(input));
}

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-scheduler-sync-v4-"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const emptyInstalled = [] as const;

describe("whole-set task source v4 scheduler sync planning — B-07 (manual-only, D2-N6)", () => {
  test("a version: 4 task with no schedule: contributes ZERO bindings and records ZERO failures — prepareSchedulerSyncSourceSet does not reject", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );

    // Today this REJECTS (see file header) — the assertion that it resolves
    // at all is the B-07 pin, independent of the shape assertions below.
    const prepared = await prepareSchedulerSyncSourceSet({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });
    expect(prepared.desired).toEqual([]);
  });

  test("a version: 4 task with no schedule: is a whole-set no-op: zero desired bindings, zero operations, on an otherwise-empty installed set", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toEqual([]);
    expect(plan.operations).toEqual([]);
    expect(plan.installed).toEqual([]);
    expect(plan.updated).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.unchanged).toEqual([]);
  });

  test("a manual-only version: 4 task alongside a normally-scheduled version: 3 task: the v3 task still installs, the v4 task contributes nothing", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      ["version: 3", "run: echo index", "akm:", "  schedule: '@daily'", ""].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.logicalSource).toEqual({ kind: "task", ref: "team//tasks/nightly" });
    expect(plan.operations).toHaveLength(1);
  });

  test("emits no diagnostic (no warn()) for a manual-only version: 4 task — B-38's warn is scoped to non-empty schedule[i].inputs only", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );
    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    });

    await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(warnCalls).toEqual([]);
  });
});

describe("whole-set task source v4 scheduler sync planning — scheduled bindings and per-entry enabled (B-08..B-10)", () => {
  test("a scheduled version: 4 task compiles exactly one binding via the SAME compileTaskSchedulerBindings seam as v3", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly-v4.yml"),
      ["version: 4", "run: echo nightly", "shell: sh", "schedule: '0 8 * * 1'", ""].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.id).toBe("nightly-v4");
    expect(plan.desired[0]?.nativeId).toBe(schedulerNativeBindingId("nightly-v4"));
    expect(plan.desired[0]?.cron).toBe("0 8 * * 1");
    expect(plan.desired[0]?.enabled).toBe(true);
    expect(plan.operations.map(({ kind }) => kind)).toEqual(["install"]);
  });
});

describe("whole-set task source v4 scheduler sync planning — B-45/F-B2 (schedule[i].inputs delivered as a sorted invocation tail)", () => {
  // P2b Lane B flip (spec docs/plans/specs/p2b-input-bindings.md §4.4, §7
  // F-B2): the P2a B-38 gap this describe block used to pin ("validated but
  // not yet delivered", single per-task warn, byte-identical fixed tail) is
  // now CLOSED — schedule[i].inputs are delivered through the compiled
  // binding's own invocation tail, so there is nothing left to warn about.
  test("schedule[i].inputs non-empty compiles a sorted --<name> <value> tail per entry — no warn, and each entry's tail reflects its OWN inputs", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "ticketed.yml"),
      [
        "version: 4",
        "run: echo ticketed",
        "shell: sh",
        "inputs:",
        "  scope:",
        "    type: string",
        "schedule:",
        // TWO entries with DIFFERENT inputs: — proves each entry's own tail
        // is compiled from its OWN inputs, never shared/collapsed.
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      scope: all",
        "  - cron: '0 9 * * 2'",
        "    inputs:",
        "      scope: changed",
        "",
      ].join("\n"),
    );
    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    });

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    // No warn: the gap the old warn announced is closed.
    expect(warnCalls).toEqual([]);

    // Each compiled binding carries its OWN schedule entry's inputs as a
    // sorted `--<name> <value>` tail after `--scheduled`.
    expect(plan.desired).toHaveLength(2);
    const byOrdinal = [...plan.desired].sort((left, right) => left.ordinal - right.ordinal);
    expect(byOrdinal[0]?.invocation).toEqual([
      "task",
      "run",
      "ticketed",
      "--bundle",
      "team",
      "--scheduled",
      "--scope",
      "all",
    ]);
    expect(byOrdinal[1]?.invocation).toEqual([
      "task",
      "run",
      "ticketed",
      "--bundle",
      "team",
      "--scheduled",
      "--scope",
      "changed",
    ]);
  });

  test("schedule[i].inputs violating the declared input's schema still fails at PARSE time (TASK_SOURCE_INVALID), not silently at sync time", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "bad-schedule-inputs.yml"),
      [
        "version: 4",
        "run: echo bad",
        "shell: sh",
        "inputs:",
        "  scope:",
        "    type: string",
        "    enum: [changed, all]",
        "schedule:",
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      scope: bogus",
        "",
      ].join("\n"),
    );

    // compileTaskSources' per-source try/catch turns a per-file parse
    // failure into one `failures` entry, which prepareSchedulerSyncSourceSet
    // then rejects with — the sync path never silently drops it.
    await expect(
      prepareSchedulerSyncSourceSet({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
      }),
    ).rejects.toThrow(UsageError);
  });
});
