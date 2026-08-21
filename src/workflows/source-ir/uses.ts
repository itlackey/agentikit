// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Structural copy of WP6's pinned target result, used only as the source
 * compiler's injection boundary. Once WP6 is integrated, composition injects
 * its canonical `classifyTaskV3Uses` implementation rather than maintaining a
 * second public grammar.
 */

import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
export type WorkflowSourceUsesTarget =
  | { kind: "builtin-command"; ref: "akm/command" }
  | { kind: "command" | "task" | "workflow" | "script"; ref: string }
  | {
      kind: "github-action";
      ref: string;
      owner: string;
      repository: string;
      path?: string;
      revision: string;
    };

export type WorkflowSourceUsesClassifier = (value: string) => WorkflowSourceUsesTarget;

/** Structural WP6 trigger seam pinned at commit 5ac14930. */
export interface WorkflowSourceScheduleBinding {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
}

/** Structural WP6 trigger seam pinned at commit 5ac14930. */
export interface WorkflowSourceTriggerPlan {
  readonly manual: boolean;
  readonly schedules: readonly WorkflowSourceScheduleBinding[];
}

/** Structural WP6 trigger seam pinned at commit 5ac14930. */
export interface WorkflowSourceTriggerClassifierOptions {
  readonly filePath: string;
  readonly lineAt?: (path: readonly (string | number)[]) => number | undefined;
}

export type WorkflowSourceTriggerClassifier = (
  value: unknown,
  options: WorkflowSourceTriggerClassifierOptions,
) => WorkflowSourceTriggerPlan;

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const GITHUB_ACTION_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GITHUB_REF_FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/**
 * Exact WP6-owner fallback for builds where the task-v3 module is not yet
 * present. Callers may inject the canonical classifier through compile options.
 */
export function classifyWorkflowSourceUses(value: string): WorkflowSourceUsesTarget {
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new Error("uses must be one exact, non-empty executable ref");
  }
  if (value === "akm/command") return { kind: "builtin-command", ref: value };
  if (/\$\{\{/.test(value)) throw new Error("GitHub expressions are unsupported in uses");
  if (value.startsWith("docker://")) throw new Error("Docker action references are unsupported");
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) {
    throw new Error("Local action paths are unsupported");
  }
  if (/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/\/)?agents\//.test(value)) {
    throw new Error("Agent refs are not executable uses targets");
  }
  try {
    const parsed = parseBundleRef(value);
    if (parsed.fragment === undefined && bundleRefToString(parsed) === value) {
      const slash = parsed.conceptId.indexOf("/");
      const family = slash < 0 ? "" : parsed.conceptId.slice(0, slash);
      const name = slash < 0 ? "" : parsed.conceptId.slice(slash + 1);
      if (
        name.length > 0 &&
        (family === "commands" || family === "tasks" || family === "workflows" || family === "scripts")
      ) {
        const kind =
          family === "commands"
            ? "command"
            : family === "tasks"
              ? "task"
              : family === "workflows"
                ? "workflow"
                : "script";
        return { kind, ref: value };
      }
    }
  } catch {
    // A noncanonical AKM ref may still be a GitHub action locator below.
  }

  const at = value.lastIndexOf("@");
  if (at > 0 && at === value.indexOf("@")) {
    const locator = value.slice(0, at);
    const revision = value.slice(at + 1);
    const [owner, repository, ...actionPath] = locator.split("/");
    if (
      owner &&
      repository &&
      GITHUB_OWNER.test(owner) &&
      GITHUB_REPOSITORY.test(repository) &&
      repository !== "." &&
      repository !== ".." &&
      actionPath.every((segment) => GITHUB_ACTION_PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..") &&
      validGithubRevision(revision)
    ) {
      const actionPathString = actionPath.join("/");
      return {
        kind: "github-action",
        ref: value,
        owner,
        repository,
        ...(actionPathString ? { path: actionPathString } : {}),
        revision,
      };
    }
  }
  throw new Error(`Unsupported uses target ${JSON.stringify(value)}`);
}

function validGithubRevision(revision: string): boolean {
  if (
    revision.length === 0 ||
    [...revision].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f || GITHUB_REF_FORBIDDEN.has(character);
    }) ||
    revision.startsWith("/") ||
    revision.endsWith("/") ||
    revision.includes("..") ||
    revision.includes("@{") ||
    revision.includes("@")
  ) {
    return false;
  }
  return revision.split("/").every((segment) => {
    return (
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(".") &&
      !segment.endsWith(".") &&
      !segment.endsWith(".lock")
    );
  });
}
