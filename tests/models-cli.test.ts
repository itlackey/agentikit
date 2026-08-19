// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli";
import { readInstalledModelMapText } from "../src/integrations/agent/model-map";
import { runCliCapture } from "./_helpers/cli";
import { withEnv } from "./_helpers/sandbox";

describe("akm models copy-defaults", () => {
  test("copies installed defaults and requires --overwrite for an existing regular file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-models-cli-"));
    const target = path.join(root, "akm", "models.json");
    try {
      await withEnv({ XDG_CONFIG_HOME: root }, async () => {
        const first = await runCliCapture(["models", "copy-defaults"]);
        expect(first.code).toBe(0);
        expect(JSON.parse(first.stdout)).toEqual({
          path: target,
          copied: true,
          overwritten: false,
          shape: "models",
          schemaVersion: 1,
        });
        expect(fs.readFileSync(target, "utf8")).toBe(readInstalledModelMapText());

        fs.writeFileSync(target, "operator bytes");
        const refused = await runCliCapture(["models", "copy-defaults"]);
        expect(refused.code).toBe(2);
        expect(JSON.parse(refused.stderr)).toMatchObject({
          ok: false,
          code: "RESOURCE_ALREADY_EXISTS",
        });
        expect(fs.readFileSync(target, "utf8")).toBe("operator bytes");

        const replaced = await runCliCapture(["models", "copy-defaults", "--overwrite"]);
        expect(replaced.code).toBe(0);
        expect(JSON.parse(replaced.stdout)).toMatchObject({ copied: true, overwritten: true, path: target });
        expect(fs.readFileSync(target, "utf8")).toBe(readInstalledModelMapText());
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("is listed as a system command with its explicit overwrite flag", async () => {
    const root = await runCliCapture(["--help"]);
    expect(root.code).toBe(0);
    expect(root.stdout).toContain("models");
    const models = (main.subCommands as Record<string, { subCommands?: Record<string, { args?: object }> }>).models;
    expect(models?.subCommands?.["copy-defaults"]?.args).toHaveProperty("overwrite");
  });
});
