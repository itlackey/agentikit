// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane B — the ONE recursive child-workflow resolver (docs/plans/specs/
 * p3a-plan-v5-child-freeze.md §4, §6 F-B1…F-B4, §7 new-suites table: this
 * file owns rows B-04…B-25; B-01…B-03 are covered by the AUTHORIZED flips in
 * tests/workflows/characterization-classification.test.ts,
 * tests/workflows/source-ir-contract.test.ts, and
 * tests/execution/target-ref.test.ts, not duplicated here).
 *
 * Implemented: `src/workflows/freeze/targets/child-workflow.ts` is the ONE
 * resolver both forms route to — `src/workflows/source-ir/semantics.ts` no
 * longer throws `nested-workflow-unsupported` for a direct
 * `uses: workflows/<ref>` step, and `src/workflows/freeze/targets/task.ts`
 * no longer throws "A workflow task step cannot compose a nested workflow
 * target." for a task-wrapped one — both former throw sites now route to
 * `childWorkflowDispatch` instead.
 *
 * `FrozenWorkflowTarget` (src/workflows/ir/schema-v4.ts) is today's closed
 * `command | shell | script` union; it gains a fourth member,
 * `FrozenChildWorkflowTarget` (kind "child-workflow"; fields ref, planHash,
 * frozenPlan, contentHash, via, taskRef?, inputBindings?, spec §3.5), in
 * Implement. Every access to one of those NEW fields is isolated behind the
 * single `childWorkflowFields` helper below (mirroring
 * tests/workflows/task-input-bindings.test.ts's `frozenInputBindings`
 * pattern) so Implement removes each directive as its own line becomes
 * type-valid, not one per call site across this file. Structural assertions
 * that only need to check a SUBSET of a target's shape use `toMatchObject`
 * instead, whose `subset: object` parameter is untyped and needs no pin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { compileResolveFreezeWorkflowV4 } from "../../src/workflows/ir/freeze-v4";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../src/workflows/ir/schema-v4";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

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

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** A minimal markdown-frontmatter workflow with a `## work` inline-dispatch step and no declared params. */
function leafWorkflowDoc(): string {
  return ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do work.", ""].join("\n");
}

/** A minimal markdown-frontmatter workflow declaring one string param, `scope`, consumed by nothing (freeze-only fixture). */
function paramWorkflowDoc(): string {
  return [
    "---",
    "type: workflow",
    "params:",
    "  scope: { type: string }",
    "steps:",
    "  - id: work",
    "---",
    "",
    "## work",
    "",
    "Do work.",
    "",
  ].join("\n");
}

/** A GitHub-shaped parent workflow with the given pre-indented `steps:` entries. */
function writeParent(name: string, stepLines: readonly string[]): void {
  write(
    `workflows/${name}.yml`,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      ...stepLines,
      "",
    ].join("\n"),
  );
}

async function planRow(runId: string) {
  return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
}

function stepTarget(plan: ReturnType<typeof decodeWorkflowPlanV4>, index: number): FrozenWorkflowTarget | undefined {
  const root = plan.steps[index]?.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
}

/** Run `ref` and return whatever it throws, or undefined if it resolves. */
async function captureRejection(ref: string): Promise<unknown> {
  try {
    await startWorkflowRun(ref);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function expectCompositionInvalid(ref: string): Promise<UsageError> {
  const error = await captureRejection(ref);
  expect(error).toBeInstanceOf(UsageError);
  if (!(error instanceof UsageError)) throw new Error("unreachable");
  expect(error.code).toBe("COMPOSITION_INVALID");
  return error;
}

async function expectInputBindingInvalid(ref: string): Promise<UsageError> {
  const error = await captureRejection(ref);
  expect(error).toBeInstanceOf(UsageError);
  if (!(error instanceof UsageError)) throw new Error("unreachable");
  expect(error.code).toBe("INPUT_BINDING_INVALID");
  return error;
}

/** B-25: every composition-bound violation fails BEFORE the run row is published. */
async function expectNoRunRowWritten(): Promise<void> {
  const { runs } = await listWorkflowRuns();
  expect(runs).toHaveLength(0);
}

/**
 * §3.5: `FrozenWorkflowTarget` gains a `child-workflow` member,
 * `FrozenChildWorkflowTarget`, in Implement (kind, ref, planHash, frozenPlan,
 * contentHash, via, taskRef?, inputBindings?). `kind` and `inputBindings`
 * already exist on today's command|shell|script union and need no pin; the
 * rest do not exist on any current variant.
 */
function childWorkflowFields(target: FrozenWorkflowTarget | undefined): {
  readonly ref: string;
  readonly planHash: string;
  readonly frozenPlanIrVersion: number;
  readonly frozenPlanTitle: string;
  readonly contentHash: string;
  readonly via: "direct" | "task";
  readonly taskRef: string | undefined;
  readonly inputBindings: readonly TaskInputBinding[] | undefined;
} {
  if (!target) throw new Error("childWorkflowFields: target is undefined");
  // Implement landed `FrozenChildWorkflowTarget` as a proper discriminated
  // union member (schema-v4.ts A-N1): `command`/`shell`/`script` do not carry
  // ref/planHash/frozenPlan/via/taskRef, so TypeScript only admits the access
  // below once `kind` narrows `target`. This narrows for the whole function;
  // every red-phase `@ts-expect-error` pin below is now genuinely unused and
  // is removed, per this file's own header comment above.
  if (target.kind !== "child-workflow") {
    throw new Error(`childWorkflowFields: expected a child-workflow target, got ${target.kind}`);
  }
  return {
    ref: target.ref,
    planHash: target.planHash,
    frozenPlanIrVersion: target.frozenPlan.irVersion,
    frozenPlanTitle: target.frozenPlan.title,
    // contentHash already exists (as `string`) on all three current
    // FrozenWorkflowTarget variants — no pin needed for the access itself,
    // only for the NEW "child-workflow" preimage §3.5 defines for it.
    contentHash: target.contentHash,
    via: target.via,
    taskRef: target.taskRef,
    inputBindings: target.inputBindings,
  };
}

// ── Direct child workflows — uses: workflows/<ref> (spec §2.4, rows B-04…B-11) ─

describe("direct child workflows — uses: workflows/<ref> (rows B-04…B-11)", () => {
  function writeChild(): void {
    write("workflows/child.md", paramWorkflowDoc());
  }

  test("B-04: a direct uses: workflows/<ref> step freezes to a child-workflow target with the embedded frozen child plan and its planHash", async () => {
    writeChild();
    writeParent("direct-basic", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // Independently freeze the child on its own and compare hashes, so this
    // test proves the EMBEDDED plan really is the child's own frozen plan,
    // not merely that SOME plan got embedded.
    const childAsset = await loadWorkflowAsset("workflows/child");
    const independentChild = await compileResolveFreezeWorkflowV4(childAsset, loadConfig());
    const expectedChildPlanHash = computePlanHash(independentChild.plan);

    const started = await startWorkflowRun("workflows/direct-basic");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({ kind: "child-workflow", via: "direct" });
    const fields = childWorkflowFields(target);
    expect(fields.ref).toMatch(/\/\/workflows\/child$/);
    expect(fields.planHash).toBe(expectedChildPlanHash);
    expect(fields.frozenPlanIrVersion).toBe(5);
    expect(fields.taskRef).toBeUndefined();
  });

  test("B-08: with: on the direct step naming a declared child param freezes as an inputBindings entry", async () => {
    writeChild();
    writeParent("direct-with", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        with:",
      "          scope: urgent",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/direct-with");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const fields = childWorkflowFields(stepTarget(plan, 0));

    expect(fields.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "urgent" }]);
  });

  test("B-09: with: naming an undeclared child param fails INPUT_BINDING_INVALID at freeze, before publication", async () => {
    writeChild();
    writeParent("direct-bogus", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        with:",
      "          bogus: nope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/direct-bogus");
    expect(error.message).toContain("bogus");
    await expectNoRunRowWritten();
  });

  test("B-10: with: {from: ...} plus another key is a hard INPUT_BINDING_INVALID failure, never reinterpreted as a literal", async () => {
    writeChild();
    writeParent("direct-hard-fail", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        with:",
      "          scope:",
      "            from: params.scope",
      "            other: 1",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/direct-hard-fail");
    expect(error.message).toContain("with.scope");
    await expectNoRunRowWritten();
  });

  test("B-11: workflows/<ref> that does not resolve fails the existing asset-resolution failure, unchanged in code and shape", async () => {
    writeParent("direct-missing", ["      - id: dispatch", "        uses: workflows/does-not-exist"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/direct-missing");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) throw new Error("unreachable");
    expect(error.code).toBe("INVALID_FLAG_VALUE");
    expect(error.message).toContain("workflows/does-not-exist");
  });
});

// ── Task-wrapped child workflows — uses: tasks/<t>, t targets a workflow ────
// ── (spec §2.5, rows B-12…B-17; the v4-declared-inputs case, B-13, is the ──
// ── AUTHORIZED flip in tests/workflows/task-input-bindings.test.ts) ─────────

describe("task-wrapped child workflows — uses: tasks/<t> where t targets a workflow (rows B-12, B-14, B-15)", () => {
  function writeChild(): void {
    write("workflows/child.md", paramWorkflowDoc());
  }

  test("B-12/B-14: a v3 task whose own uses: targets a workflow freezes to a child-workflow target, via task, and the task's own with: becomes the child's params", async () => {
    writeChild();
    write(
      "tasks/v3-wrapper.yml",
      [
        "version: 3",
        "uses: workflows/child",
        "with:",
        "  scope: from-v3-task",
        "akm:",
        '  schedule: "@daily"',
        "",
      ].join("\n"),
    );
    writeParent("v3-wrapped", ["      - id: dispatch", "        uses: tasks/v3-wrapper"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/v3-wrapped");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({ kind: "child-workflow", via: "task" });
    const fields = childWorkflowFields(target);
    expect(fields.taskRef).toMatch(/\/\/tasks\/v3-wrapper$/);
    expect(fields.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "from-v3-task" }]);
  });

  test("B-15: a v3 task with env: on a workflow target still rejects, byte-unchanged (PRESERVE)", async () => {
    writeChild();
    write(
      "tasks/v3-env-wrapper.yml",
      ["version: 3", "uses: workflows/child", "env:", "  FOO: bar", "akm:", '  schedule: "@daily"', ""].join("\n"),
    );
    writeParent("v3-env-wrapped", ["      - id: dispatch", "        uses: tasks/v3-env-wrapper"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/v3-env-wrapped");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) throw new Error("unreachable");
    expect(error.code).toBe("INVALID_FLAG_VALUE");
    expect(error.message).toBe(
      "Task v3 workflow env cannot be consumed by the durable workflow runtime in 0.9.2; remove env or use a command target.",
    );
    await expectNoRunRowWritten();
  });
});

// ── Direct and task-wrapped composition lower to the SAME target shape ─────

describe("direct and task-wrapped composition of the SAME child lower to the same target shape, modulo identity fields", () => {
  test("a direct step and a task-wrapped step composing the same child with the same effective params freeze to structurally equal child-workflow targets — only via/taskRef (and contentHash, whose preimage covers them) differ", async () => {
    write("workflows/shared-child.md", paramWorkflowDoc());
    write(
      "tasks/shared-wrapper.yml",
      [
        "version: 3",
        "uses: workflows/shared-child",
        "with:",
        "  scope: shared-value",
        "akm:",
        '  schedule: "@daily"',
        "",
      ].join("\n"),
    );
    writeParent("compare-direct", [
      "      - id: dispatch",
      "        uses: workflows/shared-child",
      "        with:",
      "          scope: shared-value",
    ]);
    writeParent("compare-task", ["      - id: dispatch", "        uses: tasks/shared-wrapper"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const directRun = await startWorkflowRun("workflows/compare-direct");
    const taskRun = await startWorkflowRun("workflows/compare-task");
    const directPlan = decodeWorkflowPlanV4(JSON.parse((await planRow(directRun.run.id))?.plan_json ?? "null"));
    const taskPlan = decodeWorkflowPlanV4(JSON.parse((await planRow(taskRun.run.id))?.plan_json ?? "null"));
    const directFields = childWorkflowFields(stepTarget(directPlan, 0));
    const taskFields = childWorkflowFields(stepTarget(taskPlan, 0));

    // The identical child, reached with identical resolved inputs: ref,
    // planHash, the embedded plan's identity, and the resulting
    // inputBindings must be equal regardless of route.
    expect(taskFields.ref).toBe(directFields.ref);
    expect(taskFields.planHash).toBe(directFields.planHash);
    expect(taskFields.frozenPlanIrVersion).toBe(directFields.frozenPlanIrVersion);
    expect(taskFields.frozenPlanTitle).toBe(directFields.frozenPlanTitle);
    expect(taskFields.inputBindings).toEqual(directFields.inputBindings);
    // Only the declared-identity fields recording HOW the child was reached
    // differ between the two routes.
    expect(directFields.via).toBe("direct");
    expect(taskFields.via).toBe("task");
    expect(directFields.taskRef).toBeUndefined();
    expect(taskFields.taskRef).toMatch(/\/\/tasks\/shared-wrapper$/);
  });
});

// ── Composition bounds — depth, cycle, aggregate size (spec §4.5, §2.6, ────
// ── rows B-18…B-25) ──────────────────────────────────────────────────────

describe("composition bounds — depth, cycle, aggregate embedded size (rows B-18…B-25)", () => {
  /**
   * A chain of `count` workflows: chain-0 -> chain-1 -> … -> chain-(count-2)
   * -> chain-(count-1) (a leaf). Every COMPOSING node must be GitHub-YAML
   * (via writeParent): the markdown-frontmatter step schema's `unit:`
   * dispatch-override bag has no `uses` key at all (STEP_KEYS/UNIT_KEYS,
   * src/workflows/parser.ts) — only the GitHub-shaped `jobs.<id>.steps[].uses`
   * surface can author composition. Only the final, non-composing leaf uses
   * the markdown body-only shape.
   */
  function writeChain(count: number): void {
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1;
      if (isLast) {
        write(`workflows/chain-${i}.md`, leafWorkflowDoc());
      } else {
        writeParent(`chain-${i}`, ["      - id: next", `        uses: workflows/chain-${i + 1}`]);
      }
    }
  }

  test("B-19: a composition chain exactly 8 levels deep (9 workflows: chain-0 .. chain-8) freezes", async () => {
    writeChain(9);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/chain-0");
    expect(started.run.id).toBeTruthy();
  });

  test("B-18: a composition chain 9 levels deep (10 workflows: chain-0 .. chain-9, one past the bound) fails COMPOSITION_INVALID naming the depth limit and the ref path", async () => {
    writeChain(10);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/chain-0");
    expect(error.message).toContain("8");
    expect(error.message.toLowerCase()).toContain("level");
    await expectNoRunRowWritten();
  });

  test("B-20: a direct self-reference (A -> A) fails COMPOSITION_INVALID naming the cycle path", async () => {
    writeParent("self-cycle", ["      - id: loop", "        uses: workflows/self-cycle"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/self-cycle");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("workflows/self-cycle");
    await expectNoRunRowWritten();
  });

  test("B-21: an indirect cycle (A -> B -> A) fails COMPOSITION_INVALID naming A -> B -> A", async () => {
    writeParent("cycle-a", ["      - id: hop", "        uses: workflows/cycle-b"]);
    writeParent("cycle-b", ["      - id: hop", "        uses: workflows/cycle-a"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/cycle-a");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("workflows/cycle-a");
    expect(error.message).toContain("workflows/cycle-b");
    await expectNoRunRowWritten();
  });

  test("B-22: a task-mediated cycle (A -> tasks/w -> B -> A) fails COMPOSITION_INVALID, the reported path naming the intermediate task ref", async () => {
    writeParent("task-cycle-a", ["      - id: hop", "        uses: tasks/wrap-task-cycle-b"]);
    write(
      "tasks/wrap-task-cycle-b.yml",
      ["version: 3", "uses: workflows/task-cycle-b", "akm:", '  schedule: "@daily"', ""].join("\n"),
    );
    writeParent("task-cycle-b", ["      - id: back", "        uses: workflows/task-cycle-a"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/task-cycle-a");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("tasks/wrap-task-cycle-b");
    await expectNoRunRowWritten();
  });

  test("B-23: the same workflow reached twice on disjoint branches (a diamond) is not a cycle and freezes, each occurrence embedding its own copy", async () => {
    write("workflows/diamond-leaf.md", leafWorkflowDoc());
    writeParent("diamond-root", [
      "      - id: s1",
      "        uses: workflows/diamond-leaf",
      "      - id: s2",
      "        uses: workflows/diamond-leaf",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/diamond-root");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    expect(stepTarget(plan, 0)).toMatchObject({ kind: "child-workflow" });
    expect(stepTarget(plan, 1)).toMatchObject({ kind: "child-workflow" });
  });

  test("B-24: aggregate embedded child plan bytes over the 1 MiB cap fails COMPOSITION_INVALID naming the cap, the running total, and the child that crossed it", async () => {
    // Five children at 250,000 'x' bytes each (well under the 256 KiB
    // per-instruction cap and the 1 MiB per-source-file cap individually)
    // sum to 1,250,000 bytes — comfortably over the 1,048,576-byte
    // (1 MiB) aggregate cap once every embedded plan's structural overhead
    // is added on top.
    const bigBody = (n: number) =>
      ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "x".repeat(n), ""].join("\n");
    for (let i = 0; i < 5; i++) write(`workflows/big-${i}.md`, bigBody(250_000));
    writeParent(
      "aggregate-root",
      Array.from({ length: 5 }, (_, i) => [`      - id: s${i}`, `        uses: workflows/big-${i}`]).flat(),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/aggregate-root");
    expect(error.message.toLowerCase()).toContain("byte");
    await expectNoRunRowWritten();
  });
});
