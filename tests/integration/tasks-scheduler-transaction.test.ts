// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../../src/commands/tasks/tasks";
import type { TaskBackend } from "../../src/tasks/backends/types";
import type { ScheduleBackend } from "../../src/tasks/schedule";
import {
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  schedulerBindingNativeId,
  schedulerNativeArtifactKey,
} from "../../src/tasks/scheduler-binding";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

type StoredBinding = Readonly<{ binding: SchedulerBinding; fingerprint: string }>;
type FakeSnapshot = Readonly<{
  nativeIds: readonly string[];
  artifacts: readonly Record<string, unknown>[];
  stored: ReadonlyMap<string, StoredBinding>;
}>;
type FakeRollbackGuard = Readonly<{
  nativeId: string;
  allowed: readonly Readonly<
    { state: "absent" } | { state: "present"; bindingId?: string; invocation?: readonly string[]; fingerprint?: string }
  >[];
}>;

let storage: IsolatedAkmStorage;

function taskYaml(run: string, schedule: string): string {
  return `version: 3\nrun: ${run}\nakm:\n  schedule: "${schedule}"\n`;
}

function writeTask(id: string, run: string, schedule: string): void {
  const file = path.join(storage.stashDir, "tasks", `${id}.yml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, taskYaml(run, schedule));
}

function binding(id: string, schedule: string): SchedulerBinding {
  const [compiled] = compileTaskSchedulerBindings({
    id,
    qualifiedRef: `stash//tasks/${id}`,
    enabled: true,
    schedules: [{ cron: schedule, source: "akm.schedule", ordinal: 0 }],
  });
  if (!compiled) throw new Error("missing compiled binding");
  return compiled;
}

function signature(value: SchedulerBinding): string {
  return JSON.stringify([value.cron, value.enabled, value.invocation]);
}

function fakeBackend(
  name: ScheduleBackend,
  initial: readonly SchedulerBinding[] = [],
  failure?: Readonly<{ kind: "install" | "uninstall"; id: string }>,
  rollbackFailureId?: string,
  concurrentRollbackDriftId?: string,
): TaskBackend & {
  stored: Map<string, StoredBinding>;
  calls: string[];
  inspectionCalls: number;
  splitReadCalls: number;
  snapshotCalls: number;
  restoreCalls: number;
  lastRollbackGuards: readonly FakeRollbackGuard[] | undefined;
} {
  const stored = new Map(
    initial.map((item) => [schedulerBindingNativeId(item), { binding: item, fingerprint: signature(item) }]),
  );
  const calls: string[] = [];
  let inspectionCalls = 0;
  let splitReadCalls = 0;
  let snapshotCalls = 0;
  let restoreCalls = 0;
  let lastRollbackGuards: readonly FakeRollbackGuard[] | undefined;

  const inspection = () => {
    const installed = [...stored.values()].map(({ binding: item, fingerprint }) => ({
      id: item.id,
      nativeId: schedulerBindingNativeId(item),
      binding: ["/test/akm"],
      contextPath: "/test/context.json",
      signature: fingerprint,
      target: "stash",
      invocation: item.invocation,
    }));
    const artifacts = [...stored.values()].map(({ binding: item, fingerprint }) => ({
      nativeId: schedulerBindingNativeId(item),
      bindingId: item.id,
      invocation: item.invocation,
      fingerprint,
    }));
    return { installed, artifacts };
  };

  const backend = {
    name,
    inspectBindings() {
      inspectionCalls += 1;
      return inspection();
    },
    list() {
      splitReadCalls += 1;
      return inspection().installed;
    },
    listNativeArtifacts() {
      splitReadCalls += 1;
      return inspection().artifacts;
    },
    expectedSignature(item: SchedulerBinding) {
      return signature(item);
    },
    snapshotBindings(nativeIds: readonly string[]): FakeSnapshot {
      snapshotCalls += 1;
      return Object.freeze({
        nativeIds: Object.freeze([...nativeIds]),
        artifacts: Object.freeze(
          inspection().artifacts.filter((artifact) =>
            nativeIds.some(
              (nativeId) => schedulerNativeArtifactKey(nativeId) === schedulerNativeArtifactKey(artifact.nativeId),
            ),
          ),
        ),
        stored: new Map(stored),
      });
    },
    restoreBindings(snapshot: FakeSnapshot, guards?: readonly FakeRollbackGuard[]) {
      restoreCalls += 1;
      lastRollbackGuards = guards;
      const errors: unknown[] = [];
      for (const nativeId of snapshot.nativeIds) {
        try {
          if (nativeId === rollbackFailureId) throw new Error(`rollback failed for ${nativeId}`);
          if (concurrentRollbackDriftId !== undefined) {
            const current = stored.get(nativeId);
            const guard = guards?.find((candidate) => candidate.nativeId === nativeId);
            if (!guard) throw new Error(`missing rollback CAS guard for ${nativeId}`);
            const matches = guard.allowed.some((allowed) =>
              allowed.state === "absent"
                ? current === undefined
                : current !== undefined &&
                  allowed.bindingId === current.binding.id &&
                  JSON.stringify(allowed.invocation) === JSON.stringify(current.binding.invocation) &&
                  allowed.fingerprint === current.fingerprint,
            );
            if (!matches) throw new Error(`rollback CAS rejected concurrent drift for ${nativeId}`);
          }
          const prior = snapshot.stored.get(nativeId);
          if (prior) stored.set(nativeId, prior);
          else stored.delete(nativeId);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "partial rollback failure");
    },
    install(item: SchedulerBinding, _options?: unknown, expected?: unknown) {
      calls.push(`install:${item.id}:${expected === undefined ? "missing-cas" : "cas"}`);
      if (failure?.kind === "install" && failure.id === item.id) {
        if (concurrentRollbackDriftId) {
          const prior = stored.get(concurrentRollbackDriftId);
          if (prior) stored.set(concurrentRollbackDriftId, { ...prior, fingerprint: "concurrent-foreign-bytes" });
        }
        throw new Error(`install failed for ${item.id}`);
      }
      stored.set(schedulerBindingNativeId(item), { binding: item, fingerprint: signature(item) });
    },
    uninstall(nativeId: string, expected?: unknown) {
      calls.push(`remove:${nativeId}:${expected === undefined ? "missing-cas" : "cas"}`);
      if (failure?.kind === "uninstall" && failure.id === nativeId) throw new Error(`remove failed for ${nativeId}`);
      stored.delete(nativeId);
    },
    setEnabled() {},
  } as unknown as TaskBackend & {
    stored: Map<string, StoredBinding>;
    calls: string[];
    inspectionCalls: number;
    splitReadCalls: number;
    snapshotCalls: number;
    restoreCalls: number;
    lastRollbackGuards: readonly FakeRollbackGuard[] | undefined;
  };
  Object.defineProperties(backend, {
    stored: { value: stored },
    calls: { value: calls },
    inspectionCalls: { get: () => inspectionCalls },
    splitReadCalls: { get: () => splitReadCalls },
    snapshotCalls: { get: () => snapshotCalls },
    restoreCalls: { get: () => restoreCalls },
    lastRollbackGuards: { get: () => lastRollbackGuards },
  });
  return backend;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
});

afterEach(() => storage.cleanup());

describe("whole-set scheduler transaction and coherent inspection", () => {
  test("uses one coherent backend inspection instead of separate list and artifact reads", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const backend = fakeBackend("cron");

    await akmTasksSync({ backend });

    expect(backend.inspectionCalls).toBe(1);
    expect(backend.splitReadCalls).toBe(0);
  });

  test.each([
    ["appearance", () => writeTask("beta", "echo beta", "0 2 * * *")],
    ["disappearance", () => fs.rmSync(path.join(storage.stashDir, "tasks", "alpha.yml"))],
    ["byte drift", () => writeTask("alpha", "echo changed", "30 1 * * *")],
  ] as const)("rejects desired source %s between projection and runtime preparation", async (_label, mutate) => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const backend = fakeBackend("cron");

    await expect(
      akmTasksSync({
        backend,
        schedulerRuntime() {
          mutate();
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      }),
    ).rejects.toThrow(/source|changed|read set|snapshot/i);

    expect(backend.stored.size).toBe(0);
    expect(backend.snapshotCalls).toBe(0);
    expect(backend.calls).toEqual([]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores an earlier create when a later create fails", async (name) => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    writeTask("beta", "echo beta", "0 2 * * *");
    const backend = fakeBackend(name, [], { kind: "install", id: "beta" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("install failed for beta");

    expect(backend.stored.size).toBe(0);
    expect(backend.snapshotCalls).toBe(1);
    expect(backend.restoreCalls).toBe(1);
    expect(backend.calls).toEqual(["install:alpha:cas", "install:beta:cas"]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores an earlier update when a later update fails", async (name) => {
    const alpha = binding("alpha", "0 1 * * *");
    const beta = binding("beta", "0 2 * * *");
    writeTask("alpha", "echo alpha", "15 1 * * *");
    writeTask("beta", "echo beta", "15 2 * * *");
    const backend = fakeBackend(name, [alpha, beta], { kind: "install", id: "beta" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("install failed for beta");

    expect(backend.stored.get("alpha")?.binding.cron).toBe("0 1 * * *");
    expect(backend.stored.get("beta")?.binding.cron).toBe("0 2 * * *");
    expect(backend.restoreCalls).toBe(1);
    expect(backend.calls).toEqual(["install:alpha:cas", "install:beta:cas"]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores an earlier removal when a later removal fails", async (name) => {
    const alpha = binding("alpha", "0 1 * * *");
    const beta = binding("beta", "0 2 * * *");
    const backend = fakeBackend(name, [alpha, beta], { kind: "uninstall", id: "beta" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("remove failed for beta");

    expect([...backend.stored.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(backend.restoreCalls).toBe(1);
    expect(backend.calls).toEqual(["remove:alpha:cas", "remove:beta:cas"]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores a mixed create/update/remove plan exactly", async (name) => {
    const update = binding("update", "0 1 * * *");
    const remove = binding("remove", "0 2 * * *");
    writeTask("create", "echo create", "0 3 * * *");
    writeTask("update", "echo update", "15 1 * * *");
    const backend = fakeBackend(name, [update, remove], { kind: "uninstall", id: "remove" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("remove failed for remove");

    expect([...backend.stored.keys()].sort()).toEqual(["remove", "update"]);
    expect(backend.stored.get("update")?.binding.cron).toBe("0 1 * * *");
    expect(backend.restoreCalls).toBe(1);
  });

  test("aggregates the primary mutation error with best-effort rollback failures", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    writeTask("beta", "echo beta", "0 2 * * *");
    const backend = fakeBackend("cron", [], { kind: "install", id: "beta" }, "alpha");

    let caught: unknown;
    try {
      await akmTasksSync({ backend });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String)).toEqual([
      "Error: install failed for beta",
      expect.stringContaining("partial rollback failure"),
    ]);
    expect(backend.restoreCalls).toBe(1);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s rollback CAS preserves a concurrent same-native edit and reports incomplete rollback", async (name) => {
    const alpha = binding("alpha", "0 1 * * *");
    writeTask("alpha", "echo alpha", "15 1 * * *");
    writeTask("beta", "echo beta", "0 2 * * *");
    const backend = fakeBackend(name, [alpha], { kind: "install", id: "beta" }, undefined, "alpha");

    let caught: unknown;
    try {
      await akmTasksSync({ backend });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(String(caught)).toMatch(/rollback|transaction/i);
    expect(backend.stored.get("alpha")?.fingerprint).toBe("concurrent-foreign-bytes");
    expect(backend.lastRollbackGuards?.map((guard) => guard.nativeId).sort()).toEqual(["alpha", "beta"]);
  });

  test("fails closed before mutation when a custom backend lacks coherent inspection", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    let installs = 0;
    const backend = {
      name: "cron",
      list: () => [],
      install: () => {
        installs += 1;
      },
      uninstall() {},
      setEnabled() {},
    } as unknown as TaskBackend;

    await expect(akmTasksSync({ backend })).rejects.toThrow(/coherent inspection/i);
    expect(installs).toBe(0);
  });

  test("fails closed before mutation when a custom backend lacks an exact transaction snapshot", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const complete = fakeBackend("cron");
    let installs = 0;
    const backend = {
      name: "cron",
      inspectBindings: complete.inspectBindings,
      expectedSignature: complete.expectedSignature,
      list: complete.list,
      install: () => {
        installs += 1;
      },
      uninstall() {},
      setEnabled() {},
    } as unknown as TaskBackend;

    await expect(akmTasksSync({ backend })).rejects.toThrow(/snapshot and restore/i);
    expect(installs).toBe(0);
  });
});
