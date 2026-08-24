import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

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
          expect(nodeSetup?.uses, `${label} must use setup-node v5`).toBe("actions/setup-node@v5");
          expect(String(nodeSetup?.with?.["node-version"]), `${label} must use Node 24`).toBe("24");
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
      expect(source, relativePath).toMatch(/>=\s*24/);
      expect(source, relativePath).not.toMatch(/>=\s*22/);
    }
  });

  test("states the current Node 24 floor in maintained runtime documentation", () => {
    for (const relativePath of CURRENT_RUNTIME_DOCS) {
      const document = read(relativePath);
      expect(document, relativePath).toMatch(/(?:Node(?:\.js)?|node:)[^\n]{0,80}(?:>=|≥)\s*24|Node\.js\s+24\+/i);
      expect(document, relativePath).not.toMatch(/(?:Node(?:\.js)?|node:)[^\n]{0,80}(?:>=|≥)\s*22/i);
    }

    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("Node.js >= 24");
    expect(changelog).toContain("Node.js 22");
  });
});
