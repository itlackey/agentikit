import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolInfo, findNearestPackageDir, shellQuote } from "../src/tool-runner";

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-toolrun-"));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ── buildToolInfo ───────────────────────────────────────────────────────────

describe("buildToolInfo", () => {
  test("returns bash kind for .sh files", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "deploy.sh");
    writeFile(toolPath, "#!/bin/bash\necho deploy\n");

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("bash");
    expect(info.runCmd).toContain("bash");
    expect(info.runCmd).toContain("deploy.sh");
    expect(info.execute.command).toBe("bash");
    expect(info.execute.args).toEqual([toolPath]);
    expect(info.install).toBeUndefined();
  });

  test("returns bun kind for .ts files without package.json", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.ts");
    writeFile(toolPath, "console.log('hi')\n");

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("bun");
    expect(info.runCmd).toContain("bun");
    expect(info.execute.command).toBe("bun");
    expect(info.install).toBeUndefined();
  });

  test("returns bun kind for .js files without package.json", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.js");
    writeFile(toolPath, "console.log('hi')\n");

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("bun");
  });

  test("includes cd to package.json directory for .ts with package.json", () => {
    const stashDir = tmpDir();
    const toolDir = path.join(stashDir, "tools", "group");
    const toolPath = path.join(toolDir, "run.ts");
    writeFile(toolPath, "console.log('hi')\n");
    writeFile(path.join(toolDir, "package.json"), '{"name":"group"}');

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("bun");
    expect(info.runCmd).toContain("cd");
    expect(info.runCmd).toContain(toolDir);
    expect(info.execute.cwd).toBe(toolDir);
  });

  test("includes bun install when AKM_BUN_INSTALL is set", () => {
    const stashDir = tmpDir();
    const toolDir = path.join(stashDir, "tools", "group");
    const toolPath = path.join(toolDir, "run.ts");
    writeFile(toolPath, "console.log('hi')\n");
    writeFile(path.join(toolDir, "package.json"), '{"name":"group"}');

    const orig = process.env.AKM_BUN_INSTALL;
    process.env.AKM_BUN_INSTALL = "true";
    try {
      const info = buildToolInfo(stashDir, toolPath);
      expect(info.runCmd).toContain("bun install");
      expect(info.install).toBeDefined();
      expect(info.install!.command).toBe("bun");
      expect(info.install!.args).toEqual(["install"]);
    } finally {
      if (orig === undefined) delete process.env.AKM_BUN_INSTALL;
      else process.env.AKM_BUN_INSTALL = orig;
    }
  });

  test("does not include bun install when AKM_BUN_INSTALL is not set", () => {
    const stashDir = tmpDir();
    const toolDir = path.join(stashDir, "tools", "group");
    const toolPath = path.join(toolDir, "run.ts");
    writeFile(toolPath, "console.log('hi')\n");
    writeFile(path.join(toolDir, "package.json"), '{"name":"group"}');

    const orig = process.env.AKM_BUN_INSTALL;
    delete process.env.AKM_BUN_INSTALL;
    try {
      const info = buildToolInfo(stashDir, toolPath);
      expect(info.runCmd).not.toContain("bun install");
      expect(info.install).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.AKM_BUN_INSTALL = orig;
    }
  });

  test("returns powershell kind for .ps1 files", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.ps1");
    writeFile(toolPath, "Write-Host 'hi'\n");

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("powershell");
    expect(info.runCmd).toContain("powershell");
    expect(info.execute.command).toBe("powershell");
  });

  test("returns cmd kind for .cmd files", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.cmd");
    writeFile(toolPath, "echo hi\n");

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("cmd");
    expect(info.execute.command).toBe("cmd");
  });

  test("returns cmd kind for .bat files", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.bat");
    writeFile(toolPath, "echo hi\n");

    const info = buildToolInfo(stashDir, toolPath);
    expect(info.kind).toBe("cmd");
  });

  test("throws for unsupported extension", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.py");
    writeFile(toolPath, "print('hi')\n");

    expect(() => buildToolInfo(stashDir, toolPath)).toThrow("Unsupported tool extension");
  });
});

// ── shellQuote ──────────────────────────────────────────────────────────────

describe("shellQuote", () => {
  test("wraps simple path in quotes", () => {
    const result = shellQuote("/path/to/file.sh");
    expect(result).toBe('"/path/to/file.sh"');
  });

  test("escapes dollar signs", () => {
    const result = shellQuote("/path/$HOME/file.sh");
    expect(result).toContain("\\$");
  });

  test("escapes backticks", () => {
    const result = shellQuote("/path/`whoami`/file.sh");
    expect(result).toContain("\\`");
  });

  test("escapes double quotes", () => {
    const result = shellQuote('/path/"quoted"/file.sh');
    expect(result).toContain('\\"');
  });

  test("throws for control characters", () => {
    expect(() => shellQuote("path\ninjection")).toThrow("Unsupported control characters");
    expect(() => shellQuote("path\rinjection")).toThrow("Unsupported control characters");
    expect(() => shellQuote("path\tinjection")).toThrow("Unsupported control characters");
    expect(() => shellQuote("path\0injection")).toThrow("Unsupported control characters");
  });

  test("handles spaces in path", () => {
    const result = shellQuote("/path/with spaces/file.sh");
    expect(result).toBe('"/path/with spaces/file.sh"');
  });
});

// ── findNearestPackageDir ───────────────────────────────────────────────────

describe("findNearestPackageDir", () => {
  test("finds package.json in the same directory", () => {
    const stashDir = tmpDir();
    const toolsRoot = path.join(stashDir, "tools");
    const toolDir = path.join(toolsRoot, "group");
    writeFile(path.join(toolDir, "package.json"), '{"name":"group"}');

    expect(findNearestPackageDir(toolDir, toolsRoot)).toBe(toolDir);
  });

  test("finds package.json in parent directory", () => {
    const stashDir = tmpDir();
    const toolsRoot = path.join(stashDir, "tools");
    const groupDir = path.join(toolsRoot, "group");
    const nestedDir = path.join(groupDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    writeFile(path.join(groupDir, "package.json"), '{"name":"group"}');

    expect(findNearestPackageDir(nestedDir, toolsRoot)).toBe(groupDir);
  });

  test("returns undefined when no package.json exists", () => {
    const stashDir = tmpDir();
    const toolsRoot = path.join(stashDir, "tools");
    const toolDir = path.join(toolsRoot, "nopackage");
    fs.mkdirSync(toolDir, { recursive: true });

    expect(findNearestPackageDir(toolDir, toolsRoot)).toBeUndefined();
  });

  test("does not look above tools root", () => {
    const stashDir = tmpDir();
    const toolsRoot = path.join(stashDir, "tools");
    const toolDir = path.join(toolsRoot, "group");
    fs.mkdirSync(toolDir, { recursive: true });
    // package.json exists above tools root but should not be found
    writeFile(path.join(stashDir, "package.json"), '{"name":"stash-root"}');

    expect(findNearestPackageDir(toolDir, toolsRoot)).toBeUndefined();
  });

  test("finds package.json at tools root itself", () => {
    const stashDir = tmpDir();
    const toolsRoot = path.join(stashDir, "tools");
    fs.mkdirSync(toolsRoot, { recursive: true });
    writeFile(path.join(toolsRoot, "package.json"), '{"name":"root"}');

    expect(findNearestPackageDir(toolsRoot, toolsRoot)).toBe(toolsRoot);
  });
});
