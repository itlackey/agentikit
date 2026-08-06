// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * npm tarball contents guard.
 *
 * `npm pack` resolves package.json's `files` allowlist PLUS npm's own
 * force-includes (package.json, LICENSE, the root README/CHANGELOG — and,
 * less obviously, every nested README.md under an included tree). Nothing
 * else in the repo pins that resolution, so a stray `files` edit (or a new
 * doc that force-includes itself) ships silently. This suite runs a real
 * `npm pack --dry-run --json` and pins:
 *
 *   1. every `files[]` entry actually contributes at least one packed file
 *      (no dead declarations),
 *   2. every packed file is accounted for — matched by a `files[]` entry or
 *      on the known force-include list (surprise additions fail loudly),
 *   3. every relative link inside a shipped markdown file resolves within
 *      the package (the 0.9.0 pre-release sweep fixed 80+ links that 404'd
 *      for npm-installed users; this keeps them fixed). The root README is
 *      exempt — prepublishOnly swaps it for .github/README.npm.md — and that
 *      swapped README is asserted to carry no relative links at all.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Files npm includes regardless of the `files` allowlist. */
function isForceIncluded(p: string): boolean {
  if (["package.json", "README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md"].includes(p)) return true;
  // npm force-includes nested README.md files under any included directory
  // tree (verified empirically: negating them in `files` does not exclude
  // them). They must therefore keep their links package-resolvable — check 3.
  return path.basename(p).toLowerCase() === "readme.md";
}

function packedPaths(): Set<string> {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
  const first = parsed[0];
  if (!first) throw new Error("npm pack --json returned no entries");
  return new Set(first.files.map((f) => f.path));
}

function filesAllowlist(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
    files?: string[];
  };
  if (!pkg.files?.length) throw new Error("package.json has no files[] allowlist");
  return pkg.files;
}

function matchesEntry(p: string, entry: string): boolean {
  return p === entry || p.startsWith(`${entry.replace(/\/+$/, "")}/`);
}

describe("npm pack contents", () => {
  const shipped = packedPaths();
  const allowlist = filesAllowlist();

  test("every files[] entry contributes at least one packed file", () => {
    const dead = allowlist.filter((entry) => ![...shipped].some((p) => matchesEntry(p, entry)));
    expect(dead).toEqual([]);
  });

  test("every packed file is accounted for by files[] or npm's force-includes", () => {
    const surprises = [...shipped].filter(
      (p) => !isForceIncluded(p) && !allowlist.some((entry) => matchesEntry(p, entry)),
    );
    expect(surprises.sort()).toEqual([]);
  });

  test("every relative link in shipped markdown resolves inside the package", () => {
    const inShipped = (resolved: string): boolean =>
      shipped.has(resolved) || [...shipped].some((s) => s.startsWith(`${resolved.replace(/\/+$/, "")}/`));

    const broken: string[] = [];
    for (const md of [...shipped].sort()) {
      // The packed root README is .github/README.npm.md post-swap — the repo
      // README's repo-relative links never ship. Checked separately below.
      if (!md.endsWith(".md") || md === "README.md") continue;
      const onDisk = path.join(PROJECT_ROOT, md);
      if (!fs.existsSync(onDisk)) continue;
      const text = fs.readFileSync(onDisk, "utf8");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] ?? "";
        if (/^(https?:\/\/|#|mailto:)/.test(target)) continue;
        const pathPart = target.split("#")[0] ?? "";
        if (!pathPart) continue;
        const resolved = path.normalize(path.join(path.dirname(md), pathPart)).replaceAll("\\", "/");
        if (!inShipped(resolved)) broken.push(`${md}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("the npm README (swapped in by prepublishOnly) has no relative links", () => {
    const npmReadme = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "README.npm.md"), "utf8");
    const relative = [...npmReadme.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((t) => !/^(https?:\/\/|#|mailto:)/.test(t));
    expect(relative).toEqual([]);
  });
});
