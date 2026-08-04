// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text rendering of `akm migrate status` / `akm migrate apply`'s
 * `MigrationPlan` result (`scripts/akm-migrate/config-migrate.ts`).
 *
 * Reuses `renderStatusEntries` (`./status-list.ts`) for the four-artifact
 * breakdown — exactly the "worst-first, glyph-prefixed" shape that module
 * exists for — rather than reinventing it for a third command.
 */

import type { TextFormatterEntry } from "./registry";
import { renderStatusEntries, type StatusEntry } from "./status-list";

interface ArtifactState {
  status: string;
  migrationIds?: string[];
  detail?: string;
}

interface TargetConfigState {
  status: string;
  source: string;
  path?: string;
  detail?: string;
}

interface GeneratedConfigInfo {
  path: string;
  status: string;
  droppedKeys: string[];
}

interface MigrationPlanResult {
  status: string;
  artifacts?: Record<string, ArtifactState>;
  targetConfig?: TargetConfigState;
  blockers?: string[];
  message?: string;
  generatedConfig?: GeneratedConfigInfo;
  activeOperation?: { kind: string; sentinelPath: string };
  backupPath?: string;
  backupRunId?: string;
}

const ARTIFACT_ORDER = ["config", "state", "workflow", "index"] as const;
const ARTIFACT_LABEL: Record<(typeof ARTIFACT_ORDER)[number], string> = {
  config: "config.json",
  state: "state.db",
  workflow: "workflow.db",
  index: "index.db",
};

/** Lower rank sorts first (worse-first) via `renderStatusEntries`. */
function artifactSeverity(status: string): { rank: number; glyph: string } {
  switch (status) {
    case "corrupt":
    case "inconsistent":
    case "newer":
      return { rank: 0, glyph: "✗" };
    case "old":
      return { rank: 1, glyph: "⚠" };
    case "missing":
      return { rank: 2, glyph: "?" };
    default: // "current"
      return { rank: 3, glyph: "✓" };
  }
}

function planGlyph(status: string): string {
  switch (status) {
    case "current":
      return "✓";
    case "ready":
      return "⚠";
    case "not-applicable":
      return "·";
    default: // "blocked"
      return "✗";
  }
}

export function formatMigratePlain(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const plan = result as MigrationPlanResult;
  if (typeof plan.status !== "string") return null;

  const lines: string[] = [`${planGlyph(plan.status)} ${plan.status}`];
  if (plan.message) lines.push(`    ${plan.message}`);
  if (plan.activeOperation) {
    lines.push(`    in-flight ${plan.activeOperation.kind} at ${plan.activeOperation.sentinelPath}`);
  }

  if (plan.artifacts) {
    const entries: StatusEntry[] = ARTIFACT_ORDER.filter((name) => plan.artifacts?.[name]).map((name) => {
      const artifact = plan.artifacts?.[name] as ArtifactState;
      const { rank, glyph } = artifactSeverity(artifact.status);
      const detailLines: string[] = [];
      if (artifact.detail) detailLines.push(artifact.detail);
      if (artifact.migrationIds?.length) detailLines.push(`migrations applied: ${artifact.migrationIds.length}`);
      return { severityRank: rank, glyph, headline: `${ARTIFACT_LABEL[name]}: ${artifact.status}`, detailLines };
    });
    lines.push("", "artifacts:", ...renderStatusEntries(entries).map((line) => `  ${line}`));
  }

  if (plan.targetConfig) {
    const target = plan.targetConfig;
    lines.push(
      "",
      `target config: ${target.status} (source: ${target.source}${target.path ? `, ${target.path}` : ""})`,
    );
    if (target.detail) lines.push(`  ${target.detail}`);
  }

  if (plan.generatedConfig) {
    const generated = plan.generatedConfig;
    lines.push("", `generated config: ${generated.status} at ${generated.path}`);
    if (generated.droppedKeys.length > 0) {
      lines.push(`  drops (add engines/defaults yourself if needed): ${generated.droppedKeys.join(", ")}`);
    }
  }

  if (plan.blockers?.length) {
    lines.push("", "blockers:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (plan.backupPath) {
    lines.push("", `backup: ${plan.backupPath}${plan.backupRunId ? ` (run ${plan.backupRunId})` : ""}`);
  }

  return lines.join("\n");
}

export const migrateFormatters: TextFormatterEntry[] = [
  { command: "migrate-status", handler: (r) => formatMigratePlain(r) },
  { command: "migrate-apply", handler: (r) => formatMigratePlain(r) },
];
