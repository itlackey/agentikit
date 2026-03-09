import fs from "node:fs"
import path from "node:path"
import { TYPE_DIRS } from "./asset-spec"

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentikitAssetType = "tool" | "skill" | "command" | "agent" | "knowledge" | "script"

// ── Constants ───────────────────────────────────────────────────────────────

export const IS_WINDOWS = process.platform === "win32"
export { SCRIPT_EXTENSIONS, TYPE_DIRS } from "./asset-spec"

// ── Validators ──────────────────────────────────────────────────────────────

export function isAssetType(type: string): type is AgentikitAssetType {
  return type in TYPE_DIRS
}

// ── Utilities ───────────────────────────────────────────────────────────────

export function resolveStashDir(): string {
  const raw = process.env.AKM_STASH_DIR?.trim()
  if (!raw) {
    throw new Error("AKM_STASH_DIR is not set. Set it to your Agentikit stash path.")
  }
  const stashDir = path.resolve(raw)
  let stat: fs.Stats
  try {
    stat = fs.statSync(stashDir)
  } catch {
    throw new Error(`Unable to read AKM_STASH_DIR at "${stashDir}".`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`AKM_STASH_DIR must point to a directory: "${stashDir}".`)
  }
  return stashDir
}

export function toPosix(input: string): string {
  return input.replace(/\\/g, "/")
}

export function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as Record<string, unknown>).code === code
}

export function isWithin(candidate: string, root: string): boolean {
  const normalizedRoot = normalizeFsPathForComparison(path.resolve(root))
  const normalizedCandidate = normalizeFsPathForComparison(path.resolve(candidate))
  const rel = path.relative(normalizedRoot, normalizedCandidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function normalizeFsPathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}

/**
 * Fetch with an AbortController timeout.
 * Defaults to 30 seconds if no timeout is specified.
 */
export async function fetchWithTimeout(
  url: string,
  opts?: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
