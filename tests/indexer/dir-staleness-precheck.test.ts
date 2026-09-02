// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #900 pre-drain freshness gate — direct unit coverage for
 * `getCachedUnchangedDirState`, independent of a full `akmIndex()` run (see
 * tests/integration/indexer/dir-precheck-skip.test.ts for the end-to-end
 * "an unchanged directory is never drained" behavior).
 *
 * Covers the deference conditions the gate must get right: no persisted
 * state, a pre-#900 row (no walked columns yet), a zero-row-only row (the
 * gate defers to `getCachedZeroRowDirState` instead), a real mismatch, and
 * the genuine match.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDirFingerprint, getCachedUnchangedDirState } from "../../src/indexer/passes/dir-staleness";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertIndexDirState } from "../../src/storage/repositories/index-meta-repository";

const createdTmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dir-staleness-precheck-"));
  createdTmpDirs.push(dir);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("getCachedUnchangedDirState", () => {
  test("no persisted index_dir_state row -> defers (undefined)", () => {
    const db = openIndexDatabase(tmpDbPath());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dsp-dir-"));
    createdTmpDirs.push(dir);
    const file = path.join(dir, "a.md");
    fs.writeFileSync(file, "content");

    expect(getCachedUnchangedDirState(db, dir, [file], "akm@1")).toBeUndefined();
  });

  test("a pre-#900 row with no walked columns -> defers (undefined)", () => {
    const db = openIndexDatabase(tmpDbPath());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dsp-dir-"));
    createdTmpDirs.push(dir);
    const file = path.join(dir, "a.md");
    fs.writeFileSync(file, "content");

    const fp = computeDirFingerprint(dir, [file], "akm@1");
    // Old-shape row: fileSetHash/fileMtimeMaxMs populated, walked columns and
    // rowCount absent (exactly what an upgrade finds pre-#900).
    upsertIndexDirState(db, {
      dirPath: dir,
      fileSetHash: fp.fileSetHash,
      fileMtimeMaxMs: fp.fileMtimeMaxMs,
      reason: "unchanged",
    });

    expect(getCachedUnchangedDirState(db, dir, [file], "akm@1")).toBeUndefined();
  });

  test("a zero-row-only persisted row (rowCount 0) -> defers to the zero-row cache instead", () => {
    const db = openIndexDatabase(tmpDbPath());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dsp-dir-"));
    createdTmpDirs.push(dir);
    const file = path.join(dir, "ignored.json");
    fs.writeFileSync(file, "{}");

    const fp = computeDirFingerprint(dir, [file], "akm@1");
    upsertIndexDirState(db, {
      dirPath: dir,
      fileSetHash: fp.fileSetHash,
      fileMtimeMaxMs: fp.fileMtimeMaxMs,
      reason: "empty-generated-set",
      walkedFileSetHash: fp.fileSetHash,
      walkedFileMtimeMaxMs: fp.fileMtimeMaxMs,
      rowCount: 0,
    });

    expect(getCachedUnchangedDirState(db, dir, [file], "akm@1")).toBeUndefined();
  });

  test("walked file set changed (new file) -> stale (undefined)", () => {
    const db = openIndexDatabase(tmpDbPath());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dsp-dir-"));
    createdTmpDirs.push(dir);
    const file = path.join(dir, "a.md");
    fs.writeFileSync(file, "content");

    const fp = computeDirFingerprint(dir, [file], "akm@1");
    upsertIndexDirState(db, {
      dirPath: dir,
      fileSetHash: fp.fileSetHash,
      fileMtimeMaxMs: fp.fileMtimeMaxMs,
      reason: "unchanged",
      walkedFileSetHash: fp.fileSetHash,
      walkedFileMtimeMaxMs: fp.fileMtimeMaxMs,
      rowCount: 1,
    });

    const newFile = path.join(dir, "b.md");
    fs.writeFileSync(newFile, "content2");

    expect(getCachedUnchangedDirState(db, dir, [file, newFile], "akm@1")).toBeUndefined();
  });

  test("identical walked file set and mtime, rowCount > 0 -> not stale", () => {
    const db = openIndexDatabase(tmpDbPath());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dsp-dir-"));
    createdTmpDirs.push(dir);
    const file = path.join(dir, "a.md");
    fs.writeFileSync(file, "content");

    const fp = computeDirFingerprint(dir, [file], "akm@1");
    upsertIndexDirState(db, {
      dirPath: dir,
      fileSetHash: fp.fileSetHash,
      fileMtimeMaxMs: fp.fileMtimeMaxMs,
      reason: "unchanged",
      walkedFileSetHash: fp.fileSetHash,
      walkedFileMtimeMaxMs: fp.fileMtimeMaxMs,
      rowCount: 3,
    });

    const state = getCachedUnchangedDirState(db, dir, [file], "akm@1");
    expect(state).toBeDefined();
    expect(state?.stale).toBe(false);
    expect(state?.reason.kind).toBe("unchanged-precheck");
    expect(state?.persistedRowCount).toBe(3);
  });
});
