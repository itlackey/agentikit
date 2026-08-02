// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import * as p from "../../cli/clack";
import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output } from "../../cli/shared";
import { decideDangerousKeyInstall } from "../../core/activation-policy";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import { akmRemove } from "./installed-stashes";
import { akmAdd } from "./source-add";
import { addStash } from "./source-manage";

// ── Shared website-options helper ──────────

export function buildWebsiteOptions(args: Record<string, unknown>): { maxPages?: number; maxDepth?: number } {
  // getStringArg maps absent/blank to undefined; parsePositiveIntFlag maps
  // undefined to undefined — so an unsupplied flag simply omits the key.
  const maxPages = parsePositiveIntFlag(getStringArg(args, "max-pages"), "--max-pages");
  const maxDepth = parsePositiveIntFlag(getStringArg(args, "max-depth"), "--max-depth");
  return { ...(maxPages !== undefined ? { maxPages } : {}), ...(maxDepth !== undefined ? { maxDepth } : {}) };
}

// ── HTTP safety check ─────────────────────────────────────────────────────────

export function shouldWarnOnPlainHttp(ref: string): boolean {
  if (!ref.startsWith("http://")) return false;
  try {
    const hostname = new URL(ref).hostname.toLowerCase();
    return (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "0.0.0.0" &&
      hostname !== "::1" &&
      hostname !== "[::1]" &&
      !hostname.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

// ── Dangerous env-key install audit ───────────────────────────────────────────
//
// C3 (code-health round 2): the previous implementation wrapped the
// `process.exit(1)` abort in a broad try/catch and distinguished an intended
// exit from a real audit bug by string-matching `err.message === "process.exit
// called"` — a TEST mock sentinel. In production `process.exit` never throws, so
// that branch was test-only; worse, if the sentinel string ever drifted the
// DANGEROUS_ENV_KEY abort would silently become fail-OPEN and an insecure
// stash would install, while the catch swallowed any genuine audit bug.
//
// This helper replaces that magic-string control flow with a typed decision.
// It performs the scan, the interactive confirmation, the rollback and the
// operator-facing error output internally, then RETURNS whether the install
// must be blocked. The caller decides `process.exit` OUTSIDE any catch, so a
// real audit bug can no longer be swallowed and the abort can no longer be
// silently bypassed. Only the best-effort *scan* is allowed to fail soft (no
// findings collected → nothing to block); once dangerous keys are found the
// gate is deterministic and fail-CLOSED.

export type DangerousKeyAuditDecision = { blocked: true; exitCode: number } | { blocked: false };

interface DangerousKeyFinding {
  envRef: string;
  keyName: string;
  relPath: string;
}

/**
 * Recursively enumerate every real env FILE under `rootDir` (a stash's
 * `env/` directory). "Real env file" is the SAME test used everywhere else
 * in akm decides what `akm env run` / `akm env list` / the indexer will
 * actually load as environment variables — `fileName === ".env" ||
 * fileName.endsWith(".env")` — see `src/indexer/walk/matchers.ts` and
 * `listEnvsRecursive` in `src/commands/env/env-cli.ts`. Reusing that exact
 * rule here (rather than inventing a second, possibly-divergent one) is what
 * closes the nested-directory bypass: `env/nested/inner.env` IS loaded by
 * `akm env run` today via that same recursive walk, so it must be scanned
 * too (previously only a flat, non-recursive `env/*.env` listing was
 * scanned).
 *
 * Deliberately excludes files that do NOT end in `.env` (e.g.
 * `env/notes.txt`). Such a file is never sourced as environment variables by
 * any akm codepath, so a dangerous key sitting in its contents cannot hijack
 * process execution via `akm env run` — there is no live attack through this
 * gate for it. Residual gap: this scanner does not protect against an
 * operator later renaming/copying that file to a `*.env` name, or feeding it
 * into `akm env run` through some other mechanism outside akm; closing that
 * would mean content-sniffing every byte of every file in the stash (README,
 * lockfiles, binaries, …) for a vector that requires a subsequent human
 * action to become live, which is a materially different and much more
 * expensive check than "is this a file `akm` will actually source".
 */
function collectEnvFilePathsRecursive(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
      results.push(full);
    }
  };
  walk(rootDir);
  return results;
}

/** Scan every real env file (recursively, see {@link collectEnvFilePathsRecursive}) in the freshly-installed stash for dangerous env keys. */
function collectDangerousKeyFindings(
  installedStashRoot: string,
  checkEnvForDangerousKeys: (
    envPath: string,
    relPath: string,
    envRef: string,
  ) => Array<{ detail: string; file: string }>,
): DangerousKeyFinding[] {
  const allFindings: DangerousKeyFinding[] = [];
  const subdir = "env";
  const prefix = "env";
  const dir = path.join(installedStashRoot, subdir);
  if (!fs.existsSync(dir)) return allFindings;
  for (const envPath of collectEnvFilePathsRecursive(dir)) {
    const relToEnvDir = path.relative(dir, envPath);
    // Only the LAST path segment carries the ".env" suffix / dotfile-default
    // naming rule; intermediate directory segments pass through unchanged.
    // e.g. "nested/inner.env" -> "nested/inner", "nested/.env" ->
    // "nested/default" (not "nested/", which is what naively stripping the
    // suffix from the whole relative path would produce).
    const segments = relToEnvDir.split(path.sep);
    const lastSegment = segments[segments.length - 1] ?? "";
    const lastSegmentBase = lastSegment.endsWith(".env") ? lastSegment.slice(0, -".env".length) : lastSegment;
    const refSegments = [...segments.slice(0, -1), lastSegmentBase === "" ? "default" : lastSegmentBase];
    const envRef = `${prefix}/${refSegments.join("/")}`;
    const relPath = path.join(subdir, relToEnvDir);
    const findings = checkEnvForDangerousKeys(envPath, relPath, envRef);
    for (const finding of findings) {
      // Extract the key name from the detail string for the summary line.
      const keyMatch = finding.detail.match(/Env key `([^`]+)`/);
      const keyName = keyMatch ? keyMatch[1]! : finding.file;
      allFindings.push({ envRef, keyName, relPath });
    }
  }
  return allFindings;
}

/**
 * Audit a freshly-installed stash for dangerous env keys and decide whether the
 * install must be blocked. Returns a typed decision instead of calling
 * `process.exit`, so the abort cannot be lost to a swallowed exception. See the
 * block comment above for the security rationale.
 */
export async function auditInstalledStashForDangerousKeys(opts: {
  installedStashRoot: string;
  ref: string;
  allowDangerousKeys: boolean;
  rollbackTarget: string;
  isTTY: boolean;
}): Promise<DangerousKeyAuditDecision> {
  const { installedStashRoot, ref, allowDangerousKeys, rollbackTarget, isTTY } = opts;

  // Best-effort scan: if collecting findings itself throws (corrupt env file,
  // fs error) there is nothing concrete to block on, so fail soft. Crucially,
  // this soft path runs BEFORE any findings exist — it can never re-open an
  // already-detected dangerous install.
  let allFindings: DangerousKeyFinding[];
  try {
    const { checkEnvForDangerousKeys } = await import("../lint/env-key-rules.js");
    allFindings = collectDangerousKeyFindings(installedStashRoot, checkEnvForDangerousKeys);
  } catch {
    return { blocked: false };
  }

  // The workspace activation policy fixes the baseline stance; the interactive
  // confirm / rollback below is layered on top of the `"gate"` stance only.
  const stance = decideDangerousKeyInstall({
    findingsPresent: allFindings.length > 0,
    allowInsecure: allowDangerousKeys,
  });
  if (stance === "allow") return { blocked: false };

  if (stance === "warn-allow") {
    // Operator has explicitly accepted the risk — warn and continue.
    for (const f of allFindings) {
      warn(
        `[dangerous-env-key] ${f.relPath}: key \`${f.keyName}\` in ${f.envRef} can hijack process execution via \`akm env run\`. Proceeding because --allow-insecure was set.`,
      );
    }
    return { blocked: false };
  }

  // Helper: roll the install back before aborting. Rollback is best-effort; a
  // failed rollback never UN-blocks the install — we still abort, just with a
  // warning telling the operator to remove the stash manually.
  async function rollback(): Promise<string | undefined> {
    try {
      await akmRemove({ target: rollbackTarget });
      return undefined;
    } catch (_rollbackErr) {
      return (
        `Rollback failed — stash may still be installed at ${installedStashRoot}. ` +
        `Remove it manually with: akm bundle remove ${rollbackTarget}`
      );
    }
  }

  if (isTTY) {
    // Interactive path: show findings and ask the user to confirm.
    // Guard on stdin (not stdout) because p.confirm() reads from stdin;
    // stdout may be a TTY while stdin is piped, which would cause a hang.
    const stashLabel = ref;
    const groupedByEnv = new Map<string, string[]>();
    for (const f of allFindings) {
      const existing = groupedByEnv.get(f.envRef) ?? [];
      existing.push(f.keyName);
      groupedByEnv.set(f.envRef, existing);
    }
    for (const [envRef, keys] of groupedByEnv) {
      warn(`[warn] Env "${envRef}" in stash "${stashLabel}" contains potentially dangerous keys:`);
      for (const key of keys) {
        warn(`  - ${key}: can hijack process execution via \`akm env run\``);
      }
    }
    const confirmed = await p.confirm({
      message: "Install anyway?",
      initialValue: false,
    });
    if (p.isCancel(confirmed) || confirmed !== true) {
      const rollbackWarning = await rollback();
      console.error(
        JSON.stringify(
          {
            ok: false,
            error:
              "Install aborted: stash contains dangerous env keys. Remove the keys or re-run with --allow-insecure to bypass.",
            code: "DANGEROUS_ENV_KEY",
            ...(rollbackWarning ? { rollbackWarning } : {}),
          },
          null,
          2,
        ),
      );
      return { blocked: true, exitCode: 1 };
    }
    // Operator confirmed at the prompt — allow the install to proceed.
    return { blocked: false };
  }

  // Non-interactive path without bypass flag: fail hard.
  const rollbackWarning = await rollback();
  const keyList = allFindings.map((f) => `  - ${f.keyName} (${f.envRef})`).join("\n");
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Install blocked: stash "${ref}" contains dangerous env keys that can hijack process execution via \`akm env run\`:\n${keyList}\nRe-run with --allow-insecure to bypass this check after reviewing the env file.`,
        code: "DANGEROUS_ENV_KEY",
        ...(rollbackWarning ? { rollbackWarning } : {}),
      },
      null,
      2,
    ),
  );
  return { blocked: true, exitCode: 1 };
}

// ── Command definition ────────────────────────────────────────────────────────

export const addCommand = defineJsonCommand({
  meta: {
    name: "add",
    description: "Add a source (local directory, website, npm package, GitHub repo, git URL, or remote provider)",
  },
  args: {
    ref: {
      type: "positional",
      description: "Path, URL, or registry ref (website URL, npm package, owner/repo, git URL, or local directory)",
      required: true,
    },
    provider: { type: "string", description: "Provider type (e.g. website, npm). Required for URL sources." },
    options: { type: "string", description: 'Provider options as JSON (e.g. \'{"apiKey":"key"}\').' },
    name: { type: "string", description: "Human-friendly name for the source" },
    writable: {
      type: "boolean",
      description: "Mark a git bundle as writable so changes can be pushed back",
      default: false,
    },
    "max-pages": { type: "string", description: "Maximum pages to crawl for website sources (default: 50)" },
    "max-depth": { type: "string", description: "Maximum crawl depth for website sources (default: 3)" },
    "allow-insecure": {
      type: "boolean",
      description:
        "Allow a plain HTTP source URL and skip confirmation for dangerous env keys (e.g. LD_PRELOAD, PATH). Use only after explicitly reviewing the bundle.",
      default: false,
    },
  },
  async run({ args }) {
    const ref = args.ref.trim();
    const allowInsecure = args["allow-insecure"];
    const allowDangerousKeys = allowInsecure;

    // --provider → declarative bundle source (URL for git/website; bare
    // package spec for npm — R-013). Config-only write; content is not
    // synced until a later `akm update`.
    if (args.provider) {
      if (shouldWarnOnPlainHttp(ref)) {
        if (!allowInsecure) {
          throw new UsageError(
            "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
              "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
            "INVALID_FLAG_VALUE",
            "Re-run with `--allow-insecure` only after confirming the URL is trusted.",
          );
        }
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious payload.",
        );
      }
      let parsedOptions: Record<string, unknown> | undefined;
      if (args.options) {
        try {
          const parsed = JSON.parse(args.options);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new UsageError("--options must be a JSON object");
          }
          parsedOptions = parsed;
        } catch (err) {
          if (err instanceof UsageError) throw err;
          throw new UsageError("--options must be valid JSON");
        }
      }
      const result = addStash({
        target: ref,
        name: args.name,
        providerType: args.provider,
        options: parsedOptions,
        writable: args.writable,
      });
      appendEvent({
        eventType: "add",
        metadata: { target: ref, provider: args.provider, name: args.name ?? null, writable: args.writable === true },
      });
      output("add", result);
      return;
    }

    if (shouldWarnOnPlainHttp(ref)) {
      if (!allowInsecure) {
        throw new UsageError(
          "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
            "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
          "INVALID_FLAG_VALUE",
          "Re-run with `--allow-insecure` only after confirming the URL is trusted.",
        );
      }
      warn(
        "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious payload.",
      );
    }
    const websiteOptions = buildWebsiteOptions(args);

    const result = await akmAdd({
      ref,
      name: args.name,
      options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
      writable: args.writable,
    });
    appendEvent({
      eventType: "add",
      metadata: {
        target: ref,
        name: args.name ?? null,
        writable: args.writable === true,
      },
    });

    // ── Post-install env key audit ──────────────────────────────────────────
    // Resolve the stash root from the install result and scan any env files
    // for dangerous env var keys.  When findings are present the install is
    // gated: TTY → interactive confirmation prompt; non-TTY without
    // --allow-insecure → hard failure (exit 1).  Pass
    // --allow-insecure to skip the prompt non-interactively.
    const installedStashRoot =
      result.installed?.stashRoot ??
      (result.sourceAdded && "stashRoot" in result.sourceAdded ? result.sourceAdded.stashRoot : undefined);
    if (installedStashRoot) {
      // Use the canonical installed id (most reliably resolved by akmRemove) rather
      // than the raw user-supplied ref which may not match after URL normalisation.
      const rollbackTarget = result.installed?.id ?? result.sourceAdded?.stashRoot ?? ref;
      // The audit RETURNS its decision; we decide the exit outcome here,
      // OUTSIDE any catch, so the abort cannot be lost to a swallowed
      // exception (C3). F4: `process.exitCode = …; return;` instead of
      // `process.exit(...)` — the DANGEROUS_ENV_KEY error envelope has
      // already been written to stderr by the audit itself (or is about to
      // be), so an explicit `return` here (skipping the success `output("add",
      // …)` below) is load-bearing, not merely cosmetic: it is what stops a
      // blocked install from ALSO printing a success envelope.
      const decision = await auditInstalledStashForDangerousKeys({
        installedStashRoot,
        ref,
        allowDangerousKeys,
        rollbackTarget,
        isTTY: process.stdin.isTTY === true,
      });
      if (decision.blocked) {
        process.exitCode = decision.exitCode;
        return;
      }
    }

    output("add", result);
  },
});
