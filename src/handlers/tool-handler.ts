import path from "node:path"
import { SCRIPT_EXTENSIONS } from "../asset-spec"
import { hasErrnoCode, toPosix } from "../common"
import { buildToolInfo } from "../tool-runner"
import { extractDescriptionFromComments } from "../metadata"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse, LocalSearchHit } from "../stash-types"
import type { StashEntry } from "../metadata"

export const toolHandler: AssetTypeHandler = {
  typeName: "tool",
  stashDir: "tools",

  isRelevantFile(fileName: string): boolean {
    return SCRIPT_EXTENSIONS.has(path.extname(fileName).toLowerCase())
  },

  toCanonicalName(typeRoot: string, filePath: string): string | undefined {
    return toPosix(path.relative(typeRoot, filePath))
  },

  toAssetPath(typeRoot: string, name: string): string {
    return path.join(typeRoot, name)
  },

  buildShowResponse(input: ShowInput): ShowResponse {
    const stashDirs = input.stashDirs ?? []
    const assetStashDir = stashDirs.find((d) =>
      path.resolve(input.path).startsWith(path.resolve(d) + path.sep),
    ) ?? stashDirs[0]

    if (!assetStashDir) {
      return { type: "tool", name: input.name, path: input.path, content: input.content }
    }

    const toolInfo = buildToolInfo(assetStashDir, input.path)
    return {
      type: "tool",
      name: input.name,
      path: input.path,
      runCmd: toolInfo.runCmd,
      kind: toolInfo.kind,
    }
  },

  enrichSearchHit(hit: LocalSearchHit, stashDir: string): void {
    try {
      const toolInfo = buildToolInfo(stashDir, hit.path)
      hit.runCmd = toolInfo.runCmd
      hit.kind = toolInfo.kind
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error
    }
  },

  defaultUsageGuide: [
    "Use the hit's runCmd for execution so runtime and working directory stay correct.",
    "Use `akm show <openRef>` to inspect the tool before running it.",
  ],

  extractTypeMetadata(entry: StashEntry, file: string, ext: string): void {
    if (SCRIPT_EXTENSIONS.has(ext) && ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(file)
      if (commentDesc && !entry.description) {
        entry.description = commentDesc
        entry.source = "comments"
        entry.confidence = 0.7
      }
    }
  },
}
