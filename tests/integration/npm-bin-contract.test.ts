import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const NPM_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?((?:[^ \t=]+=[^ \t=]+\s+)*))?([^ \t]+)(.*)$/;
const RUNTIME_DOCS = [
  "README.md",
  ".github/README.npm.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "STABILITY.md",
  "docs/guides/getting-started.md",
  "docs/agents/agent-install.md",
  "docs/guides/local-development.md",
  "docs/migration/release-notes/0.9.0.md",
  "docs/posts/intro-part-02.md",
  "docs/posts/workflows-vaults-09.md",
  "docs/architecture/internals/fresh-host-rebuild-runbook.md",
];

function npmShimInterpreter(source: string): string | undefined {
  return source.trim().split(/\r*\n/, 1)[0]?.match(NPM_SHEBANG)?.[2];
}

describe("npm bin contract", () => {
  test("uses Node as the single interpreter shared by npm's POSIX and Windows shims", () => {
    for (const bin of ["akm", "akm-migrate"]) {
      const launcher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", bin), "utf8");

      // POSIX executes this shebang and npm embeds the same interpreter in its
      // generated Windows shims. It cannot express a Bun-or-Node choice.
      expect(npmShimInterpreter(launcher)).toBe("node");
    }
  });

  test("declares the Node bootstrap required before Bun can be preferred", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.engines).toEqual({ node: ">=22" });
    expect(pkg.scripts?.preinstall).toContain("Node.js >= 22");
    expect(pkg.scripts?.preinstall).toContain("working Bun >= 1.0");
    expect(pkg.scripts?.preinstall).toContain("optional and preferred for akm and akm-migrate");
    expect(pkg.scripts?.preinstall).toContain("runtime-free standalone binary");
    expect(pkg.scripts?.preinstall).not.toContain("process.versions.bun");
    expect(pkg.scripts?.preinstall).not.toContain("bun install -g");
  });

  test("documents one npm runtime contract in diagnostics and active install docs", () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, "src", "cli.ts"), "utf8");
    expect(cli).toContain("akm-cli npm package requires Node.js >= 22");
    expect(cli).toContain("Bun >= 1.0 is optional");
    expect(cli).not.toContain("requires the Bun runtime");
    expect(cli).not.toContain("bun install -g akm-cli");

    for (const relativePath of RUNTIME_DOCS) {
      const document = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      const normalized = document.replace(/\s+/g, " ");
      expect(normalized, relativePath).toMatch(/npm package/i);
      expect(normalized, relativePath).toMatch(/Node\.js(?:\]\([^)]+\))? >= 22/i);
      expect(normalized, relativePath).toMatch(/working (?:\[)?Bun(?:\]\([^)]+\))? >= 1\.0/i);
      expect(normalized, relativePath).toMatch(/standalone binar(?:y|ies).*?runtime-free/i);
      expect(document, relativePath).not.toContain("bun install -g akm-cli");
    }
  });

  test("published bins select their supported runtime paths after the Node bootstrap", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.akm).toBe("dist/akm");
    expect(pkg.bin?.["akm-migrate"]).toBe("dist/akm-migrate");

    const akmLauncher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), "utf8");
    expect(akmLauncher.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(akmLauncher).toContain("requires Node.js >= 22 to bootstrap");
    expect(akmLauncher).toContain('new URL("./cli.js", import.meta.url)');
    expect(akmLauncher).toContain('await import("./cli-node.mjs")');

    const migrateLauncher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate"), "utf8");
    expect(migrateLauncher.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(migrateLauncher).toContain("requires Node.js >= 22 to bootstrap");
    expect(migrateLauncher).toContain('new URL("./scripts/akm-migrate.js", import.meta.url)');
    expect(migrateLauncher).toContain('process.versions.bun ? process.execPath : useBun ? "bun" : process.execPath');
    expect(migrateLauncher).not.toContain("migrate-storage-node.mjs");

    const wrapper = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "cli-node.mjs"), "utf8");
    expect(wrapper.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate-storage"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "node-runtime", "migrate-storage-node.mjs"))).toBe(false);

    for (const launcherSource of [akmLauncher, migrateLauncher]) {
      expect(launcherSource).toContain('"bun", ["--version"]');
      expect(launcherSource).toContain("bunMajor >= 1");
    }
  });
});
