import { describe, expect, test } from "bun:test";

import { normalizeSessionTopic } from "../src/integrations/session-logs";

describe("session log aggregation", () => {
  test("normalizes topic text into a shared aggregation key", () => {
    expect(normalizeSessionTopic("  Error: build failed on deploy   ")).toBe("error: build failed on deploy");
  });
});
