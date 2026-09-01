// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openStateDatabase } from "../../../src/core/state-db";
import {
  decodeTaskHistoryMetadata,
  upsertTaskHistory,
} from "../../../src/storage/repositories/task-history-repository";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

describe("decodeTaskHistoryMetadata", () => {
  test("decodes exact current engine metadata", () => {
    expect(
      decodeTaskHistoryMetadata({
        metadataVersion: 2,
        durationMs: 12,
        detail: { exitCode: 0 },
        engine: "local",
      }),
    ).toEqual({ metadataVersion: 2, durationMs: 12, detail: { exitCode: 0 }, engine: "local" });
  });

  test("rejects malformed JSON and genuinely unsupported metadataVersion values", () => {
    expect(() => decodeTaskHistoryMetadata("{not json")).toThrow(/not valid JSON/);
    // metadataVersion 1 or 3 is a genuinely unknown/future shape, distinct
    // from the tolerated ABSENT-metadataVersion legacy case below.
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 1, durationMs: 12, detail: null })).toThrow(
      /unsupported metadataVersion/,
    );
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 3 })).toThrow(/unsupported metadataVersion/);
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1 })).not.toThrow();
  });

  // Read-time compatibility shim (task-history legacy metadata issue, mirrors
  // #858/#859's storedToChanges): 58% of a real install's task_history rows
  // predate `metadataVersion` entirely. An absent metadataVersion is a LEGACY
  // row, not corruption.
  test("decodes a legacy row with no metadataVersion at all (the 8,508-row live shape)", () => {
    expect(decodeTaskHistoryMetadata({ durationMs: 48557, detail: { exitCode: 0 } })).toEqual({
      metadataVersion: 2,
      durationMs: 48557,
      detail: { exitCode: 0 },
    });
  });

  test("defaults a legacy row's absent detail key to null instead of throwing", () => {
    expect(decodeTaskHistoryMetadata({ durationMs: 1 })).toEqual({
      metadataVersion: 2,
      durationMs: 1,
      detail: null,
    });
    expect(() => decodeTaskHistoryMetadata({})).toThrow(/durationMs must be a number/);
  });

  // Additive fields written by prior releases (88 live rows) must never be
  // fatal — the strict allow-list, not just the version gate, was the hazard.
  test("decodes rows carrying additive `profile`/`repairReason` fields, dropping them harmlessly", () => {
    expect(decodeTaskHistoryMetadata({ durationMs: 1, detail: null, profile: "opencode" })).toEqual({
      metadataVersion: 2,
      durationMs: 1,
      detail: null,
    });
    expect(
      decodeTaskHistoryMetadata({
        metadataVersion: 2,
        durationMs: 1,
        detail: { reason: "repair" },
        repairReason: "manual",
      }),
    ).toEqual({ metadataVersion: 2, durationMs: 1, detail: { reason: "repair" } });
  });

  test("still rejects genuine corruption: non-number durationMs and invalid detail", () => {
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: "oops", detail: null })).toThrow(
      /durationMs must be a number/,
    );
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: { bogus: true } })).toThrow(
      /unknown detail fields/,
    );
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: "not an object" })).toThrow(
      /detail must be an object or null/,
    );
  });

  // P1b (D8, spec §5.3/§6 F-2): the result-vocabulary marker rides the
  // metadata as `targetVocab`, validated as 2 | undefined. RED until the
  // Implement step teaches the decoder the field (today it rejects it as an
  // unknown field); a later phase never widens the accepted values.
  test("accepts targetVocab 2 and metadata without targetVocab (P1b vocabulary marker)", () => {
    expect(decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null, targetVocab: 2 })).toEqual({
      metadataVersion: 2,
      durationMs: 1,
      detail: null,
      targetVocab: 2,
    });
    expect(decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null })).toEqual({
      metadataVersion: 2,
      durationMs: 1,
      detail: null,
    });
  });

  test("rejects a non-2 targetVocab (P1b vocabulary marker)", () => {
    expect(() =>
      decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null, targetVocab: 3 }),
    ).toThrow();
    expect(() =>
      decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null, targetVocab: "2" }),
    ).toThrow();
  });
});

/**
 * `readTaskHistory()` skip-and-warn regression (mirrors `listStateProposals`
 * in proposals-repository.ts): a single genuinely-corrupt row must degrade
 * one row, not abort the whole read.
 */
describe("readTaskHistory — per-row tolerance", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => {
    storage.cleanup();
  });

  const baseRow = {
    status: "completed",
    started_at: "2025-01-01T00:00:00.000Z",
    completed_at: "2025-01-01T00:00:00.000Z",
    failed_at: null,
    log_path: null,
    target_kind: "shell",
    target_ref: null,
  };

  test("a legacy row with no metadataVersion at all reads without throwing", () => {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "legacy-no-version",
        metadata_json: JSON.stringify({ durationMs: 48557, detail: { exitCode: 0 } }),
      });
    } finally {
      db.close();
    }
    const rows = readTaskHistory({ id: "legacy-no-version" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.durationMs).toBe(48557);
  });

  test("a row carrying additive profile/repairReason fields reads without throwing", () => {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "legacy-profile",
        metadata_json: JSON.stringify({ durationMs: 1, detail: null, profile: "opencode" }),
      });
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "legacy-repair-reason",
        metadata_json: JSON.stringify({
          metadataVersion: 2,
          durationMs: 1,
          detail: null,
          repairReason: "manual",
        }),
      });
    } finally {
      db.close();
    }
    expect(readTaskHistory({ id: "legacy-profile" })).toHaveLength(1);
    expect(readTaskHistory({ id: "legacy-repair-reason" })).toHaveLength(1);
  });

  test("a genuinely corrupt row (unparseable JSON) is skipped with a warning, not thrown", () => {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, { ...baseRow, task_id: "corrupt", metadata_json: "{not json" });
    } finally {
      db.close();
    }
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let rows: ReturnType<typeof readTaskHistory> = [];
      expect(() => {
        rows = readTaskHistory({ id: "corrupt" });
      }).not.toThrow();
      expect(rows).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Skipping unparseable task_history row");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a mixed list (legacy, additive-fields, and corrupt rows) returns every readable row", () => {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "mixed-legacy",
        started_at: "2025-01-01T00:00:01.000Z",
        completed_at: "2025-01-01T00:00:01.000Z",
        metadata_json: JSON.stringify({ durationMs: 1, detail: null }),
      });
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "mixed-profile",
        started_at: "2025-01-01T00:00:02.000Z",
        completed_at: "2025-01-01T00:00:02.000Z",
        metadata_json: JSON.stringify({ durationMs: 1, detail: null, profile: "opencode" }),
      });
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "mixed-corrupt",
        started_at: "2025-01-01T00:00:03.000Z",
        completed_at: "2025-01-01T00:00:03.000Z",
        metadata_json: "{not json",
      });
      upsertTaskHistory(db, {
        ...baseRow,
        task_id: "mixed-current",
        started_at: "2025-01-01T00:00:04.000Z",
        completed_at: "2025-01-01T00:00:04.000Z",
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 1, detail: null, targetVocab: 2 }),
      });
    } finally {
      db.close();
    }
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let rows: ReturnType<typeof readTaskHistory> = [];
    try {
      rows = readTaskHistory({ limit: 50 });
    } finally {
      warnSpy.mockRestore();
    }
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("mixed-legacy");
    expect(ids).toContain("mixed-profile");
    expect(ids).toContain("mixed-current");
    expect(ids).not.toContain("mixed-corrupt");
  });
});
