// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { decodeTaskHistoryMetadata } from "../src/storage/repositories/task-history-repository";

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

  test("rejects malformed JSON, old versions, and inexact current metadata", () => {
    expect(() => decodeTaskHistoryMetadata("{not json")).toThrow(/not valid JSON/);
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 1, durationMs: 12, detail: null })).toThrow(
      /unsupported metadataVersion/,
    );
    expect(() => decodeTaskHistoryMetadata({})).toThrow(/unsupported metadataVersion/);
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 3 })).toThrow(/unsupported metadataVersion/);
    expect(() =>
      decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null, profile: "old" }),
    ).toThrow(/unknown fields/);
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1 })).toThrow(/detail is required/);
  });
});
