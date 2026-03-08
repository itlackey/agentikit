import fs from "node:fs"
import path from "node:path"
import { parseOpenRef, makeOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import { resolveStashSources, findSourceForPath } from "./stash-source"

// Ensure handlers are registered
import "./handlers/index"

export interface EditOptions {
  /** Asset ref — must point to a working stash asset */
  ref: string
  /** New file content */
  content: string
}

export interface EditResponse {
  path: string
  ref: string
}

export function agentikitEdit(options: EditOptions): EditResponse {
  const parsed = parseOpenRef(options.ref)
  const sources = resolveStashSources()
  const workingSource = sources.find((s) => s.kind === "working")
  if (!workingSource) {
    throw new Error("No working stash configured. Run `akm init` first.")
  }

  // Resolve asset path — try working stash first
  let assetPath: string | undefined
  let matchedSource = workingSource

  // If ref has a source kind, validate it's the working stash
  if (parsed.sourceKind && parsed.sourceKind !== "working") {
    throw new Error(
      `Cannot edit assets in ${parsed.sourceKind} stash. Clone the asset to the working stash first using \`akm clone ${options.ref}\`.`,
    )
  }

  try {
    assetPath = resolveAssetPath(workingSource.path, parsed.type, parsed.name)
  } catch {
    // If no source kind specified, check if it exists in another source
    if (!parsed.sourceKind) {
      for (const source of sources) {
        if (source.kind === "working") continue
        try {
          resolveAssetPath(source.path, parsed.type, parsed.name)
          throw new Error(
            `Asset "${parsed.name}" was found in ${source.kind} stash but not in the working stash. ` +
            `Clone it first using \`akm clone ${options.ref}\`, then edit the clone.`,
          )
        } catch (err) {
          if (err instanceof Error && err.message.includes("was found in")) throw err
        }
      }
    }
    throw new Error(`Asset not found in working stash: ${parsed.type}:${parsed.name}`)
  }

  // Write the new content
  fs.mkdirSync(path.dirname(assetPath), { recursive: true })
  fs.writeFileSync(assetPath, options.content, "utf8")

  const ref = makeOpenRef(parsed.type, parsed.name, "working")
  return { path: assetPath, ref }
}
