// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Compat shim (spec docs/plans/specs/p1b-model-extraction.md §4.1/§9).
 *
 * The pure task-v3 runtime projection this file used to hold now lives under
 * src/tasks/prepare/: the PreparedTaskV3* type family in
 * src/tasks/prepare/prepared-execution.ts, and prepareTaskV3Execution's body
 * in src/tasks/prepare/prepare.ts. This file carries no logic of its own —
 * only re-exports — so pre-P1b importers keep compiling. Every production
 * caller was rewired to import from prepare/ directly in the same
 * change-set; only test importers still reach this shim.
 *
 * P4: delete this shim.
 */

export { prepareTaskV3Execution } from "./prepare/prepare";
export type {
  PreparedTaskV3Command,
  PreparedTaskV3DirectoryIdentity,
  PreparedTaskV3Execution,
  PreparedTaskV3Script,
  PreparedTaskV3Shell,
  PreparedTaskV3Workflow,
  PrepareTaskV3ExecutionContext,
  TaskV3PreparedBase,
  TaskV3ScriptInterpreter,
} from "./prepare/prepared-execution";
