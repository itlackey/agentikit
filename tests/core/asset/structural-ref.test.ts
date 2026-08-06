// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseBundleRootRef,
  parseStructuralRef,
  resolveStructuralFilePath,
} from "../../../src/core/asset/structural-ref";

describe("parseStructuralRef — extensionless structural show targets", () => {
  test("recognizes index/log/schema at root and nested, with and without origin", () => {
    expect(parseStructuralRef("wiki//index")).toEqual({ origin: "wiki", relPath: "index" });
    expect(parseStructuralRef("wiki//schema")).toEqual({ origin: "wiki", relPath: "schema" });
    expect(parseStructuralRef("wiki//log")).toEqual({ origin: "wiki", relPath: "log" });
    expect(parseStructuralRef("local//wikis/articles/index")).toEqual({
      origin: "local",
      relPath: "wikis/articles/index",
    });
    expect(parseStructuralRef("docs//guides/index")).toEqual({ origin: "docs", relPath: "guides/index" });
    expect(parseStructuralRef("knowledge/log")).toEqual({ relPath: "knowledge/log" });
  });

  test("the .md extension is not required — and is tolerated when pasted", () => {
    expect(parseStructuralRef("wiki//index.md")).toEqual({ origin: "wiki", relPath: "index" });
    expect(parseStructuralRef("local//wikis/articles/index.MD")).toEqual({
      origin: "local",
      relPath: "wikis/articles/index",
    });
  });

  test("the final segment matches case-insensitively; the path keeps its verbatim spelling", () => {
    expect(parseStructuralRef("local//knowledge/INDEX")).toEqual({ origin: "local", relPath: "knowledge/INDEX" });
  });

  test("bare bundle-root shorthand `<bundle>//` maps to the root listing", () => {
    expect(parseStructuralRef("wiki//")).toEqual({ origin: "wiki", relPath: "index" });
    expect(parseBundleRootRef("wiki//")).toBe("wiki");
    expect(parseBundleRootRef("wiki//index")).toBeNull();
    expect(parseBundleRootRef("//")).toBeNull();
  });

  test("non-structural refs, fragments, and unsafe paths are not structural targets", () => {
    expect(parseStructuralRef("wiki//pages/attention")).toBeNull();
    expect(parseStructuralRef("knowledge/indexing")).toBeNull();
    expect(parseStructuralRef("wiki//index#section")).toBeNull();
    expect(parseStructuralRef("wiki//../index")).toBeNull();
    expect(parseStructuralRef("../index")).toBeNull();
    expect(parseStructuralRef("/etc/index")).toBeNull();
    expect(parseStructuralRef("")).toBeNull();
    expect(parseStructuralRef("bad.slug//index")).toBeNull();
  });
});

describe("resolveStructuralFilePath — containment-guarded disk resolution", () => {
  test("resolves an existing file and returns null for a missing one", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-structural-ref-"));
    try {
      fs.mkdirSync(path.join(tmp, "wikis", "articles"), { recursive: true });
      const catalog = path.join(tmp, "wikis", "articles", "index.md");
      fs.writeFileSync(catalog, "# catalog\n");
      expect(resolveStructuralFilePath(tmp, "wikis/articles/index")).toBe(catalog);
      expect(resolveStructuralFilePath(tmp, "wikis/articles/log")).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
