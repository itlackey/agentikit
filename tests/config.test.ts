import { test, expect, describe, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, saveConfig, updateConfig, DEFAULT_CONFIG, getConfigPath } from "../src/config"

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-config-test-"))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json at stash root", () => {
    expect(getConfigPath("/some/stash")).toBe(path.join("/some/stash", "config.json"))
  })
})

// ── loadConfig ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  test("returns defaults when no config.json exists", () => {
    const dir = makeTmpDir()
    try {
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("merges partial config with defaults", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ semanticSearch: false }))
      const config = loadConfig(dir)
      expect(config.semanticSearch).toBe(false)
      expect(config.additionalStashDirs).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test("handles corrupted JSON gracefully", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(path.join(dir, "config.json"), "not valid json {{{")
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("handles non-object JSON gracefully", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(path.join(dir, "config.json"), '"just a string"')
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("handles JSON array gracefully", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(path.join(dir, "config.json"), "[1, 2, 3]")
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("drops unknown keys", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ semanticSearch: false, futureKey: "hello", anotherKey: 42 }),
      )
      const config = loadConfig(dir)
      expect(config).toEqual({ semanticSearch: false, additionalStashDirs: [] })
      expect((config as Record<string, unknown>).futureKey).toBeUndefined()
      expect((config as Record<string, unknown>).anotherKey).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("filters non-string entries from additionalStashDirs", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ additionalStashDirs: ["/valid", 123, null, "/also-valid"] }),
      )
      const config = loadConfig(dir)
      expect(config.additionalStashDirs).toEqual(["/valid", "/also-valid"])
    } finally {
      cleanup(dir)
    }
  })

  test("ignores wrong types for known keys", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ semanticSearch: "yes", additionalStashDirs: "not-an-array" }),
      )
      const config = loadConfig(dir)
      // Wrong types should fall back to defaults
      expect(config.semanticSearch).toBe(true)
      expect(config.additionalStashDirs).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})

// ── saveConfig ──────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("writes formatted JSON to config.json", () => {
    const dir = makeTmpDir()
    try {
      const config = { semanticSearch: false, additionalStashDirs: ["/extra"] }
      saveConfig(config, dir)
      const raw = fs.readFileSync(path.join(dir, "config.json"), "utf8")
      expect(JSON.parse(raw)).toEqual(config)
      // Verify formatted with indentation
      expect(raw).toContain("  ")
      // Verify trailing newline
      expect(raw.endsWith("\n")).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  test("roundtrips with loadConfig", () => {
    const dir = makeTmpDir()
    try {
      const config = { semanticSearch: false, additionalStashDirs: ["/a", "/b"] }
      saveConfig(config, dir)
      const loaded = loadConfig(dir)
      expect(loaded).toEqual(config)
    } finally {
      cleanup(dir)
    }
  })
})

// ── updateConfig ────────────────────────────────────────────────────────────

describe("updateConfig", () => {
  test("merges partial update over existing config", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/a"] }, dir)
      const updated = updateConfig({ semanticSearch: false }, dir)
      expect(updated.semanticSearch).toBe(false)
      expect(updated.additionalStashDirs).toEqual(["/a"])
      // Verify persisted
      const loaded = loadConfig(dir)
      expect(loaded).toEqual(updated)
    } finally {
      cleanup(dir)
    }
  })

  test("creates config.json if it does not exist", () => {
    const dir = makeTmpDir()
    try {
      const updated = updateConfig({ semanticSearch: false }, dir)
      expect(updated.semanticSearch).toBe(false)
      expect(updated.additionalStashDirs).toEqual([])
      expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })
})
