import path from "node:path"
import { type AgentikitAssetType, hasErrnoCode, resolveStashDir } from "./common"
import { ASSET_TYPES, TYPE_DIRS, deriveCanonicalAssetName } from "./asset-spec"
import { loadSearchIndex, buildSearchText, type IndexedEntry } from "./indexer"
import { TfIdfAdapter, type ScoredEntry } from "./similarity"
import { rgFilterCandidates } from "./ripgrep-filter"
import { buildToolInfo } from "./tool-runner"
import { walkStash } from "./walker"
import { makeOpenRef } from "./stash-ref"
import type { AgentikitSearchType, SearchHit, SearchResponse } from "./stash-types"

type IndexedAsset = {
  type: AgentikitAssetType
  name: string
  path: string
}

const DEFAULT_LIMIT = 20

export function agentikitSearch(input: {
  query: string
  type?: AgentikitSearchType
  limit?: number
}): SearchResponse {
  const query = input.query.trim().toLowerCase()
  const searchType = input.type ?? "any"
  const limit = normalizeLimit(input.limit)
  const stashDir = resolveStashDir()

  const semanticHits = trySemanticSearch(query, searchType, limit, stashDir)
  if (semanticHits) {
    return {
      stashDir,
      hits: semanticHits,
      tip: semanticHits.length === 0 ? "No matching stash assets were found. Try running 'agentikit index' to rebuild." : undefined,
    }
  }

  const assets = indexAssets(stashDir, searchType)
  const hits = assets
    .filter((asset) => asset.name.toLowerCase().includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset): SearchHit => assetToSearchHit(asset, stashDir))

  return {
    stashDir,
    hits,
    tip: hits.length === 0 ? "No matching stash assets were found." : undefined,
  }
}

function trySemanticSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
): SearchHit[] | null {
  const index = loadSearchIndex()
  if (!index || !index.entries || index.entries.length === 0) return null
  if (index.stashDir !== stashDir) return null

  let candidateEntries = index.entries
  if (query) {
    const rgResult = rgFilterCandidates(query, stashDir, stashDir)
    if (rgResult && rgResult.usedRg) {
      const matchedDirs = new Set(rgResult.matchedFiles.map((f) => path.dirname(f)))
      candidateEntries = index.entries.filter((ie) => matchedDirs.has(ie.dirPath))
      if (candidateEntries.length === 0) {
        candidateEntries = index.entries
      }
    }
  }

  const candidateScoredEntries = toScoredEntries(candidateEntries)

  let adapter: TfIdfAdapter
  if (index.tfidf && !query) {
    const allScored = toScoredEntries(index.entries)
    adapter = TfIdfAdapter.deserialize(index.tfidf, allScored)
  } else {
    adapter = new TfIdfAdapter()
    adapter.buildIndex(candidateScoredEntries)
  }

  const typeFilter = searchType === "any" ? undefined : searchType
  const results = adapter.search(query, limit, typeFilter)

  return results.map((r): SearchHit => {
    const typeRoot = path.join(stashDir, TYPE_DIRS[r.entry.type])
    const openRefName = deriveCanonicalAssetName(r.entry.type, typeRoot, r.path)
      ?? r.entry.name

    const hit: SearchHit = {
      type: r.entry.type,
      name: r.entry.name,
      path: r.path,
      openRef: makeOpenRef(r.entry.type, openRefName),
      description: r.entry.description,
      tags: r.entry.tags,
      score: r.score,
    }

    if (r.entry.type === "tool") {
      try {
        const toolInfo = buildToolInfo(stashDir, r.path)
        hit.runCmd = toolInfo.runCmd
        hit.kind = toolInfo.kind
      } catch (error: unknown) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error
        }
      }
    }

    return hit
  })
}

function toScoredEntries(entries: IndexedEntry[]): ScoredEntry[] {
  return entries.map((ie) => ({
    id: `${ie.entry.type}:${ie.entry.name}`,
    text: buildSearchText(ie.entry),
    entry: ie.entry,
    path: ie.path,
  }))
}

function assetToSearchHit(asset: IndexedAsset, stashDir: string): SearchHit {
  if (asset.type !== "tool") {
    return {
      type: asset.type,
      name: asset.name,
      path: asset.path,
      openRef: makeOpenRef(asset.type, asset.name),
    }
  }
  const toolInfo = buildToolInfo(stashDir, asset.path)
  return {
    type: "tool",
    name: asset.name,
    path: asset.path,
    openRef: makeOpenRef("tool", asset.name),
    runCmd: toolInfo.runCmd,
    kind: toolInfo.kind,
  }
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), 200)
}

function fileToAsset(assetType: AgentikitAssetType, root: string, file: string): IndexedAsset | undefined {
  const name = deriveCanonicalAssetName(assetType, root, file)
  if (!name) return undefined
  return { type: assetType, name, path: file }
}

function indexAssets(stashDir: string, type: AgentikitSearchType): IndexedAsset[] {
  const assets: IndexedAsset[] = []
  const types = type === "any" ? ASSET_TYPES : [type]
  for (const assetType of types) {
    const root = path.join(stashDir, TYPE_DIRS[assetType])
    const groups = walkStash(root, assetType)
    for (const { files } of groups) {
      for (const file of files) {
        const asset = fileToAsset(assetType, root, file)
        if (asset) assets.push(asset)
      }
    }
  }
  return assets
}

function compareAssets(a: IndexedAsset, b: IndexedAsset): number {
  if (a.type !== b.type) return a.type.localeCompare(b.type)
  return a.name.localeCompare(b.name)
}
