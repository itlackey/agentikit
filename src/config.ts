import fs from "node:fs"
import path from "node:path"
import { resolveStashDir } from "./common"

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentikitConfig {
  /** Whether semantic search is enabled. Default: true */
  semanticSearch: boolean
  /** Additional stash directories to search alongside the primary one */
  additionalStashDirs: string[]
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AgentikitConfig = {
  semanticSearch: true,
  additionalStashDirs: [],
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getConfigPath(stashDir: string): string {
  return path.join(stashDir, "config.json")
}

// ── Load / Save / Update ────────────────────────────────────────────────────

export function loadConfig(stashDir?: string): AgentikitConfig {
  const dir = stashDir ?? resolveStashDir()
  const configPath = getConfigPath(dir)

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ...DEFAULT_CONFIG }
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }

  return pickKnownKeys(raw)
}

export function saveConfig(config: AgentikitConfig, stashDir?: string): void {
  const dir = stashDir ?? resolveStashDir()
  const configPath = getConfigPath(dir)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
}

export function updateConfig(
  partial: Partial<AgentikitConfig>,
  stashDir?: string,
): AgentikitConfig {
  const dir = stashDir ?? resolveStashDir()
  const current = loadConfig(dir)
  const merged: AgentikitConfig = { ...current, ...partial }
  saveConfig(merged, dir)
  return merged
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickKnownKeys(raw: Record<string, unknown>): AgentikitConfig {
  const config = { ...DEFAULT_CONFIG }

  if (typeof raw.semanticSearch === "boolean") {
    config.semanticSearch = raw.semanticSearch
  }

  if (Array.isArray(raw.additionalStashDirs)) {
    config.additionalStashDirs = raw.additionalStashDirs.filter(
      (d): d is string => typeof d === "string",
    )
  }

  return config
}
