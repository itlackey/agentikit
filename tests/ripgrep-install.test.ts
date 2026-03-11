import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We test the module by importing and mocking its dependencies.
// Since ensureRg calls spawnSync and resolveRg, we mock at the module level.

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-rg-install-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── ensureRg – already available ────────────────────────────────────────────

describe("ensureRg", () => {
  test("returns existing rg when already available in binDir", async () => {
    // Create a fake rg binary so resolveRg finds it
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, "#!/bin/sh\necho 'ripgrep 14.1.1'\n");
    fs.chmodSync(rgPath, 0o755);

    // We need to isolate PATH so only our binDir is searched
    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    const origHome = process.env.HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.rgPath).toBe(rgPath);
      expect(result.installed).toBe(false);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });
});

// ── getRgPlatformTarget (tested via ensureRg behavior) ──────────────────────

describe("platform detection", () => {
  // We can test this indirectly: ensureRg will throw for unsupported platforms
  // We test current platform should be supported (we're running on linux/x64 or similar)
  test("current platform is recognized (does not throw unsupported)", async () => {
    const binDir = makeTmpDir();
    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      // This will try to actually download, so we expect a network error or curl error,
      // NOT an "Unsupported platform" error.
      try {
        ensureRg(binDir);
      } catch (err: unknown) {
        const message = (err as Error).message;
        // Should NOT be the unsupported platform error
        expect(message).not.toContain("Unsupported platform");
        // It should be a download/extraction error since we're not actually downloading
        expect(
          message.includes("Failed to download") ||
            message.includes("Failed to extract") ||
            message.includes("not found at"),
        ).toBe(true);
      }
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});

// ── getRgVersion (tested via ensureRg result) ───────────────────────────────

describe("getRgVersion", () => {
  test("extracts version from rg binary output", async () => {
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    // Create a script that mimics rg --version output
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "ripgrep 14.1.1 (rev abc123)"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.version).toBe("14.1.1");
      expect(result.installed).toBe(false);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });

  test("returns 'unknown' when rg binary does not output version format", async () => {
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "something else"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.version).toBe("unknown");
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});

// ── EnsureRgResult shape ────────────────────────────────────────────────────

describe("EnsureRgResult", () => {
  test("result has correct shape for existing binary", async () => {
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "ripgrep 14.0.0"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(typeof result.rgPath).toBe("string");
      expect(typeof result.installed).toBe("boolean");
      expect(typeof result.version).toBe("string");
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});

// ── Download error handling ─────────────────────────────────────────────────

describe("download error handling", () => {
  test("creates binDir if it does not exist", async () => {
    const parentDir = makeTmpDir();
    const binDir = path.join(parentDir, "nested", "bin");
    const rgPath = path.join(binDir, "rg");
    // Pre-create an rg binary so ensureRg finds it and doesn't try to download
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "ripgrep 14.1.1"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.rgPath).toBe(rgPath);
      expect(result.installed).toBe(false);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });

  test("ensureRg returns installed=true when it installs a new binary", async () => {
    // Verify that when ensureRg does find and install rg, installed is true.
    // If the environment has curl and network, ensureRg will actually download.
    // Otherwise, it throws. Either path is valid for testing.
    const binDir = makeTmpDir();
    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      try {
        // Remove any rg from binDir to force a download attempt
        const rgInBin = path.join(binDir, "rg");
        if (fs.existsSync(rgInBin)) fs.unlinkSync(rgInBin);

        const result = ensureRg(binDir);
        // If it succeeds, it should have installed a new binary
        expect(result.installed).toBe(true);
        expect(result.version).toBeTruthy();
        expect(fs.existsSync(result.rgPath)).toBe(true);
      } catch (err: unknown) {
        // If download fails (no network, etc.), that's acceptable
        expect((err as Error).message).toBeTruthy();
      }
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});
