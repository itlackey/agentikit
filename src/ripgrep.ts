import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// ── ripgrep Resolution ──────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32"
const RG_BINARY = IS_WINDOWS ? "rg.exe" : "rg"

/**
 * Resolve the path to a usable ripgrep binary.
 * Checks in order:
 *   1. stashDir/bin/rg
 *   2. system PATH (rg)
 * Returns null if ripgrep is not available.
 */
export function resolveRg(stashDir?: string): string | null {
  // Check stash bin directory first
  if (stashDir) {
    const stashRg = path.join(stashDir, "bin", RG_BINARY)
    if (fs.existsSync(stashRg)) {
      try {
        fs.accessSync(stashRg, fs.constants.X_OK)
        return stashRg
      } catch {
        // Not executable — skip
      }
    }
  }

  // Check system PATH
  const which = IS_WINDOWS ? "where" : "which"
  const result = spawnSync(which, ["rg"], { encoding: "utf8", timeout: 5_000 })
  if (result.status === 0 && result.stdout?.trim()) {
    return result.stdout.trim().split(/\r?\n/)[0]
  }

  return null
}

/**
 * Check if ripgrep is available (either in stash/bin or system PATH).
 */
export function isRgAvailable(stashDir?: string): boolean {
  return resolveRg(stashDir) !== null
}

// ── ripgrep Candidate Filtering ─────────────────────────────────────────────

export interface RgCandidateResult {
  matchedFiles: string[]
  usedRg: boolean
}

/**
 * Use ripgrep to find .stash.json files that match query tokens.
 * Returns paths to matching .stash.json files.
 *
 * If ripgrep is not available or the query is empty, returns null
 * to signal that the caller should skip pre-filtering.
 */
export function rgFilterCandidates(
  query: string,
  searchDir: string,
  stashDir?: string,
): RgCandidateResult | null {
  if (!query.trim()) return null

  const rgPath = resolveRg(stashDir)
  if (!rgPath) return null

  // Tokenize the query into an OR pattern for ripgrep
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (tokens.length === 0) return null

  const pattern = tokens.join("|")

  const result = spawnSync(rgPath, [
    "-i",                        // case insensitive
    "-l",                        // files-with-matches only
    "--glob", ".stash.json",     // only search .stash.json files
    pattern,
    searchDir,
  ], {
    encoding: "utf8",
    timeout: 10_000,
  })

  if (result.status !== 0 && result.status !== 1) {
    // rg exit code 1 = no matches (normal), anything else = error
    return null
  }

  const files = (result.stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((f) => f.length > 0)

  return { matchedFiles: files, usedRg: true }
}

// ── ripgrep Installation ────────────────────────────────────────────────────

/**
 * Platform and architecture detection for ripgrep binary downloads.
 */
function getRgPlatformTarget(): { platform: string; arch: string; ext: string } | null {
  const platform = process.platform
  const arch = process.arch

  if (platform === "linux" && arch === "x64") {
    return { platform: "x86_64-unknown-linux-musl", arch: "x64", ext: ".tar.gz" }
  }
  if (platform === "linux" && arch === "arm64") {
    return { platform: "aarch64-unknown-linux-gnu", arch: "arm64", ext: ".tar.gz" }
  }
  if (platform === "darwin" && arch === "x64") {
    return { platform: "x86_64-apple-darwin", arch: "x64", ext: ".tar.gz" }
  }
  if (platform === "darwin" && arch === "arm64") {
    return { platform: "aarch64-apple-darwin", arch: "arm64", ext: ".tar.gz" }
  }
  if (platform === "win32" && arch === "x64") {
    return { platform: "x86_64-pc-windows-msvc", arch: "x64", ext: ".zip" }
  }

  return null
}

const RG_VERSION = "14.1.1"

export interface EnsureRgResult {
  rgPath: string
  installed: boolean
  version: string
}

/**
 * Ensure ripgrep is available. If not found on PATH or in stash/bin,
 * download and install it to stash/bin.
 *
 * Returns the path to the ripgrep binary and whether it was newly installed.
 */
export function ensureRg(stashDir: string): EnsureRgResult {
  // Already available?
  const existing = resolveRg(stashDir)
  if (existing) {
    return { rgPath: existing, installed: false, version: getRgVersion(existing) }
  }

  // Determine platform
  const target = getRgPlatformTarget()
  if (!target) {
    throw new Error(
      `Unsupported platform for ripgrep auto-install: ${process.platform}/${process.arch}. ` +
      `Install ripgrep manually: https://github.com/BurntSushi/ripgrep#installation`
    )
  }

  const binDir = path.join(stashDir, "bin")
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true })
  }

  const archiveName = `ripgrep-${RG_VERSION}-${target.platform}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}${target.ext}`
  const destBinary = path.join(binDir, RG_BINARY)

  if (target.ext === ".tar.gz") {
    downloadAndExtractTarGz(url, archiveName, destBinary)
  } else {
    downloadAndExtractZip(url, archiveName, destBinary)
  }

  // Make executable
  if (!IS_WINDOWS) {
    fs.chmodSync(destBinary, 0o755)
  }

  return { rgPath: destBinary, installed: true, version: RG_VERSION }
}

function downloadAndExtractTarGz(url: string, archiveName: string, destBinary: string): void {
  // Use curl to download and tar to extract in one pipeline
  const result = spawnSync("sh", [
    "-c",
    `curl -fsSL "${url}" | tar xz --strip-components=1 -C "${path.dirname(destBinary)}" "${archiveName}/rg"`,
  ], {
    encoding: "utf8",
    timeout: 60_000,
  })

  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.error?.message || "unknown error"
    throw new Error(`Failed to download ripgrep from ${url}: ${err}`)
  }

  if (!fs.existsSync(destBinary)) {
    throw new Error(`ripgrep binary not found at ${destBinary} after extraction`)
  }
}

function downloadAndExtractZip(url: string, archiveName: string, destBinary: string): void {
  const tmpZip = path.join(path.dirname(destBinary), "rg-download.zip")
  try {
    // Download
    const dlResult = spawnSync("curl", ["-fsSL", "-o", tmpZip, url], {
      encoding: "utf8",
      timeout: 60_000,
    })
    if (dlResult.status !== 0) {
      throw new Error(dlResult.stderr?.trim() || "download failed")
    }

    // Extract just the rg.exe
    const extractResult = spawnSync("powershell", [
      "-Command",
      `Expand-Archive -Path "${tmpZip}" -DestinationPath "${path.dirname(destBinary)}" -Force; ` +
      `Move-Item -Force "${path.join(path.dirname(destBinary), archiveName, "rg.exe")}" "${destBinary}"`,
    ], {
      encoding: "utf8",
      timeout: 60_000,
    })
    if (extractResult.status !== 0) {
      throw new Error(extractResult.stderr?.trim() || "extraction failed")
    }
  } finally {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip)
  }
}

function getRgVersion(rgPath: string): string {
  const result = spawnSync(rgPath, ["--version"], { encoding: "utf8", timeout: 5_000 })
  if (result.status === 0 && result.stdout) {
    const match = result.stdout.match(/ripgrep\s+([\d.]+)/)
    return match ? match[1] : "unknown"
  }
  return "unknown"
}
