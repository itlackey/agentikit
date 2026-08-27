// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane C — fixtures): proves the shared fixture surface
 * this file owns is itself sound today, before Lanes A and B build on it.
 *
 * This file does not pin an R-nn/P-nn row from docs/plans/specs/p0-invariants.md
 * directly — it exercises the three new fixture families Lane C contributes:
 *
 *   - tests/fixtures/execution-contracts/tasks/v3-migration/     representative
 *     task-v3 sources the future v3->v4 migrator must handle (every trigger
 *     form, every target form, and the env/timeout/redact option bundle).
 *   - tests/fixtures/execution-contracts/workflows/single-job/    the accepted
 *     single-job GitHub-shaped baseline, cribbed from the existing
 *     workflows/equivalent/contract-review.yml accepted subset, contrasted
 *     against R-05/P-08's multi-job fixtures elsewhere.
 *   - tests/fixtures/execution-contracts/workflows/plan-v4/       source
 *     fixtures (never byte-snapshots of plans — plans carry machine-dependent
 *     identity) that freeze end to end into durable v4 plans, proving the
 *     structural invariants a later phase's plan-shape assertions can lean on.
 *
 * Fixture pattern for the plan-v4 sandbox/freeze pipeline follows
 * tests/workflows/characterization-with-drop.test.ts and
 * tests/workflows/characterization-classification.test.ts (withIsolatedAkmStorage
 * + writeWorkflowTestConfig + akmIndex + startWorkflowRun + withWorkflowRunsRepo
 * + decodeWorkflowPlanV4).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import type { ExecutionJsonObject } from "../../src/execution/json";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import {
  parseTaskV3Yaml,
  type TaskV3Environment,
  type TaskV3HostShell,
  type TaskV3UsesTarget,
} from "../../src/tasks/source-v3";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { decodeWorkflowPlanV4, type WorkflowPlanGraphV4 } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { compileGithubWorkflowSource } from "../../src/workflows/source-ir/compile";
import { EXECUTION_CONTRACT_FIXTURES } from "../_helpers/execution-contracts";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const TASKS_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "tasks/v3-migration");
const WORKFLOWS_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "workflows");

// ── tasks/v3-migration manifest shape ────────────────────────────────────────

type TaskV3MigrationExpectedTarget =
  | { readonly kind: "run"; readonly run: string; readonly shell?: TaskV3HostShell }
  | {
      readonly kind: "uses";
      readonly usesKind: TaskV3UsesTarget["kind"];
      readonly ref: string;
      readonly with?: ExecutionJsonObject;
    };

interface TaskV3MigrationExpected {
  readonly triggers: {
    readonly manual: boolean;
    readonly schedules: ReadonlyArray<{ cron: string; source: string; ordinal: number }>;
  };
  readonly target: TaskV3MigrationExpectedTarget;
  readonly env?: TaskV3Environment;
  readonly akmTimeout?: string;
  readonly akmRedact?: readonly string[];
}

interface TaskV3MigrationFixture {
  readonly id: string;
  readonly file: string;
  readonly represents: readonly string[];
  readonly expected: TaskV3MigrationExpected;
}

interface TaskV3MigrationManifest {
  readonly schemaVersion: 1;
  readonly sourceSchemaVersion: 3;
  readonly fixtures: readonly TaskV3MigrationFixture[];
}

function readTasksManifest(): TaskV3MigrationManifest {
  return JSON.parse(fs.readFileSync(path.join(TASKS_ROOT, "manifest.json"), "utf8")) as TaskV3MigrationManifest;
}

// ── workflows/manifest.json's singleJob + planV4 extensions ─────────────────

interface SingleJobManifestEntry {
  readonly file: string;
  readonly expectedJobId: string;
  readonly expectedStepIds: readonly string[];
}

interface PlanV4WorkflowEntry {
  readonly id: string;
  readonly file: string;
  readonly ref: string;
  readonly expectedStepTargetKinds: Record<string, string>;
  readonly taskComposedRelativeRefs?: readonly string[];
}

interface PlanV4ManifestEntry {
  readonly bundleRoot: string;
  readonly workflows: readonly PlanV4WorkflowEntry[];
  readonly expectedTargetKindSet: readonly string[];
}

interface WorkflowsManifestFragment {
  readonly singleJob: SingleJobManifestEntry;
  readonly planV4: PlanV4ManifestEntry;
}

function readWorkflowsManifest(): WorkflowsManifestFragment {
  return JSON.parse(fs.readFileSync(path.join(WORKFLOWS_ROOT, "manifest.json"), "utf8")) as WorkflowsManifestFragment;
}

// ── tasks/v3-migration: every fixture is valid v3 per src/tasks/source-v3.ts ─

describe("tasks/v3-migration fixtures (Lane C shared surface) — each is valid task-v3 source", () => {
  const manifest = readTasksManifest();

  for (const fixture of manifest.fixtures) {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); flips in P2a/P2c (task source v4
    // makes scheduling optional and P4a retires v3 acceptance — these v3 fixtures then serve the migrator only).
    test(`${fixture.id}: parses per src/tasks/source-v3.ts and matches its manifest-declared shape`, () => {
      const yaml = fs.readFileSync(path.join(TASKS_ROOT, fixture.file), "utf8");
      const document = parseTaskV3Yaml({ yaml, filePath: `tasks/v3-migration/${fixture.file}` });

      expect(document.version).toBe(3);
      expect(document.triggers).toEqual(fixture.expected.triggers);

      if (fixture.expected.target.kind === "run") {
        expect(document.target.kind).toBe("run");
        if (document.target.kind !== "run") return;
        expect(document.target.run).toBe(fixture.expected.target.run);
        if (fixture.expected.target.shell) expect(document.target.shell).toBe(fixture.expected.target.shell);
        else expect(document.target.shell).toBeUndefined();
      } else {
        expect(document.target.kind).toBe("uses");
        if (document.target.kind !== "uses") return;
        expect(document.target.uses.kind).toBe(fixture.expected.target.usesKind);
        expect(document.target.uses.ref).toBe(fixture.expected.target.ref);
        if (fixture.expected.target.with) expect(document.target.with).toEqual(fixture.expected.target.with);
      }

      if (fixture.expected.env) expect(document.env).toEqual(fixture.expected.env);
      if (fixture.expected.akmTimeout !== undefined) expect(document.akm?.timeout).toBe(fixture.expected.akmTimeout);
      if (fixture.expected.akmRedact) expect(document.akm?.redact).toEqual(fixture.expected.akmRedact);
    });
  }

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("every *.yml fixture file is registered in manifest.json (no orphan fixtures)", () => {
    const files = fs
      .readdirSync(TASKS_ROOT)
      .filter((name) => name.endsWith(".yml"))
      .sort();
    const registered = manifest.fixtures.map((fixture) => fixture.file).sort();
    expect(files).toEqual(registered);
  });
});

// ── workflows/single-job: the accepted single-job baseline ──────────────────

describe("workflows/single-job fixture — the accepted single-job baseline parses and compiles today", () => {
  const fixture = readWorkflowsManifest().singleJob;
  const yaml = fs.readFileSync(path.join(WORKFLOWS_ROOT, fixture.file), "utf8");

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("parses via compileGithubWorkflowSource into exactly one job with the manifest-declared step ids", () => {
    const result = compileGithubWorkflowSource(yaml, { path: "workflows/single-job.yml" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.jobs).toHaveLength(1);
    expect(result.ir.jobs[0]?.id).toBe(fixture.expectedJobId);
    expect(result.ir.jobs[0]?.steps.map((step) => step.id)).toEqual([...fixture.expectedStepIds]);
  });

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("compiles cleanly via compileWorkflowPlan — the single-job acceptance R-05/P-08's multi-job rejection contrasts against", () => {
    const parsed = compileGithubWorkflowSource(yaml, { path: "workflows/single-job.yml" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const compiled = compileWorkflowPlan(parsed.ir, "single-job");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.steps.map((step) => step.stepId)).toEqual([...fixture.expectedStepIds]);
  });
});

// ── workflows/plan-v4: structural invariants of a real durable v4 freeze ────

/** Recursively copy a fixture bundle-root subtree into a sandboxed stash. */
function copyFixtureTree(sourceDir: string, destDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyFixtureTree(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

/** Map every non-route step id to its frozen target's `kind`. */
function stepTargetKinds(plan: WorkflowPlanGraphV4): Record<string, string> {
  const kinds: Record<string, string> = {};
  for (const step of plan.steps) {
    if (!step.root) continue;
    kinds[step.stepId] = step.root.kind === "map" ? step.root.template.frozenTarget.kind : step.root.frozenTarget.kind;
  }
  return kinds;
}

describe("workflows/plan-v4 fixture registration", () => {
  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("every *.yml under plan-v4/workflows is registered in workflows/manifest.json's planV4.workflows (no orphan fixtures)", () => {
    const manifest = readWorkflowsManifest().planV4;
    const dir = path.join(WORKFLOWS_ROOT, manifest.bundleRoot, "workflows");
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".yml"))
      .sort();
    const registered = manifest.workflows.map((workflow) => path.basename(workflow.file)).sort();
    expect(files).toEqual(registered);
  });
});

describe("workflows/plan-v4 fixtures — freeze end to end into structurally valid durable v4 plans", () => {
  const manifest = readWorkflowsManifest().planV4;
  let storage: IsolatedAkmStorage;

  beforeEach(async () => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
    copyFixtureTree(path.join(WORKFLOWS_ROOT, manifest.bundleRoot), storage.stashDir);
    await akmIndex({ stashDir: storage.stashDir, full: true });
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  async function freeze(ref: string): Promise<WorkflowPlanGraphV4> {
    const started = await startWorkflowRun(ref);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    return decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
  }

  for (const workflow of manifest.workflows) {
    // F-A1 (docs/plans/specs/p3a-plan-v5-child-freeze.md §6): this row is the
    // flip the P0 comment here used to promise ("flips in P3a"). Plan
    // irVersion bumps to 5 once schema-v4.ts's WORKFLOW_IR_V5_VERSION lands
    // (§1.8 A-N1) — the manifest-declared target-kind set is untouched, these
    // fixtures are workflow SOURCES, not plan bytes. `.toBe<number>(5)`
    // widens the comparison past `plan.irVersion`'s still-literal-4 type
    // (Implement's type change makes this assertion valid either way, so no
    // `@ts-expect-error` directive is needed or left behind).
    test(`${workflow.id}: freezes to irVersion 5 with the manifest-declared per-step frozen target kinds`, async () => {
      const plan = await freeze(workflow.ref);
      expect(plan.irVersion).toBe<number>(5);
      expect(stepTargetKinds(plan)).toEqual(workflow.expectedStepTargetKinds);
    });
  }

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("frozen target kinds across the fixture set are exactly command, script, and shell", async () => {
    const kinds = new Set<string>();
    for (const workflow of manifest.workflows) {
      const plan = await freeze(workflow.ref);
      for (const kind of Object.values(stepTargetKinds(plan))) kinds.add(kind);
    }
    expect([...kinds].sort()).toEqual([...manifest.expectedTargetKindSet].sort());
  });

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every later phase — a failure here is
  // a regression, not an intended flip (the read set must keep covering task-composed refs after P3a's re-freeze).
  test("task-composed.yml's source read set covers every task-composed ref, all as relative paths", async () => {
    const workflow = manifest.workflows.find((entry) => entry.id === "task-composed");
    if (!workflow?.taskComposedRelativeRefs) {
      throw new Error("plan-v4 manifest must register a task-composed workflow fixture with taskComposedRelativeRefs");
    }
    const plan = await freeze(workflow.ref);
    const files = plan.sourceReadSet.map((source) => source.identity.file);
    for (const relative of workflow.taskComposedRelativeRefs) expect(files).toContain(relative);
    for (const file of files) expect(path.isAbsolute(file)).toBe(false);
  });
});
