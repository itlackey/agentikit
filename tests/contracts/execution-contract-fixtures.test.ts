import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import { claudeAdapter } from "../../src/core/adapter/adapters/claude-adapter";
import { opencodeAdapter } from "../../src/core/adapter/adapters/opencode-adapter";
import type { BundleAdapter } from "../../src/core/adapter/bundle-adapter";
import type { BundleComponent } from "../../src/core/adapter/types";
import { buildFileContext } from "../../src/indexer/walk/file-context";
import type { WorkflowPlanGraphV4 as WorkflowPlanGraph } from "../../src/workflows/ir/schema-v4";
import {
  assertFixtureBytesUnchanged,
  captureFixtureBytes,
  EXECUTION_CONTRACT_FIXTURES,
} from "../_helpers/execution-contracts";
import { freezeWorkflow } from "../_helpers/workflow";

interface NativeManifestEntry {
  adapter: "akm" | "claude" | "opencode";
  kind: "agent" | "command";
  path: string;
  conceptId: string;
}

interface WorkflowManifest {
  currentFreeze: string;
  currentFreezeWithSchema: string;
  equivalent: {
    markdown: string;
    githubYaml: string;
    expected: string;
    boundary: string;
  };
  rejected: Array<{ id: string; file: string; reasonCode: string }>;
}

interface PortableWorkflowProjection {
  schemaVersion: 1;
  name: string;
  triggers: string[];
  jobs: Array<{
    id: string;
    needs: string[];
    steps: Array<{ id: string; kind: "run"; run: string }>;
  }>;
}

const NATIVE_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "native");
const WORKFLOW_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "workflows");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function fixtureFiles(root: string, extensions: ReadonlySet<string>): string[] {
  const result: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        result.push(path.relative(root, absolute).replaceAll("\\", "/"));
      }
    }
  };
  visit(root);
  return result.sort();
}

describe("execution-contract native fixtures", () => {
  test("AKM, Claude, and OpenCode each provide one discoverable agent and command without writes", () => {
    const manifest = readJson<{ schemaVersion: 1; files: NativeManifestEntry[] }>(
      path.join(NATIVE_ROOT, "manifest.json"),
    );
    const adapters: Record<NativeManifestEntry["adapter"], BundleAdapter> = {
      akm: akmAdapter,
      claude: claudeAdapter,
      opencode: opencodeAdapter,
    };
    const before = captureFixtureBytes(NATIVE_ROOT);
    const rootBytes = Object.fromEntries(
      Object.keys(adapters).map((adapter) => [adapter, captureFixtureBytes(path.join(NATIVE_ROOT, adapter))]),
    ) as Record<NativeManifestEntry["adapter"], ReturnType<typeof captureFixtureBytes>>;

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.map(({ adapter, kind }) => `${adapter}:${kind}`).sort()).toEqual([
      "akm:agent",
      "akm:command",
      "claude:agent",
      "claude:command",
      "opencode:agent",
      "opencode:command",
    ]);
    expect(manifest.files.map(({ path: file }) => file).sort()).toEqual(
      fixtureFiles(NATIVE_ROOT, new Set([".md"])).filter(
        (file) => file.includes("/agents/") || file.includes("/commands/"),
      ),
    );

    for (const expected of manifest.files) {
      const adapter = adapters[expected.adapter];
      const root = path.join(NATIVE_ROOT, expected.adapter);
      const component: BundleComponent = {
        id: `fixture-${expected.adapter}`,
        adapter: expected.adapter,
        root,
        writable: false,
      };
      expect(adapter.looksLikeRoot?.(root), `${expected.adapter} fixture root`).toBe(true);
      const absolute = path.join(NATIVE_ROOT, expected.path);
      const document = adapter.recognize(component, buildFileContext(root, absolute));
      expect(document, expected.path).not.toBeNull();
      expect(document?.adapterId).toBe(expected.adapter);
      expect(document?.type).toBe(expected.kind);
      expect(document?.conceptId).toBe(expected.conceptId);
      expect(document?.ref).toBe(`fixture-${expected.adapter}//${expected.conceptId}`);
      expect(document?.hash).toMatch(/^[a-f0-9]{64}$/);
      if (expected.adapter !== "akm") {
        expect(document?.content).toContain("# Contract review");
        expect(document?.content).not.toStartWith("---");
      }
    }

    assertFixtureBytesUnchanged(NATIVE_ROOT, before);
    for (const adapter of Object.keys(adapters) as NativeManifestEntry["adapter"][]) {
      assertFixtureBytesUnchanged(path.join(NATIVE_ROOT, adapter), rootBytes[adapter]);
    }
  });
});

function markdownFixtureProjection(markdown: string, plan: WorkflowPlanGraph): PortableWorkflowProjection {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  if (!heading) throw new Error("equivalent Markdown fixture needs one H1 name");
  return {
    schemaVersion: 1,
    name: heading,
    triggers: ["workflow_dispatch"],
    jobs: [
      {
        id: "contract",
        needs: [],
        steps: plan.steps.map((step) => {
          if (!step.root || step.root.kind !== "unit" || step.root.frozenTarget.kind !== "shell") {
            throw new Error(`fixture step ${step.stepId} must freeze to one exec unit`);
          }
          return {
            id: step.stepId,
            kind: "run" as const,
            run: step.root.frozenTarget.exec.command.join(" "),
          };
        }),
      },
    ],
  };
}

function githubFixtureProjection(input: unknown): PortableWorkflowProjection {
  const workflow = input as {
    name: string;
    on: Record<string, unknown>;
    jobs: Record<
      string,
      { needs?: string | string[]; "runs-on": string[]; steps: Array<{ id: string; run?: string; uses?: string }> }
    >;
  };
  return {
    schemaVersion: 1,
    name: workflow.name,
    triggers: Object.keys(workflow.on).sort(),
    jobs: Object.entries(workflow.jobs).map(([id, job]) => {
      expect(job["runs-on"], `${id} must stay inside the fixture's local-only boundary`).toEqual(["self-hosted"]);
      const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
      return {
        id,
        needs,
        steps: job.steps.map((step) => {
          if (!step.run || step.uses) throw new Error(`fixture step ${step.id} is not a portable run step`);
          return { id: step.id, kind: "run" as const, run: step.run };
        }),
      };
    }),
  };
}

function rejectedGithubFixtureReason(input: unknown): string | null {
  const workflow = input as {
    on?: Record<string, unknown>;
    jobs?: Record<string, { steps?: Array<{ run?: string; uses?: string }> }>;
  };
  if (workflow.on && Object.keys(workflow.on).some((trigger) => trigger !== "workflow_dispatch")) {
    return "unsupported-service-event";
  }
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses) return "remote-action-acquisition-out-of-scope";
      if (step.run?.includes("${{")) return "unsupported-github-expression";
    }
  }
  return null;
}

describe("workflow frontend fixtures", () => {
  test("AKM Markdown and GitHub-shaped YAML share fixture intent without erasing dispatch form", () => {
    const manifest = readJson<WorkflowManifest>(path.join(WORKFLOW_ROOT, "manifest.json"));
    const before = captureFixtureBytes(WORKFLOW_ROOT);
    const markdown = fs.readFileSync(path.join(WORKFLOW_ROOT, manifest.equivalent.markdown), "utf8");
    const githubYaml = fs.readFileSync(path.join(WORKFLOW_ROOT, manifest.equivalent.githubYaml), "utf8");
    const expected = readJson<PortableWorkflowProjection>(path.join(WORKFLOW_ROOT, manifest.equivalent.expected));
    const plan = freezeWorkflow(markdown, "workflows/contract-review.md");

    expect(manifest.currentFreeze).toBe("current/agent-unit.md");
    expect(manifest.currentFreezeWithSchema).toBe("current/agent-unit-schema.md");
    expect(manifest.equivalent.boundary).toContain("self-hosted");
    expect(markdownFixtureProjection(markdown, plan)).toEqual(expected);
    // This fixture-only intent projection deliberately ignores direct-argv
    // versus shell dispatch. The source-IR contract separately pins that they
    // remain distinct and are never converted by joining argv.
    expect(githubFixtureProjection(parseYaml(githubYaml))).toEqual(expected);
    assertFixtureBytesUnchanged(WORKFLOW_ROOT, before);
  });

  test("GitHub-shaped rejection fixtures name unsupported semantics instead of silently lowering them", () => {
    const manifest = readJson<WorkflowManifest>(path.join(WORKFLOW_ROOT, "manifest.json"));
    expect(manifest.rejected.map(({ file }) => file).sort()).toEqual(
      fixtureFiles(path.join(WORKFLOW_ROOT, "rejected"), new Set([".yml"])).map((file) => `rejected/${file}`),
    );
    for (const fixture of manifest.rejected) {
      const yaml = fs.readFileSync(path.join(WORKFLOW_ROOT, fixture.file), "utf8");
      expect(rejectedGithubFixtureReason(parseYaml(yaml)), fixture.file).toBe(fixture.reasonCode);
    }
  });
});
