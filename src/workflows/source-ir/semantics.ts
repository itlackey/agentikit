// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Shared semantic validation for every workflow source-IR producer and decoder. */

import fs from "node:fs";
import path from "node:path";
import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { parseSchedule } from "../../tasks/schedule";
import { classifyWorkflowSourceUses, type WorkflowSourceUsesClassifier, type WorkflowSourceUsesTarget } from "./uses";

export class WorkflowSourceSemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowSourceSemanticError";
  }
}

export type WorkflowSourceCommandMode = "literal" | "portable-template" | "stored-ref";

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

/**
 * `run:` is lowered to `exec: {command: ["sh", "-c", <this value>]}`
 * (`source-ir/program.ts`'s `sourceStepProgramUnit`), and an author-written
 * `exec:` step already passes the identical bytes through with only a NUL
 * check (`rejectNulInArgv`). The former token-safe grammar here (rejecting
 * `run: |` multiline, `&&`, pipes, quotes, `$`) blocked nothing an author
 * could not already do one line away with `exec:` — it was a restriction on
 * spelling, not on capability. `${{ }}` stays rejected: akm genuinely does
 * not evaluate GitHub expressions/contexts, in `run:` or anywhere else.
 */
export function canonicalizeWorkflowRun(value: string): string {
  if (value.includes("${{")) {
    throw new WorkflowSourceSemanticError(
      "unsupported-github-expression",
      "GitHub expressions and contexts are not supported.",
    );
  }
  if (value.includes("\0")) {
    throw new WorkflowSourceSemanticError("invalid-exec-argv", "Local run may not contain NUL bytes.");
  }
  return value;
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
  let target: WorkflowSourceUsesTarget;
  try {
    target = classifier(value);
  } catch (cause) {
    throw usesFailure(value, cause);
  }
  // P3a (docs/plans/specs/p3a-plan-v5-child-freeze.md §1.3(2)/§4, A-N4): a
  // `kind: "workflow"` target used to throw `nested-workflow-unsupported`
  // here. That rejection is REMOVED — classification returns the workflow
  // target like any other target-ref-shaped `uses:`, and freeze decides
  // (`src/workflows/freeze/targets/child-workflow.ts`, the ONE recursive
  // child-workflow resolver both the direct and task-wrapped composition
  // forms route through).
  return target;
}

/**
 * Validate AKM's built-in command action at the shared source/decoder boundary.
 *
 * Mode consistency (stored vs. inline, literal vs. portable-template) is
 * still enforced here. The portable-template CONTENT SCAN (issue 4) is not:
 * it used to reject ordinary inline prose like `"Review $ARGUMENTS against
 * @docs/style-guide.md"` for using constructs (`@file`, bare `$NAME`, …) that
 * only matter for a STANDALONE command file meant to round-trip through a
 * native tool. The identical prose, written directly as a markdown step's
 * body instead of an explicit `uses: akm/command`, was always literal and
 * never scanned (`source-ir/compile.ts`'s `commandMode: "literal"`) — an
 * inline workflow step is authored for akm alone, so scanning it for
 * constructs akm never expands bought nothing but false positives.
 */
export function validateWorkflowBuiltinCommand(
  value: unknown,
  mode?: WorkflowSourceCommandMode,
): ParsedBuiltinCommandAction {
  let action: ParsedBuiltinCommandAction;
  try {
    action = parseBuiltinCommandAction(value);
  } catch (cause) {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      cause instanceof Error ? cause.message : "Invalid akm/command inputs.",
    );
  }

  const expectedMode: WorkflowSourceCommandMode = action.kind === "stored" ? "stored-ref" : "portable-template";
  const effectiveMode = mode ?? expectedMode;
  if (action.kind === "stored") {
    if (effectiveMode !== "stored-ref") {
      throw new WorkflowSourceSemanticError(
        "builtin-command-inputs",
        "Stored akm/command refs require commandMode stored-ref.",
      );
    }
    return action;
  }
  if (effectiveMode === "stored-ref") {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      "Inline akm/command content cannot use commandMode stored-ref.",
    );
  }
  if (effectiveMode === "literal" && action.arguments !== undefined) {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      "Literal akm/command content cannot declare arguments because no substitution occurs.",
    );
  }
  return action;
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

  let current = root;
  for (const segment of relative === "." ? [] : relative.split("/")) {
    current = path.join(current, segment);
    try {
      const entry = fs.lstatSync(current);
      if (entry.isSymbolicLink()) {
        let physical: string;
        try {
          physical = fs.realpathSync(current);
        } catch {
          throw new WorkflowSourceSemanticError(
            "working-directory-unverifiable",
            "working-directory contains a dangling or unresolvable symlink.",
          );
        }
        if (!contained(root, physical)) {
          throw new WorkflowSourceSemanticError(
            "working-directory-escape",
            "working-directory resolves through a symlink outside the workspace.",
          );
        }
        let target: fs.Stats;
        try {
          target = fs.statSync(current);
        } catch {
          throw new WorkflowSourceSemanticError(
            "working-directory-unverifiable",
            "working-directory symlink target cannot be physically verified.",
          );
        }
        if (!target.isDirectory()) {
          throw new WorkflowSourceSemanticError(
            "working-directory-unverifiable",
            "working-directory must resolve through directories.",
          );
        }
        continue;
      }
      if (!entry.isDirectory()) {
        throw new WorkflowSourceSemanticError(
          "working-directory-unverifiable",
          "working-directory must resolve through directories.",
        );
      }
      const physical = fs.realpathSync(current);
      if (!contained(root, physical)) {
        throw new WorkflowSourceSemanticError(
          "working-directory-escape",
          "working-directory resolves through a symlink outside the workspace.",
        );
      }
    } catch (cause) {
      if (cause instanceof WorkflowSourceSemanticError) throw cause;
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        // A genuinely absent lexical component is allowed at source time; the
        // runtime dispatch boundary revalidates containment when it appears.
        // `lstat` distinguishes this from a dangling symlink, which fails
        // closed above even before its target can appear.
        return;
      }
      throw new WorkflowSourceSemanticError(
        "working-directory-unverifiable",
        "working-directory cannot be physically verified.",
      );
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
