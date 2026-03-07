import { spawnSync } from "node:child_process"
import { resolveRg } from "./ripgrep-resolve"

export interface RgCandidateResult {
  matchedFiles: string[]
  usedRg: boolean
}

/**
 * Use ripgrep to find .stash.json files that match query tokens.
 * Returns paths to matching .stash.json files.
 *
 * If ripgrep is not available or the query is empty, returns null
 * to signal that the caller should skip pre-filtering.
 */
export function rgFilterCandidates(
  query: string,
  searchDir: string,
  stashDir?: string,
): RgCandidateResult | null {
  if (!query.trim()) return null

  const rgPath = resolveRg(stashDir)
  if (!rgPath) return null

  // Tokenize the query into an OR pattern for ripgrep
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (tokens.length === 0) return null

  const pattern = tokens.join("|")

  const result = spawnSync(rgPath, [
    "-i",                        // case insensitive
    "-l",                        // files-with-matches only
    "--hidden",                  // include hidden files such as .stash.json
    "--no-ignore",               // include ignored files to ensure metadata is searchable
    "--glob", ".stash.json",     // only search .stash.json files
    pattern,
    searchDir,
  ], {
    encoding: "utf8",
    timeout: 10_000,
  })

  if (result.status !== 0 && result.status !== 1) {
    // rg exit code 1 = no matches (normal), anything else = error
    return null
  }

  const files = (result.stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((f) => f.length > 0)

  return { matchedFiles: files, usedRg: true }
}
