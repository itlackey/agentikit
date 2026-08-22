// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir } from "../_helpers/sandbox";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixtureRoot(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

const VALID_YAML = `name: YAML peer
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: check
        run: bun test
`;

const INVALID_YAML = `name: Unsafe remote action
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: checkout
        env:
          RELEASE_TOKEN: AKM_SECRET_BYTES_MUST_NOT_LEAK
        uses: actions/checkout@v4
`;

const VALID_MARKDOWN = `---
type: workflow
description: Markdown peer
updated: 2026-08-22
steps:
  - id: check
    output: { type: string }
---

## check

Run checks.
`;

function diagnosticProjection(result: Awaited<ReturnType<typeof akmLint>>) {
  return result.flagged.map(({ issue, detail, fixed, line }) => ({ issue, detail, fixed, line }));
}

describe("ordinary AKM lint recognizes peer workflow YAML", () => {
  test("a valid workflows/*.yml source is compiled and remains byte-for-byte read-only under --fix", async () => {
    const root = fixtureRoot("akm-lint-yaml-valid-");
    const source = write(root, "workflows/valid.YML", VALID_YAML);
    expect(detectAdapterId(root)).toBe("akm");

    const result = await akmLint({ dir: root, typeFilter: "workflows", fix: true });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixed).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe(VALID_YAML);
  });

  test("an unsupported remote action in workflows/*.yml is one fatal, located finding with no unrelated bytes", async () => {
    const root = fixtureRoot("akm-lint-yaml-invalid-");
    write(root, "workflows/invalid.yml", INVALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      file: "workflows/invalid.yml",
      issue: "invalid-workflow-structure",
      fixed: false,
      line: 11,
    });
    expect(result.flagged[0]?.detail.toLowerCase()).toContain("remote action acquisition");
    expect(JSON.stringify(result)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
    expect(result.summary).toEqual({ fixed: 0, flagged: 1, warnings: 0 });
  });

  test("a peer .md/.yml canonical-owner collision is reported once instead of linting either owner", async () => {
    const root = fixtureRoot("akm-lint-yaml-collision-");
    write(root, "workflows/dual.md", VALID_MARKDOWN);
    write(root, "workflows/dual.yml", VALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      file: "workflows/dual.md",
      issue: "invalid-workflow-structure",
      fixed: false,
    });
    expect(result.flagged[0]?.detail).toMatch(/multiple workflow source files.*dual\.md.*dual\.yml/is);
    expect(result.warnings).toEqual([]);
  });

  test("--fail-on-flagged exits nonzero for an invalid peer .yml source", async () => {
    const root = fixtureRoot("akm-lint-yaml-cli-");
    write(root, "workflows/invalid.yml", INVALID_YAML);

    const cli = await runCliCapture([
      "lint",
      "--dir",
      root,
      "--type",
      "workflows",
      "--fail-on-flagged",
      "--format",
      "json",
    ]);

    expect(cli.code).toBe(1);
    expect(cli.stderr).toBe("");
    const result = JSON.parse(cli.stdout) as { summary: { flagged: number }; flagged: Array<{ detail: string }> };
    expect(result.summary.flagged).toBe(1);
    expect(result.flagged).toHaveLength(1);
    expect(cli.stdout).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
  });

  test("ordinary AKM and explicit akm-workflow adapters return the same safe YAML diagnostic", async () => {
    const ordinary = fixtureRoot("akm-lint-yaml-ordinary-");
    const standalone = fixtureRoot("akm-lint-yaml-standalone-");
    write(ordinary, "workflows/invalid.yml", INVALID_YAML);
    write(standalone, "invalid.yml", INVALID_YAML);
    expect(detectAdapterId(ordinary)).toBe("akm");
    expect(detectAdapterId(standalone)).toBe("akm-workflow");

    const ordinaryResult = await akmLint({ dir: ordinary, typeFilter: "workflows" });
    const standaloneResult = await akmLint({ dir: standalone });

    expect(diagnosticProjection(ordinaryResult)).toEqual(diagnosticProjection(standaloneResult));
    expect(JSON.stringify(ordinaryResult)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
    expect(JSON.stringify(standaloneResult)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
  });

  test("the unsupported .yaml spelling remains outside the peer-source lint contract", async () => {
    const root = fixtureRoot("akm-lint-yaml-extension-");
    write(root, "workflows/ignored.yaml", INVALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("cached and registry peer copies cannot create ownership findings for the real workflow set", async () => {
    const root = fixtureRoot("akm-lint-yaml-cached-peer-");
    write(root, "workflows/release.md", VALID_MARKDOWN);
    write(root, "workflows/.cache/shadow.md", VALID_MARKDOWN);
    write(root, "workflows/.cache/shadow.yml", INVALID_YAML);
    write(root, "workflows/registry/mirror.md", VALID_MARKDOWN);
    write(root, "workflows/registry/mirror.yml", INVALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test.each([
    ["collision.md.yml", VALID_YAML],
    ["collision.yml.md", VALID_MARKDOWN],
  ])("a repeated workflow suffix in %s is one in-band ownership finding", async (filename, content) => {
    const root = fixtureRoot("akm-lint-yaml-nested-suffix-");
    write(root, `workflows/${filename}`, content);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      file: `workflows/${filename}`,
      issue: "invalid-workflow-structure",
      fixed: false,
    });
    expect(result.flagged[0]?.detail).toMatch(/extensionless stem ending in recognized workflow suffix/is);
    expect(result.warnings).toEqual([]);
  });
});
