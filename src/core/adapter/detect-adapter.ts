// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getAdapters } from "./registry";

/** Select the first built-in adapter whose ordered root probe claims `root`. */
export function detectAdapterId(root: string, fallback = "akm"): string {
  for (const adapter of getAdapters()) {
    try {
      if (adapter.looksLikeRoot?.(root) === true) return adapter.id;
    } catch {
      // An unreadable or racing probe does not claim the bundle.
    }
  }
  return fallback;
}
