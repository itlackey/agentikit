// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HEALTH_CHECKS, runModelMapProbe } from "../src/commands/health/checks";

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

  test("is registered as an ordered hard health check", () => {
    expect(HEALTH_CHECKS.find((check) => check.name === "model-map-files")?.channel).toBe("hard");
  });
});
