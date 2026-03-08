import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, hasErrnoCode, isWithin } from "./common"
import { TYPE_DIRS, isRelevantAssetFile, resolveAssetPathFromName } from "./asset-spec"

export function resolveAssetPath(stashDir: string, type: AgentikitAssetType, name: string): string {
  const root = path.join(stashDir, TYPE_DIRS[type])
  const target = resolveAssetPathFromName(type, root, name)
  const resolvedRoot = resolveAndValidateTypeRoot(root, type, name)
  const resolvedTarget = path.resolve(target)
  if (!isWithin(resolvedTarget, resolvedRoot)) {
    throw new Error("Ref resolves outside the stash root.")
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new Error(`Stash asset not found for ref: ${type}:${name}`)
  }
  const realTarget = fs.realpathSync(resolvedTarget)
  if (!isWithin(realTarget, resolvedRoot)) {
    throw new Error("Ref resolves outside the stash root.")
  }
  if (!isRelevantAssetFile(type, path.basename(resolvedTarget))) {
    if (type === "tool") {
      throw new Error("Tool ref must resolve to a .sh, .ts, .js, .ps1, .cmd, or .bat file.")
    }
    if (type === "script") {
      throw new Error("Script ref must resolve to a supported script file (.sh, .ts, .js, .py, .rb, .go, etc.).")
    }
    throw new Error(`Stash asset not found for ref: ${type}:${name}`)
  }
  return realTarget
}

function resolveAndValidateTypeRoot(root: string, type: AgentikitAssetType, name: string): string {
  const rootStat = readTypeRootStat(root, type, name)
  if (!rootStat.isDirectory()) {
    throw new Error(`Stash type root is not a directory for ref: ${type}:${name}`)
  }
  return fs.realpathSync(root)
}

function readTypeRootStat(root: string, type: AgentikitAssetType, name: string): fs.Stats {
  try {
    return fs.statSync(root)
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(`Stash type root not found for ref: ${type}:${name}`)
    }
    throw error
  }
}
