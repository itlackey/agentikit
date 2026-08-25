// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Return a Node-style system error code from an error or one of its causes.
 * The bounded walk handles wrappers without trusting or parsing error text.
 */
export function systemErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/** Read-only telemetry writes are expected to disappear without diagnostics. */
export function isReadOnlyFilesystemError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "EROFS" || candidate.code === "EACCES") return true;
    current = candidate.cause;
  }
  return false;
}
