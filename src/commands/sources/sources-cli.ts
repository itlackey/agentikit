// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source-management CLI commands — `akm list/remove/update/upgrade/sync/clone`.
 *
 * Extracted verbatim from src/cli.ts (WS6). Each `main.subCommands.<key>`
 * registration line stays byte-identical; the args/output shape of every
 * subcommand is unchanged. The `--kind` filter helper (`parseKindFilter` +
 * `VALID_SOURCE_KINDS`) and the `runSyncBody` git-commit/push body are used ONLY by
 * this cluster, so they move with it.
 *
 * Leaf handlers whose body is a plain `runWithJsonErrors(async () => { … })`
 * are migrated to `defineJsonCommand`, which emits the same JSON envelope
 * (stdout/stderr/exit-code) as the inline form. `sync` keeps `defineCommand`
 * because its `run` delegates to `runSyncBody` (which owns the
 * `runWithJsonErrors` wrapper) rather than wrapping inline.
 *
 * 0.9.0 CLI overhaul (S3): top-level `history` was dropped; its
 * `--accept-rate-by-source` metric was folded into `akm health --report`
 * (src/commands/health/accept-rate.ts).
 */
import { defineCommand } from "citty";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveWritableOverride, saveGitStash } from "../../sources/providers/git";
import type { SourceKind } from "../../sources/types";
import { pkgVersion } from "../../version";
import { akmListSources, akmRemove, akmUpdate } from "./installed-stashes";
import { checkForUpdate, performUpgrade } from "./self-update";
import { akmClone } from "./source-clone";

const VALID_SOURCE_KINDS = new Set<SourceKind>(["filesystem", "git", "npm", "website"]);

function parseKindFilter(raw: string | undefined): SourceKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((s) => s.trim()) as SourceKind[];
  for (const k of kinds) {
    if (!VALID_SOURCE_KINDS.has(k)) {
      throw new UsageError(`Invalid --kind value: "${k}". Expected one of: filesystem, git, npm, website`);
    }
  }
  return kinds;
}

export const listCommand = defineJsonCommand({
  meta: { name: "list", description: "List configured bundles and their resolved source state" },
  args: {
    kind: {
      type: "string",
      description: "Filter by source provider (filesystem, git, npm, website). Comma-separated.",
    },
  },
  async run({ args }) {
    const kind = parseKindFilter(args.kind);
    const result = await akmListSources({ kind });
    output("list", result);
  },
});

export const removeCommand = defineJsonCommand({
  meta: { name: "remove", description: "Remove a source by id, ref, path, URL, or name" },
  args: {
    target: { type: "positional", description: "Source to remove (id, ref, path, URL, or name)", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(`Remove source "${args.target}"? This cannot be undone.`, {
      yes: args.yes === true,
    });
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      return;
    }
    const result = await akmRemove({ target: args.target });
    appendEvent({
      eventType: "remove",
      metadata: {
        target: args.target,
        ref: typeof result.removed?.ref === "string" ? result.removed.ref : null,
        id: typeof result.removed?.id === "string" ? result.removed.id : null,
      },
    });
    output("remove", result);
  },
});

export const updateCommand = defineJsonCommand({
  meta: { name: "update", description: "Update one or all managed sources" },
  args: {
    target: { type: "positional", description: "Source to update (id or ref)", required: false },
    all: { type: "boolean", description: "Update all installed entries", default: false },
    force: { type: "boolean", description: "Force fresh download even if version is unchanged", default: false },
    // F1/R-058: gates ONLY the rare branch where the resolved content
    // directory moves and the previous `localRoot` is deleted — a normal
    // refresh (the overwhelming majority of updates) deletes nothing and
    // never consults this flag. Mirrors `remove`'s `-y/--yes`.
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Skip the confirmation prompt when an update needs to delete a previous install directory (because the resolved content location moved). No effect on a normal refresh, which deletes nothing.",
      default: false,
    },
  },
  async run({ args }) {
    const result = await akmUpdate({ target: args.target, all: args.all, force: args.force, yes: args.yes });
    appendEvent({
      eventType: "update",
      metadata: {
        target: args.target ?? null,
        all: args.all === true,
        force: args.force === true,
        processed: Array.isArray((result as { processed?: unknown[] }).processed)
          ? (result as { processed: unknown[] }).processed.length
          : 0,
      },
    });
    output("update", result);
  },
});

export const upgradeCommand = defineJsonCommand({
  meta: { name: "upgrade", description: "Upgrade akm to the latest release" },
  args: {
    check: { type: "boolean", description: "Check for updates without installing", default: false },
    force: { type: "boolean", description: "Force upgrade even if on latest", default: false },
    "skip-post-upgrade": {
      type: "boolean",
      description: "Skip the post-upgrade index rebuild (migration preflight and apply still run)",
      default: false,
    },
    "migration-config": {
      type: "string",
      description: "For 0.9+ upgrades, pass an operator-prepared config only to the new binary's migration apply",
    },
  },
  async run({ args }) {
    const check = await checkForUpdate(pkgVersion);
    if (args.check) {
      output("upgrade", check);
      return;
    }
    const skipPostUpgrade = args["skip-post-upgrade"];
    const migrationConfig = args["migration-config"];
    const result = await performUpgrade(check, { force: args.force, skipPostUpgrade, migrationConfig });
    output("upgrade", result);
  },
});

// `sync` body, standalone so the git-commit/push logic stays in one place.
async function runSyncBody(args: { name?: string; message?: string; push?: boolean }): Promise<void> {
  await runWithJsonErrors(async () => {
    // The optional `name` positional is safe to trust: the global output flags
    // are declared on the command (GLOBAL_OUTPUT_ARGS), so `akm sync --format
    // json` parses `json` as the flag's value, never as a stash name.
    const effectiveName = args.name;

    let writable: boolean | undefined;
    if (effectiveName === undefined) {
      // Primary stash — honour the configured default bundle's writable flag.
      writable = resolveWritableOverride(loadConfig());
    }

    const result = saveGitStash(effectiveName, args.message, writable, { push: args.push !== false });
    // 0.9.0 breaking change: both "save" holdovers from the command's
    // pre-rename name are now "sync" — the persisted eventType below and the
    // envelope shape emitted at the end of this function. Historical state.db
    // rows still carry "save" — `readEvents`/`tailEvents` (src/core/events.ts)
    // treat "save" and "sync" as synonyms on READ so `akm log --type save`
    // keeps returning both old and new rows. Only the WRITE side changes here.
    // The envelope shape needs no such synonym: it is per-invocation, never
    // persisted, so nothing can be holding an old value.
    appendEvent({
      eventType: "sync",
      metadata: {
        name: effectiveName ?? null,
        message: args.message ?? null,
        ok: (result as { ok?: boolean }).ok !== false,
      },
    });
    output("sync", result);
  });
}

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync changes in a git-backed stash: commits (and pushes when writable + remote is configured). No-op for non-git stashes.",
  },
  // Raw defineCommand (not defineJsonCommand), so the global output flags are
  // spread in explicitly — without them the optional `name` positional would
  // swallow a space-separated global flag's value.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    name: {
      type: "positional",
      description: "Name of the git stash to sync (default: primary stash directory)",
      required: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "Commit message (default: timestamp)",
    },
    push: {
      type: "boolean",
      description: "Push after commit when writable + remote configured (use --no-push to commit only). Default: true.",
      default: true,
    },
  },
  async run({ args }) {
    await runSyncBody(args);
  },
});

export const cloneCommand = defineJsonCommand({
  meta: {
    name: "clone",
    description: "Clone an asset from any source into a managed bundle or an unmanaged custom destination",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (e.g. npm:@scope/pkg//scripts/deploy.sh)", required: true },
    name: { type: "string", description: "New name for the cloned asset" },
    force: { type: "boolean", description: "Overwrite if the asset already exists at the destination", default: false },
    target: {
      type: "string",
      description:
        "Override the managed destination. Accepts a bundle name from config; falls back to defaultWriteTarget then the working stash.",
    },
    dest: { type: "string", description: "Unmanaged destination directory (cannot be combined with --target)" },
  },
  async run({ args }) {
    const result = await akmClone({
      sourceRef: args.ref,
      newName: args.name,
      force: args.force,
      dest: args.dest,
      target: args.target,
    });
    output("clone", result);
  },
});
