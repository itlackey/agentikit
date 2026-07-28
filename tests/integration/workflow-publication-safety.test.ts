import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { buildWorkflowTemplate, createWorkflowAsset } from "../../src/workflows/authoring/authoring";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });
});

afterEach(() => storage.cleanup());

describe("workflow force publication safety", () => {
  test("force rejects exact-path user work before replacing the workflow", () => {
    const url = "https://example.com/akm/workflow-preflight.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const workflows = path.join(repo, "content", "workflows");
    const workflow = path.join(workflows, "release.md");
    fs.mkdirSync(workflows, { recursive: true });
    const git = (args: string[]): void => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "test@akm.local"]);
    git(["config", "user.name", "akm test"]);
    fs.writeFileSync(workflow, buildWorkflowTemplate("release"));
    git(["add", "content/workflows/release.md"]);
    git(["commit", "-m", "seed"]);
    fs.appendFileSync(workflow, "user work\n");
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, team: { git: url, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "team",
    });

    expect(() => createWorkflowAsset({ name: "release", force: true })).toThrow(/staged or unstaged work/i);
    expect(fs.readFileSync(workflow, "utf8")).toEndWith("user work\n");
  });

  test("force atomically replaces an existing workflow", () => {
    const created = createWorkflowAsset({ name: "replace" });
    const before = fs.statSync(created.path).ino;
    createWorkflowAsset({ name: "replace", content: buildWorkflowTemplate("replacement"), force: true });

    expect(fs.statSync(created.path).ino).not.toBe(before);
    expect(fs.readFileSync(created.path, "utf8")).toContain("Replacement");
  });

  test("rejects an existing descendant symlink instead of replacing its target", () => {
    const workflows = path.join(storage.stashDir, "workflows");
    const outside = path.join(storage.root, "outside");
    fs.mkdirSync(workflows, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workflows, "team"));

    expect(() => createWorkflowAsset({ name: "team/release", force: true })).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outside, "release.md"))).toBe(false);
  });

  test("continues to support a symlinked source root", () => {
    const real = path.join(storage.root, "real-stash");
    const linked = path.join(storage.root, "linked-stash");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, linked);
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, linked: { path: linked } },
      defaultBundle: "stash",
      defaultWriteTarget: "linked",
    });

    const created = createWorkflowAsset({ name: "release" });
    expect(fs.readFileSync(path.join(real, "workflows", "release.md"), "utf8")).toContain("# Workflow:");
    expect(created.path).toBe(path.join(linked, "workflows", "release.md"));
  });
});
