import { describe, expect, test } from "bun:test";

import { aggregateSessionEvents, collectSessionEvents, normalizeSessionTopic } from "../src/integrations/session-logs";
import type {
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionSummary,
} from "../src/integrations/session-logs/types";

describe("session log aggregation", () => {
  test("normalizes topic text into a shared aggregation key", () => {
    expect(normalizeSessionTopic("  Error: build failed on deploy   ")).toBe("error: build failed on deploy");
  });

  test("deduplicates repeated failure patterns across harnesses", () => {
    const events: SessionEvent[] = [
      { harness: "claude", text: "Error: build failed on deploy" },
      { harness: "opencode", text: "error: build failed on deploy" },
      { harness: "opencode", text: "error: build failed on deploy" },
      { harness: "claude", text: "all good now" },
    ];

    const entries = aggregateSessionEvents(events);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      topic: "error: build failed on deploy",
      frequency: 3,
      source: "claude,opencode",
      isFailurePattern: true,
    });
  });

  test("collectSessionEvents surfaces structured readSession content to the candidate path (#568)", () => {
    // The readSession pipeline exposes structured tool-call content.
    const summaries: SessionSummary[] = [
      { harness: "rich", sessionId: "s1", filePath: "/sessions/s1.jsonl", endedAt: 2 },
    ];
    const richSession: SessionData = {
      ref: summaries[0] as SessionSummary,
      events: [
        { harness: "rich", text: "[tool_result] error: deploy step failed", role: "tool" },
        { harness: "rich", text: "[tool_result] error: deploy step failed", role: "tool" },
      ],
      inlineRefs: [],
    };
    const richHarness: SessionLogHarness = {
      name: "rich",
      isAvailable: () => true,
      listSessions: () => summaries,
      readSession: () => richSession,
    };

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const entries = aggregateSessionEvents(collectSessionEvents([richHarness], sinceMs));
    // The repeated tool-failure pattern is only present in the readSession data.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.topic).toBe("[tool_result] error: deploy step failed");
    expect(entries[0]?.frequency).toBe(2);
    expect(entries[0]?.isFailurePattern).toBe(true);
    expect(entries[0]?.source).toBe("rich");
  });

  test("collectSessionEvents returns no events when no sessions are listed", () => {
    const harness: SessionLogHarness = {
      name: "empty",
      isAvailable: () => true,
      listSessions: () => [],
      readSession: () => {
        throw new Error("readSession must not run without a listed session");
      },
    };
    expect(collectSessionEvents([harness], Date.now() - 60_000)).toEqual([]);
  });
});
