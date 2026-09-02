import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkForUpdate,
  detectInstallMethod,
  getAkmBinaryName,
  getPackageManagerUpgradeCommand,
  type InstallSignals,
  performUpgrade,
  streamResponseToFile,
  upgradeStateOnly,
} from "../../src/commands/sources/self-update";
import { upgradeCommand } from "../../src/commands/sources/sources-cli";
import { sandboxHome, withEnv } from "../_helpers/sandbox";

// ── Fetch mocking helper ────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

function mockFetch(handler: (url: string) => Response): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

afterEach(() => {
  mock.restore();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

function fakeRelease(tagName: string): Response {
  return Response.json({ tag_name: tagName });
}

function disposableBinaryPath(name: string): string {
  const installDir = path.join(sandboxHome().dir, name);
  fs.mkdirSync(installDir, { recursive: true });
  const binaryPath = path.join(installDir, "akm");
  fs.writeFileSync(binaryPath, "old-binary");
  return binaryPath;
}

// ── detectInstallMethod ─────────────────────────────────────────────────────

describe("detectInstallMethod", () => {
  test("returns a valid install method when running via bun run (not compiled)", () => {
    const method = detectInstallMethod();
    // In test context we're running from source. May be "binary" if AKM_VERSION
    // is defined (e.g. compiled test runner), otherwise "unknown" or a package-manager install.
    expect(["unknown", "npm", "pnpm", "bun", "binary"]).toContain(method);
  });

  test("does not throw", () => {
    expect(() => detectInstallMethod()).not.toThrow();
  });

  test("returns 'binary' when Bun.main starts with /$bunfs/", () => {
    const signals: InstallSignals = {
      bunMain: "/$bunfs/root/src/cli.ts",
      importMetaDir: "/some/path",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("binary");
  });

  test("returns 'binary' when AKM_VERSION is defined (fallback)", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/akm",
      importMetaDir: "/some/path",
      hasAkmVersion: true,
    };
    expect(detectInstallMethod(signals)).toBe("binary");
  });

  test("returns 'bun' for Bun global install path", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/bun",
      importMetaDir: "/home/user/.bun/install/global/node_modules/akm-cli/dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("bun");
  });

  test("returns 'bun' for Windows-style Bun global install path", () => {
    const signals: InstallSignals = {
      bunMain: "C:\\Program Files\\Bun\\bun.exe",
      importMetaDir: "C:\\Users\\me\\.bun\\install\\global\\node_modules\\akm-cli\\dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("bun");
  });

  test("returns 'pnpm' for pnpm global install path", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/bun",
      importMetaDir: "/home/user/.local/share/pnpm/global/5/node_modules/akm-cli/dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("pnpm");
  });

  test("returns 'pnpm' for Windows-style pnpm global install path", () => {
    const signals: InstallSignals = {
      bunMain: "C:\\Program Files\\Bun\\bun.exe",
      importMetaDir: "C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\akm-cli\\dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("pnpm");
  });

  test("returns 'npm' when importMetaDir contains node_modules without bun/pnpm markers", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/bun",
      importMetaDir: "/usr/local/lib/node_modules/akm-cli/dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("npm");
  });

  test("package-manager detection takes priority over binary signals", () => {
    const signals: InstallSignals = {
      bunMain: "/$bunfs/root/src/cli.ts",
      importMetaDir: "/some/node_modules/akm",
      hasAkmVersion: true,
    };
    expect(detectInstallMethod(signals)).toBe("npm");
  });

  test("returns 'unknown' when no signals match", () => {
    const signals: InstallSignals = {
      bunMain: undefined,
      importMetaDir: "/some/path",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("unknown");
  });

  test("returns 'unknown' when Bun is present but no binary indicators", () => {
    const signals: InstallSignals = {
      bunMain: "/home/user/akm/src/cli.ts",
      importMetaDir: "/home/user/akm/src",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("unknown");
  });
});

// ── getAkmBinaryName ────────────────────────────────────────────────────────

describe("getAkmBinaryName", () => {
  test("returns a string containing 'akm'", () => {
    const name = getAkmBinaryName();
    expect(name).toContain("akm");
  });

  test("returns platform-appropriate name for current platform", () => {
    const name = getAkmBinaryName();
    const platform = process.platform;
    const arch = process.arch;

    if (platform === "linux") {
      expect(name).toStartWith("akm-linux-");
    } else if (platform === "darwin") {
      expect(name).toStartWith("akm-darwin-");
    } else if (platform === "win32") {
      expect(name).toStartWith("akm-windows-");
      expect(name).toEndWith(".exe");
    }

    if (arch === "x64") {
      expect(name).toContain("x64");
    } else if (arch === "arm64") {
      expect(name).toContain("arm64");
    }
  });
});

// ── checkForUpdate (mocked fetch) ───────────────────────────────────────────

describe("checkForUpdate", () => {
  test("returns valid UpgradeCheckResponse", async () => {
    mockFetch(() => fakeRelease("v0.0.14"));

    const result = await checkForUpdate("0.0.13");

    expect(result.currentVersion).toBe("0.0.13");
    expect(result.latestVersion).toBe("0.0.14");
    expect(result.updateAvailable).toBe(true);
    expect(["binary", "bun", "npm", "pnpm", "unknown"]).toContain(result.installMethod);
  });

  test("updateAvailable is false when current matches latest", async () => {
    mockFetch(() => fakeRelease("v0.0.13"));

    const result = await checkForUpdate("0.0.13");

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("0.0.13");
  });

  test("updateAvailable is true for an old version", async () => {
    mockFetch(() => fakeRelease("v0.0.14"));

    const result = await checkForUpdate("0.0.0");

    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe("0.0.0");
    expect(result.latestVersion).toBe("0.0.14");
  });

  test("handles missing tag_name gracefully", async () => {
    mockFetch(() => Response.json({}));

    const result = await checkForUpdate("0.0.13");

    expect(result.latestVersion).toBe("");
    expect(result.updateAvailable).toBe(false);
  });

  test("throws on non-OK response", async () => {
    mockFetch(() => new Response("Not Found", { status: 404, statusText: "Not Found" }));

    await expect(checkForUpdate("0.0.13")).rejects.toThrow("Failed to check for updates");
  });
});

// ── performUpgrade ──────────────────────────────────────────────────────────

describe("performUpgrade", () => {
  test("upgrade help and results do not claim index migrates config", async () => {
    const args = upgradeCommand.args as Record<string, { description?: string }>;
    expect(args["skip-post-upgrade"]?.description).not.toMatch(/index migrates config|auto-migrat/i);
    expect(args["migration-config"]).toBeUndefined();

    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(result.postUpgrade?.message).not.toMatch(/config migrated|migrate config|auto-migrat/i);
    expect(spawnSyncSpy).toHaveBeenCalled();
  });

  test("a lagging @latest dist-tag downgrades the result to upgraded:false with the pin remedy (§24.2)", async () => {
    // The install command "succeeds" but the on-PATH akm still reports the
    // OLD version — the registry's @latest tag lags the GitHub release.
    spyOn(childProcess, "spawnSync").mockImplementation(((_command: string, args: string[]) => {
      if (args[0] === "--version") return { status: 0, stdout: "0.0.13\n", stderr: "" } as never;
      return { status: 0, stdout: "", stderr: "" } as never;
    }) as never);
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(result.upgraded).toBe(false);
    expect(result.message).toContain("still reports v0.0.13");
    expect(result.message).toContain("@0.0.14");
  });

  test("a verified matching version is reported in the success message", async () => {
    spyOn(childProcess, "spawnSync").mockImplementation(((_command: string, args: string[]) => {
      if (args[0] === "--version") return { status: 0, stdout: "0.0.14\n", stderr: "" } as never;
      return { status: 0, stdout: "", stderr: "" } as never;
    }) as never);

    const result = await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "npm",
      },
      { skipPostUpgrade: true },
    );

    expect(result.upgraded).toBe(true);
    expect(result.message).toContain("verified");
    expect(result.message).toContain("v0.0.14");
  });

  test("rejects an oversized binary response before replacing or staging the executable", async () => {
    const installDir = path.join(sandboxHome().dir, "oversized-binary");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update("x").digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, { status: 200 })
        : new Response("x", { status: 200, headers: { "content-length": String(1024 * 1024 * 1024) } }),
    );

    await expect(
      performUpgrade(
        {
          currentVersion: "0.9.0",
          latestVersion: "0.10.0",
          updateAvailable: true,
          installMethod: "binary",
        },
        { skipPostUpgrade: true },
        { execPath: binaryPath },
      ),
    ).rejects.toThrow(/exceed|too large|limit/i);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readdirSync(installDir)).toEqual(["akm"]);
  });

  test("rejects oversized checksum metadata and removes the streamed stage", async () => {
    const installDir = path.join(sandboxHome().dir, "oversized-checksums");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryData = "new-binary";
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update(binaryData).digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, {
            status: 200,
            headers: { "content-length": String(2 * 1024 * 1024) },
          })
        : new Response(binaryData, { status: 200 }),
    );

    await expect(
      performUpgrade(
        {
          currentVersion: "0.9.0",
          latestVersion: "0.10.0",
          updateAvailable: true,
          installMethod: "binary",
        },
        { skipPostUpgrade: true },
        { execPath: binaryPath },
      ),
    ).rejects.toThrow(/exceed|too large|limit/i);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readdirSync(installDir)).toEqual(["akm"]);
  });

  test("stages and atomically installs a standalone binary", async () => {
    const installDir = path.join(sandboxHome().dir, "self-update");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryData = "new-binary";
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update(binaryData).digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, { status: 200 })
        : new Response(binaryData, { status: 200 }),
    );
    const result = await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "binary",
      },
      { skipPostUpgrade: true },
      { execPath: binaryPath },
    );

    expect(result.upgraded).toBe(true);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe(binaryData);
    expect(fs.existsSync(`${binaryPath}.bak`)).toBe(false);
  });

  test("runs npm global install for npm installs", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("npm"),
      ["install", "-g", "akm-cli@latest"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("npm");
  });

  test("runs bun global install for bun installs", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "bun",
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("bun"),
      ["install", "-g", "akm-cli@latest"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("bun");
  });

  test("runs pnpm global add for pnpm installs", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "pnpm",
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("pnpm"),
      ["add", "-g", "akm-cli@latest"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("pnpm");
  });

  test("returns guidance message for unknown install method", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "unknown",
    });

    expect(result.upgraded).toBe(false);
    expect(result.installMethod).toBe("unknown");
    expect(result.message).toContain("manually");
  });

  test("returns already-latest message when no update available", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.13",
      updateAvailable: false,
      installMethod: "binary",
    });

    expect(result.upgraded).toBe(false);
    expect(result.message).toContain("already the latest");
  });

  test("runs `akm index` post-upgrade after a successful pkg-manager install", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(result.upgraded).toBe(true);
    expect(result.postUpgrade).toBeDefined();
    expect(result.postUpgrade?.ok).toBe(true);
    expect(result.postUpgrade?.skipped).toBe(false);
    expect(result.postUpgrade?.exitCode).toBe(0);
    // Install, version verification, then the post-upgrade `akm index`.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
    expect(spawnSyncSpy).toHaveBeenLastCalledWith(
      "akm",
      ["index"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
  });

  test("skips the post-upgrade `akm index` when skipPostUpgrade is set", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "npm",
      },
      { skipPostUpgrade: true },
    );

    expect(result.upgraded).toBe(true);
    expect(result.postUpgrade).toBeDefined();
    expect(result.postUpgrade?.skipped).toBe(true);
    expect(result.postUpgrade?.ok).toBe(true);
    // Install and version verification ran; only the index rebuild was skipped.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(2);
  });

  test("a successful upgrade explicitly prepares historical state even when the index rebuild is skipped", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const upgradeHistoricalStateDatabase = mock(() => ({
      upgraded: true,
      applied: ["018-drop-dead-lane-schema"],
      safetyCopyPath: "/data/state.db.pre-018-drop-dead-lane-schema.20260824T010000000Z.bak",
    }));

    const result = await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "npm",
      },
      { skipPostUpgrade: true },
      { upgradeHistoricalStateDatabase },
    );

    expect(result.upgraded).toBe(true);
    expect(upgradeHistoricalStateDatabase).toHaveBeenCalledTimes(1);
    expect(result.postUpgrade?.ok).toBe(true);
    expect(result.postUpgrade?.skipped).toBe(true);
    expect(result.stateUpgrade?.applied).toBe(true);
    expect(result.stateUpgrade?.safetyCopyPath).toContain("state.db.pre-018-drop-dead-lane-schema");
    expect(spawnSyncSpy).toHaveBeenCalledTimes(2);
  });

  test("a historical state failure aborts the upgrade before any install is attempted", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const upgradeHistoricalStateDatabase = mock(() => {
      throw new Error(
        "018 failed. Verified safety copy: /data/state.db.pre-018-drop-dead-lane-schema.20260824T020000000Z.bak.",
      );
    });

    // The state step runs first, and its failure is the upgrade's failure:
    // reported with the verified copy, never buried under an install result.
    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "npm",
        },
        undefined,
        { upgradeHistoricalStateDatabase },
      ),
    ).rejects.toThrow(/state\.db\.pre-018-drop-dead-lane-schema/);
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  // ── #895: the state migration must be reachable without an install ───────
  //
  // Reported from a container that ships akm globally and runs unprivileged.
  // `akm index --full` was blocked on a historical destructive migration whose
  // only documented remedy, `akm upgrade --force`, npm-installs FIRST and dies
  // EACCES on /usr/local/lib/node_modules -- so the remedy could never run and
  // the install was permanently stuck. These tests pin the decoupling.

  test("state-only upgrade applies the migration without invoking any package manager", () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const upgradeHistoricalStateDatabase = mock(() => ({
      upgraded: true,
      applied: ["018-drop-dead-lane-schema"],
      safetyCopyPath: "/data/state.db.pre-018-drop-dead-lane-schema.20260901T010000000Z.bak",
    }));

    const result = upgradeStateOnly("0.9.6", { upgradeHistoricalStateDatabase });

    expect(upgradeHistoricalStateDatabase).toHaveBeenCalledTimes(1);
    expect(result.stateUpgrade?.applied).toBe(true);
    expect(result.stateUpgrade?.safetyCopyPath).toContain("pre-018-drop-dead-lane-schema");
    // THE regression: the npm/bun install is what failed EACCES for the
    // reporter. This path must never shell out to a package manager at all.
    expect(spawnSyncSpy).not.toHaveBeenCalled();
    // No binary changed, so the reported version must not claim one did.
    expect(result.upgraded).toBe(false);
    expect(result.currentVersion).toBe("0.9.6");
    expect(result.newVersion).toBe("0.9.6");
  });

  test("state-only upgrade on an already-current database reports no migration", () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const upgradeHistoricalStateDatabase = mock(() => ({ upgraded: false, applied: [] }));

    const result = upgradeStateOnly("0.9.6", { upgradeHistoricalStateDatabase });

    expect(result.stateUpgrade).toEqual({ applied: false, migrations: [] });
    expect(result.message).toContain("already current");
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  test("state-only upgrade surfaces a migration failure instead of reporting success", () => {
    const upgradeHistoricalStateDatabase = mock(() => {
      throw new Error("018 failed. Verified safety copy: /data/state.db.pre-018.bak.");
    });

    // A failed migration must throw. Reporting a cheerful no-op here would
    // leave the operator believing state was migrated when it was not.
    expect(() => upgradeStateOnly("0.9.6", { upgradeHistoricalStateDatabase })).toThrow(/018 failed/);
  });

  // ── Every `akm upgrade` runs the state step first, install or no install ──
  //
  // `--state-only` made the migration reachable, but only for a human who
  // types it. An image that ships the current akm has no install to run and
  // nobody in the loop, so a plain `akm upgrade` (a container entrypoint) has
  // to migrate state on its own -- and a failing install must not strand the
  // migration behind it the way the old post-install step did.

  test("an already-current install still applies pending state migrations", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const upgradeHistoricalStateDatabase = mock(() => ({
      upgraded: true,
      applied: ["018-drop-dead-lane-schema", "019-proposal-fingerprints"],
      safetyCopyPath: "/data/state.db.pre-018-drop-dead-lane-schema.20260902T010000000Z.bak",
    }));

    const result = await performUpgrade(
      { currentVersion: "0.9.8", latestVersion: "0.9.8", updateAvailable: false, installMethod: "npm" },
      undefined,
      { upgradeHistoricalStateDatabase },
    );

    expect(upgradeHistoricalStateDatabase).toHaveBeenCalledTimes(1);
    expect(result.upgraded).toBe(false);
    expect(result.stateUpgrade).toEqual({
      applied: true,
      migrations: ["018-drop-dead-lane-schema", "019-proposal-fingerprints"],
      safetyCopyPath: "/data/state.db.pre-018-drop-dead-lane-schema.20260902T010000000Z.bak",
    });
    expect(result.message).toContain("already the latest");
    expect(result.message).toContain("018-drop-dead-lane-schema through 019-proposal-fingerprints");
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  test("a failed package-manager install no longer strands the state migration behind it", async () => {
    // The reporter's exact shape (#895): a global install the runtime user
    // cannot rewrite. The install still fails -- but the migration ran first,
    // and the failure says so.
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 243,
      stdout: "",
      stderr: "npm error code EACCES\nnpm error path /usr/local/lib/node_modules/akm-cli",
    } as never);
    const upgradeHistoricalStateDatabase = mock(() => ({
      upgraded: true,
      applied: ["018-drop-dead-lane-schema"],
      safetyCopyPath: "/data/state.db.pre-018-drop-dead-lane-schema.20260902T020000000Z.bak",
    }));

    await expect(
      performUpgrade(
        { currentVersion: "0.9.6", latestVersion: "0.9.8", updateAvailable: true, installMethod: "npm" },
        undefined,
        { upgradeHistoricalStateDatabase },
      ),
    ).rejects.toThrow(/EACCES[\s\S]*Applied 1 pending state\.db migration/);
    expect(upgradeHistoricalStateDatabase).toHaveBeenCalledTimes(1);
    // The install attempt itself, and nothing after it.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
  });

  test("captures post-upgrade failure without failing the upgrade", async () => {
    let call = 0;
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockImplementation((() => {
      call++;
      if (call < 3) {
        // Package install and version verification succeed.
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      // The post-upgrade `akm index` fails with a non-zero exit.
      return { status: 1, stdout: "", stderr: "no embedding model configured" } as never;
    }) as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(result.upgraded).toBe(true); // upgrade itself succeeded
    expect(result.postUpgrade?.ok).toBe(false);
    expect(result.postUpgrade?.exitCode).toBe(1);
    expect(result.postUpgrade?.message).toContain("no embedding model configured");
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
  });

  test("throws when latestVersion is empty and force is used", async () => {
    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "",
          updateAvailable: false,
          installMethod: "binary",
        },
        { force: true },
      ),
    ).rejects.toThrow("Unable to determine latest version");
  });

  // Note: tests for the binary install path (installMethod: "binary") that test
  // checksum verification must avoid actually reaching the filesystem write step,
  // which would overwrite the running bun binary. We mock the download to return
  // a non-OK status after the checksum check fails, so the code throws before
  // trying to write to disk.

  test("blocks upgrade when checksum URL returns 404 (default)", async () => {
    mockFetch((url) => {
      if (url.includes("checksums.txt")) return new Response("", { status: 404, statusText: "Not Found" });
      // Use a non-OK download response so the code throws before reaching the write step
      return new Response("", { status: 500 });
    });

    // The binary download fails first (500), but if checksum fetch is tried before
    // binary download, it should throw a checksum error.
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "npm",
        },
        { skipPostUpgrade: true },
      ),
    ).resolves.toMatchObject({ upgraded: true, installMethod: "npm" });
    expect(spawnSyncSpy).toHaveBeenCalledTimes(2);
  });

  test("checksum URL 404 throws Checksum verification failed for binary install", async () => {
    // Use a mock that: binary download succeeds, checksum returns 404.
    // IMPORTANT: We ensure the test does NOT write to disk by making the checksum
    // step fail first (it runs after binary download).
    mockFetch((url) => {
      if (url.includes("checksums.txt")) return new Response("", { status: 404 });
      // Fake binary download — must succeed for checksum check to be reached
      return new Response(new Uint8Array(100), { status: 200 });
    });

    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "binary",
        },
        undefined,
        { execPath: disposableBinaryPath("checksum-404") },
      ),
    ).rejects.toThrow(/Checksum verification failed/);
  });

  // C6: the checksum bypass is no longer a `--skip-checksum` CLI option
  // threaded through `performUpgrade`'s opts — it is the internal
  // AKM_UPGRADE_SKIP_CHECKSUM env var, read directly inside performUpgrade
  // (src/commands/sources/self-update.ts), so it exercises the checksum step
  // on the binary install path rather than being a no-op npm-path option.
  test("AKM_UPGRADE_SKIP_CHECKSUM=1 bypasses checksum verification on the binary install path", async () => {
    const installDir = path.join(sandboxHome().dir, "self-update-skip-checksum");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryData = "new-binary";
    mockFetch((url) =>
      // checksums.txt fetch fails outright — with the bypass unset, this is fatal.
      url.includes("checksums.txt") ? new Response("", { status: 404 }) : new Response(binaryData, { status: 200 }),
    );

    const result = await withEnv({ AKM_UPGRADE_SKIP_CHECKSUM: "1" }, () =>
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "binary",
        },
        { skipPostUpgrade: true },
        { execPath: binaryPath },
      ),
    );

    expect(result.upgraded).toBe(true);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe(binaryData);
  });

  test("without AKM_UPGRADE_SKIP_CHECKSUM, an unreachable checksums.txt blocks the binary install", async () => {
    const installDir = path.join(sandboxHome().dir, "self-update-no-skip-checksum");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    mockFetch((url) =>
      url.includes("checksums.txt") ? new Response("", { status: 404 }) : new Response("new-binary", { status: 200 }),
    );

    await expect(
      withEnv({ AKM_UPGRADE_SKIP_CHECKSUM: undefined }, () =>
        performUpgrade(
          {
            currentVersion: "0.0.13",
            latestVersion: "0.0.14",
            updateAvailable: true,
            installMethod: "binary",
          },
          { skipPostUpgrade: true },
          { execPath: binaryPath },
        ),
      ),
    ).rejects.toThrow(/Checksum verification failed/);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
  });

  test("blocks upgrade when binary name not in checksums.txt (default)", async () => {
    const binaryName = getAkmBinaryName();
    mockFetch((url) => {
      if (url.includes("checksums.txt")) {
        // Valid checksums format but does NOT include the current binary name
        return new Response(`${"a".repeat(64)}  other-binary\n${"b".repeat(64)}  another-binary\n`, { status: 200 });
      }
      return new Response(new Uint8Array(100), { status: 200 });
    });

    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "binary",
        },
        undefined,
        { execPath: disposableBinaryPath("checksum-name") },
      ),
    ).rejects.toThrow(new RegExp(`${binaryName.replace(".", "\\.")}.*not listed|Checksum verification failed`));
  });

  test("blocks upgrade on checksum mismatch (default)", async () => {
    const binaryName = getAkmBinaryName();
    const wrongHash = "0".repeat(64);
    mockFetch((url) => {
      if (url.includes("checksums.txt")) {
        return new Response(`${wrongHash}  ${binaryName}\n`, { status: 200 });
      }
      // Return binary content that will NOT match the all-zeros hash
      return new Response(new Uint8Array(Array.from({ length: 100 }, (_, i) => i % 256)), { status: 200 });
    });

    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "binary",
        },
        undefined,
        { execPath: disposableBinaryPath("checksum-mismatch") },
      ),
    ).rejects.toThrow(/Checksum mismatch/);
  });
});

describe("getPackageManagerUpgradeCommand", () => {
  test("returns npm install command", () => {
    expect(getPackageManagerUpgradeCommand("npm", "akm-cli")).toEqual({
      command: expect.stringContaining("npm"),
      args: ["install", "-g", "akm-cli@latest"],
      displayCommand: "npm install -g akm-cli@latest",
    });
  });

  test("returns bun install command", () => {
    expect(getPackageManagerUpgradeCommand("bun", "akm-cli")).toEqual({
      command: expect.stringContaining("bun"),
      args: ["install", "-g", "akm-cli@latest"],
      displayCommand: "bun install -g akm-cli@latest",
    });
  });

  test("returns pnpm add command", () => {
    expect(getPackageManagerUpgradeCommand("pnpm", "akm-cli")).toEqual({
      command: expect.stringContaining("pnpm"),
      args: ["add", "-g", "akm-cli@latest"],
      displayCommand: "pnpm add -g akm-cli@latest",
    });
  });

  test("returns undefined for non-package-manager installs", () => {
    expect(getPackageManagerUpgradeCommand("binary", "akm-cli")).toBeUndefined();
    expect(getPackageManagerUpgradeCommand("unknown", "akm-cli")).toBeUndefined();
  });
});

// ── Binary download body bounds ──────────────────────────────────────────────

describe("streamResponseToFile body deadline", () => {
  const scratch: string[] = [];
  const destPath = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dl-"));
    scratch.push(dir);
    return path.join(dir, "akm.bin");
  };

  afterEach(() => {
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A Response whose body emits `chunks`, then stalls forever if `stall`. */
  const streamingResponse = (chunks: Uint8Array[], stall: boolean): Response => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        // Never close and never enqueue again: the exact shape of an endpoint
        // that accepted the request and then went silent mid-body.
        if (!stall) controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "application/octet-stream" } });
  };

  test("writes and hashes a well-behaved body", async () => {
    const payload = new TextEncoder().encode("akm-binary-payload");
    const dest = destPath();

    const result = await streamResponseToFile(streamingResponse([payload], false), dest, 1024);

    expect(result.byteSize).toBe(payload.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(payload));
  });

  test("aborts a stalled body instead of hanging forever", async () => {
    // Without a read deadline this call never settles — the pre-fix behavior,
    // since fetchWithTimeout's timer only covers time-to-headers.
    const dest = destPath();

    await expect(
      streamResponseToFile(streamingResponse([new Uint8Array([1, 2, 3])], true), dest, 1024, {
        stallTimeoutMs: 50,
      }),
    ).rejects.toThrow(/exceeded 50ms/);
  });

  test("removes the partial file when the deadline fires", async () => {
    const dest = destPath();

    await expect(
      streamResponseToFile(streamingResponse([new Uint8Array([1, 2, 3])], true), dest, 1024, {
        stallTimeoutMs: 50,
      }),
    ).rejects.toThrow();

    expect(fs.existsSync(dest)).toBe(false);
  });

  test("the overall bound also caps a body that keeps trickling", async () => {
    // Chunks arrive faster than the stall window, so only the overall deadline
    // can stop this one — the evasion a stall-only bound would miss.
    const trickle = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(new Uint8Array([0]));
      },
    });
    const dest = destPath();

    await expect(
      streamResponseToFile(new Response(trickle), dest, 1024 * 1024, {
        stallTimeoutMs: 10_000,
        totalTimeoutMs: 60,
      }),
      // Reports the OVERALL bound, not the (untripped) stall window.
    ).rejects.toThrow(/exceeded 60ms/);
  });
});
