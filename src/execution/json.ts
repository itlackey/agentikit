// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
    return Object.freeze(value.map((child, index) => cloneExecutionJson(child, `${path}[${index}]`, nextAncestors)));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must contain only plain objects");
  const entries = Object.entries(value).map(([key, child]) => [
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
