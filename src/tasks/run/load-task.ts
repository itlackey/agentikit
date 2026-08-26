// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Load and project one task-v3 asset into immutable executable work: id
 * validation, adapter detection, owner resolution, source read, strict v3
 * parsing, config selection, bundle-name resolution, and the
 * `prepareTaskV3Execution` call. Everything here is non-mutating — run-task.ts
 * reserves a durable attempt only after this resolves.
 *
 * Moved from src/tasks/runner.ts's `runTask` body (spec
 * docs/plans/specs/p1b-model-extraction.md §5.1, §9, runner.ts:154-194).
 */

import fs from "node:fs";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import type { AkmConfig } from "../../core/config/config-types";
import { NotFoundError } from "../../core/errors";
import { resolveWriteTarget } from "../../core/write-source";
import {
  applyInputDefaults,
  type InputContract,
  materializeInputFlags,
  type TaskInputBinding,
  validateInputs,
} from "../../execution/input-contract";
import { resolveAdapterConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveAssetPath } from "../../sources/resolve";
import type { TaskInvocation } from "../model/invocation";
import { prepareTaskV3Execution } from "../prepare/prepare";
import type { PreparedTaskV3Execution } from "../prepare/prepared-execution";
import { scheduledTaskContextEnv } from "../scheduler-invocation";
import { parseTaskSource } from "../source/parse-task-source";
import { projectTaskSourceV4 } from "../source/project-v4";
import { TASK_INPUT_DIAGNOSTICS } from "../source/task-input-diagnostics";
import { validateTaskConceptId, validateTaskId } from "../task-id";
import type { RunTaskOptions } from "./task-result";

/**
 * F-3 (spec §5.4): the literal bundle-name fallback, hoisted to a named
 * constant — the VALUE does not change (it is user-visible data, R-09's
 * observable behavior). `runner.ts:173`'s bare `"stash"` becomes this.
 */
export const DEFAULT_BUNDLE_NAME = "stash";

const CONFIG_FREE_TASK_RUNTIME: AkmConfig = Object.freeze({
  configVersion: "0.9.0",
  semanticSearchMode: "off",
});

/** Resolve, parse, and project one task-v3 asset into a frozen, executable projection. */
export async function loadPreparedTask(id: string, options: RunTaskOptions): Promise<PreparedTaskV3Execution> {
  const bundleDir = options.bundleDir;
  const adapterId = options.adapterId ?? detectAdapterId(bundleDir);
  if (adapterId === "akm-task") validateTaskConceptId(id);
  else validateTaskId(id);
  const taskConceptId = adapterId === "akm" ? `tasks/${id}` : id;
  const owner = resolveAdapterConceptOwner(bundleDir, adapterId, taskConceptId);
  if (!owner) {
    throw new NotFoundError(
      `Task ${JSON.stringify(id)} was not found in the configured ${JSON.stringify(adapterId)} component.`,
      "ASSET_NOT_FOUND",
    );
  }
  const filePath = owner.path;
  const yaml = fs.readFileSync(filePath, "utf8");
  // Version-routing seam (spec docs/plans/specs/p2a-task-source-v4.md §3.6):
  // a task source v4 document projects into the same PreparableTaskDocument
  // shape v3 already produces, so every line below is unchanged for both
  // versions.
  const parsed = parseTaskSource({ yaml, filePath, workspaceRoot: bundleDir });
  const source = parsed.version === 4 ? projectTaskSourceV4(parsed.v4) : parsed.v3;
  const requiresCommandConfig =
    source.target.kind === "uses" &&
    (source.target.uses.kind === "builtin-command" || source.target.uses.kind === "command");
  const config = requiresCommandConfig ? loadConfig() : CONFIG_FREE_TASK_RUNTIME;
  const bundleName = options.bundleName ?? config.defaultBundle ?? DEFAULT_BUNDLE_NAME;
  // P2a Lane C, Stage 2 (spec docs/plans/specs/p2a-task-source-v4.md §5.1):
  // materialize akm task run's raw input flags (Stage 1,
  // src/commands/tasks/tasks-cli.ts) against the task's own contract —
  // task source v4: its inputs: declarations; v3: the empty contract, so
  // ANY input flag on a v3 task fails UNKNOWN_FLAG (there is nothing
  // declared to match against).
  // materializeInputFlags already validates the flag-supplied values; a
  // required input satisfied only by its own default (never supplied as a
  // flag) needs the SEPARATE validateInputs call below, run after defaults
  // are applied — materializeInputFlags returns {} immediately for zero
  // flags, before ever checking `required` (spec §5.1, input-contract.ts's
  // own header). Nothing downstream consumes `inputs` in P2a (spec §0); a
  // valid flag set therefore changes nothing about `source`/`config`/dispatch
  // below, only what gets attached to the TaskInvocation this function
  // constructs.
  const inputContract: InputContract = parsed.version === 4 ? (parsed.v4.inputs ?? {}) : {};
  const materializedInputs = materializeInputFlags(inputContract, options.inputFlags ?? [], TASK_INPUT_DIAGNOSTICS);
  const defaultedInputs = applyInputDefaults(inputContract, materializedInputs);
  const requiredErrors = validateInputs(inputContract, defaultedInputs);
  if (requiredErrors.length > 0) throw TASK_INPUT_DIAGNOSTICS.contractViolation(requiredErrors);
  const inputBindings: readonly TaskInputBinding[] = Object.entries(defaultedInputs).map(([name, value]) =>
    Object.freeze({ kind: "literal" as const, name, value }),
  );
  if (options.captureTaskInvocation) {
    const invocation: TaskInvocation = Object.freeze({
      taskRef: makeBundleRef(bundleName, taskConceptId),
      caller: Object.freeze({ kind: "cli" as const }),
      ...(inputBindings.length > 0 ? { inputs: Object.freeze(inputBindings) } : {}),
    });
    options.captureTaskInvocation(invocation);
  }
  return prepareTaskV3Execution(source, {
    taskId: id,
    taskRef: makeBundleRef(bundleName, taskConceptId),
    bundleName,
    bundleRoot: bundleDir,
    config,
    // Agent profiles build child env from an allowlist, so freeze the closed
    // scheduler-restored AKM directory context before command preparation.
    ...(options.scheduled ? { schedulerContext: scheduledTaskContextEnv() } : {}),
    resolveAsset: async ({ bundle, type, name }) => {
      if (bundle === bundleName) {
        return { file: await resolveAssetPath(bundleDir, type, name), bundleRoot: bundleDir };
      }
      const resolutionConfig = requiresCommandConfig ? config : loadConfig();
      const resolvedBundle = resolveWriteTarget(resolutionConfig, bundle, { requireWritable: false });
      return {
        file: await resolveAssetPath(resolvedBundle.source.path, type, name),
        bundleRoot: resolvedBundle.source.path,
      };
    },
  });
}
