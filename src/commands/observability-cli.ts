// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Observability command cluster — `akm log` (append-only events stream) and
 * `akm hints`. Extracted verbatim from src/cli.ts (WS6) so the God Module
 * shrinks; the `main.subCommands.{log,hints}` keys and every subcommand's
 * args/output shape are byte-identical.
 *
 * These are cohesive read-only "tell me what happened / what to do" commands:
 * `log` reads the append-only state.db events stream and `hints` prints the
 * embedded CLI-reference guidance (`src/assets/hints/cli-hints-{short,full}.md`).
 * They share no helpers with any command still inline in cli.ts, so the
 * `loadHints` private helper and the `EMBEDDED_HINTS*` imports move with them.
 *
 * 0.9.0 CLI overhaul (S3): `log` was a group with `list`/`tail` subcommands;
 * `tail` (a foreground polling daemon) is dropped and `log` becomes a LEAF
 * command that is today's `list` surface, unchanged (including the
 * `--since @offset:<id>` durable cursor and --ref/--type filters). The
 * `lessons`/`lesson` group (`coverage`, `strength`) is dropped entirely —
 * ranking's `lessonStrength` contributor is untouched, only the CLI read
 * surface for it goes away.
 *
 * The leaf handler's body is a plain `runWithJsonErrors(...) + output(...)`,
 * migrated onto `defineJsonCommand`, which emits the same JSON envelope
 * (stdout/stderr/exit-code) as the inline form. `hints` (direct
 * `process.stdout.write`) keeps a plain `defineCommand` wrapping
 * `runWithJsonErrors` so its byte-for-byte output stays untouched.
 */

import { defineCommand } from "citty";
import { parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues, runWithJsonErrors } from "../cli/shared";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../output/cli-hints";
import { parseDetailLevel } from "../output/context";
import { akmEventsList } from "./log";

// ── `akm log` ────────────────────────────────────────────────────────────────
// Append-only events stream surface (#204). Reads state.db events with
// optional --since/--type/--ref filters.
//
// R-060: the internal output()/shape-registry command name is `log-list`
// (renamed from the pre-rename `events-list`, back when the command group was
// still called `akm events`). This string never reaches the wire —
// `shapeEventsOutput` (src/output/shapes/helpers.ts) builds its own envelope
// and never stamps a `shape` field — so the rename is a coherence-only
// change, not a schemaVersion bump. Kept as `log-list` (not renamed to `log`)
// even though the group flattened to a leaf, to avoid unrelated churn on the
// internal registry key.

export const logCommand = defineJsonCommand({
  meta: { name: "log", description: "List events from the append-only state.db events stream" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type (add, remove, remember, feedback, ...)" },
    ref: { type: "string", description: "Filter by asset ref ([bundle//]conceptId)" },
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
    limit: {
      type: "string",
      description: "Return only the most recent N events matching every other filter (default: unlimited)",
    },
  },
  run({ args }) {
    const excludeTags = parseAllFlagValues("--exclude-tags");
    const includeTags = parseAllFlagValues("--include-tags");
    const limit = parsePositiveIntFlag(args.limit);
    const result = akmEventsList({
      since: args.since,
      type: args.type,
      ref: args.ref,
      ...(excludeTags.length > 0 ? { excludeTags } : {}),
      ...(includeTags.length > 0 ? { includeTags } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    output("log-list", result);
  },
});

// ── `akm hints` ──────────────────────────────────────────────────────────────

export const hintsCommand = defineCommand({
  meta: {
    name: "hints",
    description:
      "Print agent instructions on how to use akm — the complete guide by default; pass --detail brief for the short one",
  },
  args: {
    detail: {
      type: "string",
      description:
        "Hints detail level (brief|normal|full). `brief` prints the short guide; `normal`/`full` print the complete guide.",
      default: "normal",
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      // Let the global parser validate the value so an invalid `--detail`
      // returns the standard JSON error envelope (exit 2) rather than a raw
      // stack trace + exit 1. `brief` → short doc; `normal`/`full` → full doc.
      const detail = parseDetailLevel(args.detail as string | undefined) ?? "normal";
      process.stdout.write(loadHints(detail === "brief" ? "brief" : "full"));
    });
  },
});

// ── Hints (embedded AGENTS.md) ──────────────────────────────────────────────

/**
 * R-006: `loadHints` used to prefer reading `<pkgroot>/docs/agents/AGENTS[.full].md`
 * off disk, falling back to the embedded `EMBEDDED_HINTS[_FULL]` constants
 * (from `src/assets/hints/cli-hints-{short,full}.md`, imported `with { type:
 * "text" }` in `../output/cli-hints`) only when that path didn't resolve.
 * `package.json`'s `files` array packs `dist` (which mirrors `src/assets/`)
 * but not `docs/agents/`, so an npm/binary install ALWAYS fell through to the
 * embedded copy while a git checkout (or an in-repo dev/test run) ALWAYS read
 * the separate `docs/agents/` copy instead — and the two had already drifted
 * (`docs/agents/AGENTS.full.md` still taught a whole `akm wiki` command family
 * that does not exist; the embedded copy did not). `akm hints` therefore
 * silently varied in content and correctness by install method — the exact
 * DEVIATION R-006 exists to close.
 *
 * Single-sourced now: this function always returns the embedded constant, in
 * every environment. `docs/agents/AGENTS.md` and `AGENTS.full.md` never fed
 * this runtime path after R-006 landed, kept re-diverging from the embedded
 * copies with no test to catch it (stale `--format` lists, a retired `wiki`
 * type, commands that no longer exist), and have since been deleted; their
 * few genuinely-current sections (the exit-code/error-shape reference, the
 * `akm lint` exit-code contract, the full `akm proposal`/`akm propose`
 * surface) were folded into `src/assets/hints/cli-hints-{short,full}.md`
 * instead. `akm hints` (and `--detail brief`) is the only reference to point
 * readers at now; browse the embedded files directly for the source text.
 */
function loadHints(detail: "brief" | "normal" | "full" = "normal"): string {
  // `brief` → the short guide; `normal`/`full` → the complete guide.
  return detail === "brief" ? EMBEDDED_HINTS : EMBEDDED_HINTS_FULL;
}
