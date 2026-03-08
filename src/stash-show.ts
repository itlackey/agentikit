import fs from "node:fs"
import { resolveStashDir } from "./common"
import { parseOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import type { KnowledgeView, ShowResponse } from "./stash-types"
import { getHandler } from "./asset-type-handler"
import { loadConfig } from "./config"

// Ensure handlers are registered
import "./handlers/index"

export function agentikitShow(input: { ref: string; view?: KnowledgeView }): ShowResponse {
  const parsed = parseOpenRef(input.ref)
  const stashDir = resolveStashDir()
  const config = loadConfig()
  const allStashDirs = [
    stashDir,
    ...config.additionalStashDirs.filter((d) => {
      try { return fs.statSync(d).isDirectory() } catch { return false }
    }),
  ]

  let assetPath: string | undefined
  let lastError: Error | undefined
  for (const dir of allStashDirs) {
    try {
      assetPath = resolveAssetPath(dir, parsed.type, parsed.name)
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  if (!assetPath) {
    throw lastError ?? new Error(`Stash asset not found for ref: ${parsed.type}:${parsed.name}`)
  }
  const content = fs.readFileSync(assetPath, "utf8")

  const handler = getHandler(parsed.type)
  return handler.buildShowResponse({
    name: parsed.name,
    path: assetPath,
    content,
    view: input.view,
    stashDirs: allStashDirs,
  })
}
