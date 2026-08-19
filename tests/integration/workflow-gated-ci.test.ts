// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  needs?: string[];
  steps?: WorkflowStep[];
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>;
    };
  };
}

interface GatedWorkflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    pull_request?: unknown;
    push?: unknown;
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: {
      inputs?: Record<string, { options?: string[]; required?: boolean; type?: string }>;
    };
  };
  "run-name"?: string;
}

const root = path.resolve(import.meta.dir, "../..");
const workflowPath = path.join(root, ".github", "workflows", "gated-ci.yml");
const source = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, "utf8") : "";
const workflow = (YAML.parse(source) ?? {}) as GatedWorkflow;
const jobs = workflow.jobs ?? {};

function getJob(id: string): WorkflowJob {
  const job = jobs[id];
  expect(job, `Missing stable gated CI job: ${id}`).toBeDefined();
  return job ?? {};
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing gated CI step: ${name}`).toBeDefined();
  return step ?? {};
}

describe("gated CI workflow", () => {
  test("is weekly and manually dispatchable without adding heavyweight push or pull-request work", () => {
    expect(source, "Missing .github/workflows/gated-ci.yml").not.toBe("");
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.pull_request).toBeUndefined();
    expect(workflow.on?.schedule).toEqual([{ cron: "23 5 * * 1" }]);

    const inputs = workflow.on?.workflow_dispatch?.inputs;
    expect(inputs?.candidate_sha).toMatchObject({ required: true, type: "string" });
    expect(inputs?.gated_suite).toMatchObject({
      required: true,
      type: "choice",
      options: ["all", "semantic", "docker", "native-scheduler"],
    });
    expect(workflow["run-name"]).toContain("inputs.candidate_sha");
  });

  test("keeps stable visible names for the three gated surfaces", () => {
    expect(getJob("semantic-search").name).toBe("Gated / Semantic Search");
    expect(getJob("docker-install").name).toBe("Gated / Docker Install");
    expect(getJob("native-scheduler").name).toBe("Gated / Native Scheduler / ${{ matrix.platform }}");
  });

  test("runs real semantic search with a stable HuggingFace cache outside sandbox HOME", () => {
    const job = getJob("semantic-search");
    expect(job.env).toMatchObject({
      AKM_SEMANTIC_TESTS: "1",
      HF_HOME: "${{ github.workspace }}/.ci-cache/huggingface",
    });
    const cache = getStep(job, "Cache HuggingFace models");
    expect(cache.uses).toBe("actions/cache@v5");
    expect(cache.with).toMatchObject({
      path: "${{ github.workspace }}/.ci-cache/huggingface",
      key: "akm-huggingface-${{ runner.os }}-${{ hashFiles('bun.lock') }}-v1",
    });
    expect(JSON.stringify(job)).toContain("tests/integration/semantic-search-e2e.test.ts");

    const semanticTest = fs.readFileSync(
      path.join(root, "tests", "integration", "semantic-search-e2e.test.ts"),
      "utf8",
    );
    expect(semanticTest).toContain('path.resolve(import.meta.dir, "../..", ".ci-cache", "huggingface")');
    expect(semanticTest).not.toContain('path.join(process.env.HOME ?? "/tmp", ".cache", "huggingface")');
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".ci-cache/");
  });

  test("runs the Docker gate only on its scheduled or explicitly requested path", () => {
    const job = getJob("docker-install");
    expect(job.env).toMatchObject({ AKM_DOCKER_TESTS: "1", DOCKER_BUILDKIT: "1" });
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain("inputs.gated_suite == 'docker'");
    expect(JSON.stringify(job)).toContain("tests/integration/docker-install.test.ts");
  });

  test("covers Linux cron, macOS launchd, and Windows Task Scheduler behavior", () => {
    const job = getJob("native-scheduler");
    expect(job.strategy?.matrix?.include).toEqual([
      { platform: "Linux", runner: "ubuntu-24.04", runtime_platform: "linux" },
      { platform: "macOS", runner: "macos-15", runtime_platform: "darwin" },
      { platform: "Windows", runner: "windows-2022", runtime_platform: "win32" },
    ]);
    const serialized = JSON.stringify(job);
    expect(serialized).toContain("AKM_STANDALONE_SCHEDULER_TESTS");
    expect(serialized).toContain("tests/integration/linux-standalone-scheduler.test.ts");
    expect(serialized).toContain("AKM_NATIVE_SCHEDULER_TESTS");
    expect(serialized).toContain("tests/integration/native-scheduler.test.ts");
    expect(job.steps?.some((step) => step.if?.includes("always()") && step.name?.startsWith("Clean up"))).toBe(true);
  });

  test("publishes an all-suite release-candidate evidence surface bound to the requested SHA", () => {
    const evidence = getJob("release-candidate-evidence");
    expect(evidence.name).toBe("Gated / Release Candidate Evidence");
    expect(evidence.needs).toEqual(["resolve-candidate", "semantic-search", "docker-install", "native-scheduler"]);
    expect(evidence.if).toContain("always()");
    expect(evidence.if).toContain("inputs.gated_suite == 'all'");
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("inputs.candidate_sha");
    expect(serialized).toContain("github.run_id");
    expect(serialized).toContain("GITHUB_STEP_SUMMARY");
    expect(serialized).toContain("needs.semantic-search.result");
    expect(serialized).toContain("needs.docker-install.result");
    expect(serialized).toContain("needs.native-scheduler.result");
  });

  test("makes candidate-SHA evidence a documented release-checklist requirement", () => {
    const checklistPath = path.join(root, "docs", "maintainers", "release-checklist.md");
    const checklist = fs.existsSync(checklistPath) ? fs.readFileSync(checklistPath, "utf8") : "";
    expect(checklist).toContain("Gated / Release Candidate Evidence");
    expect(checklist).toContain("full 40-character release-candidate SHA");
    expect(checklist).toContain("weekly run is drift detection, not release evidence");
    expect(checklist).toContain("actions/runs/");

    const releaseCheck = fs.readFileSync(path.join(root, "tests", "release-check.sh"), "utf8");
    expect(releaseCheck).toContain("tests/integration/workflow-gated-ci.test.ts");
  });
});
