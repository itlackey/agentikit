import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const CURRENT_RUNTIME_DOCS = [
  "README.md",
  ".github/README.npm.md",
  ".github/CONTRIBUTING.md",
  "SECURITY.md",
  "STABILITY.md",
  "docs/guides/getting-started.md",
  "docs/guides/recipes/headless-install.md",
  "docs/maintainers/local-development.md",
  "docs/architecture/internals/fresh-host-rebuild-runbook.md",
  "docs/architecture/internals/registry-network-boundary.md",
  "docs/architecture/runtime-boundary-design.md",
  "docs/architecture/testing/manual-testing-checklist.md",
];
const BUN_DOCKERFILES = [
  "tests/docker/Dockerfile.alpine-bun",
  "tests/docker/Dockerfile.debian-bun",
  "tests/docker/Dockerfile.fedora-bun",
  "tests/docker/Dockerfile.ubuntu-bun",
];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("Node 24 runtime minimum contract", () => {
  test("keeps every CI Node execution on Node 24 without a Node 22 matrix", () => {
    const workflow = read(".github/workflows/ci.yml");
    const nodeSmoke = workflow.slice(workflow.indexOf("\n  node-smoke:"));

    expect(workflow).toContain("node-version: 24");
    expect(workflow).not.toContain("node-version: 22");
    expect(nodeSmoke).toContain("node-version: 24");
    expect(nodeSmoke).not.toContain("matrix:");
    expect(nodeSmoke).not.toContain('"22"');
  });

  test("uses Node 24 in every Bun-install Docker builder while retaining the Ubuntu 22 OS image", () => {
    for (const relativePath of BUN_DOCKERFILES) {
      const dockerfile = read(relativePath);
      expect(dockerfile, relativePath).toMatch(/^FROM node:24(?:-alpine)? AS node-runtime$/m);
      expect(dockerfile, relativePath).toContain("major < 24");
      expect(dockerfile, relativePath).not.toContain("FROM node:22");
    }

    expect(read("tests/docker/Dockerfile.ubuntu-bun")).toContain("FROM ubuntu:22.04");
  });

  test("keeps registry helpers and release verification on the Node 24 floor", () => {
    for (const relativePath of [
      "src/registry/pinned-request-helper.ts",
      "src/registry/pinned-transport.ts",
      "tests/release-check.sh",
    ]) {
      const source = read(relativePath);
      expect(source, relativePath).toContain(">= 24");
      expect(source, relativePath).not.toContain(">= 22");
    }
  });

  test("states the current Node 24 floor in maintained runtime documentation", () => {
    for (const relativePath of CURRENT_RUNTIME_DOCS) {
      const document = read(relativePath);
      expect(document, relativePath).toMatch(/(?:Node(?:\.js)?|node:)[^\n]{0,80}(?:>=|≥)\s*24|Node\.js\s+24\+/i);
      expect(document, relativePath).not.toMatch(/(?:Node(?:\.js)?|node:)[^\n]*22/i);
    }

    const unreleased = read("CHANGELOG.md").split("## [0.9.2]", 1)[0] ?? "";
    expect(unreleased).toContain("Node.js >= 24");
    expect(unreleased).toContain("Node 22");
  });
});
