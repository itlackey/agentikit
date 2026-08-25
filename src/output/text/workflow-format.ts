// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for `akm workflow *` commands.
 *
 * Split out of `helpers.ts` (formerly 1418 lines / 59 fns) as its own
 * sibling module: the workflow list/status/run/create/resume renderers form a
 * cohesive, self-contained cluster (they call only each other, never
 * formatters from other domains).
 */

export function formatWorkflowListPlain(result: Record<string, unknown>): string {
  const runs = Array.isArray(result.runs) ? (result.runs as Array<Record<string, unknown>>) : [];
  if (runs.length === 0) {
    return "No workflow runs in the current working scope. Start one with `akm workflow run workflows/<name>` or author one with `akm workflow create <name>`.";
  }

  return runs
    .map((run) => {
      const id = typeof run.id === "string" ? run.id : "unknown";
      // Fallback matches the `id`/`status` convention just below (plain
      // "unknown", not a `type:name`-shaped placeholder — that shape reads as
      // a ref in the dead colon grammar, which this fallback must not model).
      const ref = typeof run.workflowRef === "string" ? run.workflowRef : "unknown";
      const status = typeof run.status === "string" ? run.status : "unknown";
      const currentStep = typeof run.currentStepId === "string" ? ` (current: ${run.currentStepId})` : "";
      return `${id} ${ref} [${status}]${currentStep}`;
    })
    .join("\n");
}

export function formatWorkflowStatusPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  const workflow =
    typeof result.workflow === "object" && result.workflow !== null
      ? (result.workflow as Record<string, unknown>)
      : undefined;
  if (!run || !workflow) return null;

  const lines = [
    `workflow: ${String(workflow.ref ?? "unknown")}`,
    `run: ${String(run.id ?? "unknown")}`,
    `title: ${String(run.workflowTitle ?? workflow.title ?? "Workflow")}`,
    `status: ${String(run.status ?? "unknown")}`,
  ];
  if (run.currentStepId) lines.push(`currentStep: ${String(run.currentStepId)}`);

  const steps = Array.isArray(workflow.steps) ? (workflow.steps as Array<Record<string, unknown>>) : [];
  if (steps.length > 0) {
    lines.push("steps:");
    for (const step of steps) {
      const title = typeof step.title === "string" ? step.title : "Untitled step";
      const id = typeof step.id === "string" ? step.id : "unknown";
      const status = typeof step.status === "string" ? step.status : "unknown";
      lines.push(`  - ${title} [${id}] (${status})`);
      if (typeof step.notes === "string" && step.notes.trim()) {
        lines.push(`    notes: ${step.notes}`);
      }
    }
  }

  // `workflow status --units` (#22): the honest per-unit diagnostic surface —
  // failure_reason plus any journaled result/error text. Diagnostics only; the
  // deterministic step evidence above is unaffected.
  const units = Array.isArray(result.units) ? (result.units as Array<Record<string, unknown>>) : undefined;
  if (units) {
    lines.push("");
    lines.push(units.length > 0 ? "units:" : "units: (none journaled)");
    for (const unit of units) {
      const id = typeof unit.unitId === "string" ? unit.unitId : "unknown";
      const status = typeof unit.status === "string" ? unit.status : "unknown";
      const node = typeof unit.nodeId === "string" ? unit.nodeId : "";
      const attempts = typeof unit.attempts === "number" ? unit.attempts : undefined;
      const suffix = attempts !== undefined && attempts > 1 ? `, attempt ${attempts}` : "";
      lines.push(`  - ${id} [${node}] (${status}${suffix})`);
      // Codex round-3 finding B: a `running` claim gone silent past the check-in
      // window — the process holding it likely died. Surface it (with the claim
      // holder) so a human can reclaim/re-run the unit.
      if (unit.stale === true) {
        const holder =
          typeof unit.claimHolder === "string" && unit.claimHolder.trim() ? ` claimed by ${unit.claimHolder}` : "";
        lines.push(`    stale: claim went silent past the check-in window${holder} — its driver may have died`);
      }
      if (typeof unit.failureReason === "string" && unit.failureReason.trim()) {
        lines.push(`    failure_reason: ${unit.failureReason}`);
      }
      if (typeof unit.diagnostic === "string" && unit.diagnostic.trim()) {
        const diagLines = unit.diagnostic.split("\n");
        lines.push(`    diagnostic: ${diagLines[0]}`);
        for (const diagLine of diagLines.slice(1)) lines.push(`      ${diagLine}`);
      }
    }
  }

  // Review C2: the check-in `continue` directive must survive plain-text
  // rendering — JSON consumers saw `checkin` but the text path dropped it.
  const checkinLine = formatWorkflowCheckinLine(result);
  if (checkinLine) {
    lines.push("");
    lines.push(checkinLine);
  }
  return lines.join("\n");
}

/**
 * Render the stalled-run check-in directive (#506) when present on a
 * workflow-status result. Returns null when the run is healthy.
 */
function formatWorkflowCheckinLine(result: Record<string, unknown>): string | null {
  const checkin =
    typeof result.checkin === "object" && result.checkin !== null
      ? (result.checkin as Record<string, unknown>)
      : undefined;
  if (!checkin || typeof checkin.directive !== "string" || !checkin.directive.trim()) return null;
  return checkin.directive.trim();
}

export function formatWorkflowRunPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  if (!run) return null;

  const lines = [`run: ${String(run.id ?? "unknown")}`, `status: ${String(run.status ?? "unknown")}`];
  // Creation-time notices (e.g. the implicit engine fallback) must survive the
  // text renderer: JSON/YAML pass them through, and dropping them here would
  // hide the announcement from the DEFAULT output mode — where it matters most.
  for (const warning of Array.isArray(result.warnings) ? result.warnings : []) lines.push(`! ${String(warning)}`);
  // Live-only common-lowerer diagnostics are already sanitized and deduped by
  // the workflow engine. Render their typed headline (not opaque details) so
  // default text output has the same observability as JSON without widening a
  // durable workflow schema.
  for (const value of Array.isArray(result.notices) ? result.notices : []) {
    if (typeof value !== "object" || value === null) continue;
    const notice = value as Record<string, unknown>;
    if (
      typeof notice.code !== "string" ||
      typeof notice.severity !== "string" ||
      typeof notice.adapter !== "string" ||
      typeof notice.message !== "string"
    )
      continue;
    const field = typeof notice.field === "string" && notice.field ? `; ${notice.field}` : "";
    lines.push(`! lowering[${notice.severity}] ${notice.code} (${notice.adapter}${field}): ${notice.message}`);
  }
  const executed = Array.isArray(result.executed) ? (result.executed as Array<Record<string, unknown>>) : [];
  if (executed.length === 0) {
    lines.push("executed: (no steps — run was already done or blocked)");
  } else {
    lines.push("executed:");
    for (const step of executed) {
      const marker = step.ok === true ? "ok" : "FAILED";
      lines.push(
        `  - ${String(step.stepId ?? "?")} [${marker}] units: ${String(step.unitCount ?? 0)}` +
          (Number(step.failedUnits ?? 0) > 0 ? ` (${String(step.failedUnits)} failed)` : ""),
      );
      if (typeof step.summary === "string" && step.summary.trim()) {
        lines.push(`    ${step.summary}`);
      }
    }
  }
  const gate =
    typeof result.gateRejection === "object" && result.gateRejection !== null
      ? (result.gateRejection as Record<string, unknown>)
      : undefined;
  if (gate) {
    lines.push(`gate rejected step ${String(gate.stepId ?? "?")}: ${String(gate.feedback ?? "")}`);
    const missing = Array.isArray(gate.missing) ? gate.missing : [];
    for (const item of missing) lines.push(`  missing: ${String(item)}`);
  }
  if (result.aborted === true) {
    lines.push(
      result.timedOut === true
        ? "workflow timed out; the run remains resumable."
        : "workflow interrupted; the run remains resumable.",
    );
  }
  if (result.done === true) lines.push("workflow completed.");
  return lines.join("\n");
}

export function formatWorkflowCreatePlain(r: Record<string, unknown>): string | null {
  // `workflow create --print`: no file is written, just the template text
  // (dropped `workflow template`'s output, moved onto this shape).
  if (typeof r.template === "string") return r.template;
  if (r.ref && r.path) {
    return `Created ${String(r.ref)} at ${String(r.path)}`;
  }
  return null;
}

export function formatWorkflowResumePlain(r: Record<string, unknown>): string {
  return formatWorkflowStatusPlain(r) ?? `Resumed workflow run ${String(r.id ?? r.runId ?? "?")}`;
}
