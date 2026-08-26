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
import { resolveAdapterConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveAssetPath } from "../../sources/resolve";
import { prepareTaskV3Execution } from "../prepare/prepare";
import type { PreparedTaskV3Execution } from "../prepare/prepared-execution";
import { scheduledTaskContextEnv } from "../scheduler-invocation";
import { parseTaskV3Yaml } from "../source-v3";
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
  const source = parseTaskV3Yaml({ yaml, filePath, workspaceRoot: bundleDir });
  const requiresCommandConfig =
    source.target.kind === "uses" &&
    (source.target.uses.kind === "builtin-command" || source.target.uses.kind === "command");
  const config = requiresCommandConfig ? loadConfig() : CONFIG_FREE_TASK_RUNTIME;
  const bundleName = options.bundleName ?? config.defaultBundle ?? DEFAULT_BUNDLE_NAME;
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
