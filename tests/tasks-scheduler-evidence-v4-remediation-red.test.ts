// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildCronLine, CRON_BACKEND, renderBlock } from "../src/tasks/backends/cron";
import { buildPlistXml, LAUNCHD_BACKEND } from "../src/tasks/backends/launchd";
import { buildSchtasksXml, SCHTASKS_BACKEND } from "../src/tasks/backends/schtasks";
import type { SchedulerBinding } from "../src/tasks/scheduler-binding";
import type { ScheduledTaskContext } from "../src/tasks/scheduler-invocation";
import {
  finalizeSchedulerSyncPlan,
  type PreparedSchedulerSourceSet,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncPlanInput,
} from "../src/tasks/scheduler-sync";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

interface WorkflowEvidenceV4 {
  ref: string;
  irVersion: 5;
  planHash: string;
  sourceReadSet: readonly unknown[];
  executionEvidenceDigest: string;
}

interface EvidenceBinding extends SchedulerBinding {
  readonly executionEvidenceDigest: string;
}

const CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "/srv/akm-bundle",
  AKM_CONFIG_DIR: "/srv/akm-config",
  AKM_DATA_DIR: "/srv/akm-data",
  AKM_CACHE_DIR: "/srv/akm-cache",
  AKM_STATE_DIR: "/srv/akm-state",
};

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: { team: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    defaults: { engine: "fixture" },
    engines: { fixture: { kind: "agent", platform: "opencode-sdk" } },
  });
});

afterEach(() => storage.cleanup());

function source(body: string): string {
  return [
    "name: Scheduled evidence",
    "on:",
    "  schedule:",
    "    - cron: '0 8 * * 1'",
    "jobs:",
    "  main:",
    "    runs-on: [self-hosted]",
    "    steps:",
    "      - id: work",
    `        run: ${body}`,
    "",
  ].join("\n");
}

function writeWorkflow(body: string): string {
  const file = path.join(storage.stashDir, "workflows", "scheduled.yml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source(body));
  return file;
}

function input(overrides: Partial<SchedulerSyncPlanInput> = {}): SchedulerSyncPlanInput {
  return {
    sourceRoot: storage.stashDir,
    adapterId: "akm",
    bundleName: "team",
    bundleTarget: "team",
    backend: "cron",
    installed: [],
    nativeArtifacts: [],
    ...overrides,
  };
}

function evidence(prepared: PreparedSchedulerSourceSet): WorkflowEvidenceV4 {
  const items = prepared.executableWorkflows as unknown as readonly WorkflowEvidenceV4[];
  const item = items[0];
  if (!item) throw new Error("expected scheduler workflow evidence");
  return item;
}

function workflowBinding(prepared: PreparedSchedulerSourceSet): EvidenceBinding {
  const item = prepared.desired.find((binding) => binding.logicalSource.kind === "workflow");
  if (!item) throw new Error("expected workflow scheduler binding");
  return item as EvidenceBinding;
}

function installedInput(binding: SchedulerBinding, signature: string): SchedulerSyncPlanInput {
  const nativeId = binding.nativeId ?? binding.id;
  const installed = {
    id: binding.id,
    nativeId,
    binding: ["/test/akm"],
    contextPath: "/test/context.json",
    signature,
    target: "team",
    invocation: binding.invocation,
  };
  const artifact = {
    nativeId,
    bindingId: binding.id,
    invocation: binding.invocation,
    fingerprint: signature,
  };
  return input({
    installed: [installed],
    nativeArtifacts: [artifact],
    inspection: { installed: [installed], artifacts: [artifact] },
    installOptions: { binding: ["/test/akm"], contextPath: "/test/context.json", target: "team" },
    expectedSignature: (candidate) => JSON.stringify(candidate),
  });
}

describe("scheduled workflow execution evidence", () => {
  test("canonical secret-free digest flows prepared evidence into the final workflow binding", async () => {
    const secret = "never-persist-scheduler-secret-7hR2";
    const envFile = path.join(storage.stashDir, "env", "runtime.env");
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, `TOKEN=${secret}\n`);
    writeWorkflow("printf scheduled");

    const prepared = await prepareSchedulerSyncSourceSet(input());
    const item = evidence(prepared);
    const binding = workflowBinding(prepared);

    expect(item.executionEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.executionEvidenceDigest).toBe(item.executionEvidenceDigest);
    expect(item.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item).not.toHaveProperty("planJson");
    expect(JSON.stringify(prepared)).not.toContain(secret);

    const plan = finalizeSchedulerSyncPlan(input(), prepared);
    expect((plan.desired[0] as EvidenceBinding).executionEvidenceDigest).toBe(item.executionEvidenceDigest);
    expect(JSON.stringify(plan)).not.toContain(secret);
  });

  test("same frozen body plans a no-op, while a body/read-set change plans an update", async () => {
    const file = writeWorkflow("printf first");
    const first = await prepareSchedulerSyncSourceSet(input());
    const firstBinding = workflowBinding(first);
    const firstSignature = JSON.stringify(firstBinding);

    const unchanged = await prepareSchedulerSyncSourceSet(input());
    const unchangedPlan = finalizeSchedulerSyncPlan(installedInput(firstBinding, firstSignature), unchanged);
    expect(unchangedPlan.unchanged).toEqual([firstBinding.id]);
    expect(unchangedPlan.updated).toEqual([]);

    fs.writeFileSync(file, source("printf second"));
    const changed = await prepareSchedulerSyncSourceSet(input());
    expect(evidence(changed).executionEvidenceDigest).not.toBe(evidence(first).executionEvidenceDigest);
    const changedPlan = finalizeSchedulerSyncPlan(installedInput(firstBinding, firstSignature), changed);
    expect(changedPlan.updated).toEqual([firstBinding.id]);
    expect(changedPlan.unchanged).toEqual([]);
  });

  test("a transitive task/script read-set change plans an update without changing the workflow body", async () => {
    const taskFile = path.join(storage.stashDir, "tasks", "child.yml");
    const scriptFile = path.join(storage.stashDir, "scripts", "child.sh");
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
    fs.writeFileSync(taskFile, "version: 4\nuses: scripts/child.sh\n");
    fs.writeFileSync(scriptFile, "#!/bin/sh\nprintf first\n");
    const workflowFile = path.join(storage.stashDir, "workflows", "scheduled.yml");
    fs.mkdirSync(path.dirname(workflowFile), { recursive: true });
    fs.writeFileSync(
      workflowFile,
      [
        "name: Scheduled evidence",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: work",
        "        uses: tasks/child",
        "",
      ].join("\n"),
    );

    const first = await prepareSchedulerSyncSourceSet(input());
    const firstBinding = workflowBinding(first);
    const firstSignature = JSON.stringify(firstBinding);

    fs.writeFileSync(scriptFile, "#!/bin/sh\nprintf second\n");
    const changed = await prepareSchedulerSyncSourceSet(input());
    expect(evidence(changed).executionEvidenceDigest).not.toBe(evidence(first).executionEvidenceDigest);
    const changedPlan = finalizeSchedulerSyncPlan(installedInput(firstBinding, firstSignature), changed);
    expect(changedPlan.updated).toEqual([firstBinding.id]);
    expect(changedPlan.unchanged).toEqual([]);
  });

  test("cron, launchd, and schtasks fingerprints include evidence without changing the public invocation ABI", async () => {
    writeWorkflow("printf backend");
    const prepared = await prepareSchedulerSyncSourceSet(input());
    const original = workflowBinding(prepared);
    const changed = { ...original, executionEvidenceDigest: "f".repeat(64) } satisfies EvidenceBinding;
    expect(changed.invocation).toEqual(original.invocation);
    expect(changed.invocation).toEqual(["workflow", "run", "team//workflows/scheduled"]);

    const backends = [
      CRON_BACKEND({ akmArgv: ["/abs/akm"], logDir: "/logs", envPath: false, scheduledContext: CONTEXT }),
      LAUNCHD_BACKEND({ akmArgv: ["/abs/akm"], logDir: "/logs", envPath: false, scheduledContext: CONTEXT }),
      SCHTASKS_BACKEND({
        akmArgv: ["C:\\akm.exe"],
        logDir: "C:\\logs",
        scheduledContext: CONTEXT,
        userSid: "S-1-5-21-1000",
      }),
    ];
    for (const backend of backends) {
      expect(backend.expectedSignature?.(original)).toBeTruthy();
      expect(backend.expectedSignature?.(changed)).not.toBe(backend.expectedSignature?.(original));
    }

    const cronLine = buildCronLine(original, ["/abs/akm"], "/logs", "/context.json");
    const nativeBodies = [
      renderBlock(original.nativeId ?? original.id, cronLine, original.enabled, original.executionEvidenceDigest),
      buildPlistXml(original, ["/abs/akm"], "/logs", "/context.json"),
      buildSchtasksXml(original, ["C:\\akm.exe"], "C:\\logs", {
        contextPath: "C:\\context.json",
        userSid: "S-1-5-21-1000",
        now: () => new Date("2026-08-22T12:00:00Z"),
      }),
    ];
    for (const nativeBody of nativeBodies) {
      expect(nativeBody).toContain(original.executionEvidenceDigest);
    }
  });
});
