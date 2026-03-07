import type { AgentikitAssetType } from "./common"
import type { ToolKind } from "./tool-runner"

export type AgentikitSearchType = AgentikitAssetType | "any"

export interface SearchHit {
  type: AgentikitAssetType
  name: string
  path: string
  openRef: string
  description?: string
  tags?: string[]
  score?: number
  whyMatched?: string[]
  runCmd?: string
  kind?: ToolKind
}

export interface SearchResponse {
  stashDir: string
  hits: SearchHit[]
  tip?: string
}

export interface OpenResponse {
  type: AgentikitAssetType
  name: string
  path: string
  content?: string
  template?: string
  prompt?: string
  description?: string
  toolPolicy?: unknown
  modelHint?: unknown
  runCmd?: string
  kind?: ToolKind
}

export interface RunResponse {
  type: "tool"
  name: string
  path: string
  output: string
  exitCode: number
}

export type KnowledgeView =
  | { mode: "full" }
  | { mode: "toc" }
  | { mode: "frontmatter" }
  | { mode: "section"; heading: string }
  | { mode: "lines"; start: number; end: number }
