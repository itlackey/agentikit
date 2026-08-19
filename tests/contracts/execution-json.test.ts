import { describe, expect, test } from "bun:test";
import { cloneExecutionJson } from "../../src/execution/json";

describe("execution JSON boundary", () => {
  test("clones every object onto a frozen null prototype", () => {
    const cloned = cloneExecutionJson({ nested: { value: "stable" }, array: [{ child: true }] });
    if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
      throw new Error("expected cloned object");
    }
    const clonedObject = cloned as { readonly nested: unknown; readonly array: unknown };
    const nested = clonedObject.nested;
    const array = clonedObject.array;
    if (nested === null || Array.isArray(nested) || typeof nested !== "object" || !Array.isArray(array)) {
      throw new Error("expected nested clone shapes");
    }
    const arrayChild = array[0];
    if (arrayChild === null || Array.isArray(arrayChild) || typeof arrayChild !== "object") {
      throw new Error("expected cloned array child");
    }

    expect(cloned).toEqual({ nested: { value: "stable" }, array: [{ child: true }] });
    expect(Object.getPrototypeOf(cloned)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.getPrototypeOf(arrayChild)).toBeNull();
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(arrayChild)).toBe(true);
  });

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

    const nonEnumerable = ["read"];
    Object.defineProperty(nonEnumerable, "0", { value: "read", enumerable: false });
    expect(() => cloneExecutionJson(nonEnumerable)).toThrow(/array.*enumerable|enumerable.*array/i);
  });

  test("rejects symbol, non-enumerable, and accessor fields without invoking getters", () => {
    const symbolOwned = { visible: true } as Record<PropertyKey, unknown>;
    symbolOwned[Symbol("hidden")] = "unexpected";
    expect(() => cloneExecutionJson(symbolOwned)).toThrow(/symbol|unsupported field/i);

    const nonEnumerable = { visible: true } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, "hidden", { value: "unexpected", enumerable: false });
    expect(() => cloneExecutionJson(nonEnumerable)).toThrow(/non-enumerable|enumerable data/i);

    let getterReads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? "safe" : "changed";
      },
    });
    expect(() => cloneExecutionJson(accessor)).toThrow(/accessor|data propert/i);
    expect(getterReads).toBe(0);
  });

  test("snapshots each enumerable data descriptor without property reads", () => {
    let descriptorReads = 0;
    let propertyReads = 0;
    const proxied = new Proxy(
      { value: "stable" },
      {
        get: (target, key, receiver) => {
          propertyReads += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    expect(cloneExecutionJson(proxied)).toEqual({ value: "stable" });
    expect(propertyReads).toBe(0);
    expect(descriptorReads).toBe(1);
  });

  test("snapshots array length and elements through descriptors without property reads", () => {
    let descriptorReads = 0;
    let propertyReads = 0;
    const proxied = new Proxy(["read"], {
      get: (target, key, receiver) => {
        propertyReads += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor: (target, key) => {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(cloneExecutionJson(proxied)).toEqual(["read"]);
    expect(propertyReads).toBe(0);
    expect(descriptorReads).toBe(2);
  });
});
