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
  const resolvedRoot = safeRealpath(root)
  const resolvedCandidate = safeRealpath(candidate)
  const normalizedRoot = normalizeFsPathForComparison(resolvedRoot)
  const normalizedCandidate = normalizeFsPathForComparison(resolvedCandidate)
  const rel = path.relative(normalizedRoot, normalizedCandidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
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

/**
 * Fetch with retry and exponential backoff.
 * Retries on network errors, 429, and 5xx responses.
 * Honors Retry-After header for 429 responses.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: { timeout?: number; retries?: number; baseDelay?: number },
): Promise<Response> {
  const maxRetries = options?.retries ?? 3
  const baseDelay = options?.baseDelay ?? 500
  const timeout = options?.timeout ?? 30_000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeout)
      if (attempt < maxRetries && shouldRetry(response.status)) {
        const retryAfter = parseRetryAfter(response)
        const delay = retryAfter ?? baseDelay * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      return response
    } catch (err) {
      if (attempt >= maxRetries) throw err
      const delay = baseDelay * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error("fetchWithRetry: unreachable")
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = parseInt(header, 10)
  return isNaN(seconds) ? undefined : seconds * 1000
}
