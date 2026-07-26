import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmConsolidate } from "../../src/commands/improve/consolidate";
import { assembleAsset } from "../../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import { txnNamespaceDir } from "../../src/core/fs-txn";
import { _setChatCompletionForTests } from "../../src/llm/client";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

describe("consolidation Git publication recovery", () => {
  test("retries an AKM-owned commit after push failure without committing staged user work", async () => {
    const url = "https://example.com/akm/consolidate-git-recovery.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const remote = path.join(storage.root, "remote.git");
    fs.mkdirSync(content, { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare"]);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);

    const memoryPath = path.join(content, "memories", "recover-delete.md");
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(
      memoryPath,
      assembleAsset(
        { description: "Memory deleted by the consolidation recovery fixture" },
        "This substantive memory body is intentionally long enough to pass consolidation eligibility and exercise a durable Git publication retry after a rejected push.",
      ),
      "utf8",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "seed"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);

    const userWip = path.join(content, "knowledge", "user-wip.md");
    fs.mkdirSync(path.dirname(userWip), { recursive: true });
    fs.writeFileSync(userWip, "User-owned staged work.\n", "utf8");
    git(repo, ["add", "--", "content/knowledge/user-wip.md"]);

    const rejectingHook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(rejectingHook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(rejectingHook, 0o755);

    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        team: { git: url, writable: true },
      },
      defaultBundle: "stash",
      defaultWriteTarget: "team",
      engines: {
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
        },
      },
      improve: { strategies: { judged: { processes: { consolidate: { enabled: true } } } } },
      defaults: { llmEngine: "default", improveStrategy: "judged" },
    } as unknown as AkmConfig;
    let chatCalls = 0;
    overrideSeam(_setChatCompletionForTests, async () => {
      chatCalls++;
      return JSON.stringify({
        operations: [{ op: "delete", ref: "memories/recover-delete", reason: "redundant" }],
      });
    });

    await expect(akmConsolidate({ target: "team", config, assumeYes: true })).rejects.toThrow("git push failed");

    expect(git(repo, ["rev-list", "--count", "@{u}..HEAD"])).toBe("1");
    expect(git(repo, ["status", "--porcelain"])).toBe("A  content/knowledge/user-wip.md");
    const namespace = txnNamespaceDir(content);
    const transactionDirs = fs.readdirSync(namespace);
    expect(transactionDirs).toHaveLength(1);
    const journal = JSON.parse(
      fs.readFileSync(path.join(namespace, transactionDirs[0] as string, "journal.json"), "utf8"),
    ) as { phase: string; payload: { gitPaths: string[]; gitPublication: { commit?: string } } };
    expect(journal.phase).toBe("publishing");
    expect(journal.payload.gitPaths).toContain("content/memories/recover-delete.md");
    expect(journal.payload.gitPaths.some((entry) => entry.startsWith("content/.akm/archive/"))).toBe(true);
    expect(git(repo, ["ls-tree", "--name-only", "HEAD", "content/memories/recover-delete.md"])).toBe("");
    const committed = git(repo, ["show", "--name-only", "--no-renames", "--format=", "HEAD"]);
    expect(committed).toContain("content/memories/recover-delete.md");
    expect(committed).toContain("content/.akm/archive/");
    expect(committed).not.toContain("content/knowledge/user-wip.md");
    const transactionCommit = git(repo, ["rev-parse", "HEAD"]);
    expect(journal.payload.gitPublication.commit).toBe(transactionCommit);

    git(repo, ["commit", "--only", "-m", "user follow-up", "--", "content/knowledge/user-wip.md"]);
    const userCommit = git(repo, ["rev-parse", "HEAD"]);
    const laterWip = path.join(content, "knowledge", "later-wip.md");
    fs.writeFileSync(laterWip, "Later staged user work.\n", "utf8");
    git(repo, ["add", "--", "content/knowledge/later-wip.md"]);

    fs.rmSync(rejectingHook);
    const recovered = await akmConsolidate({ target: "team", config, assumeYes: true });

    expect(recovered.ok).toBe(true);
    expect(chatCalls).toBe(1);
    expect(git(remote, ["rev-parse", "main"])).toBe(transactionCommit);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(userCommit);
    expect(git(repo, ["rev-list", "--count", "@{u}..HEAD"])).toBe("1");
    expect(git(repo, ["status", "--porcelain"])).toBe("A  content/knowledge/later-wip.md");
    expect(fs.existsSync(namespace)).toBe(false);
  });

  test("refuses an ignored archive destination before deleting its source memory", async () => {
    const url = "https://example.com/akm/consolidate-git-ignored-archive.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    fs.mkdirSync(content, { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(path.join(repo, ".gitignore"), "content/.akm/archive/\n", "utf8");
    const memoryPath = path.join(content, "memories", "ignored-archive-delete.md");
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    const original = assembleAsset(
      { description: "Memory protected from an ignored consolidation archive" },
      "This substantive memory body is intentionally long enough to pass consolidation eligibility while verifying that an ignored archive cannot precede destructive deletion.",
    );
    fs.writeFileSync(memoryPath, original, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "seed"]);
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        team: { git: url, writable: true },
      },
      defaultBundle: "stash",
      defaultWriteTarget: "team",
      engines: {
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
        },
      },
      improve: { strategies: { judged: { processes: { consolidate: { enabled: true } } } } },
      defaults: { llmEngine: "default", improveStrategy: "judged" },
    } as unknown as AkmConfig;
    overrideSeam(_setChatCompletionForTests, async () =>
      JSON.stringify({
        operations: [{ op: "delete", ref: "memories/ignored-archive-delete", reason: "redundant" }],
      }),
    );

    await expect(akmConsolidate({ target: "team", config, assumeYes: true })).rejects.toThrow(/ignored/i);
    expect(fs.readFileSync(memoryPath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(content, ".akm", "archive"))).toBe(false);
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("allows multiple transaction-owned contradiction edits to the same path", async () => {
    const url = "https://example.com/akm/consolidate-repeated-path.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    fs.mkdirSync(path.join(content, "memories"), { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    for (const name of ["repeated-primary", "contradictor-one", "contradictor-two"]) {
      fs.writeFileSync(
        path.join(content, "memories", `${name}.md`),
        assembleAsset(
          { description: `Consolidation contradiction fixture ${name}` },
          `This substantive memory body for ${name} is intentionally long enough to pass consolidation eligibility and participate in repeated contradiction updates.`,
        ),
        "utf8",
      );
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "seed"]);
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        team: { git: url, writable: true },
      },
      defaultBundle: "stash",
      defaultWriteTarget: "team",
      engines: {
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
        },
      },
      improve: { strategies: { judged: { processes: { consolidate: { enabled: true } } } } },
      defaults: { llmEngine: "default", improveStrategy: "judged" },
    } as unknown as AkmConfig;
    overrideSeam(_setChatCompletionForTests, async () =>
      JSON.stringify({
        operations: [
          {
            op: "contradict",
            ref: "memories/repeated-primary",
            contradictedByRef: "memories/contradictor-one",
            confidence: 1,
          },
          {
            op: "contradict",
            ref: "memories/repeated-primary",
            contradictedByRef: "memories/contradictor-two",
            confidence: 1,
          },
        ],
      }),
    );

    const result = await akmConsolidate({ target: "team", config, assumeYes: true });
    const frontmatter = parseFrontmatter(
      fs.readFileSync(path.join(content, "memories", "repeated-primary.md"), "utf8"),
    ).data;
    expect(result.contradicted).toBe(2);
    expect(frontmatter.contradictedBy).toEqual(["memories/contradictor-one", "memories/contradictor-two"]);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});
