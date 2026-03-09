import path from "node:path"
import { SCRIPT_EXTENSIONS, SCRIPT_EXTENSIONS_BROAD } from "../asset-spec"
import { hasErrnoCode, toPosix } from "../common"
import { buildToolInfo } from "../tool-runner"
import { extractDescriptionFromComments } from "../metadata"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse, LocalSearchHit } from "../stash-types"
import type { StashEntry } from "../metadata"

/** Extensions that buildToolInfo can handle (tool-runner supported) */
const RUNNABLE_EXTENSIONS = SCRIPT_EXTENSIONS

export const scriptHandler: AssetTypeHandler = {
  typeName: "script",
  stashDir: "scripts",

  isRelevantFile(fileName: string): boolean {
    return SCRIPT_EXTENSIONS_BROAD.has(path.extname(fileName).toLowerCase())
  },

  toCanonicalName(typeRoot: string, filePath: string): string | undefined {
    return toPosix(path.relative(typeRoot, filePath))
  },

  toAssetPath(typeRoot: string, name: string): string {
    return path.join(typeRoot, name)
  },

  buildShowResponse(input: ShowInput): ShowResponse {
    const ext = path.extname(input.path).toLowerCase()

    // For extensions supported by tool-runner, show runCmd
    if (RUNNABLE_EXTENSIONS.has(ext)) {
      const stashDirs = input.stashDirs ?? []
      const assetStashDir = stashDirs.find((d) =>
        path.resolve(input.path).startsWith(path.resolve(d) + path.sep),
      ) ?? stashDirs[0]

      if (assetStashDir) {
        try {
          const toolInfo = buildToolInfo(assetStashDir, input.path)
          return {
            type: "script",
            name: input.name,
            path: input.path,
            runCmd: toolInfo.runCmd,
            kind: toolInfo.kind,
          }
        } catch {
          // Fall through to content display
        }
      }
    }

    // For other extensions or when buildToolInfo fails, show file content
    return {
      type: "script",
      name: input.name,
      path: input.path,
      content: input.content,
    }
  },

  enrichSearchHit(hit: LocalSearchHit, stashDir: string): void {
    const ext = path.extname(hit.path).toLowerCase()
    if (!RUNNABLE_EXTENSIONS.has(ext)) return

    try {
      const toolInfo = buildToolInfo(stashDir, hit.path)
      hit.runCmd = toolInfo.runCmd
      hit.kind = toolInfo.kind
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error
    }
  },

  defaultUsageGuide: [
    "Use the hit's runCmd for execution when available, or run the script directly with the appropriate interpreter.",
    "Use `akm show <openRef>` to inspect the script before running it.",
  ],

  extractTypeMetadata(entry: StashEntry, file: string, ext: string): void {
    if (ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(file)
      if (commentDesc && !entry.description) {
        entry.description = commentDesc
        entry.source = "comments"
        entry.confidence = 0.7
      }
    }
  },
}
