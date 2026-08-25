// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P0 characterization (Lane B) — task-layer `with:` handling, per `uses`
 * target kind: loud rejection on a *command* ref (P-01) and on a *script*
 * ref (P-02), quiet acceptance as the child workflow's frozen `params` on a
 * *workflow* ref (P-03) — the one `with` consumer that works today, and the
 * shape P2b generalizes to workflow steps — plus the workflow-target `env:`
 * rejection adjacent to P-03 (P-04).
 *
 * See docs/plans/specs/p0-invariants.md rows P-01, P-02, P-03, P-04. Every
 * row pinned in this file is a Behavior to PRESERVE, not a defect: P-01 and
 * P-02 are the loud-rejection contrast that gives R-01's silent
 * workflow-step `with:` drop (tests/workflows/characterization-with-drop.test.ts)
 * its meaning.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config-types";
import { UsageError } from "../../src/core/errors";
import { type PrepareTaskV3ExecutionContext, prepareTaskV3Execution } from "../../src/tasks/runtime-v3";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";

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

describe("P-01 — task-layer with on a command ref is rejected loudly (runtime-v3.ts:397-401)", () => {
  test("P-01 — uses: commands/<ref> with with: throws UsageError INVALID_FLAG_VALUE with the exact message", async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: commands/review", "with:", "  scope: all", "akm:", '  schedule: "@daily"', ""].join(
        "\n",
      ),
      filePath: "tasks/p01-command-with.yml",
    });
    expect(task.target.kind).toBe("uses");
    if (task.target.kind === "uses") expect(task.target.uses.kind).toBe("command");

    const error = await rejection(prepareTaskV3Execution(task, context()));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe(
      "Task v3 command refs do not accept with; use akm/command with {ref, arguments} for portable arguments.",
    );
  });
});

describe("P-02 — task-layer with on a script ref is rejected loudly (runtime-v3.ts:437-439)", () => {
  test("P-02 — uses: scripts/<ref> with with: throws UsageError INVALID_FLAG_VALUE with the exact message", async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: scripts/build.sh", "with:", "  scope: all", "akm:", '  schedule: "@daily"', ""].join(
        "\n",
      ),
      filePath: "tasks/p02-script-with.yml",
    });
    expect(task.target.kind).toBe("uses");
    if (task.target.kind === "uses") expect(task.target.uses.kind).toBe("script");

    const error = await rejection(prepareTaskV3Execution(task, context()));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe("Task v3 script refs do not accept with.");
  });
});

describe("P-03 — task-layer with on a workflow ref becomes the child workflow's frozen params (runtime-v3.ts:432)", () => {
  test('P-03 — uses: workflows/<ref> with with: prepares { kind: "workflow", ref, params }, params deep-equal to the authored mapping and frozen', async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: workflows/child", "with:", "  scope: all", "akm:", '  schedule: "@daily"', ""].join(
        "\n",
      ),
      filePath: "tasks/p03-workflow-with.yml",
    });
    expect(task.target.kind).toBe("uses");
    if (task.target.kind === "uses") expect(task.target.uses.kind).toBe("workflow");

    const prepared = await prepareTaskV3Execution(task, context(resolvedWorkflowAsset()));
    expect(prepared.kind).toBe("workflow");
    if (prepared.kind !== "workflow") return;
    expect(prepared.ref).toBe("primary//workflows/child");
    expect(prepared.params).toEqual({ scope: "all" });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.params)).toBe(true);
  });

  test("P-03 — absent with: prepares params as {} (not undefined), and the result stays frozen", async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: workflows/child", "akm:", '  schedule: "@daily"', ""].join("\n"),
      filePath: "tasks/p03-workflow-no-with.yml",
    });
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

describe("P-04 — a workflow-target task with any env: is rejected (runtime-v3.ts:415-421)", () => {
  test("P-04 — uses: workflows/<ref> with a non-empty env: throws UsageError INVALID_FLAG_VALUE with the exact message", async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: workflows/child", "env:", "  FOO: bar", "akm:", '  schedule: "@daily"', ""].join(
        "\n",
      ),
      filePath: "tasks/p04-workflow-env.yml",
    });
    expect(Object.keys(task.env ?? {}).length).toBeGreaterThan(0);

    const error = await rejection(prepareTaskV3Execution(task, context(resolvedWorkflowAsset())));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    expect((error as Error).message).toBe(
      "Task v3 workflow env cannot be consumed by the durable workflow runtime in 0.9.2; remove env or use a command target.",
    );
  });

  test("P-04 — the rejection fires exactly when Object.keys(environment).length > 0, not merely when env: is authored", async () => {
    // CHARACTERIZATION (P0): pins CURRENT behavior (defect included); a later phase flips this deliberately.
    // An authored-but-empty env: mapping owns the `env` key yet yields zero
    // environment entries — proving the guard reads Object.keys(environment)
    // rather than merely `document.env !== undefined`.
    const task = parseTaskV3Yaml({
      yaml: ["version: 3", "uses: workflows/child", "env: {}", "akm:", '  schedule: "@daily"', ""].join("\n"),
      filePath: "tasks/p04-workflow-empty-env.yml",
    });
    expect(task.env).toEqual({});

    const prepared = await prepareTaskV3Execution(task, context(resolvedWorkflowAsset()));
    expect(prepared.kind).toBe("workflow");
  });
});
