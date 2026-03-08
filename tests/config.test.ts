import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  loadConfig,
  saveConfig,
  updateConfig,
  DEFAULT_CONFIG,
  getConfigDir,
  getConfigPath,
  getLegacyConfigPath,
} from "../src/config"

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-config-test-"))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function writeRawConfig(configPath: string, content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, content)
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalHome = process.env.HOME
const originalStashDir = process.env.AGENTIKIT_STASH_DIR
let testConfigHome = ""

beforeEach(() => {
  testConfigHome = makeTmpDir()
  process.env.XDG_CONFIG_HOME = testConfigHome
})

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }

  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }

  if (originalStashDir === undefined) {
    delete process.env.AGENTIKIT_STASH_DIR
  } else {
    process.env.AGENTIKIT_STASH_DIR = originalStashDir
  }

  if (testConfigHome) {
    cleanup(testConfigHome)
    testConfigHome = ""
  }
})

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json under XDG_CONFIG_HOME", () => {
    expect(getConfigPath("/some/stash")).toBe(path.join(testConfigHome, "agentikit", "config.json"))
  })

  test("defaults to ~/.config/agentikit when XDG_CONFIG_HOME is unset", () => {
    const home = makeTmpDir()
    delete process.env.XDG_CONFIG_HOME
    process.env.HOME = home

    expect(getConfigPath("/some/stash")).toBe(path.join(home, ".config", "agentikit", "config.json"))

    cleanup(home)
  })

  test("uses APPDATA on Windows", () => {
    const appData = String.raw`C:\Users\alice\AppData\Roaming`
    expect(getConfigDir({ APPDATA: appData }, "win32")).toBe(path.join(appData, "agentikit"))
  })

  test("falls back to USERPROFILE AppData Roaming on Windows", () => {
    const userProfile = String.raw`C:\Users\alice`
    expect(getConfigDir({ USERPROFILE: userProfile }, "win32")).toBe(
      path.join(userProfile, "AppData", "Roaming", "agentikit"),
    )
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

  test("loads config without requiring AGENTIKIT_STASH_DIR", () => {
    delete process.env.AGENTIKIT_STASH_DIR
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearch: false }))

    expect(loadConfig()).toEqual({ semanticSearch: false, additionalStashDirs: [] })
  })

  test("merges partial config with defaults", () => {
    const dir = makeTmpDir()
    try {
      writeRawConfig(getConfigPath(dir), JSON.stringify({ semanticSearch: false }))
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
      writeRawConfig(getConfigPath(dir), "not valid json {{{")
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("handles non-object JSON gracefully", () => {
    const dir = makeTmpDir()
    try {
      writeRawConfig(getConfigPath(dir), '"just a string"')
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("handles JSON array gracefully", () => {
    const dir = makeTmpDir()
    try {
      writeRawConfig(getConfigPath(dir), "[1, 2, 3]")
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    } finally {
      cleanup(dir)
    }
  })

  test("drops unknown keys", () => {
    const dir = makeTmpDir()
    try {
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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

  test("loads legacy stash config and migrates it to XDG config path", () => {
    const dir = makeTmpDir()
    const legacyPath = getLegacyConfigPath(dir)
    try {
      writeRawConfig(legacyPath, JSON.stringify({ semanticSearch: false }))

      const config = loadConfig(dir)

      expect(config).toEqual({ semanticSearch: false, additionalStashDirs: [] })
      expect(fs.existsSync(getConfigPath(dir))).toBe(true)
      expect(fs.existsSync(legacyPath)).toBe(false)
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
      const raw = fs.readFileSync(getConfigPath(dir), "utf8")
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

  test("removes legacy stash config after saving to XDG config path", () => {
    const dir = makeTmpDir()
    const legacyPath = getLegacyConfigPath(dir)
    try {
      writeRawConfig(legacyPath, JSON.stringify({ semanticSearch: true }))

      saveConfig({ semanticSearch: false, additionalStashDirs: [] }, dir)

      expect(fs.existsSync(getConfigPath(dir))).toBe(true)
      expect(fs.existsSync(legacyPath)).toBe(false)
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
      expect(fs.existsSync(getConfigPath(dir))).toBe(true)
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
      writeRawConfig(
        getConfigPath(dir),
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
