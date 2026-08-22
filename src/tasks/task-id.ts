// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../core/errors";

const VALID_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_FILE_SUFFIX_RE = /\.(?:yml|yaml)$/i;
const WINDOWS_RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

const WINDOWS_TASK_PATH_MAX_LENGTH = 238;
const WINDOWS_TASK_FOLDER_PREFIX_LENGTH = "\\akm\\".length;
const PORTABLE_FILENAME_COMPONENT_MAX_LENGTH = 255;
const LAUNCHD_FILENAME_OVERHEAD = "com.akm.task.".length + ".plist".length;
const TASK_FILENAME_OVERHEAD = ".yml".length;
const SCHTASKS_TEMP_FILENAME_OVERHEAD = "akm-task-".length + "-".length + 13 + ".xml".length;

export const MAX_PORTABLE_TASK_ID_LENGTH = Math.min(
  WINDOWS_TASK_PATH_MAX_LENGTH - WINDOWS_TASK_FOLDER_PREFIX_LENGTH,
  PORTABLE_FILENAME_COMPONENT_MAX_LENGTH - LAUNCHD_FILENAME_OVERHEAD,
  PORTABLE_FILENAME_COMPONENT_MAX_LENGTH - TASK_FILENAME_OVERHEAD,
  PORTABLE_FILENAME_COMPONENT_MAX_LENGTH - SCHTASKS_TEMP_FILENAME_OVERHEAD,
);

export function validateTaskId(id: string): string {
  if (!id) {
    throw new UsageError("Task id must be non-empty.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!VALID_TASK_ID_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use letters, digits, dots, underscores, and dashes only.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (id.length > MAX_PORTABLE_TASK_ID_LENGTH) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use at most ${MAX_PORTABLE_TASK_ID_LENGTH} characters for all supported schedulers.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (TASK_FILE_SUFFIX_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use the bare task id without a .yml or .yaml suffix.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (id.endsWith(".")) {
    throw new UsageError(
      `Task id "${id}" is invalid. Trailing periods are not portable across native schedulers.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (WINDOWS_RESERVED_DEVICE_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" uses a reserved Windows device name. Choose a different task id.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return id;
}

export function normaliseTaskId(raw: string): string {
  return validateTaskId(raw.trim());
}

/**
 * Validate an adapter component-relative task identity.
 *
 * Native `akm` task authoring remains deliberately flat and continues to use
 * {@link validateTaskId}. The standalone `akm-task` adapter, however, derives
 * identity from the complete extensionless path beneath its configured
 * component root. Validate every path segment with the portable task-id rules
 * without collapsing the `/` separators that distinguish physical owners.
 */
export function validateTaskConceptId(id: string): string {
  if (!id) throw new UsageError("Task id must be non-empty.", "MISSING_REQUIRED_ARGUMENT");
  if (id.includes("\\")) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use canonical forward slashes between path segments.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const segments = id.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new UsageError(`Task id "${id}" is invalid. Empty path segments are not allowed.`, "INVALID_FLAG_VALUE");
  }
  for (const segment of segments) validateTaskId(segment);
  return id;
}

export function normaliseTaskConceptId(raw: string): string {
  return validateTaskConceptId(raw.trim());
}
