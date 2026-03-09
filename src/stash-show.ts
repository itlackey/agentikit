import fs from "node:fs"
import { parseOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import type { KnowledgeView, ShowResponse } from "./stash-types"
import { getHandler } from "./asset-type-handler"
import { resolveStashSources, findSourceForPath } from "./stash-source"

export async function agentikitShow(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const parsed = parseOpenRef(input.ref)
  let sources = resolveStashSources()

  // If the ref specifies a source kind, filter to matching sources
  let searchSources = sources
  if (parsed.sourceKind) {
    if (parsed.sourceKind === "installed" && parsed.registryId) {
      searchSources = sources.filter((s) => s.kind === "installed" && s.registryId === parsed.registryId)
    } else {
      searchSources = sources.filter((s) => s.kind === parsed.sourceKind)
    }
  }

  let allStashDirs = searchSources.map((s) => s.path)

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

  if (!assetPath && parsed.registryId) {
    const installCmd = `akm add ${parsed.registryId}`
    throw new Error(
      `Stash asset not found for ref: ${parsed.type}:${parsed.name}. ` +
      `To install from registry, run: ${installCmd}`
    )
  }

  if (!assetPath) {
    throw lastError ?? new Error(`Stash asset not found for ref: ${parsed.type}:${parsed.name}`)
  }
  const content = fs.readFileSync(assetPath, "utf8")

  const source = findSourceForPath(assetPath, sources)
  const handler = getHandler(parsed.type)
  const response = handler.buildShowResponse({
    name: parsed.name,
    path: assetPath,
    content,
    view: input.view,
    stashDirs: allStashDirs,
  })

  return {
    ...response,
    sourceKind: source?.kind,
    registryId: source?.registryId,
    editable: source?.writable ?? false,
  }
}
