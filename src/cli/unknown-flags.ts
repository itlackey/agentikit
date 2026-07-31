// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reject flags the resolved command does not declare.
 *
 * citty forwards argv to mri, which has no strict mode: an undeclared flag is
 * collected into the parsed object and silently ignored by the handler. Nothing
 * downstream noticed, so `akm lint --fail-on-flaged` (one transposed letter in
 * the flag STABILITY.md documents as a CI contract) parsed fine, exited 0, and
 * the gate it was meant to enforce never fired. Same for `--limt 3`, `--jsn`,
 * and every other typo — the command ran with the default instead, and the user
 * had no signal.
 *
 * This walks the same subcommand path citty resolves, unions the arg
 * definitions declared along it, and fails a flag that matches nothing. The
 * union (rather than the leaf's args alone) is deliberate: parent-level flags
 * may legally appear before the subcommand token, and a false positive here
 * would reject a VALID invocation — much worse than the silence it replaces.
 *
 * Deliberately conservative in four more ways:
 *   - everything after a literal `--` is passthrough and never inspected;
 *   - a value that follows a declared string/enum flag is skipped, so
 *     `--reason "--not-a-flag"` is not mistaken for a flag;
 *   - `--no-<name>` negation resolves against `<name>`;
 *   - a bare `-` (stdin convention) and negative numbers are left alone.
 */

import { UsageError } from "../core/errors";

/** The structural subset of a citty command this module reads. */
export interface FlagScanCommand {
  readonly args?: Record<string, { readonly type?: string; readonly alias?: string | readonly string[] }>;
  readonly subCommands?: Record<string, FlagScanCommand> | undefined;
}

/** citty compares `foo-bar` and `fooBar` as the same arg name. */
function comparableName(name: string): string {
  return name.replace(/[-_]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function aliasList(alias: string | readonly string[] | undefined): readonly string[] {
  if (Array.isArray(alias)) return alias;
  return typeof alias === "string" ? [alias] : [];
}

/** Flags citty implements itself, which no command declares. */
const IMPLICIT_FLAGS = ["help", "h", "version", "v"];

/**
 * Retired flags whose commands still diagnose them THEMSELVES, with a message
 * that names the replacement ("`--scope` was removed, use `--filter`",
 * "`--source` was renamed to `--generator`"). A generic "unknown flag" here
 * would preempt the better diagnosis, so these are passed through to the
 * handler that owns them. Everything NOT in this list — every genuine typo —
 * still fails fast.
 *
 * Shrink-only: when a command drops its bespoke diagnostic, drop the entry and
 * the generic error takes over.
 */
const SELF_DIAGNOSED_FLAGS: ReadonlySet<string> = new Set(
  [
    "akmView", // akm show — removed view grammar
    "scope", // akm show — removed, points at --filter
    "enrich", // akm index — removed
    "re-enrich", // akm index — removed
    "source", // akm proposal accept/reject — renamed to --generator
    "profile", // akm proposal drain — retired, points at --strategy
    "status", // akm proposal — bare-group filter, retired
    "dry-run", // akm workflow next — rejected with a bespoke explanation
    "from", // akm workflow next — rejected with a bespoke explanation
    "auto-accept", // akm improve — retired in 0.9.0, warn-and-ignore
  ].map(comparableName),
);

interface KnownArgs {
  /** Every accepted flag spelling, in comparable form. */
  readonly names: ReadonlySet<string>;
  /** Comparable names of flags that consume the following token as a value. */
  readonly valueFlags: ReadonlySet<string>;
  /** Human-readable spellings, for the did-you-mean suggestion. */
  readonly displayNames: readonly string[];
  /**
   * False when the command path did not fully resolve — an unknown command
   * token, or a group with no subcommand given. citty's own UNKNOWN_COMMAND /
   * "no command specified" is the better error in both cases, so flag
   * validation stands down rather than reporting a flag error for what is
   * really a command error.
   */
  readonly resolved: boolean;
}

/**
 * Union the arg definitions declared along the resolved command path.
 *
 * The subcommand walk mirrors citty's own: a value flag consumes the token
 * after it, so the first bare token that follows is the subcommand name.
 */
export function collectKnownArgs(root: FlagScanCommand, rawArgs: readonly string[]): KnownArgs {
  const names = new Set<string>(IMPLICIT_FLAGS.map(comparableName));
  const valueFlags = new Set<string>();
  const displayNames: string[] = [];

  let cmd: FlagScanCommand = root;
  let args: readonly string[] = rawArgs;
  for (;;) {
    for (const [key, def] of Object.entries(cmd.args ?? {})) {
      // Positionals are not flags; including them would accept `--<positional>`.
      if (def.type === "positional") continue;
      names.add(comparableName(key));
      displayNames.push(`--${key}`);
      if (def.type === "string" || def.type === "enum") valueFlags.add(comparableName(key));
      for (const alias of aliasList(def.alias)) {
        names.add(comparableName(alias));
        if (def.type === "string" || def.type === "enum") valueFlags.add(comparableName(alias));
      }
    }

    const subCommands = cmd.subCommands;
    if (!subCommands || Object.keys(subCommands).length === 0) break;
    const idx = findSubCommandIndex(args, cmd);
    const token = idx >= 0 ? args[idx] : undefined;
    // A group with no subcommand token: citty reports "no command specified".
    if (token === undefined) return { names, valueFlags, displayNames, resolved: false };
    const sub = resolveSubCommand(subCommands, token);
    // An unrecognized token: citty reports the unknown command, which is the
    // real problem — its flags are beside the point.
    if (!sub) return { names, valueFlags, displayNames, resolved: false };
    cmd = sub;
    args = args.slice(idx + 1);
  }

  return { names, valueFlags, displayNames, resolved: true };
}

/** Index of the subcommand token, skipping flags and their values. */
function findSubCommandIndex(args: readonly string[], cmd: FlagScanCommand): number {
  const valueFlags = new Set<string>();
  for (const [key, def] of Object.entries(cmd.args ?? {})) {
    if (def.type !== "string" && def.type !== "enum") continue;
    valueFlags.add(comparableName(key));
    for (const alias of aliasList(def.alias)) valueFlags.add(comparableName(alias));
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return -1;
    if (arg.startsWith("-") && arg !== "-") {
      if (!arg.includes("=") && valueFlags.has(comparableName(arg.replace(/^-{1,2}/, "")))) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/** citty matches a subcommand by key or by its `meta.name`; key is enough here. */
function resolveSubCommand(subCommands: Record<string, FlagScanCommand>, token: string): FlagScanCommand | undefined {
  return subCommands[token];
}

/** Edit distance, for suggesting the flag the user meant. */
function editDistance(a: string, b: string): number {
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function closestFlag(attempted: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(attempted, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.ceil(attempted.length / 3));
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

/**
 * Throw a {@link UsageError} naming the first flag the resolved command does
 * not declare. Returns silently when every flag is known.
 */
export function assertKnownFlags(root: FlagScanCommand, rawArgs: readonly string[]): void {
  const passthroughAt = rawArgs.indexOf("--");
  const ownArgs = passthroughAt === -1 ? rawArgs : rawArgs.slice(0, passthroughAt);
  const known = collectKnownArgs(root, rawArgs);
  if (!known.resolved) return;

  for (let i = 0; i < ownArgs.length; i += 1) {
    const token = ownArgs[i] as string;
    // Not a flag: positional, a bare `-` (stdin), or a negative number.
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) continue;

    const withoutDashes = token.replace(/^-{1,2}/, "");
    const [rawName = ""] = withoutDashes.split("=", 1);
    const hasInlineValue = withoutDashes.includes("=");
    // `--no-foo` is citty's boolean negation of `--foo`.
    const negated = rawName.startsWith("no-") ? rawName.slice(3) : undefined;

    const candidates = [comparableName(rawName), ...(negated ? [comparableName(negated)] : [])];
    if (candidates.some((name) => SELF_DIAGNOSED_FLAGS.has(name))) continue;
    if (!candidates.some((name) => known.names.has(name))) {
      const suggestion = closestFlag(`--${rawName}`, known.displayNames);
      throw new UsageError(
        `Unknown flag "${token.split("=")[0]}".`,
        "UNKNOWN_FLAG",
        suggestion
          ? `Did you mean \`${suggestion}\`? Run the command with \`--help\` to see its accepted flags.`
          : "Run the command with `--help` to see its accepted flags.",
      );
    }

    // Skip a declared value flag's value so `--reason "--x"` is not scanned.
    if (!hasInlineValue && candidates.some((name) => known.valueFlags.has(name))) i += 1;
  }
}
