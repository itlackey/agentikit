// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LoweringNotice } from "../../execution/resolved-request";
import { canonicalJson } from "../ir/plan-hash";

/**
 * Merge safe lowerer diagnostics in first-seen order.
 *
 * Notices are live execution metadata only: this helper is deliberately used
 * by executor/report/output paths, never by result/evidence journal writers.
 * Canonical JSON includes `details`, so two genuinely different structured
 * diagnostics are not collapsed merely because their headline fields match.
 */
export function mergeLoweringNotices(
  ...groups: readonly (readonly Readonly<LoweringNotice>[] | undefined)[]
): readonly Readonly<LoweringNotice>[] | undefined {
  const merged = new Map<string, Readonly<LoweringNotice>>();
  for (const group of groups) {
    for (const notice of group ?? []) {
      const key = canonicalJson(notice);
      if (!merged.has(key)) merged.set(key, notice);
    }
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}
