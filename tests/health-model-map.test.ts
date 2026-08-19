// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HEALTH_CHECKS, runModelMapProbe } from "../src/commands/health/checks";
import { runCliCapture } from "./_helpers/cli";
import { withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("models.json health diagnostics", () => {
  test("treats an absent optional user file as healthy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-absent-"));
    try {
      expect(runModelMapProbe({ env: { XDG_CONFIG_HOME: root } })).toMatchObject({
        name: "model-map-files",
        status: "pass",
        evidence: { userStatus: "absent", userPath: path.join(root, "akm", "models.json") },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports invalid or unreadable user files as actionable warnings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-user-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    const target = path.join(root, "akm", "models.json");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"version":1,"aliases":{"reasoning":{"claude":{"inference":false}}}}');
      const invalid = runModelMapProbe({ env });
      expect(invalid.status).toBe("warn");
      expect(invalid.message).toContain(target);
      expect(invalid.message).toContain("$.aliases.reasoning.claude.inference");
      expect(invalid.message).toMatch(/remove.*installed defaults/i);

      fs.rmSync(target);
      fs.mkdirSync(target);
      const unreadable = runModelMapProbe({ env });
      expect(unreadable.status).toBe("warn");
      expect(unreadable.message).toMatch(/readable regular file/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an invalid installed map as an installation failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-installed-"));
    try {
      const result = runModelMapProbe({ env: { XDG_CONFIG_HOME: root }, installedText: "not-json" });
      expect(result.status).toBe("fail");
      expect(result.message).toMatch(/installed models\.json.*installation/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bun CLI health never echoes invalid user JSON or version values", async () => {
    const storage = withIsolatedAkmStorage();
    const userMap = path.join(storage.configDir, "akm", "models.json");
    fs.mkdirSync(path.dirname(userMap), { recursive: true });
    try {
      for (const [text, sentinel] of [
        ["BUNJSONPARSESECRETSENTINEL802", "BUNJSONPARSESECRETSENTINEL802"],
        [JSON.stringify({ version: "BUNVERSIONSECRETSENTINEL802", aliases: {} }), "BUNVERSIONSECRETSENTINEL802"],
      ] as const) {
        fs.writeFileSync(userMap, text, { mode: 0o600 });
        const result = await withEnv(
          {
            AKM_BUNDLE_DIR: storage.stashDir,
            XDG_CONFIG_HOME: storage.configDir,
            XDG_DATA_HOME: storage.dataDir,
            XDG_CACHE_HOME: storage.cacheDir,
            XDG_STATE_HOME: storage.stateDir,
          },
          () => runCliCapture(["health"]),
        );
        expect(result.stdout + result.stderr).not.toContain(sentinel);
        const output = JSON.parse(result.stdout) as {
          hardChecks?: Array<{ name?: string; status?: string }>;
        };
        expect(output.hardChecks?.find((check) => check.name === "model-map-files")).toMatchObject({
          status: "warn",
        });
      }
    } finally {
      storage.cleanup();
    }
  });

  test("is registered as an ordered hard health check", () => {
    expect(HEALTH_CHECKS.find((check) => check.name === "model-map-files")?.channel).toBe("hard");
  });
});
