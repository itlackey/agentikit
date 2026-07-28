// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import workflowTemplate from "../../assets/workflows/workflow-template.md" with { type: "text" };
import { adapterForId } from "../../core/adapter/registry";
import type { BundleComponent } from "../../core/adapter/types";
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { isWithin, writeFileAtomic } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { defaultBundleForTarget } from "../../core/mutation-target";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../../core/recognition-util";
import { warn } from "../../core/warn";
import { prepareWriteTargetForMutation, resolveWriteTarget, withWriteTargetMutation } from "../../core/write-source";
import { compileWorkflowProgram } from "../ir/compile";
import { parseWorkflow } from "../parser";
import { parseWorkflowProgram } from "../program/parser";
import type { WorkflowProgram } from "../program/schema";
import type { WorkflowError } from "../schema";
import workflowProgramTemplate from "./workflow-program-template.yaml" with { type: "text" };

const DEFAULT_WORKFLOW_TEMPLATE = renderWorkflowTemplate({
  title: "Example Workflow",
  firstStepTitle: "First Step",
  firstStepId: "first-step",
});

export function getWorkflowTemplate(): string {
  return DEFAULT_WORKFLOW_TEMPLATE;
}

/**
 * Minimal valid YAML workflow *program* (redesign addendum, R1), printed by
 * `akm workflow template --yaml`. Kept as an external asset file per the repo
 * convention (see `workflow-program-template.yaml` next to this module);
 * `tests/workflows/authoring-template.test.ts` pins that it parses AND
 * compiles (in-process, runs unconditionally in `bun run check`/CI).
 * `tests/integration/node-compat.test.ts` ("workflow template --yaml
 * round-trips through validate on Node") additionally round-trips it through
 * the real CLI on the Node runtime, but that one is gated behind
 * `AKM_NODE_COMPAT_TESTS=1` and does not run by default — it is a bonus
 * cross-runtime check, not the thing pinning correctness.
 */
export function getWorkflowProgramTemplate(): string {
  return workflowProgramTemplate;
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
  const result = parseWorkflow(customized, { path: `<template:${name}>` });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(`<template:${name}>`, result.errors));
  }
  return customized;
}

/**
 * Customize the shipped YAML program template ({@link getWorkflowProgramTemplate})
 * for a named workflow: swap the placeholder `name:` for the workflow's slug so
 * a freshly created `.yaml`/`.yml` asset round-trips through the program parser
 * (its `title` becomes the slug). Parses AND compiles the result — mirroring
 * {@link buildWorkflowTemplate} — so a create never writes an asset that
 * `show`/`start`/`validate` would then reject.
 */
export function buildWorkflowProgramTemplate(name?: string): string {
  if (!name) return workflowProgramTemplate;

  const programName = slugifyWorkflowStepId(name);
  const customized = workflowProgramTemplate.replace(/^name:.*$/m, `name: ${programName}`);
  const parsed = parseWorkflowProgram(customized, { path: `<template:${name}>` });
  if (!parsed.ok) {
    throw new UsageError(formatWorkflowErrors(`<template:${name}>`, parsed.errors));
  }
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) {
    throw new UsageError(formatWorkflowErrors(`<template:${name}>`, compiled.errors));
  }
  return customized;
}

/** Recognized YAML workflow-program suffixes (see {@link WORKFLOW_EXTENSIONS}). */
const WORKFLOW_PROGRAM_SUFFIX_RE = /\.ya?ml$/i;

export function createWorkflowAsset(input: { name: string; content?: string; from?: string; force?: boolean }): {
  ref: string;
  path: string;
  stashDir: string;
} {
  const config = loadConfig();
  const resolvedTarget = resolveWriteTarget(config);
  const target = prepareWriteTargetForMutation(resolvedTarget, { allowedAdapters: ["akm", "akm-workflow"] });
  const stashDir = target.source.path;
  const standaloneWorkflowBundle = target.source.adapterId === "akm-workflow";
  const typeRoot = standaloneWorkflowBundle ? stashDir : path.join(stashDir, "workflows");

  // A `.yaml`/`.yml` name selects the YAML *program* format (redesign
  // addendum, R1); capture the exact suffix the user typed so the written file
  // keeps it, then strip every workflow extension to get the canonical name.
  const suffixMatch = input.name.trim().replace(/\\/g, "/").match(WORKFLOW_PROGRAM_SUFFIX_RE);
  const programSuffix = suffixMatch ? suffixMatch[0].toLowerCase() : undefined;
  const isProgram = programSuffix !== undefined;

  const normalizedName = normalizeWorkflowName(input.name);
  const conceptId = standaloneWorkflowBundle ? normalizedName : `workflows/${normalizedName}`;
  // The write target is DEFINITIVE — the canonical name plus the chosen format's
  // extension (`.yaml`/`.yml` for a program, `.md` for markdown). We deliberately
  // do NOT go through `assetPathForName`, which PROBES existing files and
  // would redirect a markdown create onto an existing `foo.yaml` (writing
  // markdown into a `.yaml`). Computing the target directly makes a markdown
  // create always write `.md`, so the finding-C cross-extension check below sees
  // the real collision instead of a self-match.
  const targetSuffix = isProgram ? (programSuffix as string) : ".md";
  const component: BundleComponent = {
    id: target.source.name,
    adapter: target.source.adapterId ?? "akm",
    root: stashDir,
    writable: true,
  };
  const assetPath = standaloneWorkflowBundle
    ? (adapterForId("akm-workflow")?.placeNew?.(component, `${normalizedName}${targetSuffix}`) ??
      path.join(typeRoot, `${normalizedName}${targetSuffix}`))
    : path.join(typeRoot, `${normalizedName}${targetSuffix}`);
  const relativeAssetPath = path.relative(path.resolve(typeRoot), path.resolve(assetPath));
  if (
    relativeAssetPath === ".." ||
    relativeAssetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeAssetPath)
  ) {
    throw new UsageError(`Resolved workflow path escapes the stash: "${normalizedName}"`, "PATH_ESCAPE_VIOLATION");
  }
  // Codex round-3 finding C: a `workflows/<name>` ref is canonical across every
  // recognized extension (`.md`/`.yaml`/`.yml`) and resolves `.md` BEFORE
  // `.yaml`. So creating `foo.yaml` while `foo.md` exists would return the ref
  // `workflows/foo` that still starts the OLD markdown workflow — a silently
  // shadowed asset. Reject creation when ANY recognized extension already holds
  // the same canonical name, naming the existing file. A same-extension collision
  // (the target path itself exists) keeps the classic `--force` overwrite escape;
  // a DIFFERENT-extension collision cannot be force-overwritten (writing a new
  // file would leave the old one shadowing it) — remove the existing file first.
  const existingPaths = findExistingWorkflowPaths(typeRoot, normalizedName);
  const conflicting = existingPaths.find((p) => p !== assetPath);
  if (conflicting !== undefined) {
    throw new UsageError(
      `Workflow "${normalizedName}" already exists as ${path.relative(stashDir, conflicting)} — the ` +
        `\`${conceptId}\` ref resolves to that file, so creating this one would shadow it. ` +
        `Remove or rename the existing file first, or create the workflow under a different name.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Workflow "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }

  const content = input.from
    ? readWorkflowSource(input.from, stashDir)
    : (input.content ??
      (isProgram ? buildWorkflowProgramTemplate(normalizedName) : buildWorkflowTemplate(normalizedName)));
  const sourcePath = input.from ?? `workflows/${normalizedName}${isProgram ? programSuffix : ".md"}`;

  // Validate against the format the destination extension selects — a YAML
  // program parses+compiles as a program, markdown as a document — so the
  // created asset is guaranteed usable by show/start/validate, which pick
  // their parser by the same extension.
  if (isProgram) {
    const parsed = parseWorkflowProgram(content, { path: sourcePath });
    if (!parsed.ok) {
      throw new UsageError(formatWorkflowErrors(sourcePath, parsed.errors));
    }
    const compiled = compileWorkflowProgram(parsed.program);
    if (!compiled.ok) {
      throw new UsageError(formatWorkflowErrors(sourcePath, compiled.errors));
    }
  } else {
    const result = parseWorkflow(content, { path: sourcePath });
    if (!result.ok) {
      throw new UsageError(formatWorkflowErrors(sourcePath, result.errors));
    }
  }

  const authoredContent = isProgram ? content : ensureAkmMarkdownType(content, "workflow");
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

function findExistingWorkflowPaths(typeRoot: string, normalizedName: string): string[] {
  const parent = path.join(typeRoot, path.dirname(normalizedName));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const basename = path.basename(normalizedName);
  return WORKFLOW_EXTENSIONS.flatMap((extension) =>
    entries
      .filter((entry) => {
        if (!entry.isFile() && !entry.isSymbolicLink()) return false;
        const entryExtension = path.extname(entry.name);
        return entryExtension.toLowerCase() === extension && entry.name.slice(0, -entryExtension.length) === basename;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => path.join(parent, entry.name)),
  );
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
  // Strip any recognized workflow extension (.md/.yaml/.yml) so the canonical
  // name — and thus the `workflows/<name>` ref — is extension-free regardless of
  // how the user spelled it. The chosen format is recovered from the raw suffix
  // by the caller (createWorkflowAsset).
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

/**
 * Validate a YAML workflow *program* by filesystem path: parse via
 * `parseWorkflowProgram`, then — only when the parse is clean — compile via
 * `compileWorkflowProgram` so expression/reference errors surface too. Both
 * error lists carry line numbers and are returned in the same
 * `WorkflowError[]` shape, ready for `formatWorkflowErrors`. Throws
 * `UsageError` only when the target cannot be located on disk.
 */
export function validateWorkflowProgramSource(target: string): {
  path: string;
  result: { ok: true; program: WorkflowProgram; warnings: WorkflowError[] } | { ok: false; errors: WorkflowError[] };
} {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new UsageError(`Workflow file not found: "${target}".`);
  }
  const content = fs.readFileSync(resolved, "utf8");
  const parse = parseWorkflowProgram(content, { path: target });
  if (!parse.ok) {
    return { path: target, result: { ok: false, errors: parse.errors } };
  }
  const compiled = compileWorkflowProgram(parse.program);
  if (!compiled.ok) {
    return { path: target, result: { ok: false, errors: compiled.errors } };
  }
  // Non-fatal advisories ride along on a successful validation (additive) so
  // `workflow validate` can surface them without changing the ok verdict.
  return { path: target, result: { ok: true, program: parse.program, warnings: compiled.warnings } };
}

function renderWorkflowTemplate(input: { title: string; firstStepTitle: string; firstStepId: string }): string {
  return workflowTemplate
    .replace("{{TITLE}}", input.title)
    .replace("{{FIRST_STEP_TITLE}}", input.firstStepTitle)
    .replace("{{FIRST_STEP_ID}}", input.firstStepId);
}
