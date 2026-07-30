// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import workflowTemplate from "../../assets/workflows/workflow-template.md" with { type: "text" };
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { isWithin, writeFileAtomic } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { defaultBundleForTarget } from "../../core/mutation-target";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { warn } from "../../core/warn";
import { prepareWriteTargetForMutation, resolveWriteTarget, withWriteTargetMutation } from "../../core/write-source";
import { compileWorkflowPlan } from "../ir/compile";
import { parseWorkflow } from "../parser";
import type { WorkflowError } from "../schema";

const DEFAULT_WORKFLOW_TEMPLATE = renderWorkflowTemplate({
  title: "Example Workflow",
  firstStepTitle: "First Step",
  firstStepId: "first-step",
});

export function getWorkflowTemplate(): string {
  return DEFAULT_WORKFLOW_TEMPLATE;
}

export function buildWorkflowTemplate(name?: string): string {
  if (!name) return DEFAULT_WORKFLOW_TEMPLATE;

  const title = humanizeWorkflowName(name);
  const stepId = slugifyWorkflowStepId(name);
  const customized = renderWorkflowTemplate({
    title,
    firstStepTitle: `${title} Setup`,
    firstStepId: `${stepId}-setup`,
  });
  validateWorkflowContent(customized, `<template:${name}>`);
  return customized;
}

/** Parse AND compile `content`, so a create never writes an asset that `show`/`start`/`validate` would then reject. */
function validateWorkflowContent(content: string, sourcePath: string): void {
  const result = parseWorkflow(content, { path: sourcePath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(sourcePath, result.errors));
  }
  const compiled = compileWorkflowPlan(result.document, slugifyWorkflowStepId(sourcePath));
  if (!compiled.ok) {
    throw new UsageError(formatWorkflowErrors(sourcePath, compiled.errors));
  }
}

/** Recognized workflow-program suffixes — creating one is a lint-time usage error (workflow-format-unification). */
const YAML_SUFFIX_RE = /\.ya?ml$/i;

export function createWorkflowAsset(input: { name: string; content?: string; from?: string; force?: boolean }): {
  ref: string;
  path: string;
  stashDir: string;
} {
  if (YAML_SUFFIX_RE.test(input.name.trim())) {
    throw new UsageError(
      `Workflows are markdown-only now (workflow-format-unification) — "${input.name}" cannot be created. ` +
        `Use a plain name (no ".yaml"/".yml" suffix); the orchestration graph lives in the ".md" file's frontmatter.`,
    );
  }

  const config = loadConfig();
  const resolvedTarget = resolveWriteTarget(config);
  const target = prepareWriteTargetForMutation(resolvedTarget, { allowedAdapters: ["akm", "akm-workflow"] });
  const stashDir = target.source.path;
  const standaloneWorkflowBundle = target.source.adapterId === "akm-workflow";
  const typeRoot = standaloneWorkflowBundle ? stashDir : path.join(stashDir, "workflows");

  const normalizedName = normalizeWorkflowName(input.name);
  const conceptId = standaloneWorkflowBundle ? normalizedName : `workflows/${normalizedName}`;
  const assetPath = path.join(typeRoot, `${normalizedName}.md`);
  const relativeAssetPath = path.relative(path.resolve(typeRoot), path.resolve(assetPath));
  if (
    relativeAssetPath === ".." ||
    relativeAssetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeAssetPath)
  ) {
    throw new UsageError(`Resolved workflow path escapes the bundle: "${normalizedName}"`, "PATH_ESCAPE_VIOLATION");
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Workflow "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  if (input.force && !input.from) {
    throw new UsageError(
      "Refusing to overwrite with template: pass --from <file> to replace content, or omit --force to create a new workflow.",
    );
  }

  const content = input.from
    ? readWorkflowSource(input.from, stashDir)
    : (input.content ?? buildWorkflowTemplate(normalizedName));
  const sourcePath = input.from ?? `workflows/${normalizedName}.md`;

  validateWorkflowContent(content, sourcePath);

  const authoredContent = ensureAkmMarkdownType(content, "workflow");
  const mode = fs.existsSync(assetPath) ? fs.lstatSync(assetPath).mode & 0o777 : 0o644;

  const defaultBundle = defaultBundleForTarget(config);
  const ref = makeBundleRef(target.source.name === defaultBundle ? undefined : target.source.name, conceptId);
  withWriteTargetMutation(
    target,
    [assetPath],
    { ignored: "reject", purpose: "workflow-authoring", message: `Create ${ref}` },
    () => {
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      writeFileAtomic(assetPath, authoredContent.endsWith("\n") ? authoredContent : `${authoredContent}\n`, mode);
    },
  );

  return {
    ref,
    path: assetPath,
    stashDir,
  };
}

function readWorkflowSource(source: string, stashDir: string): string {
  const resolved = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new UsageError(`Workflow source not found: "${source}".`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Workflow source must be a file: "${source}".`);
  }
  // The user is allowed to import any readable file as a workflow body, but
  // an import from outside the stash is unusual enough to warn about. Anyone
  // running `akm workflow create --from /etc/passwd` deserves a heads-up.
  if (!isWithin(resolved, stashDir)) {
    warn(
      `Importing workflow content from outside the stash: ${resolved}\n  ` +
        `If this was unintentional, abort and re-run with a --from path inside ${stashDir}.`,
    );
  }
  return fs.readFileSync(resolved, "utf8");
}

function normalizeWorkflowName(name: string): string {
  // Strip a recognized workflow extension (.md) so the canonical name — and
  // thus the `workflows/<name>` ref — is extension-free regardless of how the
  // user spelled it.
  const normalized = canonicalizeWorkflowName(
    name
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, ""),
  );
  if (!normalized) {
    throw new UsageError("Workflow name cannot be empty.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("Workflow name must be a relative path without '.' or '..' segments.");
  }
  return normalized;
}

function humanizeWorkflowName(name: string): string {
  return (
    name
      .split("/")
      .pop()
      ?.replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase())
      .trim() || "Example Workflow"
  );
}

function slugifyWorkflowStepId(name: string): string {
  return (
    name
      .split("/")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

export function formatWorkflowErrors(path: string, errors: WorkflowError[]): string {
  const lines = errors.map((e) => `  ${path}:${e.line} — ${e.message}`);
  const heading = errors.length === 1 ? "Workflow has 1 error:" : `Workflow has ${errors.length} errors:`;
  return [heading, ...lines].join("\n");
}

/**
 * Validate a workflow filesystem path.
 *
 * Returns the parse result plus the source-relative path used. Throws
 * `UsageError` only when the target cannot be located on disk; parse
 * failures are returned as `{ ok: false, errors }` so callers can
 * format them however they like.
 */
export function validateWorkflowSource(target: string): {
  path: string;
  parse: ReturnType<typeof parseWorkflow>;
} {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new UsageError(`Workflow file not found: "${target}".`);
  }
  const content = fs.readFileSync(resolved, "utf8");
  return { path: target, parse: parseWorkflow(content, { path: target }) };
}

function renderWorkflowTemplate(input: { title: string; firstStepTitle: string; firstStepId: string }): string {
  return workflowTemplate
    .replace("{{TITLE}}", input.title)
    .replace("{{FIRST_STEP_TITLE}}", input.firstStepTitle)
    .replace("{{FIRST_STEP_ID}}", input.firstStepId);
}
