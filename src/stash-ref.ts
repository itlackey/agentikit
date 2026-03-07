import path from "node:path"
import { type AgentikitAssetType, isAssetType } from "./common"

export interface OpenRef {
  type: AgentikitAssetType
  name: string
}

export function parseOpenRef(ref: string): OpenRef {
  const separator = ref.indexOf(":")
  if (separator <= 0) {
    throw new Error("Invalid open ref. Expected format '<type>:<name>'.")
  }
  const rawType = ref.slice(0, separator)
  const rawName = ref.slice(separator + 1)
  if (!isAssetType(rawType)) {
    throw new Error(`Invalid open ref type: "${rawType}".`)
  }
  let name: string
  try {
    name = decodeURIComponent(rawName)
  } catch {
    throw new Error("Invalid open ref encoding.")
  }
  const normalized = path.posix.normalize(name.replace(/\\/g, "/"))
  if (
    !name
    || name.includes("\0")
    || /^[A-Za-z]:/.test(name)
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error("Invalid open ref name.")
  }
  return { type: rawType, name: normalized }
}

export function makeOpenRef(type: AgentikitAssetType, name: string): string {
  return `${type}:${encodeURIComponent(name)}`
}
