// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #900: on a no-op incremental `akm index` run, a directory whose walked file
 * set (names + max mtime) hasn't changed since it was last successfully
 * drained must not be drained again — no file read, no sha256 hash, no
 * frontmatter parse, no `adapter.recognize` call. Before the pre-drain gate
 * (`getCachedUnchangedDirState`), EVERY directory was drained on every
 * incremental run regardless of whether anything changed, which is what made
 * a no-op pass over a large corpus cost tens of CPU-minutes (see the perf
 * issue this closes).
 *
 * Verified via `_setDrainObserverForTests`, a TEST-ONLY seam fired once per
 * directory that actually reaches `drainDirDocuments` — a directory the
 * pre-drain gate skips never fires it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setDrainObserverForTests, akmIndex } from "../../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;

/** Write one knowledge file into its OWN directory under the stash. */
function writeKnowledgeDir(dirName: string, body: string): string {
  const filePath = path.join(storage.stashDir, "knowledge", dirName, "note.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${dirName}\n---\n\n# ${dirName}\n\n${body}\n`, "utf8");
  return filePath;
}

async function indexWithDrainObserver(): Promise<{
  drainedDirs: string[];
  result: Awaited<ReturnType<typeof akmIndex>>;
}> {
  const drainedDirs: string[] = [];
  const result = await withSeam(
    _setDrainObserverForTests,
    (dirPath: string) => drainedDirs.push(dirPath),
    () => akmIndex({ stashDir: storage.stashDir }),
  );
  return { drainedDirs, result };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

describe("#900 pre-drain freshness gate", () => {
  test("a no-op incremental run drains no directory", async () => {
    writeKnowledgeDir("alpha", "Alpha body.");
    writeKnowledgeDir("beta", "Beta body.");
    const full = await akmIndex({ stashDir: storage.stashDir });
    expect(full.mode).toBe("full");
    expect(full.totalEntries).toBe(2);

    const { drainedDirs, result } = await indexWithDrainObserver();

    expect(result.mode).toBe("incremental");
    expect(result.totalEntries).toBe(2);
    expect(result.directoriesScanned).toBe(0);
    expect(result.directoriesSkipped).toBe(2);
    expect(drainedDirs).toEqual([]);
  });

  test("modifying one file's content drains ONLY its own directory", async () => {
    const alphaPath = writeKnowledgeDir("alpha", "Alpha body.");
    writeKnowledgeDir("beta", "Beta body.");
    await akmIndex({ stashDir: storage.stashDir });

    // Bump both content and mtime so the change is unambiguous to the walk.
    fs.writeFileSync(alphaPath, "---\ndescription: alpha\n---\n\n# alpha\n\nUpdated alpha body.\n", "utf8");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(alphaPath, future, future);

    const { drainedDirs, result } = await indexWithDrainObserver();

    expect(result.mode).toBe("incremental");
    expect(result.directoriesScanned).toBe(1);
    expect(result.directoriesSkipped).toBe(1);
    expect(drainedDirs).toHaveLength(1);
    expect(path.resolve(drainedDirs[0]!)).toBe(path.resolve(path.dirname(alphaPath)));
  });
});
