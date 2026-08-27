// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Shared semantic validation for every workflow source-IR producer and decoder. */

import fs from "node:fs";
import path from "node:path";
import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { validatePortableCommandTemplate } from "../../commands/command/portable-template";
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
    const failure = usesFailure(value, cause);
    // §4.3 step 8: a value that is github-locator-SHAPED still throws
    // remote-action-acquisition-out-of-scope, even though the new classifier
    // (classifyTargetRef, no locator grammar) rejects it as an unrecognized
    // family. Ordering is load-bearing: usesFailure's own prefix
    // classifications (docker://, ./ ../ /, agents/) must keep winning over
    // locator-shape detection, so this only overrides the generic
    // unsupported-uses-target fallback.
    if (failure.code === "unsupported-uses-target" && isGithubLocatorShape(value)) {
      throw new WorkflowSourceSemanticError(
        "remote-action-acquisition-out-of-scope",
        `Remote action acquisition is out of scope for ${JSON.stringify(value)}.`,
      );
    }
    throw failure;
  }
  if (target.kind === "github-action") {
    throw new WorkflowSourceSemanticError(
      "remote-action-acquisition-out-of-scope",
      `Remote action acquisition is out of scope for ${JSON.stringify(value)}.`,
    );
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

/**
 * Validate AKM's built-in command action at the shared source/decoder boundary.
 *
 * Inline YAML actions are portable templates and therefore use WP4's one
 * authoritative template validator. Markdown prose is explicitly `literal`,
 * while a stored ref remains resolution-owned because its template bytes are
 * not available until the later resolver loads the command asset.
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
  if (effectiveMode === "literal") {
    if (action.arguments !== undefined) {
      throw new WorkflowSourceSemanticError(
        "builtin-command-inputs",
        "Literal akm/command content cannot declare arguments because no substitution occurs.",
      );
    }
    return action;
  }
  try {
    validatePortableCommandTemplate(action.content, "inline workflow command");
  } catch (cause) {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      cause instanceof Error ? cause.message : "Invalid portable command template.",
    );
  }
  return action;
}

export function rejectNulInArgv(command: readonly string[]): void {
  if (command.some((argument) => argument.includes("\0"))) {
    throw new WorkflowSourceSemanticError("invalid-exec-argv", "Direct exec argv may not contain NUL bytes.");
  }
}

const GITHUB_LOCATOR_OWNER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_LOCATOR_REPOSITORY_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const GITHUB_LOCATOR_REVISION_FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/**
 * Minimal GitHub-locator SHAPE detection (P1a §4.3), local to this file and
 * deliberately NOT the full `owner/repo[/path]@rev` grammar in
 * src/tasks/source-v3.ts — shape only, no import from that module. Exists
 * solely to keep `remote-action-acquisition-out-of-scope` winning over
 * `unsupported-uses-target` for a value that `classifyTargetRef` rejects
 * (it owns no locator grammar at all), preserving R-04(c) until P4 removes
 * the row entirely.
 *
 * The owner segment intentionally stays looser than source-v3.ts's
 * `GITHUB_OWNER` (no 39-char cap, `.`/`_` allowed): a value the old grammar
 * rejected on owner shape now yields `remote-action-acquisition-out-of-scope`
 * instead of `unsupported-uses-target`, which is the one-directional slack
 * Accepted deviation A-1 (spec §4.3) authorizes. The repository segment and
 * revision character sets, however, mirror source-v3.ts's `GITHUB_REPOSITORY`
 * and `validGithubRevision` (`:178`, `:497-520`) exactly: an earlier version
 * of this function used a strict allowlist for both, which rejected shapes
 * the old grammar accepted (`owner/.github@v1`, `owner/_repo@v1`,
 * `owner/-repo@v1`, `owner/repo@v1.0+meta`, `owner/repo@%40`) — the OPPOSITE,
 * unauthorized direction (a CONFIRMED code-review finding) — so those two
 * segments are checked by forbidden-character/charset rules matching the old
 * grammar instead.
 */
function isGithubLocatorShape(value: string): boolean {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) return false;

  const locator = value.slice(0, at);
  const segments = locator.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return false;
  const [owner, repository] = segments;
  if (!owner || !repository) return false;
  if (!GITHUB_LOCATOR_OWNER_SEGMENT_RE.test(owner)) return false;
  if (!GITHUB_LOCATOR_REPOSITORY_SEGMENT_RE.test(repository) || repository === "." || repository === "..") {
    return false;
  }

  return isGithubLocatorRevisionShape(value.slice(at + 1));
}

/** Revision-shape check mirroring `validGithubRevision` (source-v3.ts:497-520) by forbidden-character set rather than a strict allowlist. */
function isGithubLocatorRevisionShape(revision: string): boolean {
  if (
    revision.length === 0 ||
    hasForbiddenGithubLocatorRevisionCharacter(revision) ||
    revision.startsWith("/") ||
    revision.endsWith("/") ||
    revision.includes("..") ||
    revision.includes("@{") ||
    revision.includes("@")
  ) {
    return false;
  }
  return revision
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith(".") &&
        !segment.endsWith(".") &&
        !segment.endsWith(".lock"),
    );
}

function hasForbiddenGithubLocatorRevisionCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || GITHUB_LOCATOR_REVISION_FORBIDDEN.has(character)) return true;
  }
  return false;
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
