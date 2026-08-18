// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Making a path unreadable in a test — the uid-independent way (issue #791).
 *
 * The #791 suites all need the same fixture: a path that EXISTS as a name and
 * that the process cannot resolve or read. The obvious `chmod 0000` is a trap:
 * permission bits are unenforced for uid 0, and these suites run as root in
 * containers, so a chmod-only test passes for the wrong reason in exactly the
 * environment CI uses — which is how the bug shipped in the first place.
 *
 * A **symlink loop** (`a -> b -> a`) raises `ELOOP` from `stat`/`open` for
 * every uid, root included. That is the "present as far as anyone knows, and
 * unusable" case the classifier must never report as absent, and it is the
 * primary technique across the #791 tests. Keep {@link enforcesPermissionBits}
 * for the chmod variants that are worth running *in addition* wherever bits
 * actually bite.
 */

import fs from "node:fs";
import path from "node:path";

/** Permission bits are unenforced for uid 0; the ELOOP cases cover every uid. */
export const enforcesPermissionBits = !(typeof process.getuid === "function" && process.getuid() === 0);

/**
 * Create `<dir>/<name>` as a path that exists but cannot be resolved: it and a
 * `<name>.partner` sibling point at each other, so any attempt to follow either
 * raises `ELOOP` regardless of uid. Returns the absolute path to `<name>`.
 */
export function makeUnresolvablePath(dir: string, name: string): string {
  const target = path.join(dir, name);
  const partner = path.join(dir, `${name}.partner`);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(partner, target);
  fs.symlinkSync(target, partner);
  return target;
}

/**
 * Replace an existing file with an unresolvable path of the same name — the
 * "this asset went read-restricted between runs" fixture. Returns the path.
 */
export function makePathUnresolvableInPlace(target: string): string {
  fs.rmSync(target, { force: true });
  return makeUnresolvablePath(path.dirname(target), path.basename(target));
}
