import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../../_helpers/cli";
import { type Cleanup, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function useStorage(): ReturnType<typeof withIsolatedAkmStorage> {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function runEntrypoint(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

// NOTE: the pre-execution `--shape` gate test (rejecting global
// --shape=summary before non-show commands) lives in
// tests/integration/show-argv-entrypoint.test.ts — it needs the real
// subprocess entry point, which the in-process harness intentionally skips.

// D2: the `akm show <ref> toc|section|lines|frontmatter|full` view grammar is
// gone. A trailing positional was previously rewritten into hidden `--akmView`
// flags; it must now be a usage error that points at `#fragment`, and the
// hidden flags themselves must no longer select anything.
describe("akm show view-mode grammar is removed", () => {
  const GUIDE = ["# Intro", "Welcome.", "", "## Setup", "Install things.", ""].join("\n");

  function seedGuide(): void {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "guide.md"), GUIDE);
  }

  for (const positional of ["toc", "frontmatter", "full", "section", "lines"]) {
    test(`a trailing \`${positional}\` positional is a usage error naming #fragment`, async () => {
      seedGuide();

      const result = await runEntrypoint(["show", "knowledge/guide", positional, "--format=json"]);

      expect(result.status).toBe(2);
      const error = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(error.ok).toBe(false);
      expect(String(error.error)).toContain("akm show knowledge/guide#");
    });
  }

  test("the hidden --akmView flag no longer selects a view", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--akmView=toc", "--format=json"]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.content).toBe(GUIDE);
  });

  test("the ref keeps resolving when a view keyword is its own conceptId", async () => {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "toc.md"), "# Toc\nA doc literally named toc.\n");

    const result = await runEntrypoint(["show", "knowledge/toc", "--format=json"]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.name).toBe("toc");
  });
});

describe("entrypoint global --shape=summary ordering", () => {
  test("allows global --shape=summary before show", async () => {
    const storage = useStorage();
    // Semantic off keeps stderr empty as asserted below: with the default
    // ("auto") the local embedder fetches its model from huggingface.co
    // during auto-index, and an offline/blocked fetch warns on stderr.
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(
      path.join(storage.stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );

    const result = await runEntrypoint(["--format=json", "--shape=summary", "show", "commands/release.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.name).toBe("release");
    expect(json.description).toBe("Release");
    expect(json).not.toHaveProperty("template");
  });
});
