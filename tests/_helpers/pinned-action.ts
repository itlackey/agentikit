// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Assertions for workflow `uses:` steps after #768 pinned every action to a
 * 40-character commit SHA.
 *
 * Tests used to assert the literal tag — `expect(step.uses).toBe(
 * "actions/setup-node@v5")` — which pinned two facts at once: WHICH action runs
 * and WHICH major version. SHA pinning moves the version into a trailing
 * comment (`@<sha>  # v5.0.0`), and `YAML.parse` discards comments, so a naive
 * repair to `startsWith("actions/setup-node@")` would silently drop the
 * version half of that contract — a v4 pin would sail through a test whose
 * name still says v5.
 *
 * These helpers keep both halves: {@link expectPinnedAction} checks the parsed
 * step names the right action AND is pinned to a SHA rather than a mutable
 * tag; {@link expectPinnedVersion} reads the raw workflow text to confirm the
 * comment beside that SHA still names the expected major version.
 */

import { expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/;

/** Repo-root-relative path to the workflows directory. */
export const WORKFLOWS_DIR = path.join(import.meta.dirname, "..", "..", ".github", "workflows");

/**
 * Assert `uses` names `action` and is pinned to a commit SHA.
 *
 * `action` is the repo path with no ref (`actions/setup-node`). Returns the
 * SHA so a caller can cross-check it against the version comment.
 */
export function expectPinnedAction(uses: string | undefined, action: string, label: string): string {
  expect(uses, `${label}: expected a \`uses:\` step for ${action}`).toBeDefined();
  const [named, ref] = String(uses).split("@");
  expect(named, `${label}: expected ${action}, got ${uses}`).toBe(action);
  expect(
    SHA_RE.test(ref ?? ""),
    `${label}: ${action} must be pinned to a 40-char commit SHA, not the mutable ref "${ref}" (#768)`,
  ).toBe(true);
  return ref as string;
}

/**
 * Assert the version comment beside `action`'s pin names `majorVersion`.
 *
 * Reads the raw file because the comment is the only place the human-readable
 * version survives. Every pin of `action` in the file must agree, so a partial
 * upgrade that leaves one job on an older major cannot hide.
 */
export function expectPinnedVersion(workflowFile: string, action: string, majorVersion: string): void {
  const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), "utf8");
  const pins = [...raw.matchAll(new RegExp(`${action.replace(/[/.]/g, "\\$&")}@([0-9a-f]{40})\\s*#\\s*(\\S+)`, "g"))];
  expect(pins.length, `${workflowFile}: expected at least one pinned \`uses:\` for ${action}`).toBeGreaterThan(0);
  for (const [, sha, version] of pins) {
    expect(
      version?.startsWith(majorVersion),
      `${workflowFile}: ${action}@${String(sha).slice(0, 8)} is commented "${version}", expected ${majorVersion}.x`,
    ).toBe(true);
  }
}
