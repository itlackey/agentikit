/**
 * Agentikit initialization logic.
 *
 * Creates the working stash directory structure, sets the AKM_STASH_DIR
 * environment variable, and ensures ripgrep is available.
 */

import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS, TYPE_DIRS } from "./common"
import { ensureRg } from "./ripgrep-install"
import { getConfigPath, saveConfig, DEFAULT_CONFIG } from "./config"

export interface InitResponse {
  stashDir: string
  created: boolean
  envSet: boolean
  configPath: string
  envHint?: string
  shellSetup?: string[]
  ripgrep?: {
    rgPath: string
    installed: boolean
    version: string
  }
}

export async function agentikitInit(): Promise<InitResponse> {
  let stashDir: string
  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (localAppData) {
      stashDir = path.join(localAppData, "agentikit")
    } else {
      const userProfile = process.env.USERPROFILE?.trim()
      if (!userProfile) {
        throw new Error("Unable to determine data directory. Set LOCALAPPDATA or USERPROFILE.")
      }
      stashDir = path.join(userProfile, "Documents", "agentikit")
    }
  } else {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim()
    if (xdgDataHome) {
      stashDir = path.join(xdgDataHome, "agentikit")
    } else {
      const home = process.env.HOME?.trim()
      if (!home) {
        throw new Error("Unable to determine data directory. Set XDG_DATA_HOME or HOME.")
      }
      stashDir = path.join(home, ".local", "share", "agentikit")
    }
  }

  let created = false
  if (!fs.existsSync(stashDir)) {
    fs.mkdirSync(stashDir, { recursive: true })
    created = true
  }

  for (const sub of Object.values(TYPE_DIRS)) {
    const subDir = path.join(stashDir, sub)
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true })
    }
  }

  const envSet = false

  // Create default config.json if it doesn't exist
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG)
  }

  process.env.AKM_STASH_DIR = stashDir

  // Ensure ripgrep is available (install to stash/bin if needed)
  let ripgrep: InitResponse["ripgrep"]
  try {
    const rgResult = ensureRg(stashDir)
    ripgrep = rgResult
  } catch {
    // Non-fatal: ripgrep is optional, search works without it
  }

  // Build hints so callers can set the env var in the current shell and profile
  let envHint: string | undefined
  let shellSetup: string[] | undefined
  if (IS_WINDOWS) {
    envHint = `set AKM_STASH_DIR=${stashDir}`
    shellSetup = [`setx AKM_STASH_DIR "${stashDir}"`]
  } else {
    envHint = `export AKM_STASH_DIR="${stashDir}"`
    shellSetup = [
      `# Add to your shell profile (~/.bashrc or ~/.zshrc):`,
      `export AKM_STASH_DIR="${stashDir}"`,
    ]
  }

  return { stashDir, created, envSet, envHint, shellSetup, configPath, ripgrep }
}
