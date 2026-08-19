import { describe, expect, test } from "bun:test";
import { cloneExecutionJson } from "../../src/execution/json";

describe("execution JSON boundary", () => {
  test("rejects sparse arrays instead of silently serializing holes as null", () => {
    const sparse = new Array(2);
    sparse[1] = "present";

    expect(() => cloneExecutionJson(sparse)).toThrow(/sparse|array/i);
  });

  test("rejects non-index array properties, symbols, and exotic array prototypes", () => {
    const named = ["read"] as string[] & { policy?: string };
    named.policy = "unexpected";
    expect(() => cloneExecutionJson(named)).toThrow(/array.*propert/i);

    const symbolKey = Symbol("unexpected");
    const symbolOwned = ["read"] as unknown as Record<PropertyKey, unknown>;
    symbolOwned[symbolKey] = true;
    expect(() => cloneExecutionJson(symbolOwned)).toThrow(/array.*propert/i);

    class ExoticArray<T> extends Array<T> {}
    expect(() => cloneExecutionJson(new ExoticArray("read"))).toThrow(/array.*prototype/i);
  });
});
