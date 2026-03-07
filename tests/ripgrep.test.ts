import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveRg, isRgAvailable, rgFilterCandidates } from "../src/ripgrep"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-rg-"))
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

// ── resolveRg ───────────────────────────────────────────────────────────────

test("resolveRg finds system ripgrep on PATH", () => {
  const rg = resolveRg()
  // rg is available in this test environment
  expect(rg).not.toBeNull()
  expect(rg!).toContain("rg")
})

test("resolveRg prefers stash/bin over system PATH", () => {
  const stashDir = tmpDir()
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })

  // Create a fake rg binary
  const fakeRg = path.join(binDir, "rg")
  fs.writeFileSync(fakeRg, "#!/bin/sh\necho fake rg\n")
  fs.chmodSync(fakeRg, 0o755)

  const rg = resolveRg(stashDir)
  expect(rg).toBe(fakeRg)
})

test("resolveRg skips non-executable files in stash/bin", () => {
  const stashDir = tmpDir()
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })

  // Create a non-executable rg file
  const fakeRg = path.join(binDir, "rg")
  fs.writeFileSync(fakeRg, "not executable")
  fs.chmodSync(fakeRg, 0o644)

  const rg = resolveRg(stashDir)
  // Should fall through to system PATH
  expect(rg).not.toBe(fakeRg)
})

// ── isRgAvailable ───────────────────────────────────────────────────────────

test("isRgAvailable returns true when rg is on PATH", () => {
  expect(isRgAvailable()).toBe(true)
})

// ── rgFilterCandidates ──────────────────────────────────────────────────────

test("rgFilterCandidates returns null for empty query", () => {
  const dir = tmpDir()
  expect(rgFilterCandidates("", dir)).toBeNull()
  expect(rgFilterCandidates("   ", dir)).toBeNull()
})

test("rgFilterCandidates finds matching .stash.json files", () => {
  const dir = tmpDir()

  // Create .stash.json files with different content
  writeFile(
    path.join(dir, "tools", "docker", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "docker-build", type: "tool", description: "build docker images", tags: ["docker", "build"] }],
    }),
  )
  writeFile(
    path.join(dir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "git-diff", type: "tool", description: "summarize git diff", tags: ["git", "diff"] }],
    }),
  )

  const result = rgFilterCandidates("docker build", dir)
  expect(result).not.toBeNull()
  expect(result!.usedRg).toBe(true)
  expect(result!.matchedFiles.length).toBeGreaterThanOrEqual(1)
  expect(result!.matchedFiles.some((f) => f.includes("docker"))).toBe(true)
})

test("rgFilterCandidates returns empty list for non-matching query", () => {
  const dir = tmpDir()
  writeFile(
    path.join(dir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "git-diff", type: "tool", description: "summarize git diff" }],
    }),
  )

  const result = rgFilterCandidates("xyznonexistent", dir)
  expect(result).not.toBeNull()
  expect(result!.matchedFiles).toHaveLength(0)
})

test("rgFilterCandidates only searches .stash.json files", () => {
  const dir = tmpDir()

  // A regular .ts file with "docker" — should NOT be matched
  writeFile(path.join(dir, "tools", "docker", "build.ts"), 'console.log("docker")\n')
  // No .stash.json in this directory

  const result = rgFilterCandidates("docker", dir)
  expect(result).not.toBeNull()
  // Should not match the .ts file
  expect(result!.matchedFiles.every((f) => f.endsWith(".stash.json"))).toBe(true)
})

// ── Integration: ripgrep + semantic search ──────────────────────────────────

test("search pipeline uses ripgrep pre-filtering when index exists", () => {
  const stashDir = tmpDir()
  for (const sub of ["tools", "skills", "commands", "agents"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
  }

  // Create tools with .stash.json metadata
  writeFile(
    path.join(stashDir, "tools", "docker", "build.sh"),
    "#!/bin/bash\necho build\n",
  )
  writeFile(
    path.join(stashDir, "tools", "docker", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "docker-build", type: "tool", description: "build docker images", tags: ["docker", "container"], entry: "build.sh" }],
    }),
  )
  writeFile(
    path.join(stashDir, "tools", "git", "diff.sh"),
    "#!/bin/bash\necho diff\n",
  )
  writeFile(
    path.join(stashDir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "git-diff", type: "tool", description: "summarize git changes", tags: ["git", "diff"], entry: "diff.sh" }],
    }),
  )

  // Isolation: ensure index cache is written to a temp directory
  const oldXdgCacheHome = process.env.XDG_CACHE_HOME
  const tempCacheDir = tmpDir()
  process.env.XDG_CACHE_HOME = tempCacheDir

  try {
    // Build index
    process.env.AGENTIKIT_STASH_DIR = stashDir
    const { agentikitIndex } = require("../src/indexer")
    agentikitIndex({ stashDir })

    // Search — ripgrep should filter candidates before TF-IDF ranks them
    const { agentikitSearch } = require("../src/stash")
    const result = agentikitSearch({ query: "docker", type: "any" })

    expect(result.hits.length).toBeGreaterThan(0)
    // Docker-related result should be ranked first
    expect(result.hits[0].name).toContain("docker")
  } finally {
    process.env.XDG_CACHE_HOME = oldXdgCacheHome
  }
})
