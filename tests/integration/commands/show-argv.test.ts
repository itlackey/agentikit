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

// E-3: `akm show <ref> --scope ...` must fail LOUDLY (exit 2) for BOTH
// spellings of the removed `--scope` flag, and must diagnose the ACTUAL
// mistake (stale --scope flag, use --filter) rather than blaming the
// unrelated removed view-mode grammar.
//
// `--scope` is deliberately not a declared flag on `show` (R-047, guardrail
// 6 — no alias, no re-acceptance), which means citty's default handling of an
// undeclared flag applies, and that default is SILENT ACCEPTANCE — not a
// uniform error — depending on spelling:
//   - space form (`--scope user=x`): citty treats `--scope` as boolean and
//     pushes `user=x` into `args._` as a stray positional, which incidentally
//     trips the arity check and exits 2 — but (pre-fix) with the wrong
//     diagnosis, blaming the unrelated retired
//     toc|section|lines|frontmatter|full view-mode grammar.
//   - equals form (`--scope=user=x`): citty consumes it as the unknown flag's
//     own inline value. It never reaches `args._`, so (pre-fix) NOTHING
//     downstream ever noticed — the command ran to completion and exited 0,
//     silently ignoring the caller's scope request entirely. This is the
//     dangerous case a caller could mistake for "my read was scoped" when it
//     was not, and it directly violated guardrail 6's "must fail loudly, not
//     silently".
// Both spellings must now be rejected explicitly and identically, before
// either could produce a different (or no) error.
describe("akm show --scope fails loudly for both spellings, diagnosing the removed flag", () => {
  function seedGuide(): void {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "guide.md"), "# Intro\nWelcome.\n");
  }

  function assertScopeDiagnosis(error: Record<string, unknown>): void {
    expect(error.ok).toBe(false);
    expect(String(error.error)).toContain("--scope");
    expect(String(error.error)).toContain("--filter");
    expect(String(error.error)).not.toContain("view-mode grammar");
  }

  test("space form (--scope user=x) exits 2 and points at --filter", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--scope", "user=x", "--format=json"]);

    expect(result.status).toBe(2);
    assertScopeDiagnosis(JSON.parse(result.stderr) as Record<string, unknown>);
  });

  test("equals form (--scope=user=x) exits 2 instead of silently succeeding", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--scope=user=x", "--format=json"]);

    expect(result.status).toBe(2);
    assertScopeDiagnosis(JSON.parse(result.stderr) as Record<string, unknown>);
  });

  test("--filter (the real spelling) still works and is unaffected", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--filter", "user=x", "--format=json"]);

    // No matching scope_user on disk -> not found in this scope, NOT a usage error.
    expect(result.status).toBe(1);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(String(error.error)).toContain("out of scope");
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
