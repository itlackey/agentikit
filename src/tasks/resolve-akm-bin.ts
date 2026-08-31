// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve the absolute invocation that the OS scheduler should run.
 *
 * cron / launchd / schtasks all execute jobs with a stripped environment and
 * a minimal PATH, so the registered command must be an absolute path.
 *
 * Resolution order:
 *
 *   1. `process.execPath` alone for a Bun standalone executable.
 *   2. Absolute Node plus the public `dist/akm` package launcher — eligible
 *      when it is the active npm global install, or when this process
 *      cannot write to the directory containing it (a read-only mount, e.g.
 *      an image-baked install, gives the same "won't change out from under
 *      the scheduler" guarantee npm-global ownership does).
 *   3. Absolute runtime plus the source/build CLI entry, classified as a
 *      checkout that requires explicit `--rebind` for scheduler writes.
 *
 * Returns the argv array the scheduler should execute (e.g.
 * `["/usr/local/bin/node", "/repo/dist/cli-node.mjs"]`). The caller appends
 * subcommand args (`"task", "run", "<id>"`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../core/errors";
import { mainPath as runtimeMainPath } from "../runtime";

export interface ResolvedAkmInvocation {
  /** Argv prefix the OS scheduler should execute (one shell-safe path per element). */
  argv: string[];
  /** Source of the resolution, surfaced by `task doctor`. */
  via: "npm" | "standalone" | "checkout" | "package-local";
  kind: "npm" | "standalone" | "checkout" | "package-local";
  eligible: boolean;
}

/** True only for Bun's virtual main path inside a compiled standalone executable. */
export function isBunStandaloneMain(mainPath: string | undefined = runtimeMainPath): boolean {
  return (
    mainPath?.startsWith("/$bunfs/") === true || (mainPath !== undefined && /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(mainPath))
  );
}

export function resolveAkmInvocation(
  options: {
    env?: NodeJS.ProcessEnv;
    cliEntryUrl?: string;
    runtime?: "bun" | "node";
    execPath?: string;
    mainPath?: string;
    launcherPath?: string;
    nodePath?: string;
    resolveNpmGlobalRoot?: (nodePath: string) => string | undefined;
    isPathWritable?: (dir: string) => boolean;
  } = {},
): ResolvedAkmInvocation {
  const env = options.env ?? process.env;

  const runtime = options.runtime ?? (process.versions.bun ? "bun" : "node");
  const execPath = options.execPath ?? process.execPath;
  const mainPath = options.mainPath ?? runtimeMainPath;
  const isStandaloneMain = isBunStandaloneMain(mainPath);
  if (runtime === "bun" && isStandaloneMain && execPath) {
    return { argv: [absoluteInvocationPath(execPath)], via: "standalone", kind: "standalone", eligible: true };
  }

  const launcherPath = options.launcherPath ?? env.AKM_LAUNCHER_PATH?.trim();
  const nodePath = options.nodePath ?? env.AKM_LAUNCHER_NODE?.trim() ?? (runtime === "node" ? execPath : undefined);
  if (launcherPath && nodePath && isPublicPackageLauncher(launcherPath)) {
    const checkout = isCheckoutLauncher(launcherPath);
    let npmGlobalRoot: string | undefined;
    if (!checkout) {
      try {
        npmGlobalRoot = (options.resolveNpmGlobalRoot ?? ((node) => resolveNpmGlobalRoot(node, env)))(nodePath);
      } catch {
        // An unprovable package installation is intentionally ineligible.
      }
    }
    const npmGlobal = !checkout && packageBelongsToNpmGlobalRoot(launcherPath, npmGlobalRoot);
    const readOnlyInstall =
      !checkout && !npmGlobal && !(options.isPathWritable ?? isPathWritable)(path.dirname(launcherPath));
    const kind = checkout ? "checkout" : npmGlobal ? "npm" : "package-local";
    return {
      argv: [absoluteInvocationPath(nodePath), absoluteInvocationPath(launcherPath)],
      via: kind,
      kind,
      eligible: npmGlobal || readOnlyInstall,
    };
  }

  const checkoutEntry = resolveCheckoutEntry(options.cliEntryUrl ?? import.meta.url, runtime, mainPath);
  if (checkoutEntry && execPath) {
    return {
      argv: [absoluteInvocationPath(execPath), absoluteInvocationPath(checkoutEntry)],
      via: "checkout",
      kind: "checkout",
      eligible: false,
    };
  }

  throw new ConfigError(
    "Cannot resolve absolute path to the akm binary for scheduler registration.",
    "INVALID_CONFIG_FILE",
    "Run the npm-global launcher or a standalone akm executable.",
  );
}

function resolveCheckoutEntry(
  moduleUrl: string,
  runtime: "bun" | "node",
  mainPath: string | undefined,
): string | undefined {
  try {
    const modulePath = fileURLToPath(moduleUrl);
    const parent = path.dirname(path.dirname(modulePath));
    if (runtime === "node") {
      const wrapper = path.join(parent, "cli-node.mjs");
      if (fs.existsSync(wrapper)) return wrapper;
      if (mainPath) {
        if (path.basename(mainPath) === "cli-node.mjs" && fs.existsSync(mainPath)) return mainPath;
        const siblingWrapper = path.join(path.dirname(mainPath), "cli-node.mjs");
        if (fs.existsSync(siblingWrapper)) return siblingWrapper;
      }
      return undefined;
    }
    const extension = path.extname(modulePath);
    const candidate = path.join(parent, `cli${extension}`);
    if (fs.existsSync(candidate)) return candidate;
    const alternate = path.join(parent, extension === ".ts" ? "cli.js" : "cli.ts");
    return fs.existsSync(alternate) ? alternate : undefined;
  } catch {
    return runtime === "bun" ? mainPath : undefined;
  }
}

function absoluteInvocationPath(value: string): string {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ? value : path.resolve(value);
}

function isPublicPackageLauncher(file: string): boolean {
  return (
    path.basename(file).toLowerCase() === "akm" &&
    path.basename(path.dirname(file)).toLowerCase() === "dist" &&
    fs.existsSync(file)
  );
}

function isCheckoutLauncher(file: string): boolean {
  let launcher = path.resolve(file);
  try {
    launcher = fs.realpathSync(file);
  } catch {
    // The caller gets a missing-path diagnostic from doctor.
  }
  const packageRoot = path.dirname(path.dirname(launcher));
  return fs.existsSync(path.join(packageRoot, ".git"));
}

/** Whether this process can write to `dir` — false also covers a read-only mount. */
function isPathWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function packageBelongsToNpmGlobalRoot(launcherPath: string, npmGlobalRoot: string | undefined): boolean {
  if (!npmGlobalRoot) return false;
  try {
    const packageRoot = path.dirname(path.dirname(fs.realpathSync(launcherPath)));
    const globalRoot = fs.realpathSync(npmGlobalRoot);
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown };
    return metadata.name === "akm-cli" && samePath(path.dirname(packageRoot), globalRoot);
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function resolveNpmGlobalRoot(nodePath: string, env: NodeJS.ProcessEnv): string | undefined {
  const npmCli = resolveAssociatedNpmCli(nodePath);
  if (!npmCli) return undefined;
  const result = spawnSync(absoluteInvocationPath(nodePath), [npmCli, "root", "--global"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0] || !path.isAbsolute(lines[0])) return undefined;
  return lines[0];
}

function resolveAssociatedNpmCli(nodePath: string): string | undefined {
  const nodeDirs = new Set([path.dirname(absoluteInvocationPath(nodePath))]);
  try {
    nodeDirs.add(path.dirname(fs.realpathSync(nodePath)));
  } catch {
    // The scheduler binding will separately report a missing Node path.
  }

  for (const binDir of nodeDirs) {
    const candidates = [
      ...(process.platform === "win32" ? [] : [path.join(binDir, "npm")]),
      path.join(binDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(path.dirname(binDir), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      try {
        const resolved = fs.realpathSync(candidate);
        if (fs.statSync(resolved).isFile()) return resolved;
      } catch {
        // Try the next layout associated with this Node installation.
      }
    }
  }
  return undefined;
}
