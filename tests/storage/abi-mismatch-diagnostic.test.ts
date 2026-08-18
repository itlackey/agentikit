// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The Node-upgrade diagnostic, and where it has to live.
 *
 * A native binding is built for the Node ABI present at install time. Upgrade
 * Node afterwards and the same file no longer loads — the single most likely
 * failure a real npm user hits, and one akm reported as a bare Node internals
 * message ("The module … was compiled against a different Node.js version").
 *
 * The subtlety this pins: `require("better-sqlite3")` SUCCEEDS against a
 * mismatched binding, because the package resolves its `.node` file lazily. The
 * error lands at `new Database(...)`. A diagnostic wrapped around the require —
 * which is where akm's was — can therefore never see it, and the prose telling
 * the user to look for a version mismatch in "the error below" was unreachable
 * text. Verified against a real ABI-127 binding under Node 24 (ABI 137).
 */

import { describe, expect, test } from "bun:test";
import { abiMismatchRemedy } from "../../src/storage/database";

describe("ABI-mismatch diagnostic (#790 follow-up)", () => {
  test("recognises every shape a mismatched binding reports", () => {
    // Verbatim from Node 24.19.0 loading an ABI-127 build:
    const explicit =
      "The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\n" +
      "NODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 137.";
    // What a SECOND load attempt in the same process reports instead:
    const selfRegister = "Module did not self-register: '/x/better_sqlite3.node'.";
    // A binding for another platform/arch entirely:
    const elf = "/x/better_sqlite3.node: invalid ELF header";

    for (const message of [explicit, selfRegister, elf]) {
      const remedy = abiMismatchRemedy(message);
      expect(remedy, `no remedy for: ${message.slice(0, 40)}`).toBeDefined();
      // It must name the command that fixes it — verified to actually work.
      expect(remedy).toContain("npm rebuild better-sqlite3");
      // And say this is not a broken install, because it is not.
      expect(remedy).toContain("NOT a\nbroken install");
      // Naming the running ABI saves a round trip.
      expect(remedy).toContain(`ABI ${process.versions.modules}`);
    }
  });

  test("leaves unrelated load failures to the missing-binding path", () => {
    for (const message of [
      "Cannot find module 'better-sqlite3'",
      "gyp ERR! build error",
      "EACCES: permission denied, open '/x/better_sqlite3.node'",
    ]) {
      expect(abiMismatchRemedy(message), `false positive on: ${message}`).toBeUndefined();
    }
  });
});
