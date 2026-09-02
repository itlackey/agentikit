// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #900 pre-drain freshness gate — direct unit coverage for `getCachedDirState`
 * (see tests/integration/indexer/dir-precheck-skip.test.ts for the end-to-end
 * "an unchanged directory is never drained" behavior).
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDirFingerprint, getCachedDirState } from "../../src/indexer/passes/dir-staleness";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertIndexDirState } from "../../src/storage/repositories/index-meta-repository";

const VARIANT = "akm@1";
const createdTmpDirs: string[] = [];

/** A fresh index.db plus one directory holding `a.md`, with the walked fingerprint. */
function seed(): { db: ReturnType<typeof openIndexDatabase>; dir: string; files: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dir-staleness-precheck-"));
  createdTmpDirs.push(root);
  const dir = path.join(root, "dir");
  fs.mkdirSync(dir);
  const file = path.join(dir, "a.md");
  fs.writeFileSync(file, "content");
  return { db: openIndexDatabase(path.join(root, "test.db")), dir, files: [file] };
}

function persist(db: ReturnType<typeof openIndexDatabase>, dir: string, files: string[], rowCount?: number): void {
  upsertIndexDirState(db, { dirPath: dir, ...computeDirFingerprint(dir, files, VARIANT), reason: "updated", rowCount });
}

function gate(db: ReturnType<typeof openIndexDatabase>, dir: string, files: string[], priorDirsChanged = false) {
  return getCachedDirState(
    db,
    dir,
    files,
    Date.now(),
    priorDirsChanged,
    VARIANT,
    computeDirFingerprint(dir, files, VARIANT),
  );
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("getCachedDirState", () => {
  test("no persisted index_dir_state row -> defers (undefined)", () => {
    const { db, dir, files } = seed();
    expect(gate(db, dir, files)).toBeUndefined();
  });

  test("identical walked file set and mtime, rowCount > 0 -> unchanged-precheck", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files, 3);
    expect(gate(db, dir, files)).toEqual({
      stale: false,
      reason: { kind: "unchanged-precheck" },
      persistedRowCount: 3,
    });
  });

  test("walked file set changed (new file) -> defers (undefined)", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files, 3);
    const extra = path.join(dir, "b.md");
    fs.writeFileSync(extra, "more");
    expect(gate(db, dir, [...files, extra])).toBeUndefined();
  });

  test("a zero-row row (rowCount 0) -> takes the entries-aware zero-row path", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files, 0);
    expect(gate(db, dir, files)?.reason.kind).toBe("cached-zero-row-state");
  });

  test("a pre-#900 row (no rowCount) with no entries -> still cached as zero-row", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files);
    expect(gate(db, dir, files)?.reason.kind).toBe("cached-zero-row-state");
  });
});
