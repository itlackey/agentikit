// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const workflowsDirectory = path.join(root, ".github", "workflows");

describe("CI test path ownership", () => {
  test("every explicitly named test file in an active workflow exists", () => {
    const references: Array<{ path: string; workflow: string }> = [];

    for (const workflow of fs
      .readdirSync(workflowsDirectory)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()) {
      const source = fs.readFileSync(path.join(workflowsDirectory, workflow), "utf8");
      for (const match of source.matchAll(/\btests\/[A-Za-z0-9_./-]+\.test\.ts\b/g)) {
        references.push({ path: match[0], workflow });
      }
    }

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(fs.existsSync(path.join(root, reference.path)), `${reference.workflow}: ${reference.path}`).toBe(true);
    }
  });
});
