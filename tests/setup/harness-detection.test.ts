// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Harness auto-detection and PATH probing.
 *
 * `detectHarness` used to return `opencode-sdk` whenever `import(
 * '@opencode-ai/sdk')` resolved — but the SDK is a hard dependency of akm-cli
 * itself, so that import ALWAYS resolves and every machine was reported as
 * opencode-sdk (its CLI fallbacks were unreachable). Headless setup then wrote
 * that engine everywhere and the first agentic command died with spawn ENOENT
 * on machines with no `opencode` binary. These tests pin the corrected
 * contract: in-process/SDK dispatch is preferred, but only when the server
 * binary it spawns is actually present; otherwise CLI harnesses are probed in
 * registry order.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWhich, type WhichFn } from "../../src/integrations/agent/detect";
import { detectHarness } from "../../src/setup/detect";

/** A `which` stub resolving exactly the named binaries. */
const whichFor = (...available: string[]): WhichFn => {
  const set = new Set(available);
  return (bin: string) => (set.has(bin) ? `/usr/local/bin/${bin}` : undefined);
};

describe("detectHarness", () => {
  test("prefers the SDK when the opencode server binary is on PATH", async () => {
    expect(await detectHarness(whichFor("opencode"))).toBe("opencode-sdk");
  });

  test("prefers the SDK over any other installed CLI", async () => {
    expect(await detectHarness(whichFor("opencode", "claude", "codex"))).toBe("opencode-sdk");
  });

  test("does NOT report opencode-sdk when its server binary is absent", async () => {
    // The regression: the bundled SDK import resolves in this very process, so
    // an import-only check would answer "opencode-sdk" here.
    expect(await detectHarness(whichFor("claude"))).toBe("claude");
  });

  test("falls back to CLI subprocess harnesses in registry order", async () => {
    expect(await detectHarness(whichFor("claude", "codex"))).toBe("claude");
    expect(await detectHarness(whichFor("codex", "gemini"))).toBe("codex");
    expect(await detectHarness(whichFor("gemini"))).toBe("gemini");
    // `q` is amazonq's binary — detection reports the harness id, not the bin.
    expect(await detectHarness(whichFor("q"))).toBe("amazonq");
  });

  test("returns none when no harness binary is installed", async () => {
    expect(await detectHarness(whichFor())).toBe("none");
  });
});

describe("defaultWhich", () => {
  const posixEnv = { PATH: "/nope/a:/nope/b" } as NodeJS.ProcessEnv;

  test("returns undefined without a PATH", () => {
    expect(defaultWhich("claude", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test("finds nothing for a bin that is not on PATH", () => {
    expect(defaultWhich("definitely-not-installed-akm-test", posixEnv)).toBeUndefined();
  });

  test("resolves a real file on PATH", () => {
    // `sh` is guaranteed on the POSIX runners this suite targets.
    const resolved = defaultWhich("sh", { PATH: "/bin:/usr/bin" } as NodeJS.ProcessEnv);
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/\/sh$/);
  });

  test("probes PATHEXT spellings so Windows shims resolve", () => {
    // Windows installs agent CLIs as `claude.cmd` / `q.exe`; an exact-name
    // probe reports every one of them missing, which silently hid the
    // "installed CLI agent" option on Windows. PATHEXT in the env is the seam
    // that lets this be covered from a POSIX runner.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-pathext-"));
    try {
      // Windows resolves PATHEXT case-insensitively; this POSIX runner does
      // not, so the fixture matches the PATHEXT spelling exactly.
      fs.writeFileSync(path.join(shimDir, "claude.CMD"), "@echo off\n");
      const winEnv = { PATH: shimDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;

      expect(defaultWhich("claude", winEnv)).toBe(path.join(shimDir, "claude.CMD"));
      // Without PATHEXT (POSIX), the extension-bearing shim stays invisible.
      expect(defaultWhich("claude", { PATH: shimDir } as NodeJS.ProcessEnv)).toBeUndefined();
      expect(defaultWhich("definitely-not-installed-akm-test", winEnv)).toBeUndefined();
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("prefers a bare name over its PATHEXT spellings", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-pathext-"));
    try {
      fs.writeFileSync(path.join(shimDir, "codex"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(shimDir, "codex.CMD"), "@echo off\n");
      const winEnv = { PATH: shimDir, PATHEXT: ".CMD" } as NodeJS.ProcessEnv;

      expect(defaultWhich("codex", winEnv)).toBe(path.join(shimDir, "codex"));
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("keeps bare-name resolution first on POSIX", () => {
    expect(defaultWhich("sh", { PATH: "/bin" } as NodeJS.ProcessEnv)).toBe("/bin/sh");
  });
});
