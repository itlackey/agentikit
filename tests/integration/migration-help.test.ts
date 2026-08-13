import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBundledReleaseVersions, renderMigrationHelp } from "../../src/commands/sources/migration-help";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RELEASE_NOTES_DIR = path.join(PROJECT_ROOT, "docs", "migration", "release-notes");

describe("migration help", () => {
  test("renders bundled migration guidance when changelog is unavailable", () => {
    const result = renderMigrationHelp("0.5.0", undefined);
    expect(result).toContain("Migration notes for akm v0.5.0");
    expect(result).toContain("akm wiki");
  });

  test("normalizes v-prefixed prerelease versions to the stable release notes", () => {
    const result = renderMigrationHelp("v0.5.0-rc1");
    expect(result).toContain("Migration notes for akm v0.5.0");
    expect(result).toContain("## [0.5.0]");
  });

  test("supports latest alias when changelog text is available", () => {
    const result = renderMigrationHelp("latest");
    // Derive the expected version from the changelog so this never re-breaks on a
    // version bump: "latest" resolves to the newest RELEASED (non-Unreleased) section.
    const changelog = fs.readFileSync(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
    const latest = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
      .map((m) => m[1])
      .find((v) => v!.toLowerCase() !== "unreleased");
    expect(latest).toBeTruthy();
    expect(result).toContain(`## [${latest}]`);
  });

  test("ensures published static files exist in the repo", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };

    const staticFiles = (packageJson.files ?? []).filter((entry) => entry !== "dist");
    // CHANGELOG.md and LICENSE are auto-published by npm from the package root
    // and intentionally NOT listed in files[] to avoid duplicate shipment.
    expect(staticFiles).toContain("docs/migration/release-notes");
    expect(staticFiles).toContain("docs/migration/v0.7-to-v0.8.md");
    for (const entry of staticFiles) {
      expect(fs.existsSync(path.join(PROJECT_ROOT, entry))).toBe(true);
    }
    expect(fs.existsSync(path.join(PROJECT_ROOT, "CHANGELOG.md"))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_ROOT, "LICENSE"))).toBe(true);
  });

  test("every bundled release-notes file is surfaced by the loader", () => {
    const bundled = listBundledReleaseVersions();
    expect(bundled.length).toBeGreaterThan(0);
    // Sanity: every known prior release has a note. Adding a new file to
    // docs/migration/release-notes/ should be all it takes to extend this.
    for (const version of ["0.0.13", "0.1.0", "0.2.0", "0.3.0", "0.5.0", "0.6.0", "0.7.5", "0.9.0"]) {
      expect(bundled).toContain(version);
      const result = renderMigrationHelp(version, undefined);
      expect(result).toContain(`Migration notes for akm v${version}`);
    }
  });

  test("latest alias resolves to the changelog section for the shipping version", () => {
    // Derived from package.json, NOT hardcoded. `resolveLatestVersion()`
    // returns the first non-`Unreleased` heading, which makes this the one
    // check that catches a release cut where `## [Unreleased]` was never
    // renamed to `## [<version>]`: the shipped binary would then answer
    // `akm help migrate latest` with the PREVIOUS release's notes, and a
    // hardcoded expectation here would still pass because it names that
    // previous release. Nothing in release.yml, tests/release-check.sh or any
    // lint gate covers this.
    const version = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version as string;
    const result = renderMigrationHelp("latest");
    expect(result).toContain(`## [${version}]`);
    // The stable section must also sit ABOVE the rc/beta history, or the alias
    // reports a prerelease.
    expect(result).not.toContain(`## [${version}-rc`);
  });

  test("renders dedicated message when no bundled note or changelog entry exists", () => {
    const result = renderMigrationHelp("9.9.9", undefined);
    expect(result).toContain("No dedicated migration note");
    expect(result).toContain("9.9.9");
    // Fallback lists the bundled versions so users can pick one that exists.
    expect(result).toContain("Available bundled notes:");
    expect(result).toContain("0.6.0");
  });

  test("rejects unsafe version components (path traversal guard)", () => {
    // Any of these would escape the release-notes directory if passed
    // directly to fs.readFileSync; the loader must refuse them and fall
    // through to the no-note fallback.
    for (const bad of ["../../etc/passwd", "..", "0.6.0/../secret", "0.6.0\0"]) {
      const result = renderMigrationHelp(bad, undefined);
      expect(result).toContain("No dedicated migration note");
    }
  });

  test("dist build resolves release-notes relative to the compiled module", () => {
    // VALUE-07: the previous version of this test reimplemented the
    // path-resolution logic under test and got it wrong — it resolved only
    // ONE directory level up from a flat `<pkg>/dist`, so it could never
    // fail even if production's traversal broke. Production's
    // `releaseNotesDir()` (src/commands/sources/migration-help.ts) computes
    // `path.resolve(getDirname(import.meta.url), "../../../docs/migration/release-notes")`
    // — THREE levels up — because `tsc` (see package.json "build") mirrors
    // `src/` into `dist/` 1:1, so the compiled module really lives three
    // levels deep at `<pkg>/dist/commands/sources/migration-help.js`.
    //
    // This rewrite extracts the literal traversal string straight out of the
    // production source (so it can't silently drift from what production
    // actually does) and applies it at a module directory that mirrors the
    // REAL `dist/commands/sources` nesting (a structural fact independent of
    // that literal). If production's traversal depth ever stops matching the
    // real src/dist nesting, `resolved` points at a directory that doesn't
    // exist in this fixture and the test fails.
    const migrationHelpSrcPath = path.join(PROJECT_ROOT, "src", "commands", "sources", "migration-help.ts");
    const migrationHelpSrc = fs.readFileSync(migrationHelpSrcPath, "utf8");
    const traversalMatch = migrationHelpSrc.match(/path\.resolve\(getDirname\(import\.meta\.url\),\s*"([^"]+)"\)/);
    expect(traversalMatch, "releaseNotesDir()'s path.resolve(...) call shape changed").not.toBeNull();
    const traversal = traversalMatch![1]!;

    const tempPkg = fs.mkdtempSync(path.join(os.tmpdir(), "akm-pkg-layout-"));
    try {
      // `tsc` preserves the src/ directory structure, so the compiled module
      // for src/commands/sources/migration-help.ts lands at this same depth.
      const moduleDir = path.join(tempPkg, "dist", "commands", "sources");
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.mkdirSync(path.join(tempPkg, "docs", "migration", "release-notes"), { recursive: true });
      const notePath = path.join(tempPkg, "docs", "migration", "release-notes", "0.6.0.md");
      fs.writeFileSync(notePath, "Migration notes for akm v0.6.0\n- stub body for test\n", "utf8");

      const resolved = path.resolve(moduleDir, traversal, "0.6.0.md");
      expect(fs.existsSync(resolved)).toBe(true);
      expect(fs.readFileSync(resolved, "utf8")).toContain("Migration notes for akm v0.6.0");
    } finally {
      fs.rmSync(tempPkg, { recursive: true, force: true });
    }
  });

  test("every release-notes filename matches a published version shape", () => {
    const files = fs.readdirSync(RELEASE_NOTES_DIR).filter((name) => name.endsWith(".md") && name !== "README.md");
    for (const file of files) {
      const version = file.slice(0, -".md".length);
      // Accept semver-ish strings the loader is willing to serve.
      expect(version).toMatch(/^[A-Za-z0-9._+-]+$/);
    }
  });
});
