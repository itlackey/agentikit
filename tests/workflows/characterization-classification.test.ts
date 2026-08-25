// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane A): the workflow-step `uses:` classification
 * matrix, the nested-workflow rejection sites (R-03), and multi-job
 * parse-vs-execute behavior (R-05, P-08).
 *
 * See docs/plans/specs/p0-invariants.md, "Lane pin checklists" / Lane A, for
 * the authoritative source-site citations reproduced in the comments below.
 * Every test pins an OBSERVABLE surface (error type + code + verbatim
 * message, or a returned shape) rather than a private helper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import type { AkmConfig } from "../../src/core/config/config-types";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { prepareTaskV3Execution } from "../../src/tasks/runtime-v3";
import { classifyTaskV3Uses, parseTaskV3Yaml } from "../../src/tasks/source-v3";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";
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

// ── classifyTaskV3Uses: the GitHub-action locator grammar (R-04) ────────────

describe("classifyTaskV3Uses — GitHub-action locator grammar (R-04, task-v3/source-v3.ts:523-593)", () => {
  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P4 (grammar removal).
  test("R-04(a): accepts owner/repo@rev and owner/repo/path@rev as kind github-action, parsed and frozen", () => {
    const base = classifyTaskV3Uses("owner/repo@v1");
    expect(base).toEqual({
      kind: "github-action",
      ref: "owner/repo@v1",
      owner: "owner",
      repository: "repo",
      revision: "v1",
    });
    expect(Object.hasOwn(base, "path")).toBe(false);
    expect(Object.isFrozen(base)).toBe(true);

    const withPath = classifyTaskV3Uses("owner/repo/sub/dir@v1");
    expect(withPath).toEqual({
      kind: "github-action",
      ref: "owner/repo/sub/dir@v1",
      owner: "owner",
      repository: "repo",
      path: "sub/dir",
      revision: "v1",
    });
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P4 (grammar removal).
  test("R-04(a): a near-miss locator (no @rev, no canonical asset family) falls through to the trailing classification error verbatim", () => {
    const error = thrown(() => classifyTaskV3Uses("review"));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe(
      "Task v3 uses must be akm/command, a canonical commands/, workflows/, or scripts/ asset ref, or owner/repo[/path]@ref. Agent/task/local/Docker/ambiguous targets are not executable.",
    );
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P4 (grammar removal).
  test("R-04(b): a task whose uses: classifies as github-action is recognized at parse but rejected at prepare with the exact message (runtime-v3.ts:366-371)", async () => {
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: actions/checkout@v4", "akm:", '  schedule: "@daily"', ""].join("\n"),
      filePath: "tasks/gha.yml",
    });
    expect(task.target.kind).toBe("uses");
    if (task.target.kind === "uses") expect(task.target.uses.kind).toBe("github-action");

    const error = await rejection(
      prepareTaskV3Execution(task, {
        taskId: "gha",
        taskRef: "primary//tasks/gha",
        bundleName: "primary",
        bundleRoot: "/nonexistent",
        config: {} as AkmConfig,
      }),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe(
      'GitHub action "actions/checkout@v4" is recognized but remote action acquisition is unsupported in 0.9.2.',
    );
  });
});

// ── classifyWorkflowStepUses: task-ref priority, delegation, and the ────────
// ── two direct-rejection kinds it wraps around the injected classifier ─────

describe("classifyWorkflowStepUses — task-ref priority and delegation (source-ir/semantics.ts:111-148)", () => {
  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. This priority ordering is what R-01's
  // fixtures depend on and is unrelated to R-01's own flip.
  test("recognizes 'tasks/x' before ever calling the delegated classifier", () => {
    let calls = 0;
    const spy = (_value: string): WorkflowSourceUsesTarget => {
      calls++;
      throw new Error("delegated classifier must not be called for a task ref");
    };
    const result = classifyWorkflowStepUses("tasks/build", spy);
    expect(result).toEqual({ kind: "task", ref: "tasks/build" });
    expect(calls).toBe(0);
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately.
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

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P3 (child workflows). This is
  // R-03's FIRST site — semantics.ts:141-146 — independent of the two
  // source-freeze-v4.ts sites pinned below.
  test("R-03 (site 1/3, semantics.ts:141-146): a direct 'uses: workflows/x' step throws nested-workflow-unsupported", () => {
    const error = thrown(() => classifyWorkflowStepUses("workflows/child"));
    expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
    expect((error as WorkflowSourceSemanticError).code).toBe("nested-workflow-unsupported");
    expect((error as Error).message).toBe(
      'Nested workflow target "workflows/child" is unsupported in a workflow step.',
    );
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P4 (grammar removal).
  test("R-04(c): a GitHub-action locator in a workflow step throws remote-action-acquisition-out-of-scope", () => {
    const error = thrown(() => classifyWorkflowStepUses("actions/checkout@v4"));
    expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
    expect((error as WorkflowSourceSemanticError).code).toBe("remote-action-acquisition-out-of-scope");
    expect((error as Error).message).toBe('Remote action acquisition is out of scope for "actions/checkout@v4".');
  });
});

// ── R-03, sites 2 and 3: a task-composed nested-workflow target ─────────────

describe("R-03 (sites 2/3, source-freeze-v4.ts:211-239) — a task-composed nested-workflow target", () => {
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

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P3 (child workflows).
  test("a workflow step composing a task whose own uses: is a workflow rejects with the exact byte-identical message", async () => {
    write(
      storage.stashDir,
      "tasks/nested-workflow-task.yml",
      ["version: 3", "uses: workflows/child", "akm:", '  schedule: "@daily"', ""].join("\n"),
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

    const error = await rejection(startWorkflowRun("workflows/nested-composition"));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe("A workflow task step cannot compose a nested workflow target.");

    // R-03's third site (source-freeze-v4.ts:237-239, guarding
    // `prepared.kind === "workflow"` on the return of prepareTaskV3Execution)
    // throws the byte-identical message from the SAME taskDispatch function.
    // As written today it is unreachable independently of the :220-222 guard
    // exercised above: prepareTaskV3Execution can only return kind "workflow"
    // when `document.target.uses.kind === "workflow"` (runtime-v3.ts:415) —
    // exactly the fact the :220 guard already tests on the same `task` object
    // before prepareTaskV3Execution is ever called. No fixture can pass :220
    // and still reach :237 with prepared.kind === "workflow". This test
    // therefore pins the one reachable observable failure; the second site is
    // a currently-dead-in-practice duplicate rather than independently
    // exercised — see the P0 review log / discoveries.
  });
});

// ── R-02: a direct scripts/<ref> workflow step (directScript) ──────────────

describe("R-02 — a direct scripts/<ref> workflow step (source-freeze-v4.ts:274-298, directScript)", () => {
  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P1b (typed preparer).
  test("directScript's synthetic task document reproduces the exact <workflow path>#<step id> identity contract", async () => {
    // Reproduces, field for field, what source-freeze-v4.ts's directScript()
    // constructs at :282-295 for a workflow step `uses: scripts/<ref>`:
    //   yaml = `version: 3\nuses: ${owned.ref}\nakm:\n  schedule: "@daily"\n`
    //   filePath = `${asset.path}#${step.id}`, taskId = step.id,
    //   taskRef = `${asset.ref}#${step.id}`, bundleRoot = asset.sourcePath.
    const assetPath = "workflows/script-step.yml";
    const assetRef = "primary//workflows/script-step";
    const stepId = "run-script";
    const scriptBytes = new TextEncoder().encode("#!/bin/sh\nprintf direct-script\n");

    const synthetic = parseTaskV3Yaml({
      yaml: 'version: 3\nuses: primary//scripts/exact.sh\nakm:\n  schedule: "@daily"\n',
      filePath: `${assetPath}#${stepId}`,
    });
    const prepared = await prepareTaskV3Execution(synthetic, {
      taskId: stepId,
      taskRef: `${assetRef}#${stepId}`,
      bundleName: "primary",
      bundleRoot: process.cwd(),
      config: {} as AkmConfig,
      resolveAsset: async () => ({
        file: path.join(process.cwd(), "scripts", "exact.sh"),
        bundleRoot: process.cwd(),
      }),
      readFile: () => scriptBytes,
    });

    expect(prepared.kind).toBe("script");
    expect(prepared.taskId).toBe(stepId);
    expect(prepared.taskRef).toBe("primary//workflows/script-step#run-script");
    if (prepared.kind === "script")
      expect(prepared.sha256).toBe(createHash("sha256").update(scriptBytes).digest("hex"));

    // NOTE: prepared.taskId / prepared.taskRef (the <workflow path>#<step id>
    // identity just pinned above) are NOT read by scriptResult() in
    // source-freeze-v4.ts — only prepared.sourceRef/.interpreter/.extension/
    // .bytesBase64/.byteLength/.sha256/.cwdIdentity flow into the frozen
    // FrozenWorkflowScriptTarget (its `ref` is the SCRIPT's own qualified ref,
    // see the end-to-end test below — not this workflow-path#step-id shape).
    // The identity contract this test pins is computed by directScript() but
    // is not currently observable in a persisted plan; see the P0 review log.
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
    // site above.
  });

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

// ── R-05 / P-08: multi-job parses and orders deterministically, but the ────
// ── current runtime refuses to execute more than one job ────────────────────

describe("multi-job source IR (P-08, R-05(a)) — parses and orders deterministically", () => {
  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. This ordering must be PRESERVED (P-08) —
  // it is the parser behavior later phases build the durable job-boundary
  // adapter on top of.
  test("P-08: emits ready jobs in canonical dependency-topological, lexical-tie-break order, recomputed after each emission", () => {
    const result = compileGithubWorkflowSource(
      "name: Ordering\non: { workflow_dispatch: null }\njobs:\n" +
        "  zulu:\n    runs-on: [self-hosted]\n    steps: [{ id: zulu, run: echo zulu }]\n" +
        "  bravo:\n    runs-on: [self-hosted]\n    steps: [{ id: bravo, run: echo bravo }]\n" +
        "  alpha:\n    needs: bravo\n    runs-on: [self-hosted]\n    steps: [{ id: alpha, run: echo alpha }]\n",
      { path: "workflows/order.yml" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "alpha" becomes ready only once "bravo" is emitted, then out-ranks
    // "zulu" (both ready at that point) purely by lexical order — proving
    // readiness is recomputed after each emission rather than sorted once.
    expect(result.ir.jobs.map((job) => job.id)).toEqual(["bravo", "alpha", "zulu"]);
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. P-08 (preserve): `needs` sorting.
  test("P-08: needs entries are stored in sorted order regardless of authored order", () => {
    const result = compileGithubWorkflowSource(
      "name: G\non: { workflow_dispatch: null }\njobs:\n" +
        "  report:\n    needs: [test, build]\n    runs-on: [self-hosted]\n    steps: [{ id: report, run: echo report }]\n" +
        "  test:\n    needs: build\n    runs-on: [self-hosted]\n    steps: [{ id: test, run: echo test }]\n" +
        "  build:\n    runs-on: [self-hosted]\n    steps: [{ id: build, run: echo build }]\n",
      { path: "workflows/g.yml" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.jobs.map((job) => job.id)).toEqual(["build", "test", "report"]);
    expect(result.ir.jobs.find((job) => job.id === "report")?.needs).toEqual(["build", "test"]);
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. P-08 (preserve): job-count bounds.
  test("P-08: rejects 0 jobs and 257 jobs, accepts exactly 256, all with code job-count-limit", () => {
    const empty = compileGithubWorkflowSource("name: Empty\non: { workflow_dispatch: null }\njobs: {}\n", {
      path: "workflows/empty.yml",
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.some((error) => error.code === "job-count-limit")).toBe(true);

    const jobsBlock = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `  j${index}:\n    runs-on: [self-hosted]\n    steps: [{ id: s, run: echo ${index} }]`,
      ).join("\n");

    const at256 = compileGithubWorkflowSource(
      `name: At256\non: { workflow_dispatch: null }\njobs:\n${jobsBlock(256)}\n`,
      { path: "workflows/at256.yml" },
    );
    expect(at256.ok).toBe(true);
    if (at256.ok) expect(at256.ir.jobs).toHaveLength(256);

    const over256 = compileGithubWorkflowSource(
      `name: Over256\non: { workflow_dispatch: null }\njobs:\n${jobsBlock(257)}\n`,
      { path: "workflows/over256.yml" },
    );
    expect(over256.ok).toBe(false);
    if (!over256.ok) expect(over256.errors.some((error) => error.code === "job-count-limit")).toBe(true);
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. P-08 (preserve): needs validation.
  test("P-08: rejects a missing needs target with the exact message and code missing-job-dependency", () => {
    const result = compileGithubWorkflowSource(
      "name: Missing\non: { workflow_dispatch: null }\njobs:\n" +
        "  main:\n    needs: absent\n    runs-on: [self-hosted]\n    steps: [{ id: ok, run: echo ok }]\n",
      { path: "workflows/missing.yml" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find((entry) => entry.code === "missing-job-dependency");
    expect(error?.message).toBe("Job main needs missing job absent.");
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. P-08 (preserve): needs validation.
  test("P-08: rejects a dependency cycle with code job-dependency-cycle and the exact message", () => {
    const result = compileGithubWorkflowSource(
      "name: Cycle\non: { workflow_dispatch: null }\njobs:\n" +
        "  a:\n    needs: b\n    runs-on: [self-hosted]\n    steps: [{ id: a, run: echo a }]\n" +
        "  b:\n    needs: a\n    runs-on: [self-hosted]\n    steps: [{ id: b, run: echo b }]\n",
      { path: "workflows/cycle.yml" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find((entry) => entry.code === "job-dependency-cycle");
    expect(error?.message).toBe("Workflow jobs contain a dependency cycle.");
  });

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. P-08 (preserve): needs validation.
  test("P-08: rejects duplicate needs entries with code duplicate-job-dependency", () => {
    const result = compileGithubWorkflowSource(
      "name: Dup\non: { workflow_dispatch: null }\njobs:\n" +
        "  main:\n    needs: [build, build]\n    runs-on: [self-hosted]\n    steps: [{ id: ok, run: echo ok }]\n" +
        "  build:\n    runs-on: [self-hosted]\n    steps: [{ id: build, run: echo build }]\n",
      { path: "workflows/dup.yml" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((entry) => entry.code === "duplicate-job-dependency")).toBe(true);
  });
});

describe("R-05 — multi-job parses clean, but the current runtime refuses to execute it", () => {
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

  // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
  // phase flips this deliberately. Flips in P4 (adapter-boundary rejection).
  // Pins the RETURN-vs-THROW asymmetry against R-05(b) below: this path
  // returns `ok: false`, it never throws.
  test("R-05(c): compileWorkflowPlan RETURNS ok:false (never throws) with the exact message and the second job's source line", () => {
    const parsed = compileGithubWorkflowSource(TWO_JOB_YAML, { path: "workflows/two-job.yml" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ir.jobs.map((job) => job.id)).toEqual(["build", "deploy"]);
    const secondJob = parsed.ir.jobs[1];
    if (!secondJob) throw new Error("fixture must contain a second job");

    let compiled: ReturnType<typeof compileWorkflowPlan> | undefined;
    expect(() => {
      compiled = compileWorkflowPlan(parsed.ir, "two-job");
    }).not.toThrow();
    expect(compiled?.ok).toBe(false);
    if (!compiled || compiled.ok) return;
    expect(compiled.errors).toEqual([
      {
        line: secondJob.source.start,
        message: "Current workflow execution requires exactly one source-IR job.",
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

    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later
    // phase flips this deliberately. Flips in P4 (adapter-boundary rejection).
    test("throws the exact multi-job UsageError instead of executing (source-freeze-v4.ts:105-110)", async () => {
      write(storage.stashDir, "workflows/two-job.yml", TWO_JOB_YAML);

      const error = await rejection(startWorkflowRun("workflows/two-job"));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
      expect((error as Error).message).toBe(
        "Multi-job workflow cannot execute until job boundaries and needs have a durable runtime representation.",
      );
    });
  });
});
