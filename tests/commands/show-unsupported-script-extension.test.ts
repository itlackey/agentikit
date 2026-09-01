// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { showLocal } from "../../src/commands/read/show";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "primary",
    bundles: {
      primary: {
        path: storage.stashDir,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
  });
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

async function captureShowError(ref: string): Promise<Error> {
  try {
    await showLocal({ ref });
    throw new Error(`expected ${ref} to fail`);
  } catch (error) {
    return error as Error;
  }
}

describe("show unsupported AKM script extension diagnostics", () => {
  test.each([
    "scripts/readme.txt",
    "primary//scripts/readme.txt",
  ])("reports an existing unsupported canonical script path for %s", async (ref) => {
    write(storage.stashDir, "scripts/readme.txt", "UNSUPPORTED_SCRIPT_SENTINEL\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureShowError(ref);

    expect(error.message).toMatch(/supported script extension/i);
    expect(error.message).not.toContain("UNSUPPORTED_SCRIPT_SENTINEL");
  });

  test("matches an unsupported extension case-insensitively while requiring the exact authored spelling", async () => {
    write(storage.stashDir, "scripts/report.TxT", "MIXED_CASE_SENTINEL\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const exact = await captureShowError("scripts/report.TxT");
    const wrongCase = await captureShowError("scripts/report.txt");

    expect(exact.message).toMatch(/supported script extension/i);
    expect(wrongCase.message).toMatch(/asset not found/i);
    expect(wrongCase.message).not.toMatch(/supported script extension/i);
  });

  test("keeps bare names and absent unsupported-looking canonical paths on the normal not-found path", async () => {
    write(storage.stashDir, "scripts/readme.txt", "BARE_NAME_SENTINEL\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    for (const ref of ["readme.txt", "scripts/absent.txt", "primary//scripts/absent.TXT"]) {
      const error = await captureShowError(ref);
      expect(error.message, ref).toMatch(/asset not found/i);
      expect(error.message, ref).not.toMatch(/supported script extension/i);
    }
  });

  test.each([
    "scripts/deploy.sh",
    "primary//scripts/deploy.SH",
  ])("leaves supported script extension resolution unchanged for %s", async (ref) => {
    const authored = ref.endsWith(".SH") ? "scripts/deploy.SH" : "scripts/deploy.sh";
    const scriptPath = write(storage.stashDir, authored, "#!/bin/sh\necho supported\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    await expect(showLocal({ ref })).resolves.toMatchObject({
      type: "script",
      path: scriptPath,
    });
  });

  test("does not read an unsupported script body to choose or render the diagnostic", async () => {
    const scriptPath = write(storage.stashDir, "scripts/private.txt", "SECRET_BODY_MUST_NOT_LEAK\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(scriptPath)) {
        throw new Error(`unsupported script body read: ${scriptPath}`);
      }
      return originalReadFileSync(candidate, options as never);
    }) as typeof fs.readFileSync);

    try {
      const error = await captureShowError("scripts/private.txt");
      expect(error.message).toMatch(/supported script extension/i);
      expect(error.message).not.toContain("SECRET_BODY_MUST_NOT_LEAK");
      expect(readSpy).not.toHaveBeenCalledWith(scriptPath, "utf8");
    } finally {
      readSpy.mockRestore();
    }
  });

  test("does not diagnose an unsupported symlink whose target escapes the source", async () => {
    const outsidePath = write(storage.root, "outside/private.txt", "OUTSIDE_SCRIPT_SENTINEL\n");
    const authoredPath = path.join(storage.stashDir, "scripts", "private.txt");
    fs.symlinkSync(outsidePath, authoredPath);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureShowError("scripts/private.txt");

    expect(error.message).toMatch(/asset not found/i);
    expect(error.message).not.toMatch(/supported script extension/i);
    expect(error.message).not.toContain("OUTSIDE_SCRIPT_SENTINEL");
  });
});

describe("show unsupported scripts and first-owner arbitration", () => {
  test("a valid earlier physical owner wins before a later AKM unsupported-path diagnostic", async () => {
    resetConfigCache();
    storage.cleanup();
    storage = withIsolatedAkmStorage({ AKM_BUNDLE_DIR: undefined });
    const early = path.join(storage.root, "early");
    const later = path.join(storage.root, "later");
    const earlyPath = write(early, "scripts/readme.txt.md", "# EARLY_OKF_OWNER\n");
    write(later, "scripts/readme.txt", "LATE_UNSUPPORTED_AKM_FILE\n");
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "early",
      bundles: {
        early: {
          path: early,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
        later: {
          path: later,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    resetConfigCache();
    await akmIndex({ stashDir: early, full: true });

    await expect(showLocal({ ref: "scripts/readme.txt" })).resolves.toMatchObject({
      path: earlyPath,
      content: expect.stringContaining("EARLY_OKF_OWNER"),
    });
    await expect(showLocal({ ref: "later//scripts/readme.txt" })).rejects.toThrow(/supported script extension/i);
  });
});
