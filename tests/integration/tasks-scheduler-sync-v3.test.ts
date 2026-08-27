// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileTaskSchedulerBindings, schedulerNativeBindingId } from "../../src/tasks/scheduler-binding";
import {
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncPlanInput,
} from "../../src/tasks/scheduler-sync";

async function planSchedulerSync(input: SchedulerSyncPlanInput) {
  return finalizeSchedulerSyncPlan(input, await prepareSchedulerSyncSourceSet(input));
}

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

  test("a valid multi-schedule task is an exact no-op on its identical second whole-set plan", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      [
        "version: 3",
        "run: echo index",
        "on:",
        "  schedule:",
        "    - cron: '0 1 * * *'",
        "    - cron: '0 2 * * *'",
        "",
      ].join("\n"),
    );
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
      expectedSignature: (binding: { id: string; cron: string }) => `${binding.id}:${binding.cron}`,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const installed = initial.desired.map((binding) => ({
      id: binding.id,
      nativeId: schedulerNativeBindingId(binding.id),
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: binding.invocation,
      signature: `${binding.id}:${binding.cron}`,
    }));
    const nativeArtifacts = initial.desired.map((binding) => ({
      nativeId: schedulerNativeBindingId(binding.id),
      bindingId: binding.id,
      invocation: binding.invocation,
    }));

    const second = await planSchedulerSync({ ...base, installed, nativeArtifacts } as never);

    expect(second.unchanged).toEqual(initial.desired.map(({ id }) => id));
    expect(second.operations).toEqual([]);
  });

  test("multi-schedule drift updates only the changed higher ordinal binding", async () => {
    const bundleRoot = root();
    const file = path.join(bundleRoot, "tasks", "nightly.yml");
    const source = (second: string) =>
      [
        "version: 3",
        "run: echo index",
        "on:",
        "  schedule:",
        "    - cron: '0 1 * * *'",
        `    - cron: '${second}'`,
        "",
      ].join("\n");
    write(file, source("0 2 * * *"));
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
      expectedSignature: (binding: { id: string; cron: string }) => `${binding.id}:${binding.cron}`,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const installed = initial.desired.map((binding) => ({
      id: binding.id,
      nativeId: schedulerNativeBindingId(binding.id),
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: binding.invocation,
      signature: `${binding.id}:${binding.cron}`,
    }));
    const nativeArtifacts = initial.desired.map((binding) => ({
      nativeId: schedulerNativeBindingId(binding.id),
      bindingId: binding.id,
      invocation: binding.invocation,
    }));
    write(file, source("30 2 * * *"));

    const drift = await planSchedulerSync({ ...base, installed, nativeArtifacts } as never);

    expect(drift.unchanged).toEqual([initial.desired[0]!.id]);
    expect(drift.updated).toEqual([initial.desired[1]!.id]);
  });

  test("higher-ordinal removal freezes the exact parsed owner and installed fingerprint", async () => {
    const bundleRoot = root();
    const file = path.join(bundleRoot, "tasks", "nightly.yml");
    write(file, "version: 3\nrun: echo index\non:\n  schedule:\n    - cron: '0 1 * * *'\n    - cron: '0 2 * * *'\n");
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
      expectedSignature: (binding: { id: string; cron: string }) => `${binding.id}:${binding.cron}`,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const installed = initial.desired.map((binding) => ({
      id: binding.id,
      nativeId: schedulerNativeBindingId(binding.id),
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: binding.invocation,
      signature: `${binding.id}:${binding.cron}`,
    }));
    const nativeArtifacts = initial.desired.map((binding) => ({
      nativeId: schedulerNativeBindingId(binding.id),
      bindingId: binding.id,
      invocation: binding.invocation,
    }));
    write(file, "version: 3\nrun: echo index\non:\n  schedule:\n    - cron: '0 1 * * *'\n");

    const removal = await planSchedulerSync({ ...base, installed, nativeArtifacts } as never);
    const removed = initial.desired[1];
    if (!removed) throw new Error("missing higher-ordinal binding");
    expect(removal.operations).toContainEqual({
      kind: "remove",
      id: removed.id,
      nativeId: schedulerNativeBindingId(removed.id),
      expected: {
        state: "present",
        bindingId: removed.id,
        nativeId: schedulerNativeBindingId(removed.id),
        logicalSource: removed.logicalSource,
        ordinal: removed.ordinal,
        invocation: removed.invocation,
        fingerprint: `${removed.id}:${removed.cron}`,
      },
    });
  });

  test("freezes exact absence and exact prior CAS state on every planned mutation", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "create.yml"),
      "version: 3\nrun: echo create\nakm:\n  schedule: '0 1 * * *'\n",
    );
    write(
      path.join(bundleRoot, "tasks", "update.yml"),
      "version: 3\nrun: echo update\nakm:\n  schedule: '0 2 * * *'\n",
    );
    const existing = compileTaskSchedulerBindings({
      id: "update",
      qualifiedRef: "team//tasks/update",
      enabled: true,
      schedules: [{ cron: "30 2 * * *", source: "akm.schedule", ordinal: 0 }],
    })[0]!;
    const installed = {
      id: existing.id,
      nativeId: existing.nativeId,
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: existing.invocation,
      signature: "installed-fingerprint",
    };

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
      installed: [installed],
      nativeArtifacts: [
        {
          nativeId: existing.nativeId!,
          bindingId: existing.id,
          invocation: existing.invocation,
          fingerprint: "installed-fingerprint",
        },
      ],
      expectedSignature: (item) => `desired:${item.id}:${item.cron}`,
    });

    const create = plan.operations.find((operation) => operation.kind === "install");
    const update = plan.operations.find((operation) => operation.kind === "update");
    expect(create).toMatchObject({
      expected: {
        state: "absent",
        bindingId: "create",
        nativeId: "create",
        logicalSource: { kind: "task", ref: "team//tasks/create" },
        ordinal: 0,
        invocation: ["task", "run", "create", "--bundle", "team", "--scheduled"],
      },
    });
    expect(update).toMatchObject({
      expected: {
        state: "present",
        bindingId: "update",
        nativeId: "update",
        logicalSource: { kind: "task", ref: "team//tasks/update" },
        ordinal: 0,
        invocation: ["task", "run", "update", "--bundle", "team", "--scheduled"],
        fingerprint: "installed-fingerprint",
      },
    });
  });

  test("rejects incoherent installed and native fingerprints instead of planning a false no-op", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      "version: 3\nrun: echo nightly\nakm:\n  schedule: '0 1 * * *'\n",
    );
    const [desired] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      enabled: true,
      schedules: [{ cron: "0 1 * * *", source: "akm.schedule", ordinal: 0 }],
    });
    if (!desired) throw new Error("missing binding");

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: [
          {
            id: desired.id,
            nativeId: desired.nativeId,
            binding: ["/opt/akm"],
            contextPath: "/state/context.json",
            target: "team",
            invocation: desired.invocation,
            signature: "stale-list-fingerprint",
          },
        ],
        nativeArtifacts: [
          {
            nativeId: desired.nativeId!,
            bindingId: desired.id,
            invocation: desired.invocation,
            fingerprint: "newer-native-fingerprint",
          },
        ],
        expectedSignature: () => "stale-list-fingerprint",
      }),
    ).rejects.toThrow(/coherent|fingerprint|changed/i);
  });

  test("a production coherent inspection cannot omit the native fingerprint behind a listed no-op", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      "version: 3\nrun: echo nightly\nakm:\n  schedule: '0 1 * * *'\n",
    );
    const [desired] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      enabled: true,
      schedules: [{ cron: "0 1 * * *", source: "akm.schedule", ordinal: 0 }],
    });
    if (!desired) throw new Error("missing binding");
    const installed = {
      id: desired.id,
      nativeId: desired.nativeId,
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: desired.invocation,
      signature: "desired-fingerprint",
    };
    const artifact = {
      nativeId: desired.nativeId!,
      bindingId: desired.id,
      invocation: desired.invocation,
    };

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: [installed],
        nativeArtifacts: [artifact],
        inspection: { installed: [installed], artifacts: [artifact] },
        expectedSignature: () => "desired-fingerprint",
      }),
    ).rejects.toThrow(/coherent|fingerprint|changed/i);
  });

  test("accepts the workflow-only tasks target through canonical step authority", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "child.yml"), "version: 3\nrun: echo child\non:\n  workflow_dispatch: {}\n");
    write(
      path.join(bundleRoot, "workflows", "parent.yml"),
      [
        "name: parent",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: child",
        "        uses: tasks/child",
      ].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.logicalSource).toEqual({ kind: "workflow", ref: "team//workflows/parent" });
  });

  test.each([
    ["remote action", "actions/checkout@v4", /remote action|acquisition|unsupported/i],
  ] as const)("rejects %s before scheduler signatures or mutation preparation", async (_label, uses, message) => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "workflows", "parent.yml"),
      [
        "name: parent",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: child",
        `        uses: ${uses}`,
      ].join("\n"),
    );
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
    ).rejects.toThrow(message);
    expect(signatures).toBe(0);
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

  test("preserves an arbitrary-depth standalone task concept id through the whole plan", async () => {
    const componentRoot = root();
    write(
      path.join(componentRoot, "sub", "deep", "nightly.yml"),
      "version: 3\nrun: echo nested\nakm:\n  schedule: '@daily'\n",
    );

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]).toMatchObject({
      id: "sub/deep/nightly",
      logicalSource: { kind: "task", ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    });
  });

  test("duplicate standalone basenames retain distinct canonical ids instead of colliding", async () => {
    const componentRoot = root();
    write(
      path.join(componentRoot, "alpha", "nightly.yml"),
      "version: 3\nrun: echo alpha\nakm:\n  schedule: '@daily'\n",
    );
    write(path.join(componentRoot, "beta", "nightly.yml"), "version: 3\nrun: echo beta\nakm:\n  schedule: '@daily'\n");

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired.map(({ id }) => id)).toEqual(["alpha/nightly", "beta/nightly"]);
    expect(plan.desired.map(({ logicalSource }) => logicalSource.ref)).toEqual([
      "team//alpha/nightly",
      "team//beta/nightly",
    ]);
  });

  test("rejects logical ids whose exact native scheduler artifacts collide before signatures", async () => {
    const componentRoot = root();
    write(path.join(componentRoot, "sub", "nightly.yml"), "version: 3\nrun: echo nested\nakm:\n  schedule: '@daily'\n");
    write(
      path.join(componentRoot, "task-5f14bc23cb233df4713f2e147b6c077f.yml"),
      "version: 3\nrun: echo flat\nakm:\n  schedule: '@daily'\n",
    );
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      }),
    ).rejects.toThrow(/native scheduler artifact|collision/i);
    expect(signatures).toBe(0);
  });

  test.each([
    ["case folding", "Nightly", "nightly"],
  ] as const)("rejects portable native artifact collisions caused by %s", async (_label, first, second) => {
    const componentRoot = root();
    write(path.join(componentRoot, `${first}.yml`), "version: 3\nrun: echo first\nakm:\n  schedule: '@daily'\n");
    write(path.join(componentRoot, `${second}.yml`), "version: 3\nrun: echo second\nakm:\n  schedule: '@daily'\n");
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "schtasks",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      }),
    ).rejects.toThrow(/native scheduler artifact|collision/i);
    expect(signatures).toBe(0);
  });

  test("rejects a single logical/native id ending in a period before signatures", async () => {
    const componentRoot = root();
    write(path.join(componentRoot, "nightly..yml"), "version: 3\nrun: echo unsafe\nakm:\n  schedule: '@daily'\n");
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "schtasks",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      }),
    ).rejects.toThrow(/period|portable|native scheduler artifact/i);
    expect(signatures).toBe(0);
  });

  test.each([
    ["different logical owner", "task-5f14bc23cb233df4713f2e147b6c077f"],
    ["malformed source-absent owner", undefined],
  ] as const)("rejects an installed %s at the desired exact native artifact before signatures", async (_label, bindingId) => {
    const componentRoot = root();
    write(path.join(componentRoot, "sub", "nightly.yml"), "version: 3\nrun: echo nested\nakm:\n  schedule: '@daily'\n");
    let signatures = 0;
    const nativeArtifacts = [
      {
        nativeId: "task-5f14bc23cb233df4713f2e147b6c077f",
        ...(bindingId
          ? {
              bindingId,
              invocation: ["task", "run", bindingId, "--bundle", "team", "--scheduled"],
            }
          : {}),
      },
    ];

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
        nativeArtifacts,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      } as never),
    ).rejects.toThrow(/native scheduler artifact|collision|unproven owner/i);
    expect(signatures).toBe(0);
  });

  test("rejects a foreign fully-qualified workflow owner under the same binding and native id", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "workflows", "release.yml"),
      "name: release\non:\n  schedule:\n    - cron: '0 8 * * 1'\njobs:\n  main:\n    runs-on: [self-hosted]\n    steps:\n      - id: release\n        run: echo release\n",
    );
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const workflow = initial.desired.find((binding) => binding.logicalSource.kind === "workflow");
    if (!workflow) throw new Error("missing workflow binding");
    const foreignInvocation = ["workflow", "run", "team//workflows/other"] as const;

    await expect(
      planSchedulerSync({
        ...base,
        installed: [
          {
            id: workflow.id,
            nativeId: workflow.nativeId,
            binding: ["/opt/akm"],
            contextPath: "/state/context.json",
            target: "team",
            invocation: foreignInvocation,
          },
        ],
        nativeArtifacts: [
          { nativeId: workflow.nativeId ?? workflow.id, bindingId: workflow.id, invocation: foreignInvocation },
        ],
      }),
    ).rejects.toThrow(/native scheduler artifact|collision|team\/\/workflows\/other/i);
  });

  test("a proven source-absent nested owner removes by its exact enumerated native id", async () => {
    const componentRoot = root();
    const nativeId = "task-5f14bc23cb233df4713f2e147b6c077f";
    const installed = {
      id: "sub/nightly",
      nativeId,
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      target: "team",
      invocation: ["task", "run", "sub/nightly", "--bundle", "team", "--scheduled"],
      signature: "installed-fingerprint",
    };

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: [installed],
      nativeArtifacts: [
        {
          nativeId,
          bindingId: "sub/nightly",
          invocation: installed.invocation,
          fingerprint: "installed-fingerprint",
        },
      ],
    });

    expect(plan.removed).toEqual(["sub/nightly"]);
    expect(plan.operations).toEqual([
      {
        kind: "remove",
        id: "sub/nightly",
        nativeId,
        expected: {
          state: "present",
          bindingId: "sub/nightly",
          nativeId,
          logicalSource: { kind: "task", ref: "team//sub/nightly" },
          ordinal: 0,
          invocation: installed.invocation,
          fingerprint: "installed-fingerprint",
        },
      },
    ]);
  });

  test("a true standalone physical-source identity collision rejects before diffing", async () => {
    const componentRoot = root();
    const owner = path.join(componentRoot, "alpha", "nightly.yml");
    const alias = path.join(componentRoot, "beta", "nightly.yml");
    write(owner, "version: 3\nrun: echo owner\nakm:\n  schedule: '@daily'\n");
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(owner, alias);
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      }),
    ).rejects.toThrow(/physical.*identity.*collision|same physical source/i);
    expect(signatures).toBe(0);
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
    ).rejects.toThrow(/exactly one (?:source-IR )?job|single-job|multi-job|cannot project/i);
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
