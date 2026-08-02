// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Validate a parsed {@link TaskDocument} for runnability.
 *
 * Enforces:
 *   • the schedule is parseable and translates to the active backend
 *   • the workflow ref resolves (workflow targets)
 *   • the asset/file source exists (prompt targets)
 *   • the selected engine resolves (prompt targets)
 *
 * Validation is deliberately split from parsing: callers that only inspect
 * task metadata (e.g. `akm show`) can skip these checks, while
 * `task add` and `task run` should always run them.
 */

import fs from "node:fs";
import path from "node:path";
import { placementSpecFor } from "../core/asset/asset-placement";
import { parseRefInput } from "../core/asset/resolve-ref";
import { loadConfig } from "../core/config/config";
import { NotFoundError } from "../core/errors";
import { NO_ENGINE_MESSAGE_SUFFIX, withEngineFallback } from "../integrations/agent/engine-fallback";
import { resolveEngine } from "../integrations/agent/engine-resolution";
import { resolveAssetPath } from "../sources/resolve";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import type { TaskDocument } from "./schema";

export interface ValidateTaskOptions {
  /** Which backend the schedule must translate to. */
  backend: ScheduleBackend;
  /**
   * The stash directory the task's asset refs resolve against. Resolved once at
   * the `akm task` command boundary (WI-9.10 CLI-wide sweep) and threaded in —
   * this leaf no longer reads the ambient stash-dir resolver.
   */
  stashDir: string;
}

export async function validateTaskDocument(task: TaskDocument, options: ValidateTaskOptions): Promise<void> {
  // Schedule must parse and translate.
  parseSchedule(task.schedule, options.backend);

  if (task.target.kind === "workflow") {
    const stashDir = options.stashDir;
    const ref = parseRefInput(task.target.ref);
    if (ref.type !== "workflow") {
      throw new NotFoundError(
        `Task "${task.id}" workflow target must be a workflow ref (got "${task.target.ref}").`,
        "WORKFLOW_NOT_FOUND",
      );
    }
    await resolveAssetPath(stashDir, "workflow", ref.name);
    return;
  }

  if (task.target.kind !== "prompt") {
    return;
  }

  // Prompt target. Resolve the engine unconditionally — when no engine is
  // set on the task, defaults.engine is required. Catching this at
  // `task add` / `task sync` time is much more useful than failing only
  // when the OS scheduler fires.
  // Resolve against the SAME effective config the runner will use
  // (`tasks/runner.ts`), or validation rejects at `task add` / `task sync` a
  // task the runner would have happily executed via the implicit fallback.
  const { config } = withEngineFallback(loadConfig());
  const engine = task.target.engine ?? config.defaults?.engine;
  if (!engine) throw new NotFoundError(`Task "${task.id}" ${NO_ENGINE_MESSAGE_SUFFIX}`, "ASSET_NOT_FOUND");
  const resolved = resolveEngine(engine, config);
  if (task.target.llm !== undefined && resolved.kind !== "llm") {
    throw new NotFoundError(`Task "${task.id}" uses llm overrides with non-LLM engine "${engine}".`, "ASSET_NOT_FOUND");
  }

  const src = task.target.source;
  if (src.kind === "asset") {
    const stashDir = options.stashDir;
    const ref = parseRefInput(src.ref);
    // D11 — `parseRefInput` now also accepts an opaque adapter conceptId (a
    // ref whose leading segment is not an AKM placement dir), but
    // `resolveAssetPath` (src/sources/resolve.ts) is placement-dir-only: it
    // has no stash-subdir to route an opaque type through. Surface a clean
    // domain error here rather than let that helper crash on a missing
    // directory mapping.
    if (placementSpecFor(ref.type) === undefined) {
      throw new NotFoundError(
        `Task "${task.id}" prompt asset ref "${src.ref}" is not an AKM-placed asset — adapter-owned (opaque) prompt sources are not resolvable as task inputs yet.`,
        "ASSET_NOT_FOUND",
      );
    }
    await resolveAssetPath(stashDir, ref.type, ref.name);
  } else if (src.kind === "file") {
    const taskDir = path.dirname(task.source.path);
    const resolved = path.isAbsolute(src.path) ? src.path : path.resolve(taskDir, src.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new NotFoundError(
        `Prompt file not found for task "${task.id}": ${src.path} (resolved to ${resolved}).`,
        "FILE_NOT_FOUND",
      );
    }
  }
  // inline source is always valid post-parse.
}
