import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, hasErrnoCode, resolveStashDir } from "./common"
import { ASSET_TYPES, TYPE_DIRS, deriveCanonicalAssetName } from "./asset-spec"
import { loadSearchIndex, buildSearchText, type IndexedEntry, type SearchIndex } from "./indexer"
import { TfIdfAdapter, type ScoredEntry, type ScoredResult } from "./similarity"
import { rgFilterCandidates } from "./ripgrep-filter"
import { buildToolInfo } from "./tool-runner"
import { walkStash } from "./walker"
import { makeOpenRef } from "./stash-ref"
import type { AgentikitSearchType, SearchHit, SearchResponse } from "./stash-types"
import { loadConfig } from "./config"

type IndexedAsset = {
  type: AgentikitAssetType
  name: string
  path: string
}

const DEFAULT_LIMIT = 20

export async function agentikitSearch(input: {
  query: string
  type?: AgentikitSearchType
  limit?: number
}): Promise<SearchResponse> {
  const query = input.query.trim().toLowerCase()
  const searchType = input.type ?? "any"
  const limit = normalizeLimit(input.limit)
  const stashDir = resolveStashDir()
  const config = loadConfig(stashDir)

  const allStashDirs = [
    stashDir,
    ...config.additionalStashDirs.filter((d) => {
      try { return fs.statSync(d).isDirectory() } catch { return false }
    }),
  ]

  // Try embedding-based search first if semantic search is enabled
  if (config.semanticSearch) {
    const embeddingHits = await tryEmbeddingSearch(query, searchType, limit, stashDir, allStashDirs)
    if (embeddingHits) {
      return {
        stashDir,
        hits: embeddingHits,
        tip: embeddingHits.length === 0 ? "No matching stash assets were found. Try running 'agentikit index' to rebuild." : undefined,
      }
    }
  }

  // Fall back to TF-IDF / substring search across all stash dirs
  let allHits: SearchHit[] = []

  for (const dir of allStashDirs) {
    const hits = searchSingleStash(query, searchType, limit, dir, config.semanticSearch, allStashDirs)
    allHits.push(...hits)
  }

  // Deduplicate by path (primary stash wins since it's first)
  const seen = new Set<string>()
  allHits = allHits.filter((hit) => {
    if (seen.has(hit.path)) return false
    seen.add(hit.path)
    return true
  })

  // Sort by score descending (scored hits first), then apply limit
  allHits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  allHits = allHits.slice(0, limit)

  return {
    stashDir,
    hits: allHits,
    tip: allHits.length === 0 ? "No matching stash assets were found. Try running 'agentikit index' to rebuild." : undefined,
  }
}

async function tryEmbeddingSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  allStashDirs: string[],
): Promise<SearchHit[] | null> {
  const index = loadSearchIndex()
  if (!index || !index.entries || index.entries.length === 0) return null
  if (index.stashDir !== stashDir) return null
  if (!index.hasEmbeddings || !query) return null

  // Check that at least some entries have embeddings
  const entriesWithEmbeddings = index.entries.filter((ie) => ie.embedding && ie.embedding.length > 0)
  if (entriesWithEmbeddings.length === 0) return null

  try {
    const { loadConfig } = await import("./config.js")
    const searchConfig = loadConfig(stashDir)
    const { embed, cosineSimilarity } = await import("./embedder.js")
    const queryEmbedding = await embed(query, searchConfig.embedding)

    let candidates = entriesWithEmbeddings
    if (searchType !== "any") {
      candidates = candidates.filter((ie) => ie.entry.type === searchType)
    }

    const scored = candidates.map((ie) => ({
      ie,
      score: cosineSimilarity(queryEmbedding, ie.embedding!),
    }))

    scored.sort((a, b) => b.score - a.score)
    const topResults = scored.slice(0, limit)

    return topResults.map(({ ie, score }): SearchHit => {
      const entryStashDir = findStashDirForPath(ie.path, allStashDirs) ?? stashDir
      const typeRoot = path.join(entryStashDir, TYPE_DIRS[ie.entry.type])
      const openRefName = deriveCanonicalAssetName(ie.entry.type, typeRoot, ie.path)
        ?? ie.entry.name

      const hit: SearchHit = {
        type: ie.entry.type,
        name: ie.entry.name,
        path: ie.path,
        openRef: makeOpenRef(ie.entry.type, openRefName),
        description: ie.entry.description,
        tags: ie.entry.tags,
        score: Math.round(score * 1000) / 1000,
      }

      if (ie.entry.type === "tool") {
        try {
          const toolInfo = buildToolInfo(entryStashDir, ie.path)
          hit.runCmd = toolInfo.runCmd
          hit.kind = toolInfo.kind
        } catch (error: unknown) {
          if (!hasErrnoCode(error, "ENOENT")) throw error
        }
      }

      return hit
    })
  } catch {
    // @xenova/transformers not available, fall through to TF-IDF
    return null
  }
}

function findStashDirForPath(filePath: string, stashDirs: string[]): string | undefined {
  const resolved = path.resolve(filePath)
  for (const dir of stashDirs) {
    if (resolved.startsWith(path.resolve(dir) + path.sep)) return dir
  }
  return undefined
}

function searchSingleStash(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  semanticEnabled: boolean,
  allStashDirs: string[],
): SearchHit[] {
  if (semanticEnabled) {
    const semanticHits = tryTfIdfSearch(query, searchType, limit, stashDir, allStashDirs)
    if (semanticHits) return semanticHits
  }

  const assets = indexAssets(stashDir, searchType)
  return assets
    .filter((asset) => asset.name.toLowerCase().includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset): SearchHit => assetToSearchHit(asset, stashDir))
}

function tryTfIdfSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  allStashDirs: string[],
): SearchHit[] | null {
  const index = loadSearchIndex()
  if (!index || !index.entries || index.entries.length === 0) return null
  if (index.stashDir !== stashDir) return null

  let candidateEntries = index.entries
  if (query) {
    // Try ripgrep pre-filtering across all stash dirs
    for (const dir of allStashDirs) {
      const rgResult = rgFilterCandidates(query, dir, dir)
      if (rgResult && rgResult.usedRg) {
        const matchedDirs = new Set(rgResult.matchedFiles.map((f) => path.dirname(f)))
        const filtered = index.entries.filter((ie) => matchedDirs.has(ie.dirPath))
        if (filtered.length > 0) {
          candidateEntries = filtered
          break
        }
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

  return results.map((r): SearchHit => indexResultToHit(r, stashDir))
}

function indexResultToHit(r: ScoredResult, stashDir: string): SearchHit {
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
