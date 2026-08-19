// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Canonical identity for Git sources selected by setup.
 *
 * Git accepts a terminal `.git` suffix as an optional spelling of the same
 * remote. Registry, fallback, and historical setup entries have used both
 * forms, so comparisons must not turn that spelling difference into a second
 * configured bundle.
 */
export function canonicalSetupGitUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}
