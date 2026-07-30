// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-cutting semantic checks over an assembled `WorkflowDocument` draft
 * that need the whole document (not just one frontmatter key) at once.
 *
 * Per-key structural checks (unknown keys, id/param-name patterns, timeout
 * format, retry taxonomy, route target ordering, duplicate ids, gate/body
 * binding) all live in `parser.ts`, where line-anchored errors are cheapest to
 * produce. The workflow-only closed frontmatter allowlist that used to live
 * here (`ALLOWED_FRONTMATTER_KEYS`/`checkFrontmatterKeys`) is GONE —
 * `schemas/akm-workflow.json` (`additionalProperties: false` over the shared
 * asset envelope ∪ the workflow keys) is the closed-key authority now; this
 * module only runs checks the schema cannot express (canonical xref shape,
 * resource limits).
 */

import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { utf8Bytes, WORKFLOW_MAX_INSTRUCTION_BYTES, WORKFLOW_MAX_PARAMS, WORKFLOW_MAX_STEPS } from "./resource-limits";
import type { WorkflowDocument, WorkflowError } from "./schema";

export function runSemanticChecks(
  draft: WorkflowDocument,
  frontmatterData: Record<string, unknown>,
  frontmatterEndLine: number,
  errors: WorkflowError[],
): void {
  checkXrefs(frontmatterData.xrefs, frontmatterEndLine, errors);
  checkResourceLimits(draft, errors);
}

function checkXrefs(value: unknown, line: number, errors: WorkflowError[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return; // shape already flagged by parser.ts's checkXrefs
  for (const ref of value) {
    try {
      if (typeof ref !== "string") throw new Error("non-canonical ref");
      const parsed = parseBundleRef(ref);
      if (parsed.conceptId.includes(":") || ref !== bundleRefToString(parsed)) throw new Error("non-canonical ref");
    } catch {
      errors.push({
        line,
        message: `Workflow frontmatter "xrefs" contains an invalid or non-canonical ref: ${String(ref)}.`,
      });
    }
  }
}

function checkResourceLimits(draft: WorkflowDocument, errors: WorkflowError[]): void {
  if (draft.steps.length > WORKFLOW_MAX_STEPS) {
    errors.push({ line: 1, message: `Workflow must contain at most ${WORKFLOW_MAX_STEPS} steps.` });
  }
  if (Object.keys(draft.params ?? {}).length > WORKFLOW_MAX_PARAMS) {
    errors.push({ line: 1, message: `Workflow must contain at most ${WORKFLOW_MAX_PARAMS} parameters.` });
  }
  for (const step of draft.steps) {
    if (step.instructions && utf8Bytes(step.instructions.text) > WORKFLOW_MAX_INSTRUCTION_BYTES) {
      errors.push({
        line: step.instructions.source.start,
        message: `Step "${step.id}" instructions exceed the 256 KiB resource limit.`,
      });
    }
    if (step.gateRubric && utf8Bytes(step.gateRubric.text) > WORKFLOW_MAX_INSTRUCTION_BYTES) {
      errors.push({
        line: step.gateRubric.source.start,
        message: `Step "${step.id}" gate rubric exceeds the 256 KiB resource limit.`,
      });
    }
  }
}
