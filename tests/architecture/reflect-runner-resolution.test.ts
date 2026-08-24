// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reflect execution-boundary ratchet.
 *
 * Reflect must select its named engine from the current config/improve
 * cascade, then lower that selection through the shared execution path. A
 * caller-supplied RunnerSpec is already-resolved runtime material: accepting
 * one on AkmReflectOptions creates a second entry that skips engine selection
 * and its validation. Keep transport fakes at the dispatch seams instead.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REFLECT_SOURCE = path.resolve(__dirname, "../../src/commands/improve/reflect.ts");

test("reflect has no pre-resolved RunnerSpec injection entry", () => {
  const source = fs.readFileSync(REFLECT_SOURCE, "utf8");

  expect(source).not.toMatch(/\brunner\??:\s*RunnerSpec\b/);
  expect(source).not.toMatch(/\boptions\.runner\b/);
  expect(source).not.toContain("v2 test seam");
});
