// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #882 — `akm lint` silently skipped `type:slug` xrefs (the grammar retired at
 * the write boundary, see resolve-ref.ts Q-02) instead of validating them.
 * `classifyConceptRef` only recognized the current conceptId (`type/slug`)
 * grammar via `typeNameFromConceptId`, so an old-grammar token mapped to
 * `undefined` and was treated as "not a local asset ref, skip" rather than
 * checked for existence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function writeMemory(stashDir: string, slug: string, xrefsYaml: string): void {
  const file = path.join(stashDir, "memories", `${slug}.md`);
  fs.writeFileSync(file, `---\ndescription: Test memory for #882\nxrefs:\n${xrefsYaml}\n---\n\nBody.\n`);
}

describe("akm lint validates the legacy type:slug xref grammar (#882)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a resolvable type:slug xref is validated, not silently skipped", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "target-doc.md"),
      "---\ndescription: target\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "legacy-ok", "  - knowledge:target-doc");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("a dangling type:slug xref is now caught as missing-ref", async () => {
    writeMemory(storage.stashDir, "legacy-dangling", "  - memory:does-not-exist");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    const missing = result.flagged.filter((f) => f.issue === "missing-ref");
    expect(missing.length).toBe(1);
    expect(missing[0]?.detail).toContain("memory:does-not-exist");
  });

  test("the current conceptId grammar still resolves and still catches dangling refs", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "current-doc.md"),
      "---\ndescription: target\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "conceptid-mixed", "  - knowledge/current-doc\n  - memories/does-not-exist-either");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    const missing = result.flagged.filter((f) => f.issue === "missing-ref");
    expect(missing.length).toBe(1);
    expect(missing[0]?.detail).toContain("memories/does-not-exist-either");
  });
});
