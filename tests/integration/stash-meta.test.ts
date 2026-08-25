/**
 * Tests for the stash `.meta/` convention: ref parsing, on-disk resolution
 * (including traversal guards), and the `akm bundle create` scaffold.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmInit } from "../../src/commands/sources/init";
import { scaffoldStashMeta } from "../../src/commands/sources/stash-skeleton";
import { META_DEFAULT_NAME, parseMetaRef, resolveMetaFilePath } from "../../src/core/asset/stash-meta";
import { UsageError } from "../../src/core/errors";
import { type Cleanup, sandboxHome, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const testSymlink = process.platform === "win32" ? test.skip : test;

describe("parseMetaRef", () => {
  test("recognizes bare and named meta refs, with and without origin", () => {
    expect(parseMetaRef("meta")).toEqual({ origin: undefined, name: META_DEFAULT_NAME });
    expect(parseMetaRef("meta:about")).toEqual({ origin: undefined, name: "about" });
    expect(parseMetaRef("local//meta")).toEqual({ origin: "local", name: META_DEFAULT_NAME });
    expect(parseMetaRef("github:o/r//meta:conventions")).toEqual({ origin: "github:o/r", name: "conventions" });
  });

  test("empty meta name falls back to the default index doc", () => {
    expect(parseMetaRef("meta:")).toEqual({ origin: undefined, name: META_DEFAULT_NAME });
  });

  test("returns null for non-meta refs so callers fall through", () => {
    expect(parseMetaRef("skills/code-review")).toBeNull();
    expect(parseMetaRef("knowledge/guide")).toBeNull();
    expect(parseMetaRef("metaphor:x")).toBeNull(); // must not greedily match the `meta` prefix
    expect(parseMetaRef("")).toBeNull();
  });
});

describe("resolveMetaFilePath", () => {
  let root = "";
  beforeEach(() => {
    root = makeTempDir("akm-meta-resolve-");
    fs.mkdirSync(path.join(root, ".meta"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("prefers <name>.md and falls back to an extensionless file", () => {
    fs.writeFileSync(path.join(root, ".meta", "about.md"), "# md wins");
    expect(resolveMetaFilePath(root, "about")).toBe(path.join(root, ".meta", "about.md"));

    fs.writeFileSync(path.join(root, ".meta", "license"), "MIT");
    expect(resolveMetaFilePath(root, "license")).toBe(path.join(root, ".meta", "license"));
  });

  test("returns null when the doc does not exist", () => {
    expect(resolveMetaFilePath(root, "nope")).toBeNull();
  });

  test("rejects path traversal in the meta name", () => {
    expect(() => resolveMetaFilePath(root, "../../etc/passwd")).toThrow(UsageError);
  });

  testSymlink("rejects a meta file symlink that escapes the bundle", () => {
    const outsideDir = makeTempDir("akm-meta-outside-file-");
    try {
      const outsidePath = path.join(outsideDir, "outside.md");
      fs.writeFileSync(outsidePath, "OUTSIDE_META_SECRET");
      fs.symlinkSync(outsidePath, path.join(root, ".meta", "about.md"));

      expect(() => resolveMetaFilePath(root, "about")).toThrow(UsageError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  testSymlink("rejects symlinked meta roots and intermediate directories", () => {
    const outsideDir = makeTempDir("akm-meta-outside-tree-");
    try {
      fs.writeFileSync(path.join(outsideDir, "about.md"), "OUTSIDE_META_TREE");
      fs.rmSync(path.join(root, ".meta"), { recursive: true, force: true });
      fs.symlinkSync(outsideDir, path.join(root, ".meta"), "dir");
      expect(() => resolveMetaFilePath(root, "about")).toThrow(UsageError);

      fs.rmSync(path.join(root, ".meta"), { force: true });
      fs.mkdirSync(path.join(root, ".meta"));
      fs.symlinkSync(outsideDir, path.join(root, ".meta", "nested"), "dir");
      expect(() => resolveMetaFilePath(root, "nested/about")).toThrow(UsageError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("akm bundle create .meta scaffold", () => {
  let cleanup: Cleanup = () => {};
  beforeEach(() => {
    process.env.AKM_FORCE_INIT_TMP_STASH = "1";
    const cache = sandboxXdgCacheHome();
    const cfg = sandboxXdgConfigHome(cache.cleanup);
    cleanup = sandboxHome(cfg.cleanup).cleanup;
  });
  afterEach(() => {
    delete process.env.AKM_FORCE_INIT_TMP_STASH;
    cleanup();
    cleanup = () => {};
  });

  test("writes .meta/index.md on a freshly created stash", async () => {
    const stashDir = makeTempDir("akm-init-meta-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });
    const indexPath = path.join(stashDir, ".meta", "index.md");
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.readFileSync(indexPath, "utf8")).toContain("About this stash");
  });

  test("scaffoldStashMeta never overwrites an existing .meta/index.md", () => {
    const stashDir = makeTempDir("akm-init-meta-keep-");
    const indexPath = path.join(stashDir, ".meta", "index.md");
    scaffoldStashMeta(stashDir);
    fs.writeFileSync(indexPath, "# customized");
    scaffoldStashMeta(stashDir);
    expect(fs.readFileSync(indexPath, "utf8")).toBe("# customized");
  });
});
