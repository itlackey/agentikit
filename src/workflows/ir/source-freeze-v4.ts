// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Pure re-export shim (spec docs/plans/specs/p2b-input-bindings.md §3.1,
// A-N1): the mechanical split moved every symbol formerly defined here into
// `src/workflows/freeze/**`. This file is now the shim P4 will delete once
// every caller has been re-pointed at the new home directly.
export {
  type ResolvedWorkflowSourceV4,
  type ResolvedWorkflowUnitV4,
  resolveWorkflowSourceV4,
} from "../freeze/source-freeze";
