// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import { appendEvent } from "../../src/core/events";
import { _setWarnSinkForTests } from "../../src/core/warn";
import type { Database } from "../../src/storage/database";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

function throwingDatabase(code: string): Database {
  return {
    prepare() {
      throw Object.assign(new Error(`${code}: raw private telemetry path`), { code });
    },
  } as unknown as Database;
}

test.each(["EROFS", "EACCES"])("best-effort event insertion silently ignores %s", (code) => {
  const diagnostics: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "error") diagnostics.push(args.map(String).join(" "));
  });

  appendEvent({ eventType: "search" }, { db: throwingDatabase(code) });

  expect(diagnostics).toEqual([]);
});

test("read-only errno is recognized through a runtime wrapper cause", () => {
  const diagnostics: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "error") diagnostics.push(args.map(String).join(" "));
  });
  const cause = Object.assign(new Error("read-only inner path"), { code: "EROFS" });
  const db = {
    prepare() {
      throw Object.assign(new Error("wrapper"), { code: "ERR_SQLITE_OPEN", cause });
    },
  } as unknown as Database;

  appendEvent({ eventType: "search" }, { db });

  expect(diagnostics).toEqual([]);
});

test("real event storage faults remain diagnosable", () => {
  const diagnostics: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "error") diagnostics.push(args.map(String).join(" "));
  });

  appendEvent({ eventType: "search" }, { db: throwingDatabase("EIO") });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain("state.db event insert failed");
  expect(diagnostics[0]).toContain("EIO");
});

test.skipIf(process.platform === "win32")(
  "a read-only canonical state directory does not emit appendEvent maintenance/open noise",
  () => {
    const storage = withIsolatedAkmStorage();
    const diagnostics: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "error") diagnostics.push(args.map(String).join(" "));
    });

    fs.chmodSync(storage.dataDir, 0o500);
    try {
      appendEvent({ eventType: "search" });
      expect(diagnostics).toEqual([]);
    } finally {
      fs.chmodSync(storage.dataDir, 0o700);
      storage.cleanup();
    }
  },
);
