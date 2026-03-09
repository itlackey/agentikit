import fs from "node:fs"
import path from "node:path"
import { resolveStashDir } from "./common"
import { loadConfig } from "./config"

// ── Types ───────────────────────────────────────────────────────────────────

export type StashSourceKind = "working" | "mounted" | "installed"

export interface StashSource {
  kind: StashSourceKind
  path: string
  /** For installed sources, the registry entry id */
  registryId?: string
  /** Whether this source is writable (only working stash) */
  writable: boolean
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources:
 *   1. Working stash (writable)
 *   2. Mounted stash dirs (read-only, user-configured)
 *   3. Installed stash dirs (read-only, derived from registry.installed)
 */
export function resolveStashSources(overrideStashDir?: string): StashSource[] {
  const stashDir = overrideStashDir ?? resolveStashDir()
  const config = loadConfig()

  const sources: StashSource[] = [
    { kind: "working", path: stashDir, writable: true },
  ]

  for (const dir of config.mountedStashDirs) {
    if (isValidDirectory(dir)) {
      sources.push({ kind: "mounted", path: dir, writable: false })
    }
  }

  for (const entry of config.registry?.installed ?? []) {
    if (isValidDirectory(entry.stashRoot)) {
      sources.push({
        kind: "installed",
        path: entry.stashRoot,
        registryId: entry.id,
        writable: false,
      })
    }
  }

  return sources
}

/**
 * Convenience: returns just the directory paths, preserving priority order.
 */
export function resolveAllStashDirs(overrideStashDir?: string): string[] {
  return resolveStashSources(overrideStashDir).map((s) => s.path)
}

/**
 * Find which source a file path belongs to.
 */
export function findSourceForPath(filePath: string, sources: StashSource[]): StashSource | undefined {
  const resolved = path.resolve(filePath)
  for (const source of sources) {
    if (resolved.startsWith(path.resolve(source.path) + path.sep)) return source
  }
  return undefined
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
