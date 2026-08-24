// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../../storage/database";
import { openSqliteReadSnapshot } from "../../../storage/sqlite-read-snapshot";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import { AbstractSessionLogProvider } from "../../session-logs/provider-base";
import type {
  InlineRefMention,
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../../session-logs/types";

function getOpenCodeBaseDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

/**
 * Opencode session storage:
 *
 *   SQLite (current, observed 2026-06): `<base>/opencode.db` — a Drizzle-managed
 *   database with `session` / `message` / `part` tables. Message text lives in
 *   `part` rows (`data` JSON, `type: "text"`); `message.data` holds role/timing.
 *   This is the sole supported layout.
 */

/** Filename of opencode's SQLite session store, relative to its base dir. */
const OPENCODE_DB_FILENAME = "opencode.db";

export class OpenCodeProvider extends AbstractSessionLogProvider implements SessionLogHarness {
  readonly name = "opencode";
  readonly #baseDir = getOpenCodeBaseDir();

  protected availabilityRoot(): string {
    return this.#baseDir;
  }

  /** Absolute path to opencode's SQLite store under `base`. */
  #dbPath(base: string): string {
    return path.join(base, OPENCODE_DB_FILENAME);
  }

  listSessions(input: { sinceMs?: number; location?: string; isolatedSnapshot?: boolean } = {}): SessionSummary[] {
    const base = input.location ?? this.#baseDir;
    const sinceMs = input.sinceMs ?? 0;
    const dbPath = this.#dbPath(base);
    if (!fs.existsSync(dbPath)) return [];
    return this.#listSessionsFromDb(dbPath, sinceMs, input.isolatedSnapshot ?? false);
  }

  readSession(ref: SessionRef): SessionData {
    return this.#readSessionFromDb(ref);
  }

  /**
   * List sessions from the SQLite store. `filePath` on each summary is the
   * `opencode.db` path so {@link readSession} can route back to the DB reader.
   * Returns `[]` (never throws) when the DB is unreadable or lacks the expected
   * schema — callers treat a missing harness as "no sessions".
   */
  #listSessionsFromDb(dbPath: string, sinceMs: number, isolatedSnapshot: boolean): SessionSummary[] {
    let db: ReturnType<typeof openDatabase>;
    try {
      const opened = isolatedSnapshot
        ? openSqliteReadSnapshot(dbPath)
        : openDatabase(dbPath, { readonly: true, create: false });
      if (!opened) return [];
      db = opened;
    } catch {
      return [];
    }
    try {
      const rows = db
        .prepare<{
          id: string;
          title: string | null;
          directory: string | null;
          time_created: number | null;
          time_updated: number | null;
        }>(
          "SELECT id, title, directory, time_created, time_updated FROM session WHERE time_updated >= ? ORDER BY time_updated DESC",
        )
        .all(sinceMs);
      return rows.map((r) =>
        this.sessionRef({
          sessionId: r.id,
          filePath: dbPath,
          startedAt: typeof r.time_created === "number" ? r.time_created : undefined,
          endedAt: typeof r.time_updated === "number" ? r.time_updated : undefined,
          projectHint: typeof r.directory === "string" && r.directory.length > 0 ? r.directory : undefined,
          title: typeof r.title === "string" && r.title.length > 0 ? r.title : undefined,
        }),
      );
    } catch {
      // Missing `session` table / unexpected schema — treat as no sessions.
      return [];
    } finally {
      db.close();
    }
  }

  /**
   * Read one session from the SQLite store. Message text lives in `part` rows
   * (`type: "text"`); `message.data` carries role + timing. One event per
   * message, text-parts concatenated in time order. Returns empty events
   * (never throws) when the DB is unreadable.
   */
  #readSessionFromDb(ref: SessionRef): SessionData {
    const emptyRef: SessionSummary = this.sessionRef({ sessionId: ref.sessionId, filePath: ref.filePath });
    let db: ReturnType<typeof openDatabase>;
    try {
      db = openDatabase(ref.filePath, { readonly: true, create: false });
    } catch {
      return { ref: emptyRef, events: [], inlineRefs: [] };
    }
    try {
      const meta = db
        .prepare<{
          title: string | null;
          directory: string | null;
          time_created: number | null;
          time_updated: number | null;
        }>("SELECT title, directory, time_created, time_updated FROM session WHERE id = ?")
        .get(ref.sessionId);
      const startedAt = typeof meta?.time_created === "number" ? meta.time_created : undefined;
      const endedAt = typeof meta?.time_updated === "number" ? meta.time_updated : undefined;
      const title = typeof meta?.title === "string" && meta.title.length > 0 ? meta.title : undefined;
      const projectHint = typeof meta?.directory === "string" && meta.directory.length > 0 ? meta.directory : undefined;

      const messages = db
        .prepare<{ id: string; data: string; time_created: number | null }>(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(ref.sessionId);
      const parts = db
        .prepare<{ message_id: string; data: string }>(
          "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(ref.sessionId);

      // Group text-part bodies by their parent message.
      const textByMessage = new Map<string, string[]>();
      for (const part of parts) {
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(part.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed?.type !== "text") continue;
        const text = parsed.text;
        if (typeof text !== "string" || text.length < 1) continue;
        const bucket = textByMessage.get(part.message_id) ?? [];
        bucket.push(text);
        textByMessage.set(part.message_id, bucket);
      }

      const events: SessionEvent[] = [];
      const inlineRefs: InlineRefMention[] = [];
      for (const message of messages) {
        let mdata: Record<string, unknown> = {};
        try {
          mdata = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          // role/timing unavailable — fall through with defaults
        }
        const role = typeof mdata.role === "string" ? (mdata.role as SessionEvent["role"]) : "unknown";
        const mtime = (mdata.time as Record<string, unknown> | undefined)?.created;
        const ts =
          typeof mtime === "number"
            ? mtime
            : typeof message.time_created === "number"
              ? message.time_created
              : undefined;
        const text = (textByMessage.get(message.id) ?? []).join("\n").trim();
        if (text.length < 1) continue;
        events.push({ harness: this.name, text, ts, sessionId: ref.sessionId, role, filePath: ref.filePath });
        inlineRefs.push(...extractInlineRefMentions(text, ts));
      }
      events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

      return {
        ref: this.sessionRef({
          sessionId: ref.sessionId,
          filePath: ref.filePath,
          startedAt,
          endedAt,
          projectHint,
          title,
        }),
        events,
        inlineRefs,
      };
    } catch {
      return { ref: emptyRef, events: [], inlineRefs: [] };
    } finally {
      db.close();
    }
  }
}
