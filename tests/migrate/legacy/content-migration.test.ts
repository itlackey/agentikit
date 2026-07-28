// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applyReservedRenameBatch,
  planReservedRenameBatch,
  runContentMigration,
} from "../../../scripts/akm-migrate/migrate/legacy/content-migration";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { makeSandboxDir } from "../../_helpers/sandbox";

test("retains a sidecar unless every entry can be folded", () => {
  const sandbox = makeSandboxDir("akm-content-sidecar-retention");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.md"), "# Note\n");
    fs.writeFileSync(path.join(dir, "tool.sh"), "#!/bin/sh\n");
    const sidecarPath = path.join(dir, ".stash.json");
    const sidecar = `${JSON.stringify({
      entries: [
        { name: "note", type: "memory", filename: "note.md", description: "Curated note" },
        { name: "tool", type: "script", filename: "tool.sh", description: "Curated tool" },
      ],
    })}\n`;
    fs.writeFileSync(sidecarPath, sidecar);

    const report = runContentMigration([sandbox.dir]);
    expect(report.entriesFolded).toBe(1);
    expect(report.entriesSkipped).toBe(1);
    expect(report.sidecarsFolded).toBe(0);
    expect(fs.readFileSync(sidecarPath, "utf8")).toBe(sidecar);
    expect(parseFrontmatter(fs.readFileSync(path.join(dir, "note.md"), "utf8")).data.description).toBe("Curated note");
  } finally {
    sandbox.cleanup();
  }
});

test("retains malformed sidecars byte-for-byte", () => {
  const sandbox = makeSandboxDir("akm-content-invalid-sidecar");
  try {
    const sidecarPath = path.join(sandbox.dir, ".stash.json");
    const malformed = '{"entries":[{"name":"recoverable"}';
    fs.writeFileSync(sidecarPath, malformed);

    const report = runContentMigration([sandbox.dir]);
    expect(report.sidecarsFolded).toBe(0);
    expect(report.sidecarReports).toEqual([{ path: sidecarPath, status: "malformed", detail: expect.any(String) }]);
    expect(fs.readFileSync(sidecarPath, "utf8")).toBe(malformed);
  } finally {
    sandbox.cleanup();
  }
});

test("retains a sidecar whose filename escapes its directory", () => {
  const sandbox = makeSandboxDir("akm-content-sidecar-confinement");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(sandbox.dir, "outside.md");
    const outsideBytes = "# Outside\n";
    fs.writeFileSync(outside, outsideBytes);
    const sidecarPath = path.join(dir, ".stash.json");
    fs.writeFileSync(
      sidecarPath,
      `${JSON.stringify({
        entries: [{ name: "outside", type: "memory", filename: "../outside.md", description: "overwrite" }],
      })}\n`,
    );

    const report = runContentMigration([sandbox.dir]);
    expect(report.entriesSkipped).toBe(1);
    expect(report.sidecarsFolded).toBe(0);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe(outsideBytes);
  } finally {
    sandbox.cleanup();
  }
});

test("does not overwrite malformed frontmatter during source backref migration", () => {
  const sandbox = makeSandboxDir("akm-content-malformed-frontmatter");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "derived.md");
    const original = '---\nsource: memory:parent\ntitle: "unterminated\ntags:\n  - keep-me\n---\nBody.\n';
    fs.writeFileSync(filePath, original);

    expect(runContentMigration([sandbox.dir]).sourceBackrefsRewritten).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  } finally {
    sandbox.cleanup();
  }
});

test("rescues reserved files indexed by the frozen layout without renaming wiki structure", () => {
  const sandbox = makeSandboxDir("akm-content-reserved-rescue");
  try {
    const knowledge = path.join(sandbox.dir, "knowledge");
    const wiki = path.join(sandbox.dir, "wikis", "team");
    fs.mkdirSync(knowledge, { recursive: true });
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(knowledge, "index.md"), "---\ntags: [legacy]\n---\nLegacy concept.\n");
    fs.writeFileSync(path.join(wiki, "index.md"), "---\ndescription: Team wiki\n---\nWiki structure.\n");

    const report = runContentMigration([sandbox.dir]);
    expect(report.reservedRenames).toEqual([
      { from: path.join(knowledge, "index.md"), to: path.join(knowledge, "index-content.md") },
    ]);
    expect(fs.existsSync(path.join(knowledge, "index-content.md"))).toBe(true);
    expect(fs.existsSync(path.join(wiki, "index.md"))).toBe(true);
  } finally {
    sandbox.cleanup();
  }
});

test("persists an operation-bound rename batch before mutation and publishes without replacement", () => {
  const sandbox = makeSandboxDir("akm-content-reserved-batch");
  try {
    const knowledge = path.join(sandbox.dir, "knowledge");
    fs.mkdirSync(knowledge, { recursive: true });
    const source = path.join(knowledge, "index.md");
    const target = path.join(knowledge, "index-content.md");
    const batchPath = path.join(sandbox.dir, "rename-batch.json");
    fs.writeFileSync(source, "---\ndescription: Legacy\n---\nBody\n");

    const batch = planReservedRenameBatch([sandbox.dir], batchPath, "operation-1");
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(JSON.parse(fs.readFileSync(batchPath, "utf8"))).toMatchObject({
      operationId: "operation-1",
      entries: [{ from: source, to: target, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });

    fs.writeFileSync(target, "concurrent target\n");
    expect(() => applyReservedRenameBatch(batch, "operation-1")).toThrow();
    expect(fs.readFileSync(source, "utf8")).toContain("Legacy");
    expect(fs.readFileSync(target, "utf8")).toBe("concurrent target\n");
  } finally {
    sandbox.cleanup();
  }
});

test("resumes the persisted rename batch after publication removed the source", () => {
  const sandbox = makeSandboxDir("akm-content-reserved-resume");
  try {
    const knowledge = path.join(sandbox.dir, "knowledge");
    fs.mkdirSync(knowledge, { recursive: true });
    const source = path.join(knowledge, "index.md");
    const target = path.join(knowledge, "index-content.md");
    const batchPath = path.join(sandbox.dir, "rename-batch.json");
    fs.writeFileSync(source, "---\ndescription: Legacy\n---\nBody\n");
    const batch = planReservedRenameBatch([sandbox.dir], batchPath, "operation-resume");
    applyReservedRenameBatch(batch, "operation-resume");

    const report = runContentMigration([sandbox.dir], {
      renameBatchPath: batchPath,
      operationId: "operation-resume",
    });
    expect(report.reservedRenames).toEqual([{ from: source, to: target }]);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toContain("Legacy");
  } finally {
    sandbox.cleanup();
  }
});

test("resumes after the authentic target was published before source unlink", () => {
  const sandbox = makeSandboxDir("akm-content-reserved-both");
  try {
    const knowledge = path.join(sandbox.dir, "knowledge");
    fs.mkdirSync(knowledge, { recursive: true });
    const source = path.join(knowledge, "index.md");
    const target = path.join(knowledge, "index-content.md");
    const batchPath = path.join(sandbox.dir, "rename-batch.json");
    fs.writeFileSync(source, "---\ndescription: Legacy\n---\nBody\n");
    const batch = planReservedRenameBatch([sandbox.dir], batchPath, "operation-both");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);

    applyReservedRenameBatch(batch, "operation-both");
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toContain("Legacy");
  } finally {
    sandbox.cleanup();
  }
});

test("direct hard-link publication preserves the source when the filesystem rejects links", () => {
  const sandbox = makeSandboxDir("akm-content-link-failure");
  const original = fs.linkSync;
  try {
    const knowledge = path.join(sandbox.dir, "knowledge");
    fs.mkdirSync(knowledge, { recursive: true });
    const source = path.join(knowledge, "index.md");
    const target = path.join(knowledge, "index-content.md");
    const batchPath = path.join(sandbox.dir, "rename-batch.json");
    fs.writeFileSync(source, "---\ndescription: Legacy\n---\nBody\n");
    const batch = planReservedRenameBatch([sandbox.dir], batchPath, "operation-link-failure");
    let attempted: [fs.PathLike, fs.PathLike] | undefined;
    fs.linkSync = ((existingPath, newPath) => {
      attempted = [existingPath, newPath];
      const error = new Error("hard links unavailable") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof fs.linkSync;

    expect(() => applyReservedRenameBatch(batch, "operation-link-failure")).toThrow(/hard links unavailable/i);
    expect(attempted).toEqual([source, target]);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  } finally {
    fs.linkSync = original;
    sandbox.cleanup();
  }
});

test("folds provenance: legacy sourceRefs merge into xrefs; xrefs/sources survive the fold", () => {
  const sandbox = makeSandboxDir("akm-content-provenance-fold");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.md"), "# Note\n");
    const sidecarPath = path.join(dir, ".stash.json");
    fs.writeFileSync(
      sidecarPath,
      `${JSON.stringify({
        entries: [
          {
            name: "note",
            type: "memory",
            filename: "note.md",
            description: "Curated note",
            // Legacy provenance channel — validateStashEntry no longer copies
            // it, and its old `source_refs` destination has no 0.9 readers.
            sourceRefs: ["knowledge/auth-flow"],
            // Current channels, both validated and round-tripped by the indexer.
            xrefs: ["skills/code-review"],
            sources: ["sessions/claude/abc123"],
          },
        ],
      })}\n`,
    );

    const report = runContentMigration([sandbox.dir]);
    expect(report.entriesFolded).toBe(1);
    expect(report.sidecarsFolded).toBe(1);
    expect(fs.existsSync(sidecarPath)).toBe(false); // the only copy is gone...

    // ...so everything it carried must now live in the asset's frontmatter.
    const fm = parseFrontmatter(fs.readFileSync(path.join(dir, "note.md"), "utf8")).data;
    expect(fm.xrefs).toEqual(["skills/code-review", "knowledge/auth-flow"]);
    expect(fm.sources).toEqual(["sessions/claude/abc123"]);
    expect(fm).not.toHaveProperty("source_refs"); // the dead destination stays dead
  } finally {
    sandbox.cleanup();
  }
});
