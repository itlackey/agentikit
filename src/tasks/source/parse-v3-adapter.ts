// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `parseTaskV3Yaml` output -> `TaskDefinition` (spec
 * docs/plans/specs/p1b-model-extraction.md §1.1 D4, §3).
 *
 * Pure, additive adapter: NO new parsing, NO new validation, NO
 * source-syntax change — `src/tasks/source-v3.ts` is untouched by this
 * phase (spec §9's `git diff --stat -- src/tasks/source-v3.ts` acceptance
 * criterion). Every value handled here already passed `parseTaskV3Yaml`'s
 * strict grammar; this module only reshapes that already-validated document
 * into the closed `TaskDefinition` vocabulary (`../model/definition`),
 * which performs its own (pre-existing, not new) construction validation.
 *
 * A task's fully-qualified ref depends on which bundle owns it — bundle
 * resolution is IO, so it cannot be derived here without breaking the
 * module's purity (spec §3.2 ratchet: no fs/db/subprocess/network imports).
 * The caller supplies it via `identity.ref`, exactly how
 * `prepareTaskV3Execution` already takes `context.taskId`/`context.taskRef`
 * for the same reason (`src/tasks/runtime-v3.ts:108-110`).
 *
 * Out of scope in P1b (see tests/tasks/parse-v3-adapter.test.ts, design
 * decision 3): `akm/command` (builtin-command) and GitHub-action `uses:`
 * targets have no representation in the closed 4-kind `TaskDefinitionTarget`
 * vocabulary this phase pins. Inline builtin-command content in particular
 * carries no ref at all (`ParsedBuiltinCommandAction`'s `kind: "inline"`
 * variant, `src/commands/command/builtin-action.ts`), and a GitHub-action
 * locator (`owner/repo[/path]@rev`) is not an asset ref. Both throw rather
 * than silently mis-mapping into `{kind:"command", ref}` and losing or
 * misrepresenting the authored data — mirroring
 * `prepareTaskV3Execution`'s own github-action rejection
 * (`runtime-v3.ts:366-371`). No fixture in
 * tests/fixtures/execution-contracts/tasks/v3-migration/ exercises either
 * kind. Also out of scope: `TaskV3Target`'s `run` variant's
 * `workingDirectory` has no slot in P1b's `TaskDefinitionTarget` shell
 * variant (a genuinely new, not-yet-complete type — see
 * tests/tasks/model-contracts.test.ts's file header) and is intentionally
 * dropped rather than fabricating a field the pinned test-first contract
 * does not carry.
 */

import { UsageError } from "../../core/errors";
import { createTaskDefinition, type TaskDefinition, type TaskDefinitionTarget } from "../model/definition";
import type { TaskScheduleBinding } from "../model/schedule";
import type { TaskV3SourceDocument, TaskV3Target, TaskV3TriggerPlan } from "../source-v3";

function adaptTarget(target: TaskV3Target): TaskDefinitionTarget {
  if (target.kind === "run") {
    return {
      kind: "shell",
      command: target.run,
      ...(target.shell !== undefined ? { shell: target.shell } : {}),
    };
  }
  const uses = target.uses;
  if (uses.kind === "command") return { kind: "command", ref: uses.ref };
  if (uses.kind === "script") return { kind: "script", ref: uses.ref };
  if (uses.kind === "workflow") {
    return { kind: "workflow", ref: uses.ref, params: { ...(target.with ?? {}) } };
  }
  throw new UsageError(
    `Task v3 uses kind ${JSON.stringify(uses.kind)} has no TaskDefinition target representation in P1b.`,
    "INVALID_FLAG_VALUE",
  );
}

/**
 * v3 has no per-schedule-entry `enabled` concept — the single document-level
 * `akm.enabled` flag broadcasts onto every schedule entry (spec §1.1/§3.3
 * design decision 5), matching `TaskV3PreparedBase.enabled`'s existing
 * "absent or anything but `false` means enabled" convention
 * (`runtime-v3.ts:242`).
 */
function adaptScheduleBindings(
  triggers: TaskV3TriggerPlan,
  akmEnabled: boolean | undefined,
): readonly TaskScheduleBinding[] {
  const enabled = akmEnabled !== false;
  return triggers.schedules.map((schedule) => ({ cron: schedule.cron, enabled }));
}

/** Map one already-parsed, already-validated task-v3 document to a `TaskDefinition`. */
export function taskDefinitionFromV3(
  document: TaskV3SourceDocument,
  identity: Readonly<{ ref: string }>,
): TaskDefinition {
  const akm = document.akm;
  const name = document.name;
  const description = akm?.description;
  const engine = akm?.engine;
  const model = akm?.model;
  const timeout = akm?.timeout;

  return createTaskDefinition({
    ref: identity.ref,
    source: { path: document.source.path },
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    target: adaptTarget(document.target),
    execution: {
      ...(engine !== undefined ? { engine } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      redact: akm?.redact ?? [],
      env: document.env ?? {},
    },
    scheduleBindings: adaptScheduleBindings(document.triggers, akm?.enabled),
  });
}
