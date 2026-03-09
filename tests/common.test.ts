import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveStashDir, toPosix, hasErrnoCode, isAssetType, isWithin } from "../src/common"

// ── resolveStashDir ──────────────────────────────────────────────────────────

describe("resolveStashDir", () => {
  const origEnv = process.env.AKM_STASH_DIR

  afterAll(() => {
    if (origEnv === undefined) {
      delete process.env.AKM_STASH_DIR
    } else {
      process.env.AKM_STASH_DIR = origEnv
    }
  })

  test("throws when AKM_STASH_DIR is not set", () => {
    delete process.env.AKM_STASH_DIR
    expect(() => resolveStashDir()).toThrow("AKM_STASH_DIR is not set")
  })

  test("throws when AKM_STASH_DIR is empty string", () => {
    process.env.AKM_STASH_DIR = "   "
    expect(() => resolveStashDir()).toThrow("AKM_STASH_DIR is not set")
  })

  test("throws when path does not exist", () => {
    process.env.AKM_STASH_DIR = "/nonexistent/path/that/does/not/exist"
    expect(() => resolveStashDir()).toThrow("Unable to read")
  })

  test("throws when path is a file, not a directory", () => {
    const tmpFile = path.join(os.tmpdir(), `agentikit-common-test-file-${Date.now()}`)
    fs.writeFileSync(tmpFile, "not a directory")
    try {
      process.env.AKM_STASH_DIR = tmpFile
      expect(() => resolveStashDir()).toThrow("must point to a directory")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  test("returns resolved path for valid directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-common-test-"))
    try {
      process.env.AKM_STASH_DIR = tmpDir
      const result = resolveStashDir()
      expect(result).toBe(path.resolve(tmpDir))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ── toPosix ──────────────────────────────────────────────────────────────────

describe("toPosix", () => {
  test("already-posix paths are unchanged", () => {
    expect(toPosix("foo/bar/baz")).toBe("foo/bar/baz")
  })

  test("backslash paths are converted to forward slashes", () => {
    expect(toPosix("foo\\bar\\baz")).toBe("foo/bar/baz")
  })

  test("mixed separators are normalized", () => {
    expect(toPosix("foo\\bar/baz")).toBe("foo/bar/baz")
  })

  test("empty string returns empty string", () => {
    expect(toPosix("")).toBe("")
  })
})

// ── hasErrnoCode ─────────────────────────────────────────────────────────────

describe("hasErrnoCode", () => {
  test("returns true for error with matching code", () => {
    const err = Object.assign(new Error("fail"), { code: "ENOENT" })
    expect(hasErrnoCode(err, "ENOENT")).toBe(true)
  })

  test("returns false for error with non-matching code", () => {
    const err = Object.assign(new Error("fail"), { code: "EACCES" })
    expect(hasErrnoCode(err, "ENOENT")).toBe(false)
  })

  test("returns false for string error", () => {
    expect(hasErrnoCode("some string error", "ENOENT")).toBe(false)
  })

  test("returns false for null", () => {
    expect(hasErrnoCode(null, "ENOENT")).toBe(false)
  })

  test("returns false for object without code property", () => {
    expect(hasErrnoCode({ message: "fail" }, "ENOENT")).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(hasErrnoCode(undefined, "ENOENT")).toBe(false)
  })
})

// ── isAssetType ──────────────────────────────────────────────────────────────

describe("isAssetType", () => {
  test("returns true for all valid types", () => {
    expect(isAssetType("tool")).toBe(true)
    expect(isAssetType("skill")).toBe(true)
    expect(isAssetType("command")).toBe(true)
    expect(isAssetType("agent")).toBe(true)
    expect(isAssetType("knowledge")).toBe(true)
  })

  test("returns false for invalid strings", () => {
    expect(isAssetType("widget")).toBe(false)
    expect(isAssetType("")).toBe(false)
    expect(isAssetType("Tool")).toBe(false)
    expect(isAssetType("TOOL")).toBe(false)
    expect(isAssetType("plugin")).toBe(false)
  })
})

// ── isWithin ────────────────────────────────────────────────────────────────

describe("isWithin", () => {
  test("returns true for path inside root", () => {
    expect(isWithin("/root/sub/file.txt", "/root")).toBe(true)
  })

  test("returns true for path equal to root", () => {
    expect(isWithin("/root", "/root")).toBe(true)
  })

  test("returns false for path outside root", () => {
    expect(isWithin("/other/file.txt", "/root")).toBe(false)
  })

  test("returns false for parent traversal", () => {
    expect(isWithin("/root/../etc/passwd", "/root")).toBe(false)
  })

  test("returns true for nested subdirectory", () => {
    expect(isWithin("/root/a/b/c/d.txt", "/root")).toBe(true)
  })

  test("returns false for sibling directory with similar prefix", () => {
    expect(isWithin("/root-other/file.txt", "/root")).toBe(false)
  })
})
