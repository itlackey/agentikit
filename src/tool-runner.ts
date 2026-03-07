/**
 * Tool execution utilities.
 *
 * Handles building run commands and executing tool scripts for all supported
 * kinds (bash, bun, powershell, cmd).
 */

import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS, isWithin } from "./common"

// ── Types ───────────────────────────────────────────────────────────────────

/** The supported tool execution kinds. */
export type ToolKind = "bash" | "bun" | "powershell" | "cmd"

export interface ToolExecution {
  command: string
  args: string[]
  cwd?: string
}

export interface ToolInfo {
  runCmd: string
  kind: ToolKind
  install?: ToolExecution
  execute: ToolExecution
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build execution metadata for a tool file based on its extension.
 *
 * For `.ts` / `.js` files, looks up the nearest `package.json` so that
 * `bun install` can be run in the correct working directory when the
 * `AGENTIKIT_BUN_INSTALL` env flag is set.
 */
export function buildToolInfo(stashDir: string, filePath: string): ToolInfo {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === ".sh") {
    return {
      runCmd: `bash ${shellQuote(filePath)}`,
      kind: "bash",
      execute: { command: "bash", args: [filePath] },
    }
  }

  if (ext === ".ps1") {
    return {
      runCmd: `powershell -ExecutionPolicy Bypass -File ${shellQuote(filePath)}`,
      kind: "powershell",
      execute: { command: "powershell", args: ["-ExecutionPolicy", "Bypass", "-File", filePath] },
    }
  }

  if (ext === ".cmd" || ext === ".bat") {
    return {
      runCmd: `cmd /c ${shellQuote(filePath)}`,
      kind: "cmd",
      execute: { command: "cmd", args: ["/c", filePath] },
    }
  }

  if (ext !== ".ts" && ext !== ".js") {
    throw new Error(`Unsupported tool extension: ${ext}`)
  }

  const toolsRoot = path.resolve(path.join(stashDir, "tools"))
  const pkgDir = findNearestPackageDir(path.dirname(filePath), toolsRoot)
  if (!pkgDir) {
    return {
      runCmd: `bun ${shellQuote(filePath)}`,
      kind: "bun",
      execute: { command: "bun", args: [filePath] },
    }
  }
  const installFlag = process.env.AGENTIKIT_BUN_INSTALL
  const shouldInstall = installFlag === "1" || installFlag === "true" || installFlag === "yes"

  const quotedPkgDir = shellQuote(pkgDir)
  const quotedFilePath = shellQuote(filePath)
  const cdCmd = IS_WINDOWS ? `cd /d ${quotedPkgDir}` : `cd ${quotedPkgDir}`
  const chain = IS_WINDOWS ? " & " : " && "
  return {
    runCmd: shouldInstall
      ? `${cdCmd}${chain}bun install${chain}bun ${quotedFilePath}`
      : `${cdCmd}${chain}bun ${quotedFilePath}`,
    kind: "bun",
    install: shouldInstall ? { command: "bun", args: ["install"], cwd: pkgDir } : undefined,
    execute: { command: "bun", args: [filePath], cwd: pkgDir },
  }
}

/**
 * Shell-quote a path for inclusion in a human-readable `runCmd` string.
 */
export function shellQuote(input: string): string {
  if (/[\r\n\t\0]/.test(input)) {
    throw new Error("Unsupported control characters in stash path.")
  }
  if (IS_WINDOWS) {
    return `"${input.replace(/"/g, '""')}"`
  }
  const escaped = input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
  return `"${escaped}"`
}

/**
 * Walk up from `startDir` toward `toolsRoot` looking for the nearest `package.json`.
 */
export function findNearestPackageDir(startDir: string, toolsRoot: string): string | undefined {
  let current = path.resolve(startDir)
  const root = path.resolve(toolsRoot)
  while (isWithin(current, root)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current
    }
    if (current === root) return undefined
    current = path.dirname(current)
  }
  return undefined
}

