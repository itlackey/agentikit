// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D-R6 usability revision (2026-08-06): reserved is not invisible.
 *
 * The reserved structural files (OKF directory listing / update history at
 * any depth; an LLM wiki's root rulebook/catalog/log) stay OUT of the index
 * and search exactly as D-R6 pins — but they are the bundle's orientation
 * layer, so:
 *
 *   1. `akm show` serves them by extensionless ref (`wiki//index`,
 *      `local//wikis/articles/index`; a pasted `.md` is tolerated), with the
 *      bare `<bundle>//` (or installed-bundle-name) shorthand for the root
 *      listing. Fallback-only: an indexed concept always wins.
 *   2. `akm lint` keeps wiki catalogs honest (`stale-index` / `missing-index`
 *      attributed to the catalog file) for standalone llm-wiki bundles AND
 *      stash `wikis/<name>/` dirs. Read-only: akm detects drift, the agent
 *      fixes it. No file is ever renamed or rewritten.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { akmShowUnified } from "../../src/commands/read/show";
import { resetConfigCache } from "../../src/core/config/config";
import { NotFoundError } from "../../src/core/errors";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function write(root: string, rel: string, content: string): void {
  const destination = path.join(root, rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function page(description: string, pageKind: string): string {
  return `---\ndescription: ${description}\npageKind: ${pageKind}\n---\n\n# ${description}\n`;
}

describe("reserved structural files — readable via show, honest via lint, never indexed", () => {
  let storage: IsolatedAkmStorage;
  let wikiRoot: string;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    wikiRoot = path.join(storage.root, "team-wiki");

    // Standalone llm-wiki bundle: catalog lists http-caching + varnish + a
    // dangling ghost entry, and omits the orphan page.
    write(
      wikiRoot,
      "schema.md",
      "---\ndescription: Rules for this wiki.\nwikiRole: schema\n---\n\n# team-wiki schema\n",
    );
    write(
      wikiRoot,
      "index.md",
      "---\ndescription: Catalog of pages in the team-wiki wiki.\nwikiRole: index\n---\n\n# team-wiki — catalog\n\n" +
        "- [http-caching](pages/http-caching.md)\n- [varnish](pages/entities/varnish.md)\n- [ghost](pages/ghost.md)\n",
    );
    write(wikiRoot, "log.md", "---\ndescription: Append-only log.\nwikiRole: log\n---\n\n# team-wiki — log\n");
    write(wikiRoot, "pages/http-caching.md", page("How HTTP caching works", "concept"));
    write(wikiRoot, "pages/entities/varnish.md", page("The Varnish cache", "entity"));
    write(wikiRoot, "pages/orphan.md", page("An unlisted page", "note"));

    // Stash wikis: `articles` drifted both directions; `fresh` is consistent;
    // `nocat` has pages but no catalog at all.
    const stash = storage.stashDir;
    write(stash, "wikis/articles/schema.md", "# articles wiki schema\n");
    write(
      stash,
      "wikis/articles/index.md",
      "---\ndescription: Catalog of pages in the articles wiki.\nwikiRole: index\n---\n\n# articles — catalog\n\n" +
        "- [note-a](pages/note-a.md)\n- [missing](pages/missing.md)\n",
    );
    write(stash, "wikis/articles/pages/note-a.md", page("First note", "note"));
    write(stash, "wikis/articles/pages/note-b.md", page("Second, unlisted note", "note"));
    write(stash, "wikis/fresh/schema.md", "# fresh wiki schema\n");
    write(
      stash,
      "wikis/fresh/index.md",
      "---\ndescription: Catalog of pages in the fresh wiki.\nwikiRole: index\n---\n\n# fresh — catalog\n\n- [solo](pages/solo.md)\n",
    );
    write(stash, "wikis/fresh/pages/solo.md", page("The only page", "note"));
    write(stash, "wikis/nocat/schema.md", "# nocat wiki schema\n");
    write(stash, "wikis/nocat/pages/stray.md", page("A page with no catalog", "note"));

    // A lowercase authored directory listing in the stash: structural (never
    // indexed) but readable, plus a normal knowledge item beside it.
    write(stash, "knowledge/index.md", "# Knowledge listing\n\n- [real](real.md)\n");
    write(stash, "knowledge/real.md", "---\ndescription: A real item\nupdated: 2026-08-06\n---\n\n# Real\n");

    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      bundles: {
        local: {
          path: storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        wiki: {
          path: wikiRoot,
          components: { main: { root: ".", adapter: "llm-wiki" } },
        },
      },
    });
    resetConfigCache();
  });

  afterEach(() => storage.cleanup());

  test("show serves structural files by extensionless ref; search never indexes them", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const catalog = await akmShowUnified({ ref: "wiki//index", skipLogging: true });
    expect(catalog.type).toBe("structural");
    expect(catalog.ref).toBe("wiki//index");
    expect(catalog.content).toContain("# team-wiki — catalog");

    const schema = await akmShowUnified({ ref: "wiki//schema", skipLogging: true });
    expect(schema.type).toBe("structural");
    expect(schema.content).toContain("# team-wiki schema");

    const log = await akmShowUnified({ ref: "wiki//log", skipLogging: true });
    expect(log.content).toContain("# team-wiki — log");

    // The .md extension is not required — and a pasted one is tolerated.
    const pasted = await akmShowUnified({ ref: "wiki//index.md", skipLogging: true });
    expect(pasted.ref).toBe("wiki//index");
    expect(pasted.content).toBe(catalog.content);

    // Bare-bundle shorthands serve the root listing.
    const rootShorthand = await akmShowUnified({ ref: "wiki//", skipLogging: true });
    expect(rootShorthand.content).toBe(catalog.content);
    const bareName = await akmShowUnified({ ref: "wiki", skipLogging: true });
    expect(bareName.content).toBe(catalog.content);

    // Stash structural files: a wiki catalog and a knowledge directory listing.
    const stashCatalog = await akmShowUnified({ ref: "local//wikis/articles/index", skipLogging: true });
    expect(stashCatalog.type).toBe("structural");
    expect(stashCatalog.content).toContain("# articles — catalog");
    const knowledgeListing = await akmShowUnified({ ref: "local//knowledge/index", skipLogging: true });
    expect(knowledgeListing.content).toContain("# Knowledge listing");

    // Fallback-only: an indexed concept still resolves the normal way.
    const concept = await akmShowUnified({ ref: "wiki//pages/http-caching", skipLogging: true });
    expect(concept.type).not.toBe("structural");
    expect(concept.name).toBe("http-caching");

    // Fragments and genuinely missing refs keep their normal errors.
    expect(akmShowUnified({ ref: "wiki//index#section", skipLogging: true })).rejects.toThrow(NotFoundError);
    expect(akmShowUnified({ ref: "wiki//pages/nope", skipLogging: true })).rejects.toThrow(NotFoundError);

    // Keep-out-of-search: no structural file has an index row.
    const db = openExistingDatabase(getDbPath());
    try {
      const paths = (db.prepare("SELECT file_path AS filePath FROM entries").all() as Array<{ filePath: string }>).map(
        (row) => row.filePath,
      );
      const structural = [
        path.join(wikiRoot, "index.md"),
        path.join(wikiRoot, "log.md"),
        path.join(wikiRoot, "schema.md"),
        path.join(storage.stashDir, "wikis", "articles", "index.md"),
        path.join(storage.stashDir, "knowledge", "index.md"),
      ];
      for (const file of structural) {
        expect(paths, `${file} must not be indexed`).not.toContain(file);
      }
    } finally {
      closeDatabase(db);
    }
  }, 30_000);

  test("lint flags catalog drift on the llm-wiki bundle, attributed to the catalog file", async () => {
    const result = await akmLint({ dir: wikiRoot });
    expect(result.ok).toBe(true);
    const catalogIssues = result.flagged.filter((i) => i.issue === "stale-index" || i.issue === "missing-index");
    expect(catalogIssues).toHaveLength(2);
    expect(catalogIssues.every((i) => i.file === "index.md")).toBe(true);
    expect(catalogIssues.some((i) => i.detail.includes("pages/orphan.md"))).toBe(true); // unlisted page
    expect(catalogIssues.some((i) => i.detail.includes("pages/ghost.md"))).toBe(true); // dangling entry
  }, 30_000);

  test("lint flags catalog drift for stash wikis and leaves a consistent wiki clean", async () => {
    const result = await akmLint({ dir: storage.stashDir });
    expect(result.ok).toBe(true);
    const catalogIssues = result.flagged.filter((i) => i.issue === "stale-index" || i.issue === "missing-index");

    const articles = catalogIssues.filter((i) => i.file === "wikis/articles/index.md");
    expect(articles).toHaveLength(2);
    expect(articles.some((i) => i.detail.includes("wikis/articles/pages/note-b.md"))).toBe(true);
    expect(articles.some((i) => i.detail.includes("wikis/articles/pages/missing.md"))).toBe(true);

    expect(catalogIssues.filter((i) => i.file === "wikis/nocat/index.md").map((i) => i.issue)).toEqual([
      "missing-index",
    ]);
    expect(catalogIssues.some((i) => i.file === "wikis/fresh/index.md")).toBe(false);
  }, 30_000);
});
