// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";

/**
 * Best-effort portable directory durability fence.
 *
 * POSIX filesystems that implement directory fsync surface real I/O failures.
 * Platforms/filesystems that cannot open or fsync directories report one of
 * the documented unsupported-operation codes and retain the durable file
 * fsync + atomic rename guarantees. All migrator publication legs use this one
 * helper so retry behavior cannot diverge between format generations.
 */
export function fsyncDirectoryPortable(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw cause;
  }
}
