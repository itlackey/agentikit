import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginWriteTargetMutation,
  planWriteTargetPublication,
  publishWriteTargetPlan,
  type ResolvedWriteTarget,
} from "../../src/core/write-source";

const roots: string[] = [];

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function target(): ResolvedWriteTarget {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-publication-plan-"));
  roots.push(root);
  git(["init", "--initial-branch=main"], root);
  git(["config", "user.email", "test@akm.local"], root);
  git(["config", "user.name", "akm test"], root);
  fs.writeFileSync(path.join(root, ".gitignore"), "env/\n");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n");
  git(["add", ".gitignore", "README.md"], root);
  git(["commit", "-m", "seed"], root);
  return {
    source: { kind: "git", name: "team", path: root, repoPath: root },
    config: { type: "git", name: "team", writable: true },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exact-path publication planner", () => {
  test("rejects descendant symlinks for filesystem targets while allowing a symlinked source root", () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-publication-fs-"));
    const linkedRoot = `${realRoot}-link`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-publication-outside-"));
    roots.push(realRoot, linkedRoot, outside);
    fs.symlinkSync(realRoot, linkedRoot);
    const fsTarget: ResolvedWriteTarget = {
      source: { kind: "filesystem", name: "local", path: linkedRoot },
      config: { type: "filesystem", name: "local", path: linkedRoot, writable: true },
    };
    const safePath = path.join(linkedRoot, "env", "safe.env");
    expect(() => planWriteTargetPublication(fsTarget, [safePath], { ignored: "reject" })).not.toThrow();

    fs.symlinkSync(outside, path.join(realRoot, "env"));
    expect(() => planWriteTargetPublication(fsTarget, [safePath], { ignored: "reject" })).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outside, "safe.env"))).toBe(false);
  });

  test("reject policy refuses an ignored path before mutation", () => {
    const writeTarget = target();
    const filePath = path.join(writeTarget.source.path, "env", "prod.env");

    expect(() => planWriteTargetPublication(writeTarget, [filePath], { ignored: "reject" })).toThrow(/ignored/i);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("local-only policy skips publication for the complete operation when one path is ignored", () => {
    const writeTarget = target();
    const envPath = path.join(writeTarget.source.path, "env", "prod.env");
    const markerPath = path.join(writeTarget.source.path, "env", "prod.sensitive");
    const plan = planWriteTargetPublication(writeTarget, [envPath, markerPath], { ignored: "local-only" });

    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, "TOKEN=private\n");
    fs.writeFileSync(markerPath, "");
    publishWriteTargetPlan(plan, "Update env/prod");

    expect(git(["rev-list", "--count", "HEAD"], writeTarget.source.path)).toBe("1");
    expect(fs.readFileSync(envPath, "utf8")).toBe("TOKEN=private\n");
  });

  test("preflights every unignored path before any caller mutation", () => {
    const writeTarget = target();
    fs.writeFileSync(path.join(writeTarget.source.path, ".gitignore"), "");
    const envPath = path.join(writeTarget.source.path, "env", "prod.env");
    const markerPath = path.join(writeTarget.source.path, "env", "prod.sensitive");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "user work");

    expect(() => planWriteTargetPublication(writeTarget, [envPath, markerPath], { ignored: "local-only" })).toThrow(
      /staged or unstaged work/i,
    );
    expect(fs.existsSync(envPath)).toBe(false);
  });

  test("preflights unignored paths even when another operation path is ignored", () => {
    const writeTarget = target();
    fs.writeFileSync(path.join(writeTarget.source.path, ".gitignore"), "env/*.sensitive\n");
    git(["add", ".gitignore"], writeTarget.source.path);
    git(["commit", "-m", "ignore markers"], writeTarget.source.path);
    const envPath = path.join(writeTarget.source.path, "env", "prod.env");
    const markerPath = path.join(writeTarget.source.path, "env", "prod.sensitive");
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, "user work");

    expect(() => planWriteTargetPublication(writeTarget, [envPath, markerPath], { ignored: "local-only" })).toThrow(
      /staged or unstaged work/i,
    );
  });

  test("rejects a Git target that advances after preflight and before mutation", () => {
    const writeTarget = target();
    fs.writeFileSync(path.join(writeTarget.source.path, ".gitignore"), "");
    const filePath = path.join(writeTarget.source.path, "env", "prod.env");
    const plan = planWriteTargetPublication(writeTarget, [filePath], { ignored: "reject" });
    git(["commit", "--allow-empty", "-m", "concurrent advance"], writeTarget.source.path);

    expect(() => beginWriteTargetMutation(plan)).toThrow(/advanced/i);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("rejects a Git target that advances after mutation and before publication", () => {
    const writeTarget = target();
    fs.writeFileSync(path.join(writeTarget.source.path, ".gitignore"), "");
    const filePath = path.join(writeTarget.source.path, "env", "prod.env");
    const plan = planWriteTargetPublication(writeTarget, [filePath], { ignored: "reject" });
    beginWriteTargetMutation(plan);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "AKM mutation");
    git(["commit", "--allow-empty", "-m", "concurrent advance"], writeTarget.source.path);

    expect(() => publishWriteTargetPlan(plan, "Update env/prod")).toThrow(/advanced/i);
    expect(git(["log", "-1", "--format=%s"], writeTarget.source.path)).toBe("concurrent advance");
  });
});
