import { describe, expect, test } from "bun:test";
import { resolveTaskHistoryId } from "../../src/commands/tasks/tasks-cli";
import { UsageError } from "../../src/core/errors";

// #911: `akm task history <id>` used to accept the positional id and drop it.
describe("resolveTaskHistoryId", () => {
  test("a positional id alone filters", () => {
    expect(resolveTaskHistoryId("nightly", undefined)).toBe("nightly");
  });

  test("--id alone filters", () => {
    expect(resolveTaskHistoryId(undefined, "nightly")).toBe("nightly");
  });

  test("neither means every task", () => {
    expect(resolveTaskHistoryId(undefined, undefined)).toBeUndefined();
  });

  test("both with the same value is fine", () => {
    expect(resolveTaskHistoryId("nightly", "nightly")).toBe("nightly");
  });

  test("both with different values is a usage error, not a silent pick", () => {
    expect(() => resolveTaskHistoryId("nightly", "weekly")).toThrow(UsageError);
    expect(() => resolveTaskHistoryId("nightly", "weekly")).toThrow(/two task ids/);
  });
});
