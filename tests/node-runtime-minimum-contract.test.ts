import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { expectPinnedAction, expectPinnedVersion } from "./_helpers/pinned-action";

const ROOT = path.resolve(import.meta.dir, "..");
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

interface WorkflowStep {
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function runsBunInstall(run: string | undefined): boolean {
  return (run ?? "").split("\n").some((line) => {
    const command = line.trimStart();
    return !command.startsWith("#") && /(?:^|&&|\|\||;)\s*bun\s+install(?:\s|$)/.test(command);
  });
}

describe("Node 22 runtime minimum contract", () => {
  test("node-smoke exercises BOTH the Node 22 floor and Node 24 on every run", () => {
    // The floor is only real if CI runs it. 0.9.3 dropped Node 22 by
    // declaration and deleted this matrix in the same commit — the exact
    // "permitted but untested" gap that lets upgrade breaks ship. Restored
    // in 0.9.4: the smoke matrix pins both the minimum and current majors.
    const workflow = read(".github/workflows/ci.yml");
    const nodeSmoke = workflow.slice(workflow.indexOf("\n  node-smoke:"));

    expect(nodeSmoke).toContain("matrix:");
    expect(nodeSmoke).toContain('"22"');
    expect(nodeSmoke).toContain('"24"');
    expect(nodeSmoke).toContain("node-version: ${{ matrix.node-version }}");
  });

  test("selects Node 24 with setup-node v5 before every workflow Bun install", () => {
    const workflowsDirectory = path.join(ROOT, ".github", "workflows");
    const coveredInstallJobs: string[] = [];

    for (const filename of fs
      .readdirSync(workflowsDirectory)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort()) {
      const workflow = YAML.parse(fs.readFileSync(path.join(workflowsDirectory, filename), "utf8")) as Workflow;

      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          if (!runsBunInstall(step.run)) continue;

          const label = `${filename}#${jobId}`;
          coveredInstallJobs.push(label);
          const nodeSetup = [...(job.steps ?? [])]
            .slice(0, index)
            .reverse()
            .find((candidate) => candidate.uses?.startsWith("actions/setup-node@"));

          expect(nodeSetup, `${label} must select Node before bun install`).toBeDefined();
          // #768 pinned actions to commit SHAs, so the major version now lives
          // in the trailing comment. Assert BOTH halves of the original
          // contract — the right action, pinned; and still v5.
          expectPinnedAction(nodeSetup?.uses, "actions/setup-node", label);
          expectPinnedVersion(filename, "actions/setup-node", "v5");
          const selected = String(nodeSetup?.with?.["node-version"]);
          expect(
            ["22", "24", "${{ matrix.node-version }}"],
            `${label} must select a supported Node (22 floor, 24 current, or the smoke matrix)`,
          ).toContain(selected);
          expect(nodeSetup?.if, `${label} must not conditionally select Node`).toBeUndefined();
        }
      }
    }

    expect(coveredInstallJobs.sort()).toEqual([
      "akm-eval-smoke.yml#smoke",
      "ci.yml#check",
      "ci.yml#node-smoke",
      "gated-ci.yml#docker-install",
      "gated-ci.yml#native-scheduler",
      "gated-ci.yml#semantic-search",
      "release.yml#release",
    ]);
  });

  test("uses the Node 22 floor in every Bun-install Docker builder while retaining the Ubuntu 22 OS image", () => {
    // The Docker smoke images deliberately run the MINIMUM supported Node so
    // the floor is exercised, not merely declared.
    for (const relativePath of BUN_DOCKERFILES) {
      const dockerfile = read(relativePath);
      expect(dockerfile, relativePath).toMatch(/^FROM node:22(?:-alpine)? AS node-runtime$/m);
      expect(dockerfile, relativePath).toContain("major < 22");
      expect(dockerfile, relativePath).not.toContain("FROM node:24");
    }

    expect(read("tests/docker/Dockerfile.ubuntu-bun")).toContain("FROM ubuntu:22.04");
  });

  test("keeps registry helpers and release verification on the Node 22 floor", () => {
    for (const relativePath of [
      "src/registry/pinned-request-helper.ts",
      "src/registry/pinned-transport.ts",
      "tests/release-check.sh",
    ]) {
      const source = read(relativePath);
      expect(source, relativePath).toMatch(/>=\s*22/);
      expect(source, relativePath).not.toMatch(/>=\s*24/);
    }
  });

  test("states the current Node 22 floor in maintained runtime documentation", () => {
    for (const relativePath of CURRENT_RUNTIME_DOCS) {
      const document = read(relativePath);
      expect(document, relativePath).toMatch(/(?:Node(?:\.js)?|node:)[^\n]{0,80}(?:>=|≥)\s*22|Node\.js\s+22\+/i);
      expect(document, relativePath).not.toMatch(/(?:Node(?:\.js)?|node:)[^\n]{0,80}(?:>=|≥)\s*24/i);
    }

    const current = read("CHANGELOG.md").split("## [0.9.3]", 1)[0] ?? "";
    expect(current).toContain("Node.js 22 support is restored");
  });
});
