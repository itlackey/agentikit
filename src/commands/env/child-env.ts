// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { WIN32_SPAWN_ENV_FLOOR } from "../../core/spawn-env";

const CLEAN_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TZ",
  "NO_COLOR",
  "COLORTERM",
] as const;

export interface ChildEnvOptions {
  clean: boolean;
  inherit: string[];
}

export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  options: ChildEnvOptions,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = options.clean ? {} : { ...parentEnv };

  if (options.clean) {
    for (const key of CLEAN_ENV_ALLOWLIST) {
      if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
    }
    // The allowlist above is POSIX-shaped. On Windows a child started without
    // SystemRoot/COMSPEC/PATHEXT and friends frequently cannot start at all —
    // which is why every other spawn path in the codebase applies this floor
    // (see spawnEnvNamesFor). `env run --clean` / `secret run --clean` did not,
    // so clean-mode injection was unusable there. The floor is names the OS
    // requires of any child, not user configuration, so it does not weaken what
    // "clean" means about inherited secrets.
    if (process.platform === "win32") {
      for (const key of WIN32_SPAWN_ENV_FLOOR) {
        if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
      }
    }
  }

  for (const key of options.inherit) {
    if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
  }

  return base;
}
