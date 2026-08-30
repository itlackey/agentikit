// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane A): the workflow-step `uses:` classification
 * matrix, the nested-workflow rejection sites (R-03), and (P4 FLIP,
 * docs/plans/specs/p4-deletions-closeout.md §3.3) the ONE multi-job
 * adapter-boundary rejection that replaced R-05/P-08's parse-vs-execute
 * split.
 *
 * See docs/plans/specs/p0-invariants.md, "Lane pin checklists" / Lane A, for
 * the authoritative source-site citations reproduced in the comments below.
 * Every test pins an OBSERVABLE surface (error type + code + verbatim
 * message, or a returned shape) rather than a private helper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { compileGithubWorkflowSource } from "../../src/workflows/source-ir/compile";
import { classifyWorkflowStepUses, WorkflowSourceSemanticError } from "../../src/workflows/source-ir/semantics";
import type { WorkflowSourceUsesTarget } from "../../src/workflows/source-ir/uses";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

/** Capture a synchronous throw once, so a message/code pin never re-invokes the function under test. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

/** Capture a promise rejection once, so a message/code pin never re-invokes the function under test. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

// classifyTaskV3Uses — the GitHub-action locator grammar this describe block
// used to pin (R-04(a), F-A1.3/F-A1.4) — is DELETED along with task source
// v3 acceptance itself (P4 docs/plans/specs/p4-deletions-closeout.md §3.2.3,
// F-A2.1: "the parser" including its uses: classifier is vendored into the
// migrator, never re-accepted by `src`). The vendored copy
// (src/tasks/source/task-source-v3-frozen.ts) is deliberately
// FROZEN at its pre-A1 shape — it still accepts a locator-shaped ref, since
// a real migration source may still contain one — so it cannot stand in for
// this block's post-A1-flip expectations, and task source v4's own
// classifyTaskSourceV4Uses (src/tasks/source/task-source-v4.ts) rejects the
// same inputs through a different code/message taxonomy (TARGET_REF_INVALID
// for a non-locator-shaped ref, INVALID_FLAG_VALUE with the B-11 message for
// a locator-shaped one) — not a byte-compatible successor to re-point this
// block at. The locator grammar's absence stays pinned elsewhere: row
// F-A1.7 (tests/execution/target-ref.test.ts, the canonical classifier) and
// F-A1.9 (tests/workflows/source-ir-contract.test.ts, the workflow-step
// parity table).

// ── classifyWorkflowStepUses: task-ref delegation, and the two direct- ──────
// ── rejection kinds it wraps around the injected classifier ────────────────

describe("classifyWorkflowStepUses — task-ref delegation (source-ir/semantics.ts) FLIPPED in P4", () => {
  // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1.2, row B-09;
  // implementer addition to §7.1 per the F-A1.19/F-A3.7 pattern — recorded in
  // the commit body and the Review log): `canonicalTaskTarget`, the
  // locator-parity pre-check that used to intercept a task ref BEFORE ever
  // calling the classifier, is deleted along with the locator grammar it
  // existed to keep priority over (P1a §4.3's own rationale). With the
  // locator gone, `classifyTargetRef`'s own `tasks/` arm is the one authority
  // (brief §8.1) — the classifier is now called for every value, task refs
  // included, superseding this test's old "never calling the delegated
  // classifier" pin.
  test("B-09: 'tasks/x' is classified by delegating to the classifier, not intercepted ahead of it", () => {
    let calls = 0;
    let seen: string | undefined;
    const spy = (value: string): WorkflowSourceUsesTarget => {
      calls++;
      seen = value;
      return { kind: "task", ref: value };
    };
    const result = classifyWorkflowStepUses("tasks/build", spy);
    expect(calls).toBe(1);
    expect(seen).toBe("tasks/build");
    expect(result).toEqual({ kind: "task", ref: "tasks/build" });

    // The default classifier (classifyWorkflowSourceUses -> classifyTargetRef)
    // reaches the identical answer with no injection at all.
    expect(classifyWorkflowStepUses("tasks/build")).toEqual({ kind: "task", ref: "tasks/build" });
  });

  // CHARACTERIZATION (P0): pins behavior that must be PRESERVED through every
  // later phase — a failure here is a regression, not an intended flip.
  test("delegates every non-task-ref uses string to the injected classifier", () => {
    let calls = 0;
    let seen: string | undefined;
    const spy = (value: string): WorkflowSourceUsesTarget => {
      calls++;
      seen = value;
      return { kind: "command", ref: value };
    };
    const result = classifyWorkflowStepUses("commands/review", spy);
    expect(calls).toBe(1);
    expect(seen).toBe("commands/review");
    expect(result).toEqual({ kind: "command", ref: "commands/review" });
  });

  // P3a FLIP (docs/plans/specs/p3a-plan-v5-child-freeze.md §1.5/§6 F-B1, row
  // B-01): R-03's FIRST site — semantics.ts:155-159 (A-N3's head-verified
  // line numbers) — no longer throws. Classification returns the workflow
  // target and freeze decides (A-N4): a direct 'uses: workflows/x' step
  // classifies exactly like any other target-ref-shaped uses:.
  test("R-03 (site 1/3, semantics.ts:155-159) FLIPPED in P3a: a direct 'uses: workflows/x' step classifies as kind workflow and throws nothing", () => {
    const result = classifyWorkflowStepUses("workflows/child");
    expect(result).toEqual({ kind: "workflow", ref: "workflows/child" });
  });

  // P4 FLIP (row B-05, F-A1.6): the github-locator-shape override that used
  // to promote this to remote-action-acquisition-out-of-scope is deleted
  // (§3.1.2) — the classifier (classifyTargetRef, no locator grammar) rejects
  // it as an unrecognized ref shape, and usesFailure's generic fallback code
  // wins with no override left to beat it.
  test("R-04(c) FLIPPED in P4: a GitHub-action-shaped uses: in a workflow step now falls to the generic unsupported-uses-target rejection", () => {
    const error = thrown(() => classifyWorkflowStepUses("actions/checkout@v4"));
    expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
    expect((error as WorkflowSourceSemanticError).code).toBe("unsupported-uses-target");
    expect((error as Error).message).toBe(
      'Target ref "actions/checkout@v4" must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.',
    );
  });
});

// ── R-03, sites 2 and 3: a task-composed nested-workflow target ─────────────

describe("R-03 (sites 2/3, freeze/targets/task.ts:116,149) FLIPPED in P3a — a task-composed workflow target", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  // P3a FLIP (spec §1.5/§6 F-B1, row B-12): both source sites this describe
  // block used to pin — the task.target.kind check (task.ts:116) and the
  // post-prepare prepared.kind check (task.ts:149), A-N3's corrected line
  // numbers for the pre-P2b-split source-freeze-v4.ts:220-222/:237-239 §1.1
  // cites — now route to the ONE childWorkflowDispatch resolver instead of
  // throwing "A workflow task step cannot compose a nested workflow target."
  // (row B-16: rg "cannot compose a nested workflow" src/ is empty). A
  // workflow step composing a task whose own uses: targets a workflow
  // freezes to a child-workflow target, via: "task", carrying the composing
  // task's qualified ref — exactly as it did for the v3 fixture this test
  // already used pre-flip (the ONLY reachable site, per the pre-flip trailing
  // comment this edit removes: the second site stays dead-in-practice, same
  // as before — a fixture that reaches taskDispatch's target.kind==="uses"
  // guard can never independently also drive prepareTaskV3Execution's
  // returned kind==="workflow" check).
  test("a workflow step composing a task whose own uses: is a workflow freezes to a child-workflow target, via task", async () => {
    write(
      storage.stashDir,
      "tasks/nested-workflow-task.yml",
      ["version: 4", "uses: workflows/child", 'schedule: "@daily"', ""].join("\n"),
    );
    write(
      storage.stashDir,
      "workflows/child.yml",
      [
        "name: Child",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps: [{ id: work, run: echo child, shell: sh }]",
        "",
      ].join("\n"),
    );
    write(
      storage.stashDir,
      "workflows/nested-composition.yml",
      [
        "name: Nested composition",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: tasks/nested-workflow-task",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/nested-composition");
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const root = plan.steps[0]?.root;
    const target: FrozenWorkflowTarget | undefined = root && root.kind !== "map" ? root.frozenTarget : undefined;

    expect(target).toMatchObject({
      kind: "child-workflow",
      via: "task",
      taskRef: expect.stringContaining("tasks/nested-workflow-task"),
    });
  });
});

// ── R-02: a direct scripts/<ref> workflow step (directScript) ──────────────

describe("R-02 — a direct scripts/<ref> workflow step (source-freeze-v4.ts:274-298, directScript)", () => {
  describe("end-to-end", () => {
    let storage: IsolatedAkmStorage;

    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      writeWorkflowTestConfig();
      resetConfigCache();
    });

    afterEach(() => {
      resetConfigCache();
      storage.cleanup();
    });

    // directScript() (source-freeze-v4.ts:274-298) fabricates a synthetic task
    // document for this workflow step:
    //   yaml = `version: 3\nuses: ${owned.ref}\nakm:\n  schedule: "@daily"\n`
    //   filePath = `${asset.path}#${step.id}`, taskId = step.id,
    //   taskRef = `${asset.ref}#${step.id}`, bundleRoot = asset.sourcePath.
    // Those identity fields (filePath/taskId/taskRef) are computed by
    // directScript() but are NOT read by scriptResult() in source-freeze-v4.ts
    // — only prepared.sourceRef/.interpreter/.extension/.bytesBase64/
    // .byteLength/.sha256/.cwdIdentity flow into the frozen
    // FrozenWorkflowScriptTarget (its `ref` is the SCRIPT's own qualified ref,
    // pinned below — not this workflow-path#step-id shape). The identity
    // contract is therefore not observable anywhere production surfaces and is
    // not pinned by a test; see the P0 review log (p0-invariants.md:197-212).
    // This test pins only the observable surface: the script's own qualified
    // ref, its exact bytes, and its interpreter.
    //
    // Also at source-freeze-v4.ts:296: `if (prepared.kind !== "script") throw
    // new Error("direct script did not project as a script")` is a bare,
    // uncoded invariant (exit 70, not a UsageError). As written it cannot be
    // triggered from directScript()'s own call site: `owned.ref` is always
    // built from `plural = "scripts"` (resolveOwnedAssetCore), so the
    // synthetic document's `uses:` is always scripts/-family-shaped and
    // therefore always classifies (and prepares) as kind "script". No fixture
    // reachable through directScript can make prepareTaskV3Execution return
    // anything else — the same unreachable-in-practice shape as R-03's third
    // site above; it is likewise not pinned by a test — see the P0 review log
    // (p0-invariants.md:185-195).
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
    // phase flips this deliberately. Flips in P1b (typed preparer).
    test("a workflow step 'uses: scripts/<ref>' freezes to a script dispatch carrying the script's own qualified ref and exact bytes", async () => {
      write(storage.stashDir, "scripts/exact.sh", "#!/bin/sh\nprintf direct-script\n");
      write(
        storage.stashDir,
        "workflows/script-step.yml",
        [
          "name: Script step",
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  main:",
          "    runs-on: [self-hosted]",
          "    steps:",
          "      - id: run-script",
          "        uses: scripts/exact.sh",
          "",
        ].join("\n"),
      );
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const started = await startWorkflowRun("workflows/script-step");
      const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
      const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
      const root = plan.steps[0]?.root;
      const target = root && root.kind !== "map" ? root.frozenTarget : undefined;

      expect(target?.kind).toBe("script");
      if (!target || target.kind !== "script") return;
      expect(target.ref).toMatch(/\/\/scripts\/exact\.sh$/);
      expect(Buffer.from(target.bytesBase64, "base64").toString("utf8")).toBe("#!/bin/sh\nprintf direct-script\n");
      expect(target.interpreter).toBe("sh");
    });
  });
});

// ── R-05/P-08 RETIRED in P4 (docs/plans/specs/p4-deletions-closeout.md §3.3,
// ── §5.5 P-08 disposition): multi-job parsing, ordering, needs validation
// ── and the 256-job bound all existed only to support MORE THAN ONE job.
// ── The adapter now confines a workflow source to exactly one job (F-A3.1
// ── DELETED the describe block that lived here — "multi-job source IR
// ── (P-08, R-05(a)) — parses and orders deterministically", 6 tests
// ── covering canonical ordering, needs sorting, the 0/256/257 job-count
// ── bounds, missing-needs, cycle and duplicate-needs — none of those
// ── scenarios has a reachable document any more). The one surviving
// ── describe below now pins the single adapter-boundary rejection.

describe("R-05 — multi-job now fails at the adapter boundary, not at freeze/execute", () => {
  const TWO_JOB_YAML = [
    "name: Two-job",
    "on:",
    "  workflow_dispatch:",
    "jobs:",
    "  build:",
    "    runs-on: [self-hosted]",
    "    steps: [{ id: build, run: echo build }]",
    "  deploy:",
    "    needs: build",
    "    runs-on: [self-hosted]",
    "    steps: [{ id: deploy, run: echo deploy }]",
    "",
  ].join("\n");

  // FLIPPED in P4 (docs/plans/specs/p4-deletions-closeout.md §3.3, row B-34,
  // F-A3.2): a 2-job document now fails to PARSE — compileWorkflowPlan never
  // sees it, so the RETURN-vs-THROW asymmetry this test used to pin against
  // R-05(b) below no longer exists (row B-43: the check compileWorkflowPlan
  // used to return ok:false from is deleted, unreachable by construction).
  test("a 2-job document fails to parse with multi-job-unsupported, anchored at the second job", () => {
    const parsed = compileGithubWorkflowSource(TWO_JOB_YAML, { path: "workflows/two-job.yml" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      {
        code: "multi-job-unsupported",
        message:
          "AKM workflow YAML requires exactly one job; this document declares 2. AKM's YAML is an AKM workflow " +
          "format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.",
        path: "workflows/two-job.yml",
        line: 8,
      },
    ]);
  });

  describe("R-05(b): the freeze/start path", () => {
    let storage: IsolatedAkmStorage;

    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      writeWorkflowTestConfig();
      resetConfigCache();
    });

    afterEach(() => {
      resetConfigCache();
      storage.cleanup();
    });

    // FLIPPED in P4 (docs/plans/specs/p4-deletions-closeout.md §3.3.4, row
    // B-44, P4-N2, F-A3.2): the ref resolves through loadWorkflowAsset's own
    // compile (workflow-asset-loader.ts) before compileResolveFreezeWorkflowV4
    // is ever reached, so THAT site — not source-freeze.ts's wrapper — is
    // what a `startWorkflowRun` caller observes; it carries the same P4-N2
    // code split. The message's leading "Workflow source has N error(s)"
    // frame and absolute asset path are that site's own, unrelated to the
    // freeze wrapper's "Workflow source cannot be frozen" text — only the
    // adapter's policy message (pinned below) and the CODE are shared.
    test("throws COMPOSITION_INVALID wrapping the adapter's multi-job-unsupported rejection", async () => {
      write(storage.stashDir, "workflows/two-job.yml", TWO_JOB_YAML);

      const error = await rejection(startWorkflowRun("workflows/two-job"));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("COMPOSITION_INVALID");
      expect((error as Error).message).toContain(
        "AKM workflow YAML requires exactly one job; this document declares 2. AKM's YAML is an AKM workflow " +
          "format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.",
      );
    });
  });
});
