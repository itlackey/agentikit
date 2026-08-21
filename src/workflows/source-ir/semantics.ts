// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Shared semantic validation for every workflow source-IR producer and decoder. */

import fs from "node:fs";
import path from "node:path";
import { parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
import { parseSchedule } from "../../tasks/schedule";
import { classifyWorkflowSourceUses, type WorkflowSourceUsesClassifier, type WorkflowSourceUsesTarget } from "./uses";

const TOKEN_SAFE_RUN = /^[A-Za-z0-9_./:@+=,-]+(?: [A-Za-z0-9_./:@+=,-]+)*$/;

export class WorkflowSourceSemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowSourceSemanticError";
  }
}

export function canonicalizeWorkflowCron(value: string): string {
  const canonical = value.trim().split(/\s+/).join(" ");
  if (canonical.startsWith("@") || canonical.split(" ").length !== 5) {
    throw new WorkflowSourceSemanticError("invalid-cron", "GitHub schedule cron must use exactly five fields.");
  }
  try {
    parseSchedule(canonical, "cron");
  } catch (cause) {
    throw new WorkflowSourceSemanticError(
      "invalid-cron",
      cause instanceof Error ? cause.message : "Invalid cron schedule.",
    );
  }
  return canonical;
}

export function canonicalizeWorkflowRun(value: string): string {
  if (value.includes("${{")) {
    throw new WorkflowSourceSemanticError(
      "unsupported-github-expression",
      "GitHub expressions and contexts are not supported.",
    );
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new WorkflowSourceSemanticError(
      "unsafe-run-syntax",
      "Local run accepts only whitespace-separated safe tokens; shell expansion and operators are unsupported.",
    );
  }
  const canonical = value
    .trim()
    .split(/[ \t]+/)
    .join(" ");
  if (!TOKEN_SAFE_RUN.test(canonical)) {
    throw new WorkflowSourceSemanticError(
      "unsafe-run-syntax",
      "Local run accepts only whitespace-separated safe tokens; shell expansion and operators are unsupported.",
    );
  }
  return canonical;
}

export function canonicalizeWorkflowWorkingDirectory(value: string, workspaceRoot?: string): string {
  if (hasControlCharacter(value)) {
    throw new WorkflowSourceSemanticError(
      "working-directory-control-character",
      "working-directory may not contain NUL or control characters.",
    );
  }
  if (value === "" || value.trim() === "") {
    throw new WorkflowSourceSemanticError(
      "working-directory-escape",
      "working-directory must be a non-empty relative contained path.",
    );
  }
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    portable.startsWith("~") ||
    segments.some((segment) => segment === "" || segment === "..")
  ) {
    throw new WorkflowSourceSemanticError(
      "working-directory-escape",
      "working-directory must be relative and contained.",
    );
  }
  const withoutDots = segments.filter((segment) => segment !== ".");
  const canonical = withoutDots.length === 0 ? "." : withoutDots.join("/");
  if (workspaceRoot !== undefined) verifyPhysicalContainment(workspaceRoot, canonical);
  return canonical;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function classifyWorkflowStepUses(
  value: string,
  classifier: WorkflowSourceUsesClassifier = classifyWorkflowSourceUses,
): WorkflowSourceUsesTarget {
  if (value.includes("${{")) {
    throw new WorkflowSourceSemanticError(
      "unsupported-github-expression",
      "GitHub expressions are unsupported in uses.",
    );
  }
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new WorkflowSourceSemanticError(
      "unsupported-uses-target",
      "uses must be one exact, non-empty executable ref",
    );
  }
  const task = canonicalTaskTarget(value);
  if (task) return task;
  let target: WorkflowSourceUsesTarget;
  try {
    target = classifier(value);
  } catch (cause) {
    throw usesFailure(value, cause);
  }
  if (target.kind === "github-action") {
    throw new WorkflowSourceSemanticError(
      "remote-action-acquisition-out-of-scope",
      `Remote action acquisition is out of scope for ${JSON.stringify(value)}.`,
    );
  }
  if (target.kind === "workflow") {
    throw new WorkflowSourceSemanticError(
      "nested-workflow-unsupported",
      `Nested workflow target ${JSON.stringify(value)} is unsupported in a workflow step.`,
    );
  }
  return target;
}

function canonicalTaskTarget(value: string): { kind: "task"; ref: string } | undefined {
  try {
    const parsed = parseBundleRef(value);
    if (parsed.fragment !== undefined || bundleRefToString(parsed) !== value) return undefined;
    const slash = parsed.conceptId.indexOf("/");
    if (slash < 0 || parsed.conceptId.slice(0, slash) !== "tasks" || parsed.conceptId.length === slash + 1) {
      return undefined;
    }
    return { kind: "task", ref: value };
  } catch {
    return undefined;
  }
}

export function validateWorkflowBuiltinCommand(value: unknown): void {
  try {
    parseBuiltinCommandAction(value);
  } catch (cause) {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      cause instanceof Error ? cause.message : "Invalid akm/command inputs.",
    );
  }
}

export function rejectNulInArgv(command: readonly string[]): void {
  if (command.some((argument) => argument.includes("\0"))) {
    throw new WorkflowSourceSemanticError("invalid-exec-argv", "Direct exec argv may not contain NUL bytes.");
  }
}

function usesFailure(value: string, cause: unknown): WorkflowSourceSemanticError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = value.startsWith("docker://")
    ? "docker-action-unsupported"
    : value.startsWith("./") || value.startsWith("../") || value.startsWith("/")
      ? "local-action-path-unsupported"
      : /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/\/)?agents\//.test(value)
        ? "non-executable-asset-ref"
        : "unsupported-uses-target";
  return new WorkflowSourceSemanticError(code, message);
}

function verifyPhysicalContainment(workspaceRoot: string, relative: string): void {
  let root: string;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch {
    throw new WorkflowSourceSemanticError(
      "working-directory-unverifiable",
      "Workspace root cannot be physically verified.",
    );
  }
  const candidate = path.resolve(root, ...relative.split("/"));
  if (!contained(root, candidate)) {
    throw new WorkflowSourceSemanticError("working-directory-escape", "working-directory escapes the workspace.");
  }

  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const stat = fs.statSync(current);
      if (!stat.isDirectory()) {
        throw new WorkflowSourceSemanticError(
          "working-directory-unverifiable",
          "working-directory must resolve through directories.",
        );
      }
      const physical = path.join(fs.realpathSync(current), ...suffix);
      if (!contained(root, physical)) {
        throw new WorkflowSourceSemanticError(
          "working-directory-escape",
          "working-directory resolves through a symlink outside the workspace.",
        );
      }
      return;
    } catch (cause) {
      if (cause instanceof WorkflowSourceSemanticError) throw cause;
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw new WorkflowSourceSemanticError(
          "working-directory-unverifiable",
          "working-directory cannot be physically verified.",
        );
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new WorkflowSourceSemanticError(
          "working-directory-unverifiable",
          "working-directory cannot be physically verified.",
        );
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
