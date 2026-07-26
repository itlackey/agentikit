// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm 0.9.0 Chunk-5 flip, F4c M1 — REF_RE dual-recognition.
 *
 * The linter's missing-ref scan and `akm mv`'s inbound-xref rewrite recognize
 * `[bundle//]conceptId` refs. Retired `type:name` text is inert.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { runCliCapture } from "../_helpers/cli";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const tempDirs: string[] = [];

function makeStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-lint-dual-"));
  tempDirs.push(dir);
  for (const sub of ["memories", "knowledge"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function writeMemory(stashDir: string, name: string, frontmatter: string, body = "body text"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : "";
  fs.writeFileSync(path.join(stashDir, "memories", `${name}.md`), `${fm}${body}\n`, "utf8");
}

function missingRefDetails(stashDir: string): string[] {
  const res = akmLint({ dir: stashDir, config: makeConfig(stashDir) });
  return res.flagged.filter((i) => i.issue === "missing-ref").map((i) => i.detail);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("F4c M1 — linter missing-ref dual grammar", () => {
  test("short conceptId supersededBy pointing at an EXISTING asset is not flagged", () => {
    const stash = makeStash();
    writeMemory(stash, "target", "");
    writeMemory(stash, "source", "supersededBy: [memories/target]");
    expect(missingRefDetails(stash)).toEqual([]);
  });

  test("short conceptId supersededBy pointing at a MISSING asset IS flagged (the closed gap)", () => {
    const stash = makeStash();
    writeMemory(stash, "source", "supersededBy: [memories/ghost]");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("memories/ghost") && d.includes("supersededBy"))).toBe(true);
  });

  test("fully-qualified bundle//conceptId xref to a MISSING asset is flagged", () => {
    const stash = makeStash();
    writeMemory(stash, "source", "xrefs: [core//memories/ghost]");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("core//memories/ghost"))).toBe(true);
  });

  test("legacy type:name xref is INERT post-chunk-8 — never recognized, never flagged (§11.1)", () => {
    // WI-8.5c deleted the linter's legacy ref-list arm: the old grammar is no
    // longer a ref anywhere outside the frozen migrator, so a legacy xref is
    // plain text — neither resolved nor reported missing.
    const stash = makeStash();
    writeMemory(stash, "target", "");
    writeMemory(stash, "ok", "xrefs: [memory:target]");
    writeMemory(stash, "bad", "xrefs: [memory:ghost]");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("memory:ghost"))).toBe(false);
    expect(details.some((d) => d.includes("memory:target"))).toBe(false);
  });

  test("a bare short conceptId in PROSE is NOT a ref (no false positive, D-R3)", () => {
    const stash = makeStash();
    // No frontmatter refs list; conceptId-shaped token only in the body prose.
    writeMemory(stash, "source", "", "see memories/ghost for details");
    expect(missingRefDetails(stash)).toEqual([]);
  });

  test("a fully-qualified bundle//conceptId in PROSE body IS recognized", () => {
    const stash = makeStash();
    writeMemory(stash, "source", "", "see core//memories/ghost for details");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("core//memories/ghost"))).toBe(true);
  });
});

describe("F4c M1 — akm mv rewrites current refs only", () => {
  let storage: IsolatedAkmStorage;

  afterEach(() => {
    storage?.cleanup();
  });

  test("a conceptId xref re-points while type:name text remains inert", async () => {
    storage = withIsolatedAkmStorage();
    const stashDir = storage.stashDir;
    writeSandboxConfig({
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
    });
    fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
    // The asset being moved.
    fs.writeFileSync(path.join(stashDir, "memories", "old-note.md"), "# old note\n", "utf8");
    // A citer carrying the SAME logical ref in both grammars.
    fs.writeFileSync(
      path.join(stashDir, "memories", "citer.md"),
      [
        "---",
        "xrefs: [memories/old-note, memory:old-note]",
        "---",
        "See memories/old-note and memory:old-note.",
        "",
      ].join("\n"),
      "utf8",
    );

    const res = await runCliCapture(["mv", "memories/old-note", "new-note"]);
    expect(res.code).toBe(0);

    const citer = fs.readFileSync(path.join(stashDir, "memories", "citer.md"), "utf8");
    expect(citer).toContain("memories/new-note");
    expect(citer).toContain("memory:old-note");
    expect(citer).not.toContain("memory:new-note");
  });

  test("a qualified local bundle is rejected instead of moving the primary copy", async () => {
    storage = withIsolatedAkmStorage();
    const localDir = path.join(storage.root, "local-bundle");
    fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
    fs.mkdirSync(path.join(localDir, "memories"), { recursive: true });
    const primary = path.join(storage.stashDir, "memories", "old-note.md");
    const local = path.join(localDir, "memories", "old-note.md");
    fs.writeFileSync(primary, "Primary copy.\n", "utf8");
    fs.writeFileSync(local, "Local bundle copy.\n", "utf8");
    writeSandboxConfig({
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        local: { path: localDir, writable: true },
      },
      defaultBundle: "stash",
    });

    const result = await runCliCapture(["mv", "local//memories/old-note", "new-note"]);

    expect(result.code).toBe(2);
    expect(fs.readFileSync(primary, "utf8")).toBe("Primary copy.\n");
    expect(fs.readFileSync(local, "utf8")).toBe("Local bundle copy.\n");
    expect(fs.existsSync(path.join(storage.stashDir, "memories", "new-note.md"))).toBe(false);
    expect(fs.existsSync(path.join(localDir, "memories", "new-note.md"))).toBe(false);
  });
});
