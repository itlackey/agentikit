// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `cli-version` advisory for `akm health` (#950).
 *
 * A fleet running a mix of akm-cli versions can look healthy on every other
 * check while quietly running stale code (the motivating case: a host on
 * 0.9.12 next to four peers already on 0.9.14, with nothing in `akm health`
 * calling that out). This closes that gap by reusing {@link checkForUpdate}
 * — the exact "installed vs GitHub latest release" comparison `akm upgrade`
 * already trusts — rather than adding a second, parallel "ask npm" query
 * that could disagree with it during the gap between a GitHub release and
 * its npm publish step.
 *
 * Modelled 1:1 on `plugin-staleness.ts`'s shape: an injectable network seam,
 * best-effort, silent-on-failure (never a false positive, never a hang). This
 * is the SECOND deliberate network exception in `akm health` (see
 * `plugin-staleness.ts` and `docs/architecture/internals/health-advisories.md`)
 * — unlike plugin-staleness's unconditional `git ls-remote`, this one is
 * gated behind the same `--probe`/`--no-probe` flag the engine-reachability
 * checks already use, so an air-gapped host's existing `--no-probe` habit
 * suppresses it too, and offline/rate-limited failures degrade to `unknown`
 * (never a false `warn`).
 */

import { pkgVersion } from "../../version";
import { checkForUpdate } from "../sources/self-update";
import type { HealthCheckResult } from "./types";

/** Options for {@link collectVersionDriftAdvisory}. */
export interface VersionDriftDependencies {
  /** Injectable "installed vs latest release" check; defaults to the real GitHub-releases lookup. */
  checkForUpdate?: typeof checkForUpdate;
  /** The running akm-cli version to check. Defaults to {@link pkgVersion}. */
  cliVersion?: string;
}

/**
 * Build the `cli-version` advisory. `probe` mirrors the engine-reachability
 * checks' `--probe`/`--no-probe` gating: only network when `true`; otherwise
 * `unknown` with "not probed", matching the un-probed engine-reachability
 * message shape rather than silently omitting the check.
 */
export async function collectVersionDriftAdvisory(
  probe: boolean,
  deps: VersionDriftDependencies = {},
): Promise<HealthCheckResult> {
  const cliVersion = deps.cliVersion ?? pkgVersion;
  if (!probe) {
    return {
      name: "cli-version",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: `akm v${cliVersion} is installed. Version-drift was not probed.`,
      evidence: { installedVersion: cliVersion },
    };
  }
  try {
    const result = await (deps.checkForUpdate ?? checkForUpdate)(cliVersion);
    return {
      name: "cli-version",
      kind: "deterministic",
      status: result.updateAvailable ? "warn" : "pass",
      confidence: "high",
      message: result.updateAvailable
        ? `akm v${cliVersion} is installed; v${result.latestVersion} is available — run 'akm upgrade'.`
        : `akm v${cliVersion} is installed and up to date.`,
      evidence: { installedVersion: cliVersion, latestVersion: result.latestVersion },
    };
  } catch (error) {
    // Offline, rate-limited, or a malformed release response — never a false
    // "stale" or "up to date" claim, only "could not be checked".
    return {
      name: "cli-version",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: `akm v${cliVersion} is installed; the update check could not reach the release source.`,
      evidence: {
        installedVersion: cliVersion,
        error: error instanceof Error ? error.constructor.name : "UnknownError",
      },
    };
  }
}
