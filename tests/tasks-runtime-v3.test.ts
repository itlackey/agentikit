import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config-types";
import { createAdapterRenderedExecutionSource } from "../src/execution/source";
import { prepareTaskV3Execution } from "../src/tasks/runtime-v3";
import { parseTaskV3Yaml } from "../src/tasks/source-v3";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-runtime-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
  return root;
}

const config: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  defaults: { engine: "fixture" },
  engines: { fixture: { kind: "agent", platform: "claude", bin: "/bin/true" } },
};

function source(yaml: string, root: string) {
  return parseTaskV3Yaml({ yaml, filePath: path.join(root, "tasks", "nightly.yml"), workspaceRoot: root });
}

describe("prepareTaskV3Execution", () => {
  test("prepares akm/command through the common command cascade with task provenance and exact current values", async () => {
    const root = fixtureRoot();
    const prepared = await prepareTaskV3Execution(
      source(
        [
          "version: 3",
          "uses: akm/command",
          "with:",
          "  content: Review $ARGUMENTS",
          "  arguments: exact",
          "env:",
          "  MODE: 0",
          "akm:",
          '  schedule: "@daily"',
          "  agent: null",
          "  engine: fixture",
          "  model: exact/model",
          "  inference:",
          "    temperature: 0",
          "  timeout: 0",
          "",
        ].join("\n"),
        root,
      ),
      { taskId: "nightly", taskRef: "bundle//tasks/nightly", bundleName: "bundle", bundleRoot: root, config },
    );

    expect(prepared.kind).toBe("command");
    if (prepared.kind !== "command") throw new Error("expected command");
    expect(prepared.invocation.request.command.content).toBe("Review exact");
    expect(prepared.invocation.request.engine.name).toBe("fixture");
    expect(prepared.invocation.request.model?.input).toBe("exact/model");
    expect(prepared.invocation.request.inference).toEqual({ temperature: 0 });
    expect(prepared.invocation.request.runtime.timeoutMs).toBe(0);
    expect(prepared.invocation.request.agent).toBeNull();
    expect(prepared.environment).toEqual({ MODE: "0" });
  });

  test("qualifies built-in command and persona refs to the task's owning bundle before loading", async () => {
    const root = fixtureRoot();
    const calls: Array<{ ref: string; kind: string }> = [];
    const prepared = await prepareTaskV3Execution(
      source(
        [
          "version: 3",
          "uses: akm/command",
          "with:",
          "  ref: commands/review",
          "akm:",
          '  schedule: "@daily"',
          "  agent: agents/reviewer",
          "  engine: fixture",
          "",
        ].join("\n"),
        root,
      ),
      {
        taskId: "nightly",
        taskRef: "other//tasks/nightly",
        bundleName: "other",
        bundleRoot: root,
        config,
        commandSourceLoader: async (ref, kind) => {
          calls.push({ ref, kind });
          return createAdapterRenderedExecutionSource({
            kind,
            content: kind === "command" ? "Review." : "Be exact.",
            identity: {
              ref,
              bundle: "other",
              adapter: "akm",
              file: `${kind === "command" ? "commands/review" : "agents/reviewer"}.md`,
              hash: "a".repeat(64),
            },
          });
        },
      },
    );
    expect(prepared.kind).toBe("command");
    expect(calls).toEqual([
      { ref: "other//commands/review", kind: "command" },
      { ref: "other//agents/reviewer", kind: "persona" },
    ]);
  });

  test("rejects nonprojectable and remote targets before returning a prepared dispatch", async () => {
    const root = fixtureRoot();
    for (const yaml of [
      'version: 3\nuses: actions/checkout@v4\nakm:\n  schedule: "@daily"\n',
      'version: 3\nuses: commands/review\nwith:\n  value: no\nakm:\n  schedule: "@daily"\n',
      'version: 3\nuses: scripts/missing\nakm:\n  schedule: "@daily"\n',
    ]) {
      await expect(
        prepareTaskV3Execution(source(yaml, root), {
          taskId: "nightly",
          taskRef: "bundle//tasks/nightly",
          bundleName: "bundle",
          bundleRoot: root,
          config,
        }),
      ).rejects.toThrow();
    }
  });

  test("freezes script bytes and hash and never retains a live resumable path", async () => {
    const root = fixtureRoot();
    const scriptPath = path.join(root, "scripts", "nightly.sh");
    const bytes = Buffer.from("#!/bin/sh\nprintf frozen\n", "utf8");
    fs.writeFileSync(scriptPath, bytes);
    const prepared = await prepareTaskV3Execution(
      source('version: 3\nuses: scripts/nightly.sh\nakm:\n  schedule: "@daily"\n', root),
      { taskId: "nightly", taskRef: "bundle//tasks/nightly", bundleName: "bundle", bundleRoot: root, config },
    );
    expect(prepared).toMatchObject({
      kind: "script",
      interpreter: "sh",
      sourceRef: "bundle//scripts/nightly.sh",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (prepared.kind !== "script") throw new Error("expected script");
    expect(Buffer.from(prepared.bytesBase64, "base64")).toEqual(bytes);
    expect("path" in prepared).toBe(false);
  });

  test("rejects secret-shaped literal env before preparation and canonicalizes run shell/cwd/env", async () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, "work"));
    const valid = await prepareTaskV3Execution(
      source(
        [
          "version: 3",
          "run: printf ok",
          "shell: bash",
          "working-directory: work",
          "env:",
          "  COUNT: 0",
          "  ENABLED: false",
          "akm:",
          '  schedule: "@daily"',
          "",
        ].join("\n"),
        root,
      ),
      { taskId: "nightly", taskRef: "bundle//tasks/nightly", bundleName: "bundle", bundleRoot: root, config },
    );
    expect(valid).toMatchObject({
      kind: "shell",
      shell: "bash",
      command: "printf ok",
      cwd: path.join(root, "work"),
      environment: { COUNT: "0", ENABLED: "false" },
    });

    await expect(
      prepareTaskV3Execution(
        source(
          'version: 3\nrun: printf no\nenv:\n  API_TOKEN: github_pat_012345678901234567890123456789\nakm:\n  schedule: "@daily"\n',
          root,
        ),
        { taskId: "nightly", taskRef: "bundle//tasks/nightly", bundleName: "bundle", bundleRoot: root, config },
      ),
    ).rejects.toThrow(/secret-shaped literal env/i);
  });

  test("injects a platform-safe default shell while preserving an explicit authored shell exactly", async () => {
    const root = fixtureRoot();
    const document = source('version: 3\nrun: printf ok\nakm:\n  schedule: "@daily"\n', root);
    const common = {
      taskId: "nightly",
      taskRef: "bundle//tasks/nightly",
      bundleName: "bundle",
      bundleRoot: root,
      config,
    } as const;

    const posix = await prepareTaskV3Execution(document, { ...common, platform: "linux" });
    const windows = await prepareTaskV3Execution(document, { ...common, platform: "win32" });
    const explicit = await prepareTaskV3Execution(
      source('version: 3\nrun: printf ok\nshell: bash\nakm:\n  schedule: "@daily"\n', root),
      { ...common, platform: "win32" },
    );

    expect(posix).toMatchObject({ kind: "shell", shell: "sh" });
    expect(windows).toMatchObject({ kind: "shell", shell: "powershell" });
    expect(explicit).toMatchObject({ kind: "shell", shell: "bash" });
  });

  test.skipIf(process.platform === "win32")(
    "prepares the canonical physical cwd instead of retaining a live symlink spelling",
    async () => {
      const root = fixtureRoot();
      const physical = path.join(root, "physical-work");
      const linked = path.join(root, "linked-work");
      fs.mkdirSync(physical);
      fs.symlinkSync(physical, linked, "dir");

      const prepared = await prepareTaskV3Execution(
        source('version: 3\nrun: printf ok\nworking-directory: linked-work\nakm:\n  schedule: "@daily"\n', root),
        { taskId: "nightly", taskRef: "bundle//tasks/nightly", bundleName: "bundle", bundleRoot: root, config },
      );

      expect(prepared).toMatchObject({ kind: "shell", cwd: fs.realpathSync.native(physical) });
    },
  );

  test("qualifies workflow refs to the owning bundle and allows parameters only on that target", async () => {
    const root = fixtureRoot();
    fs.writeFileSync(
      path.join(root, "workflows", "daily.md"),
      "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n",
    );
    const prepared = await prepareTaskV3Execution(
      source(
        [
          "version: 3",
          "uses: workflows/daily",
          "with:",
          "  count: 0",
          "akm:",
          '  schedule: "@daily"',
          "  timeout: null",
          "  maxSteps: 2",
          "  maxRetries: 1",
          "",
        ].join("\n"),
        root,
      ),
      { taskId: "nightly", taskRef: "bundle//tasks/nightly", bundleName: "bundle", bundleRoot: root, config },
    );
    expect(prepared).toMatchObject({
      kind: "workflow",
      ref: "bundle//workflows/daily",
      params: { count: 0 },
      timeoutMs: null,
      maxSteps: 2,
      maxRetries: 1,
    });
  });

  test("preserves qualified cross-bundle refs and resolves immutable script bytes from that bundle", async () => {
    const root = fixtureRoot();
    const shared = fixtureRoot();
    const file = path.join(shared, "scripts", "shared.sh");
    fs.writeFileSync(file, "#!/bin/sh\nprintf shared\n");
    const requests: string[] = [];
    const prepared = await prepareTaskV3Execution(
      source('version: 3\nuses: shared//scripts/shared.sh\nakm:\n  schedule: "@daily"\n', root),
      {
        taskId: "nightly",
        taskRef: "bundle//tasks/nightly",
        bundleName: "bundle",
        bundleRoot: root,
        config,
        resolveAsset: async ({ bundle, ref }) => {
          requests.push(`${bundle}:${ref}`);
          return file;
        },
      },
    );
    expect(prepared).toMatchObject({ kind: "script", sourceRef: "shared//scripts/shared.sh" });
    expect(requests).toEqual(["shared:shared//scripts/shared.sh"]);
  });
});
