/**
 * Shared filesystem walker for agentikit stash directories.
 *
 * Provides a single implementation used by both the search fallback
 * (stash.ts) and the indexer (indexer.ts) to walk type-specific asset
 * directories and group files by parent directory.
 */

import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType } from "./common"
import { isRelevantAssetFile } from "./asset-spec"

export interface DirectoryGroup {
  dirPath: string
  files: string[]
}

/**
 * Walk a type root directory and return files grouped by their parent directory.
 *
 * Only files relevant to the given `assetType` are included (e.g. `.md` for
 * commands, script extensions for tools, `SKILL.md` for skills).
 */
export function walkStash(typeRoot: string, assetType: AgentikitAssetType): DirectoryGroup[] {
  if (!fs.existsSync(typeRoot)) return []

  const groups = new Map<string, string[]>()

  const stack = [typeRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && isRelevantAssetFile(assetType, entry.name)) {
        const parentDir = path.dirname(fullPath)
        const existing = groups.get(parentDir)
        if (existing) {
          existing.push(fullPath)
        } else {
          groups.set(parentDir, [fullPath])
        }
      }
    }
  }

  return Array.from(groups, ([dirPath, files]) => ({ dirPath, files }))
}
