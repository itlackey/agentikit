// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane C — fixtures): proves the shared fixture surface
 * this file owns is itself sound today, before Lanes A and B build on it.
 *
 * This file does not pin an R-nn/P-nn row from docs/plans/specs/p0-invariants.md
 * directly — it exercises the fixture families Lane C contributes:
 *
 *   - tests/fixtures/execution-contracts/workflows/single-job/    the accepted
 *     single-job GitHub-shaped baseline, cribbed from the existing
 *     workflows/equivalent/contract-review.yml accepted subset, contrasted
 *     against R-05/P-08's multi-job fixtures elsewhere.
 *   - tests/fixtures/execution-contracts/workflows/plan-v4/       source
 *     fixtures (never byte-snapshots of plans — plans carry machine-dependent
 *     identity) that freeze end to end into durable v4 plans, proving the
 *     structural invariants a later phase's plan-shape assertions can lean on.
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.24) DELETED this
 * file's third original family — tests/fixtures/execution-contracts/tasks/
 * v3-migration/'s representative task-v3 sources and the describe block that
 * proved each parsed per src/tasks/source-v3.ts — along with task source v3
 * acceptance itself; the fixture family it exercised is gone too (F-A2.25).
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
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import {
  decodeWorkflowPlanV4,
  type FrozenWorkflowTarget,
  type WorkflowPlanGraphV4,
} from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { compileGithubWorkflowSource } from "../../src/workflows/source-ir/compile";
import { EXECUTION_CONTRACT_FIXTURES } from "../_helpers/execution-contracts";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const WORKFLOWS_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "workflows");

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

// ── workflows/manifest.json's childWorkflow extension (P3b Lane C) ──────────

interface ChildWorkflowManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly ref: string;
  readonly expectedStepTargetKinds: Record<string, string>;
  /** Step id -> the composed child's ref (unqualified, e.g. "workflows/leaf"). Present only on composing entries. */
  readonly expectedChildRefs?: Record<string, string>;
  /** Count of distinct embedded plan documents in this entry's deepest composition chain. Present only on composing entries. */
  readonly expectedChildDepth?: number;
}

interface ChildWorkflowManifestFragment {
  readonly bundleRoot: string;
  readonly workflows: readonly ChildWorkflowManifestEntry[];
  readonly expectedTargetKindSet: readonly string[];
}

interface WorkflowsManifestFragment {
  readonly singleJob: SingleJobManifestEntry;
  readonly planV4: PlanV4ManifestEntry;
  readonly childWorkflow: ChildWorkflowManifestFragment;
}

function readWorkflowsManifest(): WorkflowsManifestFragment {
  return JSON.parse(fs.readFileSync(path.join(WORKFLOWS_ROOT, "manifest.json"), "utf8")) as WorkflowsManifestFragment;
}

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

// ── workflows/child-workflow: structural invariants of a real durable v4 ────
// ── freeze containing child-workflow targets (P3b Lane C, spec §5.5,     ────
// ── rows C-08…C-13) ───────────────────────────────────────────────────────
//
// New describe blocks only — every block above this comment (including
// "workflows/plan-v4 fixture registration" and its freeze-loop sibling) is
// byte-unchanged (row C-13).

/** The frozen target of one step, or undefined for a route-only step. Mirrors this file's own `stepTargetKinds`. */
function stepTargetById(plan: WorkflowPlanGraphV4, stepId: string): FrozenWorkflowTarget | undefined {
  const step = plan.steps.find((s) => s.stepId === stepId);
  if (!step?.root) return undefined;
  return step.root.kind === "map" ? step.root.template.frozenTarget : step.root.frozenTarget;
}

/** Every `child-workflow` target in `plan.steps`, recursing into each one's own embedded `frozenPlan`. */
function everyChildWorkflowTarget(
  plan: WorkflowPlanGraphV4,
  visit: (target: Extract<FrozenWorkflowTarget, { kind: "child-workflow" }>) => void,
): void {
  for (const step of plan.steps) {
    if (!step.root) continue;
    const target = step.root.kind === "map" ? step.root.template.frozenTarget : step.root.frozenTarget;
    if (target.kind !== "child-workflow") continue;
    visit(target);
    everyChildWorkflowTarget(target.frozenPlan, visit);
  }
}

/** C-11: every embedded child plan's `planHash` is a real function of its own `frozenPlan` bytes, at every nesting level. */
function assertEveryChildPlanHashMatches(plan: WorkflowPlanGraphV4): void {
  everyChildWorkflowTarget(plan, (target) => {
    expect(computePlanHash(target.frozenPlan)).toBe(target.planHash);
    expect(target.frozenPlan.irVersion).toBe(5);
  });
}

/** Count of distinct embedded plan documents in `plan`'s deepest `child-workflow` composition chain (the top plan itself counts as 1). */
function deepestChildPlanDepth(plan: WorkflowPlanGraphV4): number {
  let deepest = 1;
  for (const step of plan.steps) {
    if (!step.root) continue;
    const target = step.root.kind === "map" ? step.root.template.frozenTarget : step.root.frozenTarget;
    if (target.kind !== "child-workflow") continue;
    deepest = Math.max(deepest, 1 + deepestChildPlanDepth(target.frozenPlan));
  }
  return deepest;
}

/**
 * Reads `frozenPlan.outputs` without depending on the not-yet-added
 * `WorkflowPlanGraphV4.outputs` TS field (P3b Lane B, spec B-N1) — mirrors
 * `tests/workflows/workflow-outputs-source.test.ts`'s `outputsView` cast
 * convention. A bare cast through `unknown` is always type-legal, so this
 * needs no `@ts-expect-error` directive; Lane B's own landing of the real
 * field does not require this helper to change.
 */
function embeddedOutputs(frozenPlan: WorkflowPlanGraphV4): Record<string, { from?: unknown }> | undefined {
  return (frozenPlan as unknown as { outputs?: Record<string, { from?: unknown }> }).outputs;
}

describe("workflows/child-workflow fixture registration", () => {
  // CHARACTERIZATION: pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("every *.yml AND *.md under child-workflow/workflows is registered in workflows/manifest.json's childWorkflow.workflows (no orphan fixtures)", () => {
    const manifest = readWorkflowsManifest().childWorkflow;
    const dir = path.join(WORKFLOWS_ROOT, manifest.bundleRoot, "workflows");
    // Unlike planV4's `.yml`-only enumeration (byte-unchanged above), this
    // family registers BOTH extensions: the parent must be GitHub-shaped
    // (only `jobs.<id>.steps[].uses` composes) while a child declaring
    // `outputs:` must be Markdown (B-N4) — so both live directly under this
    // one `workflows/` directory and both must be swept.
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".md"))
      .sort();
    const registered = manifest.workflows.map((workflow) => path.basename(workflow.file)).sort();
    expect(files).toEqual(registered);
  });
});

describe("workflows/child-workflow fixtures — freeze end to end, including child-workflow targets (rows C-08…C-12)", () => {
  const manifest = readWorkflowsManifest().childWorkflow;
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
    // RED until Lane B's `outputs:` frontmatter key parses (`exporter` and
    // `child-with-outputs`, which composes it, both fail to freeze today —
    // see workflow-outputs-source.test.ts's own header). `direct-child`,
    // `task-wrapped-child`, `leaf`, `mid`, and `three-level` freeze
    // successfully already: P3a's freeze-side child-workflow support is
    // shipped, so composition-only entries are a green characterization
    // here, not a red one — only the outputs-dependent entries are new red
    // coverage (§5.5, C-10).
    test(`${workflow.id}: freezes with the manifest-declared per-step frozen target kinds, including child-workflow entries (C-10)`, async () => {
      const plan = await freeze(workflow.ref);
      expect(plan.irVersion).toBe(5);
      expect(stepTargetKinds(plan)).toEqual(workflow.expectedStepTargetKinds);

      for (const [stepId, expectedRef] of Object.entries(workflow.expectedChildRefs ?? {})) {
        const target = stepTargetById(plan, stepId);
        expect(target?.kind).toBe("child-workflow");
        if (target?.kind === "child-workflow") {
          expect(target.ref.endsWith(`//${expectedRef}`)).toBe(true);
        }
      }

      assertEveryChildPlanHashMatches(plan);

      if (workflow.expectedChildDepth !== undefined) {
        expect(deepestChildPlanDepth(plan)).toBe(workflow.expectedChildDepth);
      }
    });
  }

  // CHARACTERIZATION: pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip.
  test("frozen target kinds across the fixture set are exactly child-workflow, command, and shell (C-08)", async () => {
    const kinds = new Set<string>();
    for (const workflow of manifest.workflows) {
      const plan = await freeze(workflow.ref);
      for (const kind of Object.values(stepTargetKinds(plan))) kinds.add(kind);
    }
    expect([...kinds].sort()).toEqual([...manifest.expectedTargetKindSet].sort());
  });

  // RED until outputs: parses (workflow-outputs-source.test.ts) — the embedded
  // exporter.md plan carries no `outputs` field today, so `embeddedOutputs`
  // returns undefined and `.report` fails.
  test("child-with-outputs: the embedded exporter child plan carries a declared `report` output (C-12)", async () => {
    const workflow = manifest.workflows.find((entry) => entry.id === "child-with-outputs");
    if (!workflow) throw new Error("childWorkflow manifest must register a child-with-outputs entry");
    const plan = await freeze(workflow.ref);
    const target = stepTargetById(plan, "dispatch");
    expect(target?.kind).toBe("child-workflow");
    if (target?.kind === "child-workflow") {
      expect(embeddedOutputs(target.frozenPlan)?.report?.from).toBe("steps.summarize.output");
    }
  });

  // CHARACTERIZATION: pins behavior that must be PRESERVED through every later phase — a failure here is a regression, not an intended flip. Recursive freeze-side embedding is P3a's own shipped capability (tests/workflows/child-workflow-freeze.test.ts already exercises a deep composition chain), so this row is green today, not red.
  test("three-level: the embedded chain is 3 plans deep, each level's planHash verified (C-11)", async () => {
    const workflow = manifest.workflows.find((entry) => entry.id === "three-level");
    if (!workflow) throw new Error("childWorkflow manifest must register a three-level entry");
    const plan = await freeze(workflow.ref);
    expect(deepestChildPlanDepth(plan)).toBe(3);
    assertEveryChildPlanHashMatches(plan);
  });
});
