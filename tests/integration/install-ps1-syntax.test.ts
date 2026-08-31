// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * install.ps1 (the Windows installer) has no automated execution coverage
 * anywhere in this repo — unlike install.sh, it cannot be exercised
 * end-to-end without a real Windows host: its PATH-persistence step
 * (`[Environment]::SetEnvironmentVariable(..., "User")`) throws
 * PlatformNotSupportedException under PowerShell on Linux/macOS, so a fake
 * harness mirroring install-script.test.ts cannot deterministically drive it
 * outside a Windows runner (see #770).
 *
 * This is the cheap slice that IS deterministic everywhere PowerShell (pwsh)
 * is available, including GitHub's ubuntu-latest runners which ship it: a
 * static parse of install.ps1 through PowerShell's own parser, with no
 * network access and no script execution. It catches syntax regressions
 * (unbalanced braces, malformed expressions, ...) — a real risk for a script
 * that contributors without a Windows machine can only edit blind — but it
 * does NOT catch semantic bugs (wrong cmdlet, wrong logic) or anything that
 * only manifests when the script actually runs on Windows.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const INSTALL_PS1 = path.join(PROJECT_ROOT, "install.ps1");

function resolvePwsh(): string | undefined {
  const result = spawnSync("bash", ["-lc", "command -v pwsh"], { encoding: "utf8" });
  const resolved = result.stdout.trim();
  return result.status === 0 && resolved ? resolved : undefined;
}

const PWSH_PATH = resolvePwsh();

describe("install.ps1", () => {
  test.skipIf(!PWSH_PATH)("parses as syntactically valid PowerShell", () => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$tokens = $null",
      "$parseErrors = $null",
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${INSTALL_PS1}', [ref]$tokens, [ref]$parseErrors)`,
      "if ($parseErrors.Count -gt 0) {",
      "  $parseErrors | ForEach-Object { Write-Output 'PARSE ERROR:' $_ }",
      "  exit 1",
      "}",
      "exit 0",
    ].join("\n");

    const result = spawnSync(PWSH_PATH!, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
    });

    expect(result.stdout + result.stderr).not.toContain("PARSE ERROR");
    expect(result.status).toBe(0);
  });
});
