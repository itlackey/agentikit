import { test, expect, describe, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, saveConfig, updateConfig, addStashDir, removeStashDir, DEFAULT_CONFIG, getConfigPath } from "../src/config"

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

// ── embedding config ────────────────────────────────────────────────────────

describe("embedding config", () => {
  test("loads embedding connection config", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          embedding: {
            endpoint: "http://localhost:11434/v1/embeddings",
            model: "nomic-embed-text",
          },
        }),
      )
      const config = loadConfig(dir)
      expect(config.embedding).toEqual({
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      })
    } finally {
      cleanup(dir)
    }
  })

  test("loads embedding config with apiKey", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          embedding: {
            endpoint: "https://api.openai.com/v1/embeddings",
            model: "text-embedding-3-small",
            apiKey: "sk-test123",
          },
        }),
      )
      const config = loadConfig(dir)
      expect(config.embedding?.apiKey).toBe("sk-test123")
    } finally {
      cleanup(dir)
    }
  })

  test("ignores invalid embedding config (missing model)", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ embedding: { endpoint: "http://localhost:11434" } }),
      )
      const config = loadConfig(dir)
      expect(config.embedding).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("ignores non-object embedding config", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ embedding: "not-an-object" }),
      )
      const config = loadConfig(dir)
      expect(config.embedding).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("defaults to no embedding config", () => {
    const dir = makeTmpDir()
    try {
      const config = loadConfig(dir)
      expect(config.embedding).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("roundtrips embedding config via updateConfig", () => {
    const dir = makeTmpDir()
    try {
      const embeddingConfig = {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      }
      updateConfig({ embedding: embeddingConfig }, dir)
      const loaded = loadConfig(dir)
      expect(loaded.embedding).toEqual(embeddingConfig)
    } finally {
      cleanup(dir)
    }
  })

  test("clears embedding config with undefined", () => {
    const dir = makeTmpDir()
    try {
      const embeddingConfig = {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      }
      updateConfig({ embedding: embeddingConfig }, dir)
      updateConfig({ embedding: undefined }, dir)
      const loaded = loadConfig(dir)
      expect(loaded.embedding).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })
})

// ── llm config ──────────────────────────────────────────────────────────────

describe("llm config", () => {
  test("loads llm connection config", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          llm: {
            endpoint: "http://localhost:11434/v1/chat/completions",
            model: "llama3.2",
          },
        }),
      )
      const config = loadConfig(dir)
      expect(config.llm).toEqual({
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
      })
    } finally {
      cleanup(dir)
    }
  })

  test("loads llm config with apiKey", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          llm: {
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-4",
            apiKey: "sk-key",
          },
        }),
      )
      const config = loadConfig(dir)
      expect(config.llm?.apiKey).toBe("sk-key")
    } finally {
      cleanup(dir)
    }
  })

  test("ignores invalid llm config", () => {
    const dir = makeTmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ llm: { endpoint: "http://localhost" } }),
      )
      const config = loadConfig(dir)
      expect(config.llm).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("roundtrips llm config via updateConfig", () => {
    const dir = makeTmpDir()
    try {
      const llmConfig = {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
      }
      updateConfig({ llm: llmConfig }, dir)
      const loaded = loadConfig(dir)
      expect(loaded.llm).toEqual(llmConfig)
    } finally {
      cleanup(dir)
    }
  })
})

// ── addStashDir ─────────────────────────────────────────────────────────────

describe("addStashDir", () => {
  test("appends a new directory to additionalStashDirs", () => {
    const dir = makeTmpDir()
    try {
      const config = addStashDir("/extra/stash", dir)
      expect(config.additionalStashDirs).toContain("/extra/stash")
      // Verify persisted
      const loaded = loadConfig(dir)
      expect(loaded.additionalStashDirs).toContain("/extra/stash")
    } finally {
      cleanup(dir)
    }
  })

  test("does not duplicate an already-present directory", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/existing"] }, dir)
      const config = addStashDir("/existing", dir)
      expect(config.additionalStashDirs).toEqual(["/existing"])
    } finally {
      cleanup(dir)
    }
  })

  test("appends when existing dirs are present", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/first"] }, dir)
      const config = addStashDir("/second", dir)
      expect(config.additionalStashDirs).toEqual(["/first", "/second"])
    } finally {
      cleanup(dir)
    }
  })

  test("creates config.json if it does not exist", () => {
    const dir = makeTmpDir()
    try {
      addStashDir("/new", dir)
      expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true)
      const loaded = loadConfig(dir)
      expect(loaded.additionalStashDirs).toEqual(["/new"])
    } finally {
      cleanup(dir)
    }
  })
})

// ── removeStashDir ──────────────────────────────────────────────────────────

describe("removeStashDir", () => {
  test("removes an existing directory from additionalStashDirs", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/a", "/b"] }, dir)
      const config = removeStashDir("/a", dir)
      expect(config.additionalStashDirs).toEqual(["/b"])
      // Verify persisted
      const loaded = loadConfig(dir)
      expect(loaded.additionalStashDirs).toEqual(["/b"])
    } finally {
      cleanup(dir)
    }
  })

  test("is a no-op when directory is not in the list", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/a"] }, dir)
      const config = removeStashDir("/nothere", dir)
      expect(config.additionalStashDirs).toEqual(["/a"])
    } finally {
      cleanup(dir)
    }
  })

  test("results in empty list when last directory is removed", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/only"] }, dir)
      const config = removeStashDir("/only", dir)
      expect(config.additionalStashDirs).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test("removes only the matching directory when multiple exist", () => {
    const dir = makeTmpDir()
    try {
      saveConfig({ semanticSearch: true, additionalStashDirs: ["/a", "/b", "/c"] }, dir)
      const config = removeStashDir("/b", dir)
      expect(config.additionalStashDirs).toEqual(["/a", "/c"])
    } finally {
      cleanup(dir)
    }
  })
})
