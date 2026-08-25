// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test.skipIf(process.platform === "win32")("models.json rejects a FIFO promptly instead of blocking on read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-models-fifo-"));
  const target = path.join(root, "models.json");
  try {
    const made = spawnSync("mkfifo", [target], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/integrations/agent/model-map.ts")).href;
    const script = [
      `const { loadModelMap } = await import(${JSON.stringify(moduleUrl)});`,
      `try { loadModelMap({ env: { AKM_CONFIG_DIR: ${JSON.stringify(root)} } }); process.exit(0); }`,
      `catch (error) { console.error(error?.code, error?.message); process.exit(error?.code === "INVALID_CONFIG_FILE" ? 78 : 70); }`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 2_000,
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/regular file/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a registered standalone model map is authoritative over mutable external assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-standalone-model-authority-"));
  try {
    const output = path.join(root, "resolved-models.json");
    const embedded = `${JSON.stringify({ version: 1, aliases: { fast: { claude: "embedded-authority-802" } } }, null, 2)}\n`;
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/integrations/agent/model-map.ts")).href;
    const script = [
      `const fs = await import("node:fs");`,
      `const { readInstalledModelMapText, registerStandaloneModelMapFallback } = await import(${JSON.stringify(moduleUrl)});`,
      `registerStandaloneModelMapFallback(${JSON.stringify(embedded)});`,
      `fs.writeFileSync(${JSON.stringify(output)}, readInstalledModelMapText());`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 2_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe(embedded);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
