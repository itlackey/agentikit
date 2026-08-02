import { describe, expect, test } from "bun:test";
import { buildWebsiteOptions } from "../src/commands/sources/add-cli";
import { shouldAddAsWebsiteUrl } from "../src/commands/sources/source-add";

describe("buildWebsiteOptions", () => {
  test("parses website crawl limits as numbers", () => {
    expect(buildWebsiteOptions({ "max-pages": "12", "max-depth": "4" })).toEqual({ maxPages: 12, maxDepth: 4 });
  });

  test("rejects non-positive website crawl limits", () => {
    expect(() => buildWebsiteOptions({ "max-pages": "0" })).toThrow("Invalid --max-pages value");
    expect(() => buildWebsiteOptions({ "max-depth": "-1" })).toThrow("Invalid --max-depth value");
  });
});

describe("shouldAddAsWebsiteUrl", () => {
  test("treats docs-style URLs as website sources", () => {
    expect(shouldAddAsWebsiteUrl("https://docs.example.com/guide")).toBe(true);
  });

  test("keeps known git hosts on the registry install path", () => {
    expect(shouldAddAsWebsiteUrl("https://gitlab.com/acme/project")).toBe(false);
    expect(shouldAddAsWebsiteUrl("https://example.com/acme/project.git")).toBe(false);
  });
});
