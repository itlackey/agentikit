// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Observability command cluster — `akm log` (events list/tail), `akm lessons`
 * (coverage), and `akm hints`. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.{log,lessons,hints}` keys and every
 * subcommand's args/output shape are byte-identical.
 *
 * These three surfaces are cohesive read-only "tell me what happened / what to
 * do" commands: `log` reads the append-only state.db events stream, `lessons
 * coverage` reports tag-coverage gaps from the index, and `hints` prints the
 * embedded AGENTS.md guidance. They share no helpers with any command still
 * inline in cli.ts, so the `loadHints` private helper and the
 * `formatEventLine` / `EMBEDDED_HINTS*` / db-tag-set imports move with them.
 *
 * The leaf handlers whose body is a plain `runWithJsonErrors(...) + output(...)`
 * (`events list`, `lessons coverage`) are migrated onto `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `events tail` (manual streaming console/stderr writes) and `hints`
 * (direct `process.stdout.write`) keep a plain `defineCommand` wrapping
 * `runWithJsonErrors` so their byte-for-byte output stays untouched.
 */

import { defineCommand } from "citty";
import { parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues, runWithJsonErrors } from "../cli/shared";
import { NotFoundError } from "../core/errors";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../output/cli-hints";
import { getOutputMode, parseDetailLevel } from "../output/context";
import { registerOutputShape } from "../output/shapes/registry";
import { formatEventLine } from "../output/text/helpers";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import {
  collectTagSetFromEntries,
  findEntryIdByRef,
  getAllEntries,
  getEntryById,
} from "../storage/repositories/index-entries-repository";
import { akmEventsList, akmEventsTail } from "./events";

// ── `akm log` ────────────────────────────────────────────────────────────────
// Append-only events stream surface (#204). `list` reads state.db events
// with optional --since/--type/--ref filters; `tail` follows the table via
// a polling loop and prints each event as a single JSONL line.
//
// R-060: the internal output()/shape-registry command names are `log-list` /
// `log-tail` (renamed from the pre-rename `events-list` / `events-tail`, back
// when the command group was still called `akm events`). These strings never
// reach the wire — `shapeEventsOutput` (src/output/shapes/helpers.ts) builds
// its own envelope and never stamps a `shape` field — so the rename is a
// coherence-only change, not a schemaVersion bump. EXCEPTION: the `[events-tail]`
// stderr trailer below is left as `events-tail` — it IS documented
// (docs/reference/cli.md:1421) and is pending an owner ruling on whether it is
// contract; do not rename it here.

const eventsListCommand = defineJsonCommand({
  meta: { name: "list", description: "List events from the append-only state.db events stream" },
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
  },
  run({ args }) {
    const excludeTags = parseAllFlagValues("--exclude-tags");
    const includeTags = parseAllFlagValues("--include-tags");
    const result = akmEventsList({
      since: args.since,
      type: args.type,
      ref: args.ref,
      ...(excludeTags.length > 0 ? { excludeTags } : {}),
      ...(includeTags.length > 0 ? { includeTags } : {}),
    });
    output("log-list", result);
  },
});

const eventsTailCommand = defineCommand({
  meta: { name: "tail", description: "Follow the append-only state.db events stream (polling)" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type" },
    ref: { type: "string", description: "Filter by asset ref ([bundle//]conceptId)" },
    "interval-ms": { type: "string", description: "Polling interval in ms (default: 75)" },
    "max-duration-ms": { type: "string", description: "Stop after this many ms (default: never)" },
    "max-events": { type: "string", description: "Stop after observing this many events" },
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const intervalMs = parsePositiveIntFlag(args["interval-ms"], "--interval-ms");
      const maxDurationMs = parsePositiveIntFlag(args["max-duration-ms"], "--max-duration-ms");
      const maxEvents = parsePositiveIntFlag(args["max-events"], "--max-events");
      const mode = getOutputMode();
      // In streaming text mode we want each event to print as soon as it
      // arrives. The polling loop emits via `onEvent`; the final result is
      // also rendered through the standard output() pipeline so JSON
      // consumers always get the canonical envelope.
      const stream = mode.format === "text" || mode.format === "jsonl";
      const excludeTags = parseAllFlagValues("--exclude-tags");
      const includeTags = parseAllFlagValues("--include-tags");
      const result = await akmEventsTail({
        since: args.since,
        type: args.type,
        ref: args.ref,
        intervalMs,
        maxDurationMs,
        maxEvents,
        ...(excludeTags.length > 0 ? { excludeTags } : {}),
        ...(includeTags.length > 0 ? { includeTags } : {}),
        onEvent: stream
          ? (event) => {
              if (mode.format === "jsonl") {
                console.log(JSON.stringify(event));
              } else {
                console.log(formatEventLine(event as unknown as Record<string, unknown>));
              }
            }
          : undefined,
      });
      // Emit the canonical envelope last (JSON/YAML modes rely on this;
      // streaming modes already printed each event but we still emit a
      // trailer so callers can persist the resumable cursor).
      if (!stream) {
        output("log-tail", result);
      } else if (mode.format === "jsonl") {
        // Final discriminated trailer row so jsonl consumers can resume.
        const trailer = {
          _kind: "trailer",
          schemaVersion: 1,
          nextOffset: result.nextOffset,
          totalCount: result.totalCount,
          reason: result.reason,
        };
        console.log(JSON.stringify(trailer));
      } else {
        // text mode: keep stdout pristine for line-oriented parsers and
        // emit the trailer on stderr.
        process.stderr.write(
          `[events-tail] reason=${result.reason} nextOffset=${result.nextOffset} total=${result.totalCount}\n`,
        );
      }
    });
  },
});

export const logCommand = defineCommand({
  meta: {
    name: "log",
    description: "Read or follow the append-only state.db events stream (mutations, feedback, indexing)",
  },
  subCommands: {
    list: eventsListCommand,
    tail: eventsTailCommand,
  },
});

// ── lessons subcommands (Phase 7A / Advantage D4c) ──────────────────────────

const lessonsCoverageCommand = defineJsonCommand({
  meta: {
    name: "coverage",
    description:
      "Report tags that exist on indexed assets but are NOT yet covered by any lesson.\n\n" +
      "Useful for spotting topics where the stash has skills/commands/scripts but no\n" +
      "crystallized lesson — a signal that the team has tacit knowledge worth distilling.\n\n" +
      "Default output is JSON: { uncoveredTags: string[], lessonTagCount: number, totalTagCount: number }.\n" +
      "Pass --format text for a plain-text bulleted list.",
  },
  args: {},
  run() {
    const db = openExistingDatabase();
    try {
      const allTagSet = collectTagSetFromEntries(db, undefined);
      const lessonTagSet = collectTagSetFromEntries(db, "lesson");
      const uncovered: string[] = [];
      for (const tag of allTagSet) {
        if (!lessonTagSet.has(tag)) uncovered.push(tag);
      }
      uncovered.sort((a, b) => a.localeCompare(b));
      output("lessons-coverage", {
        ok: true,
        uncoveredTags: uncovered,
        lessonTagCount: lessonTagSet.size,
        totalTagCount: allTagSet.size,
      });
    } finally {
      closeDatabase(db);
    }
  },
});

// R-054: the group description below has long advertised "strength queries"
// alongside `coverage`, but no such subcommand was ever registered —
// `lessonStrength` (the count of distinct feedback refs credited to a lesson
// via `akm feedback --applied-to`, src/commands/feedback-cli.ts) was written
// and read by search ranking (src/indexer/search/ranking-contributors.ts) but
// unreadable from any command. `strength` closes that gap: pass a ref for a
// single lookup, or omit it to list every indexed lesson's strength.
//
// Every output() call must have a registered shape (src/output/shapes.ts:
// "no silent JSON.stringify fallback... fail loudly") or the command dies at
// the render step with an {ok:false,"output shape not registered"} envelope
// (see the regression guard at tests/integration/cli-errors.test.ts:320-365).
// New built-in shapes are normally added to the PASSTHROUGH_COMMANDS array in
// src/output/shapes/passthrough.ts, which the central src/output/shapes.ts
// barrel feeds to registerOutputShapes() — but both of those files are
// outside this package's assigned file list for this change, so the shape is
// registered directly here instead (registerOutputShape is idempotent and
// module-load-order-independent; see src/output/shapes/registry.ts). Same
// schemaVersion/shape stamp as every other PASSTHROUGH_COMMANDS entry.
// Follow-up: fold "lessons-strength" into PASSTHROUGH_COMMANDS and delete this
// registerOutputShape call once that file is in scope.
registerOutputShape("lessons-strength", (result) => {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const obj = result as Record<string, unknown>;
  if (obj.shape === undefined) obj.shape = "lessons-strength";
  if (obj.schemaVersion === undefined) obj.schemaVersion = 1;
  return obj;
});

const lessonsStrengthCommand = defineJsonCommand({
  meta: {
    name: "strength",
    description:
      "Report a lesson's `lessonStrength` — the count of distinct feedback refs credited to it via " +
      "`akm feedback <feedback-ref> --applied-to <lesson-ref>`, which the search ranker also reads.\n\n" +
      "Pass a ref to look up one lesson; omit it to list every indexed lesson's strength, highest first.\n\n" +
      "Default output is JSON: { ref, strength } for a single lookup, or " +
      "{ lessons: [{ ref, strength }], totalCount } for the list form.",
  },
  args: {
    ref: {
      type: "positional",
      description: "Lesson ref ([bundle//]lessons/<name>). Omit to list every lesson's strength.",
      required: false,
    },
  },
  run({ args }) {
    const db = openExistingDatabase();
    try {
      const refArg = typeof args.ref === "string" ? args.ref : undefined;
      if (refArg) {
        const entryId = findEntryIdByRef(db, refArg);
        const entry = entryId !== undefined ? getEntryById(db, entryId) : undefined;
        if (!entry || entry.entry.type !== "lesson") {
          throw new NotFoundError(`No indexed lesson found for ref "${refArg}".`);
        }
        output("lessons-strength", {
          ok: true,
          ref: entry.itemRef ?? refArg,
          strength: entry.entry.lessonStrength ?? 0,
        });
        return;
      }
      const lessons = getAllEntries(db, "lesson")
        .map((e) => ({ ref: e.itemRef, strength: e.entry.lessonStrength ?? 0 }))
        .sort((a, b) => b.strength - a.strength || a.ref.localeCompare(b.ref));
      output("lessons-strength", { ok: true, lessons, totalCount: lessons.length });
    } finally {
      closeDatabase(db);
    }
  },
});

export const lessonsCommand = defineCommand({
  meta: {
    name: "lessons",
    alias: "lesson",
    description: "Lesson-asset tooling: tag-coverage gaps, strength queries.",
  },
  subCommands: {
    coverage: lessonsCoverageCommand,
    strength: lessonsStrengthCommand,
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
 * every environment. `docs/agents/AGENTS.md` / `AGENTS.full.md` still exist as
 * human-readable repo documentation (linked from `docs/agents/README.md` and
 * `docs/README.md`) and have been brought back into content-agreement with
 * the embedded copies (no more `akm wiki` teaching, no more dead `type:name`
 * colon refs) — but they no longer feed this runtime path, so they cannot
 * make `akm hints`'s behavior diverge by install method again. A drift
 * between the two is now a documentation-accuracy issue, not the P0 "agent
 * runs a command that doesn't exist" bug this item was filed for.
 */
function loadHints(detail: "brief" | "normal" | "full" = "normal"): string {
  // `brief` → the short guide; `normal`/`full` → the complete guide.
  return detail === "brief" ? EMBEDDED_HINTS : EMBEDDED_HINTS_FULL;
}
