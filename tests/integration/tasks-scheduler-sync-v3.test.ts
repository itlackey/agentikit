// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planSchedulerSync } from "../../src/tasks/scheduler-sync";

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-scheduler-sync-v3-"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const emptyInstalled = [] as const;

describe("whole-set v3 scheduler sync planning", () => {
  test("compiles task and workflow schedules together and never installs workflow_dispatch", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "nightly.yml"), "version: 3\nrun: echo index\nakm:\n  schedule: '@daily'\n");
    write(
      path.join(bundleRoot, "workflows", "release.yml"),
      [
        "name: release",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "    - cron: '0 9 * * 2'",
        "  workflow_dispatch: {}",
        "jobs:",
        "  publish:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: publish",
        "        run: echo publish",
      ].join("\n"),
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

    expect(plan.desired).toHaveLength(3);
    expect(plan.desired.map(({ logicalSource }) => logicalSource)).toEqual([
      { kind: "task", ref: "team//tasks/nightly" },
      { kind: "workflow", ref: "team//workflows/release" },
      { kind: "workflow", ref: "team//workflows/release" },
    ]);
    expect(plan.operations.map(({ kind }) => kind)).toEqual(["install", "install", "install"]);
  });

  test("enumerates a standalone akm-task bundle with qualified logical refs", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "nightly.yml"), "version: 3\nrun: echo yes\nakm:\n  schedule: '@daily'\n");

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.logicalSource).toEqual({ kind: "task", ref: "team//nightly" });
    expect(plan.desired[0]?.invocation).toEqual(["task", "run", "nightly", "--bundle", "team", "--scheduled"]);
  });

  test("one invalid desired task poisons the whole plan without signature or mutation preparation", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "a-valid.yml"), "version: 3\nuses: commands/a\nakm:\n  schedule: '@daily'\n");
    write(path.join(bundleRoot, "tasks", "b-invalid.yml"), "version: 2\nschedule: '@daily'\ncommand: echo no\n");
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "sig";
        },
      }),
    ).rejects.toThrow("akm migrate apply --dry-run");
    expect(signatures).toBe(0);
  });

  test("an unresolved desired task target poisons the whole read-only plan", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "a-valid.yml"), "version: 3\nrun: echo yes\nakm:\n  schedule: '@daily'\n");
    write(
      path.join(bundleRoot, "tasks", "b-unresolved.yml"),
      "version: 3\nuses: scripts/does-not-exist\nakm:\n  schedule: '@daily'\n",
    );
    let signatures = 0;

    await expect(
      Promise.resolve(
        planSchedulerSync({
          sourceRoot: bundleRoot,
          adapterId: "akm",
          bundleName: "team",
          bundleTarget: "team",
          backend: "cron",
          installed: emptyInstalled,
          expectedSignature: () => {
            signatures += 1;
            return "sig";
          },
        }),
      ),
    ).rejects.toThrow(/not found|not present|no script assets/i);
    expect(signatures).toBe(0);
  });

  test("a nonprojectable workflow poisons the whole read-only plan", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "workflows", "multi.yml"),
      [
        "name: multi",
        "on:",
        "  schedule:",
        "    - cron: '0 0 * * *'",
        "jobs:",
        "  first:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: first",
        "        run: echo first",
        "  second:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: second",
        "        run: echo second",
      ].join("\n"),
    );

    await expect(
      Promise.resolve(
        planSchedulerSync({
          sourceRoot: bundleRoot,
          adapterId: "akm",
          bundleName: "team",
          bundleTarget: "team",
          backend: "cron",
          installed: emptyInstalled,
        }),
      ),
    ).rejects.toThrow(/exactly one job|single-job|multi-job|cannot project/i);
  });

  test("an unsupported workflow trigger and a valid peer fail as one read-only source set", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "valid.yml"), "version: 3\nrun: echo yes\nakm:\n  schedule: '@daily'\n");
    write(
      path.join(bundleRoot, "workflows", "bad.yml"),
      "name: bad\non: { push: {} }\njobs: { main: { runs-on: [self-hosted], steps: [{ run: echo no }] } }\n",
    );

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
      }),
    ).rejects.toThrow(/unsupported|trigger/i);
  });

  test("workflow collision domains fail before reading or fingerprinting either candidate", async () => {
    const bundleRoot = root();
    const workflows = path.join(bundleRoot, "workflows");
    write(path.join(workflows, "same.md"), "---\ntype: workflow\n---\n# Same\n\n## Steps\n\n### one\nDo it.\n");
    write(
      path.join(workflows, "same.yml"),
      "name: same\non: { workflow_dispatch: null }\njobs: { main: { runs-on: [self-hosted], steps: [] } }\n",
    );
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "sig";
        },
      }),
    ).rejects.toThrow(/multiple workflow source files/i);
    expect(signatures).toBe(0);
  });

  test("preflights desired and foreign installed id collisions before diffing", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "nightly.yml"), "version: 3\nrun: echo yes\nakm:\n  schedule: '@daily'\n");

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: [{ id: "nightly", target: "other", binding: ["/bin/akm"], contextPath: "/tmp/context.json" }],
      }),
    ).rejects.toThrow(/already scheduled|collision/i);
  });

  test("rejects desired sources that physically escape the bundle before diffing", async () => {
    const bundleRoot = root();
    const outsideRoot = root();
    const outside = path.join(outsideRoot, "escaped.yml");
    write(outside, "version: 3\nrun: echo escaped\nakm:\n  schedule: '@daily'\n");
    fs.mkdirSync(path.join(bundleRoot, "tasks"), { recursive: true });
    fs.symlinkSync(outside, path.join(bundleRoot, "tasks", "escaped.yml"));
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "sig";
        },
      }),
    ).rejects.toThrow(/outside the bundle root/);
    expect(signatures).toBe(0);
  });
});
