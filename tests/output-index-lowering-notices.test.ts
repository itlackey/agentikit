import { describe, expect, test } from "bun:test";
import { formatIndexPlain } from "../src/output/text/command-format";

describe("index lowering notices", () => {
  test("plain output surfaces safe notice fields without serializing details", () => {
    const text = formatIndexPlain({
      totalEntries: 1,
      directoriesScanned: 1,
      mode: "full",
      notices: [
        {
          code: "untranslated-field",
          severity: "warning",
          adapter: "llm",
          field: "inference.effort",
          message: "The selected adapter cannot translate this field.",
          details: { secret: "INDEX_NOTICE_SECRET_SENTINEL" },
        },
      ],
    });

    expect(text).toContain("notice[warning] untranslated-field adapter=llm field=inference.effort");
    expect(text).toContain("The selected adapter cannot translate this field.");
    expect(text).not.toContain("INDEX_NOTICE_SECRET_SENTINEL");
  });
});
