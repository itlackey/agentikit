// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane C boundary (spec docs/plans/specs/p2b-input-bindings.md §1.7
 * C-N1, row B-75 — "`src/` importing anything from `scripts/` -> zero
 * occurrences").
 *
 * `tsconfig.build.json`'s `rootDir` is `src`; a static `import`/`export …
 * from` reaching outside it would make `bun run build` try to emit
 * `dist/scripts` (AGENTS.md pins the identical invariant for the sibling
 * directory: "`dist/tests` should never appear"). The pure v2 -> v3 and v3 ->
 * task source v4 migration planners (`src/tasks/source/task-to-v3.ts`,
 * `src/tasks/source/task-to-v4.ts`, `src/tasks/source/task-source-v3-frozen.ts`)
 * live IN `src/` — moved there so the version-gate read shim in
 * `parse-task-source.ts` can call them without crossing this very boundary —
 * and `scripts/akm-migrate/migrate/task-files-to-v3.ts` /
 * `task-files-to-v4.ts` (the filesystem/apply side) import them in the legal
 * direction, scripts -> src. `tests/migrate/task-v3-to-v4.test.ts` (Lane C)
 * exercises the same planner directly from `src/`. Nothing in that suite
 * fails if `src/` grows an import of `scripts/`, which is the direction this
 * test exists to forbid.
 *
 * §1.7 C-N1 names a reviewer-run spot-check —
 * `rg -n 'from "\.\./\.\./scripts|from "\.\./scripts|scripts/akm-migrate'
 * src/` — but that bare-substring grep is NOT reproduced verbatim as the
 * automated check here: it already matches two PRE-EXISTING, deliberately
 * non-import references that must keep compiling —
 * `src/commands/migration-tool.ts:13-15` builds the standalone-tool path via
 * `fileURLToPath(new URL("../scripts/akm-migrate.js", import.meta.url))`
 * specifically so it never statically imports across the boundary (that
 * file's own comment: "src must not import scripts/: the dist build's tsc
 * has rootDir: src"), and `src/output/format-exempt.ts:31` merely mentions
 * the tool in a doc comment. Neither is a module dependency edge. Instead
 * this reuses the same static import graph
 * `tests/architecture/import-cycle-ratchet.test.ts` and
 * `tests/architecture/website-provider-boundary.test.ts` already build over
 * `src/**` (`buildImportGraph`, `scripts/lint-import-cycles.ts`): an
 * AST-based scan of top-level `import`/`export … from` declarations only,
 * which is exactly what `tsc`'s `rootDir` constraint cares about, at every
 * relative-import depth (not just the two shallow `../`/`../../` cases the
 * reviewer's own grep spot-checks).
 */

import { describe, expect, test } from "bun:test";
import { buildImportGraph } from "../../scripts/lint-import-cycles";

describe("src/ -> scripts/ import boundary (P2b B-75)", () => {
  test("no src/** file has a static import/export edge into scripts/**", () => {
    const graph = buildImportGraph();
    const violations: string[] = [];
    for (const [file, edges] of graph) {
      for (const edge of edges) {
        if (edge.startsWith("scripts/")) violations.push(`${file} -> ${edge}`);
      }
    }
    expect(violations.sort()).toEqual([]);
  });
});
