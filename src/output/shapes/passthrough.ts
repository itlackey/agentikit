// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Identity-passthrough commands — registered here so the registry stays
// exhaustive (v1 spec §9). Each result object is already shaped at the
// command boundary; the registry just confirms there's no surprise
// command name slipping through.
import type { OutputShapeEntry } from "./registry";

// #484: stamp schemaVersion + shape discriminator on passthrough envelopes so
// third-party consumers can pin a schema version and dispatch on shape uniformly.
// Idempotent — never overwrites an existing schemaVersion or shape field.
function makeStampHandler(command: string) {
  return (result: unknown): unknown => {
    if (result === null || result === undefined) return result;
    if (typeof result !== "object" || Array.isArray(result)) return result;
    const obj = result as Record<string, unknown>;
    if (obj.shape === undefined) obj.shape = command;
    if (obj.schemaVersion === undefined) obj.schemaVersion = 1;
    return obj;
  };
}

const PASSTHROUGH_COMMANDS = [
  "add",
  "agent-result",
  "bundle-create",
  "bundle-show",
  "clone",
  "config",
  "env-create",
  "env-export",
  "env-remove",
  "feedback",
  "extract",
  "health",
  "improve",
  "import",
  "index",
  "info",
  "lint",
  "list",
  "proposal-accept-batch",
  "proposal-drain",
  "proposal-reject-batch",
  "proposal-revert",
  "registry-add",
  "registry-list",
  "registry-remove",
  "remember",
  "remove",
  "secret-set",
  "setup",
  "sync",
  "task-add",
  "task-doctor",
  "task-history",
  "task-run",
  "task-sync",
  "update",
  "upgrade",
  "workflow-abandon",
  "workflow-brief",
  "workflow-complete",
  "workflow-complete-rejected",
  "workflow-create",
  "workflow-list",
  "workflow-next",
  "workflow-report",
  "workflow-resume",
  "workflow-run",
  "workflow-start",
  "workflow-status",
] as const;

export const passthroughShapes: OutputShapeEntry[] = PASSTHROUGH_COMMANDS.map((command) => ({
  command,
  handler: makeStampHandler(command),
}));
