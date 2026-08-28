// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Locale-independent code-point ordering, shared by the workflow source-IR
 * lane (job `needs` canonicalization) and `akm lint` (name sorting).
 *
 * Split out of the deleted `source-ir/ordering.ts` (P4 §3.3, docs/plans/specs/
 * p4-deletions-closeout.md): that file's other export,
 * `canonicalTopologicalJobs`, existed only to order MULTIPLE ready jobs —
 * moot once the adapter confines a workflow source to exactly one job. This
 * comparator has an unrelated consumer (`src/commands/lint/index.ts`) and
 * survives on its own.
 */
export function compareWorkflowSourceCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
