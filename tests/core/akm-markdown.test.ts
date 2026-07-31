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
    // Conformant means type AND updated — `akm lint` flags a frontmatter-
    // bearing document with no `updated` as `missing-updated`.
    const input = "---\ntype: workflow\nupdated: 2026-01-15\ndescription: Keep formatting\n---\n\n# Workflow: Test\n";
    expect(ensureAkmMarkdownType(input, "workflow")).toBe(input);
  });

  // Every asset akm writes goes through this chokepoint. Without an `updated`
  // stamp, `akm remember` / `akm import` / accepted proposals produced files
  // that akm's own `akm lint` immediately flagged `missing-updated`.
  describe("updated stamp", () => {
    const FIXED_NOW = new Date(2026, 2, 14); // 2026-03-14, local time

    test("stamps updated when adding frontmatter to a bare body", () => {
      const parsed = parseFrontmatter(ensureAkmMarkdownType("Body bytes.\n", "knowledge", FIXED_NOW));
      expect(parsed.data.type).toBe("knowledge");
      expect(parsed.data.updated).toBe("2026-03-14");
    });

    test("stamps updated on an existing frontmatter block that lacks it", () => {
      const input = "---\ntype: memory\ndescription: Note\n---\n\nBody.\n";
      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "memory", FIXED_NOW));
      expect(parsed.data.updated).toBe("2026-03-14");
      expect(parsed.data.description).toBe("Note");
      expect(parsed.content).toBe("\nBody.\n");
    });

    test("never overwrites an author's existing updated value", () => {
      const input = "---\ntype: knowledge\nupdated: 2020-01-01\n---\n\nBody.\n";
      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "knowledge", FIXED_NOW));
      expect(parsed.data.updated).toBe("2020-01-01");
    });

    test("preserves YAML comments and formatting when only adding updated", () => {
      // Round-tripping the mapping through the serializer to contribute one
      // field would silently erase user-authored comments — unacceptable for
      // a write path every accepted proposal and asset edit passes through.
      const input = [
        "---",
        "type: knowledge",
        "# rotate quarterly — see runbook",
        'description: "Prod notes"',
        "---",
        "",
        "Body.",
      ].join("\n");

      const out = ensureAkmMarkdownType(input, "knowledge", FIXED_NOW);

      expect(out).toContain("# rotate quarterly — see runbook");
      expect(out).toContain('description: "Prod notes"');
      expect(parseFrontmatter(out).data.updated).toBe("2026-03-14");
      expect(parseFrontmatter(out).content).toBe("\nBody.\n".replace(/\n$/, ""));
    });

    test("stamps updated even when the type already matches", () => {
      // The type check used to short-circuit the whole function, so a
      // correctly-typed document could never acquire the stamp.
      const input = "---\ntype: knowledge\ndescription: Already typed\n---\n\nBody.\n";
      const parsed = parseFrontmatter(ensureAkmMarkdownType(input, "knowledge", FIXED_NOW));
      expect(parsed.data.updated).toBe("2026-03-14");
    });
  });
});
