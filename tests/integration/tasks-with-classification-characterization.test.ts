// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane B) — task-layer `with:` handling on a *workflow*
 * ref (P-03): quiet acceptance as the child workflow's frozen `params` — and
 * the workflow-target `env:` rejection adjacent to P-03 (P-04).
 *
 * See docs/plans/specs/p0-invariants.md rows P-01, P-02, P-03, P-04. P4
 * (docs/plans/specs/p4-deletions-closeout.md §5.5, F-A2.8) resolves P-01 and
 * P-02 BY DELETION, not by flipping them: task source v4 rejects `with:` on
 * any target but `uses: akm/command` at PARSE time (row B-11/B-28) — a
 * `commands/`/`scripts/` ref with `with:` never reaches
 * `prepareTaskV3Execution`'s runtime guard any more, so those two blocks'
 * SUBJECT (that runtime guard firing) is unreachable. The guards themselves
 * are KEPT as seam invariants (P4-N4, `src/tasks/prepare/prepare.ts`'s own
 * comment explains why) — this file's job was only ever to prove they fire
 * from a real parsed document, and no parsed document can reach them any
 * more.
 *
 * P-03's "params deep-equal the authored mapping" case is deleted the same
 * way — task source v4 has no grammar for authoring `with:` on a workflow
 * target at all. What survives, converted to task source v4 (row B-28): a
 * workflow-target task with no `inputs:` declared still prepares
 * `params: {}` (never undefined), frozen. P-04 stays fully reachable and
 * pinned — the workflow-target `env:` rejection is a `prepare.ts` seam
 * invariant independent of task source version.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config-types";
import { UsageError } from "../../src/core/errors";
import { prepareTaskV3Execution } from "../../src/tasks/prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "../../src/tasks/prepare/prepared-execution";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../src/tasks/source/project-v4";

/** Capture a promise rejection once, so a message/code pin never re-invokes the function under test. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

/** A workflow document minimal enough to satisfy validateWorkflowRuntimeSource. */
const WORKFLOW_MD = "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n";

/**
 * Minimal prepareTaskV3Execution context. The workflow arm (P-03, P-04) never
 * touches real disk: resolveAsset/readFile are injected in-memory, following
 * the same seam tests/workflows/characterization-classification.test.ts uses
 * for R-02's directScript identity-contract test.
 */
function context(extra: Partial<PrepareTaskV3ExecutionContext> = {}): PrepareTaskV3ExecutionContext {
  return {
    taskId: "x",
    taskRef: "primary//tasks/x",
    bundleName: "primary",
    bundleRoot: "/nonexistent",
    config: {} as AkmConfig,
    ...extra,
  };
}

function resolvedWorkflowAsset(): Partial<PrepareTaskV3ExecutionContext> {
  return {
    resolveAsset: async () => ({ file: "/fixture/workflows/child.md", bundleRoot: "/fixture" }),
    readFile: () => new TextEncoder().encode(WORKFLOW_MD),
  };
}

function v4Task(yaml: string, filePath: string) {
  const parsed = parseTaskSource({ yaml, filePath });
  return projectTaskSourceV4(parsed.v4);
}

describe("P-03 — task-layer with on a workflow ref becomes the child workflow's frozen params (prepare.ts)", () => {
  test("row B-28 — no inputs: declared prepares params as {} (not undefined), and the result stays frozen", async () => {
    // CHARACTERIZATION (P0, converted to task source v4 — spec §7.2 F-A2.8):
    // pins behavior that must be PRESERVED through every later phase — a
    // failure here is a regression, not an intended flip.
    const task = v4Task(["version: 4", "uses: workflows/child", "schedule: '@daily'", ""].join("\n"), "tasks/p03.yml");
    expect(task.target.kind).toBe("uses");
    if (task.target.kind === "uses") expect(task.target.with).toBeUndefined();

    const prepared = await prepareTaskV3Execution(task, context(resolvedWorkflowAsset()));
    expect(prepared.kind).toBe("workflow");
    if (prepared.kind !== "workflow") return;
    expect(prepared.params).toEqual({});
    expect(prepared.params).not.toBeUndefined();
    expect(Object.isFrozen(prepared.params)).toBe(true);
  });
});

describe("P-04 — a workflow-target task with any env: is rejected (prepare.ts)", () => {
  test("P-04 — uses: workflows/<ref> with a non-empty env: throws UsageError INVALID_FLAG_VALUE with the exact message", async () => {
    // CHARACTERIZATION (P0, converted to task source v4): pins behavior that
    // must be PRESERVED through every later phase — a failure here is a
    // regression, not an intended flip.
    const task = v4Task(
      ["version: 4", "uses: workflows/child", "env:", "  FOO: bar", "schedule: '@daily'", ""].join("\n"),
      "tasks/p04-workflow-env.yml",
    );
    expect(Object.keys(task.env ?? {}).length).toBeGreaterThan(0);

    const error = await rejection(prepareTaskV3Execution(task, context(resolvedWorkflowAsset())));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe(
      "Task workflow env cannot be consumed by the durable workflow runtime in 0.9.2; remove env or use a command target.",
    );
  });

  test("P-04 — the rejection fires exactly when Object.keys(environment).length > 0, not merely when env: is authored", async () => {
    // CHARACTERIZATION (P0, converted to task source v4): pins behavior that
    // must be PRESERVED through every later phase — a failure here is a
    // regression, not an intended flip.
    // An authored-but-empty env: mapping owns the `env` key yet yields zero
    // environment entries — proving the guard reads Object.keys(environment)
    // rather than merely `document.env !== undefined`.
    const task = v4Task(
      ["version: 4", "uses: workflows/child", "env: {}", "schedule: '@daily'", ""].join("\n"),
      "tasks/p04-workflow-empty-env.yml",
    );
    expect(task.env).toEqual({});

    const prepared = await prepareTaskV3Execution(task, context(resolvedWorkflowAsset()));
    expect(prepared.kind).toBe("workflow");
  });
});
