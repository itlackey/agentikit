// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { snapshotStrictRecord } from "./record";

/** JSON-safe values carried across the frozen execution boundary. */
export type ExecutionJsonPrimitive = string | number | boolean | null;
export interface ExecutionJsonObject {
  readonly [key: string]: ExecutionJsonValue;
}
export interface ExecutionJsonArray extends ReadonlyArray<ExecutionJsonValue> {}
export type ExecutionJsonValue = ExecutionJsonPrimitive | ExecutionJsonArray | ExecutionJsonObject;

function fail(path: string, detail: string): never {
  throw new TypeError(`${path} ${detail}`);
}

/**
 * Validate, clone, and freeze a value for durable JSON transport.
 *
 * `undefined`, non-finite numbers, non-plain objects, and cycles are rejected
 * instead of being silently rewritten by `JSON.stringify`. That makes field
 * presence meaningful at the execution boundary: omit a key, or provide an
 * explicit JSON value (including `false`, `0`, `[]`, `{}`, `""`, or `null`).
 */
export function cloneExecutionJson(
  value: unknown,
  path = "execution value",
  ancestors: ReadonlySet<object> = new Set(),
): ExecutionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite numbers");
    return value;
  }
  if (value === undefined) fail(path, "must be omitted rather than set to undefined");
  if (typeof value !== "object") fail(path, "must be JSON-safe");
  if (ancestors.has(value)) fail(path, "must not contain a cycle");

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, "array must use the standard Array prototype");
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      fail(path, "array length must be a stable nonnegative integer data property");
    }
    const length = lengthDescriptor.value;
    if (ownKeys.length !== length + 1) {
      fail(path, "array must be dense and contain no non-index properties");
    }
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
        fail(path, "array must contain only canonical index properties");
      }
    }
    const cloned: ExecutionJsonValue[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail(path, "array must be dense enumerable data properties");
      }
      cloned.push(cloneExecutionJson(descriptor.value, `${path}[${index}]`, nextAncestors));
    }
    return Object.freeze(cloned);
  }

  const snapshot = snapshotStrictRecord(value, path);
  const entries = Object.entries(snapshot).map(([key, child]) => [
    key,
    cloneExecutionJson(child, `${path}.${key}`, nextAncestors),
  ]) as Array<[string, ExecutionJsonValue]>;
  return Object.freeze(Object.fromEntries(entries));
}

export function cloneExecutionJsonObject(value: unknown, path: string): ExecutionJsonObject {
  const cloned = cloneExecutionJson(value, path);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    fail(path, "must be a JSON object");
  }
  return cloned as ExecutionJsonObject;
}

/** Stable object-key ordering for request fingerprints; array order is semantic. */
export function sortExecutionJson(value: ExecutionJsonValue): ExecutionJsonValue {
  if (Array.isArray(value)) return value.map(sortExecutionJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortExecutionJson(child)]),
  );
}
