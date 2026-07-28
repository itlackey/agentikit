import { describe, expect, test } from "bun:test";
import { ensureAkmMarkdownType } from "../../src/core/asset/akm-markdown";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";

describe("AKM Markdown OKF compatibility", () => {
  test("adds the native type without changing the body", () => {
    const body = "# A note\n\nBody bytes.\n";
    const output = ensureAkmMarkdownType(body, "knowledge");
    const parsed = parseFrontmatter(output);
    expect(parsed.data.type).toBe("knowledge");
    expect(parsed.content).toBe(body);
  });

  test("preserves nested metadata and body while correcting type", () => {
    const input = "---\ntype: Vendor\nvendor:\n  nested: 42\n---\n\nBody.\n";
    const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "memory"));
    expect(parsed.data.type).toBe("memory");
    expect(parsed.data.vendor).toEqual({ nested: 42 });
    expect(parsed.content).toBe("\nBody.\n");
  });

  test("leaves an already conformant native document byte-identical", () => {
    const input = "---\ntype: workflow\ndescription: Keep formatting\n---\n\n# Workflow: Test\n";
    expect(ensureAkmMarkdownType(input, "workflow")).toBe(input);
  });
});
