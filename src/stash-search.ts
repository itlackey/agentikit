import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, hasErrnoCode, resolveStashDir } from "./common"
import { ASSET_TYPES, TYPE_DIRS, deriveCanonicalAssetName } from "./asset-spec"
import { loadSearchIndex, buildSearchText, type IndexedEntry } from "./indexer"
import { TfIdfAdapter, type ScoredEntry } from "./similarity"
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
    const embeddingHits = await tryEmbeddingSearch(query, searchType, limit, stashDir, allStashDirs, config)
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
  config: import("./config").AgentikitConfig,
): Promise<SearchHit[] | null> {
  const index = loadSearchIndex()
  if (!index || !index.entries || index.entries.length === 0) return null
  if (index.stashDir !== stashDir) return null
  if (!index.hasEmbeddings || !query) return null

  // Check that at least some entries have embeddings
  const entriesWithEmbeddings = index.entries.filter((ie) => ie.embedding && ie.embedding.length > 0)
  if (entriesWithEmbeddings.length === 0) return null

  try {
    const { embed, cosineSimilarity } = await import("./embedder.js")
    const queryEmbedding = await embed(query, config.embedding)

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

    return topResults.map(({ ie, score }): SearchHit =>
      buildIndexedHit({
        entry: ie.entry,
        path: ie.path,
        score: Math.round(score * 1000) / 1000,
        query,
        rankingMode: "semantic",
        defaultStashDir: stashDir,
        allStashDirs,
      }))
  } catch {
    // Embedding provider not available, fall through to TF-IDF
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

  const candidateEntries = index.entries
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

  return results.map((r): SearchHit =>
    buildIndexedHit({
      entry: r.entry,
      path: r.path,
      score: r.score,
      query,
      rankingMode: "tfidf",
      defaultStashDir: stashDir,
      allStashDirs,
    }))
}


function buildIndexedHit(input: {
  entry: IndexedEntry["entry"]
  path: string
  score: number
  query: string
  rankingMode: "semantic" | "tfidf"
  defaultStashDir: string
  allStashDirs: string[]
}): SearchHit {
  const entryStashDir = findStashDirForPath(input.path, input.allStashDirs) ?? input.defaultStashDir
  const typeRoot = path.join(entryStashDir, TYPE_DIRS[input.entry.type])
  const openRefName = deriveCanonicalAssetName(input.entry.type, typeRoot, input.path)
    ?? input.entry.name

  const qualityBoost = input.entry.generated === true ? 0 : 0.05
  const confidenceBoost = typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0
  const score = Math.round((input.score + qualityBoost + confidenceBoost) * 1000) / 1000

  const whyMatched = buildWhyMatched(input.entry, input.query, input.rankingMode, qualityBoost, confidenceBoost)

  const hit: SearchHit = {
    type: input.entry.type,
    name: input.entry.name,
    path: input.path,
    openRef: makeOpenRef(input.entry.type, openRefName),
    description: input.entry.description,
    tags: input.entry.tags,
    score,
    whyMatched,
  }

  if (input.entry.type === "tool") {
    try {
      const toolInfo = buildToolInfo(entryStashDir, input.path)
      hit.runCmd = toolInfo.runCmd
      hit.kind = toolInfo.kind
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error
    }
  }

  return hit
}

function buildWhyMatched(
  entry: IndexedEntry["entry"],
  query: string,
  rankingMode: "semantic" | "tfidf",
  qualityBoost: number,
  confidenceBoost: number,
): string[] {
  const reasons: string[] = [rankingMode === "semantic" ? "semantic similarity" : "tf-idf lexical relevance"]
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)

  const name = entry.name.toLowerCase()
  const tags = entry.tags?.join(" ").toLowerCase() ?? ""
  const intents = entry.intents?.join(" ").toLowerCase() ?? ""
  const aliases = entry.aliases?.join(" ").toLowerCase() ?? ""

  if (tokens.some((t) => name.includes(t))) reasons.push("matched name tokens")
  if (tokens.some((t) => tags.includes(t))) reasons.push("matched tags")
  if (tokens.some((t) => intents.includes(t))) reasons.push("matched intents")
  if (tokens.some((t) => aliases.includes(t))) reasons.push("matched aliases")
  if (qualityBoost > 0) reasons.push("curated metadata boost")
  if (confidenceBoost > 0) reasons.push("metadata confidence boost")

  return reasons
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
