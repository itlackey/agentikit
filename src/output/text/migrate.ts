// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text rendering of the combined task-v2-to-v3 and task-v3-to-task-
 * source-v4 migration plan (spec docs/plans/specs/p4-deletions-closeout.md
 * §3.2.5, rows B-31/B-32).
 */

import type { TextFormatterEntry } from "./registry";

interface MigrationPlanResult {
  status: string;
  blockers?: string[];
  taskV3Migration?: { changed: number; skipped: number; blocked: number };
  taskV4Migration?: { changed: number; skipped: number; blocked: number };
  backupPath?: string;
  applied?: number;
  taskV4BackupPath?: string;
  taskV4Applied?: number;
}

function planGlyph(status: string): string {
  switch (status) {
    case "current":
      return "✓";
    case "ready":
      return "⚠";
    default: // "blocked"
      return "✗";
  }
}

export function formatMigratePlain(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const plan = result as MigrationPlanResult;
  if (typeof plan.status !== "string") return null;

  const lines: string[] = [`${planGlyph(plan.status)} ${plan.status}`];
  if (plan.taskV3Migration) {
    const tasks = plan.taskV3Migration;
    lines.push(`    task-v2->v3: ${tasks.changed} change, ${tasks.skipped} current, ${tasks.blocked} blocked`);
  }
  if (plan.taskV4Migration) {
    const tasks = plan.taskV4Migration;
    lines.push(`    task-v3->v4: ${tasks.changed} change, ${tasks.skipped} current, ${tasks.blocked} blocked`);
  }

  if (plan.blockers?.length) {
    lines.push("", "blockers:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (plan.backupPath) {
    lines.push("", `backup (v2->v3): ${plan.backupPath}`);
  }
  if (plan.applied !== undefined) lines.push(`applied (v2->v3): ${plan.applied}`);
  if (plan.taskV4BackupPath) {
    lines.push(`backup (v3->v4): ${plan.taskV4BackupPath}`);
  }
  if (plan.taskV4Applied !== undefined) lines.push(`applied (v3->v4): ${plan.taskV4Applied}`);

  return lines.join("\n");
}

export const migrateFormatters: TextFormatterEntry[] = [
  { command: "migrate-status", handler: (r) => formatMigratePlain(r) },
  { command: "migrate-apply", handler: (r) => formatMigratePlain(r) },
];
