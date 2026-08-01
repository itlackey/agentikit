#!/usr/bin/env bun

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Entry point for COMPILED standalone binaries (`bun build --compile`) —
 * release artifacts, tests/release-check.sh, and the Docker install tests.
 *
 * It exists so the executable embeds BOTH the CLI and the akm-migrate tool:
 * a compiled binary has no scripts/ tree on disk, so the subprocess entry
 * `runMigrationTool` (src/commands/migration-tool.ts) resolves does not exist
 * there, and the documented `./akm-<ver> migrate status/apply` upgrade path
 * used to dead-end with FILE_NOT_FOUND. src must never import scripts/ (the
 * dist build's tsc has `rootDir: src`), so the coupling lives HERE, in the
 * migrator's own home — mirroring how dist/ ships separate Bun- and Node-targeted
 * `Bun.build` bundles (scripts/copy-assets.ts).
 *
 * Dispatch:
 *   - `AKM_MIGRATE_ENTRY=1` (set by `runMigrationTool` when it re-execs this
 *     same binary): run the migrator's `main` over our args, exactly like the
 *     `scripts/akm-migrate.ts` subprocess would.
 *   - otherwise: run the CLI. `AKM_STANDALONE_ENTRY=1` opts into cli.ts's
 *     startup block, the same pattern `dist/cli-node.mjs` uses with
 *     `AKM_NODE_ENTRY` — cli.ts is imported, so its `import.meta.main` is
 *     false.
 */

export {}; // top-level await requires module context; this entry has only dynamic imports

if (process.env.AKM_MIGRATE_ENTRY === "1") {
  // Consume the marker so commands the migrator itself shells out to never
  // see it, and a re-entrant `akm` child dispatches normally.
  delete process.env.AKM_MIGRATE_ENTRY;
  const { runWithJsonErrors } = await import("../src/cli/shared");
  const { main } = await import("./akm-migrate");
  await runWithJsonErrors(() => main(process.argv.slice(2)));
} else {
  process.env.AKM_STANDALONE_ENTRY = "1";
  await import("../src/cli");
}
