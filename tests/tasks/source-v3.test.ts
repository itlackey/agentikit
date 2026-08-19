// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyTaskV3Triggers,
  classifyTaskV3Uses,
  parseTaskV3Document,
  parseTaskV3Yaml,
  TASK_V2_MIGRATION_HINT,
  TASK_V3_HOST_SHELLS,
  TASK_V3_MAX_SOURCE_BYTES,
  TASK_V3_MAX_STRING_BYTES,
  taskV3SourceErrorDetail,
} from "../../src/tasks/source-v3";

function scheduled(overrides: Record<string, unknown>): Record<string, unknown> {
  return { version: 3, akm: { schedule: "@daily" }, ...overrides };
}

describe("task v3 target grammar", () => {
  test.each([
    ["akm/command", { kind: "builtin-command", ref: "akm/command" }],
    ["commands/review", { kind: "command", ref: "commands/review" }],
    ["team//commands/review", { kind: "command", ref: "team//commands/review" }],
    ["workflows/release", { kind: "workflow", ref: "workflows/release" }],
    ["team//scripts/check", { kind: "script", ref: "team//scripts/check" }],
    [
      "actions/checkout@v4",
      { kind: "github-action", ref: "actions/checkout@v4", owner: "actions", repository: "checkout", revision: "v4" },
    ],
    [
      "octo-org/action-repo/sub/action@feature/v2",
      {
        kind: "github-action",
        ref: "octo-org/action-repo/sub/action@feature/v2",
        owner: "octo-org",
        repository: "action-repo",
        path: "sub/action",
        revision: "feature/v2",
      },
    ],
  ] as const)("classifies %s deterministically", (input, expected) => {
    expect(classifyTaskV3Uses(input)).toEqual(expected);
  });

  test.each([
    "agents/reviewer",
    "tasks/nightly",
    "knowledge/guide",
    "akm:command",
    "akm/commands/review",
    "commands/my command",
    "./local-action",
    "docker://alpine:3",
    "commands/../agents/reviewer",
    "team//commands/./review",
    "owner/repo/../action@v1",
    "owner/repo@refs/heads/../main",
    "owner/repo@feature..main",
    "owner/repo@refs/.hidden/main",
    "owner/repo@refs/heads/main.",
    "owner/repo@main.lock",
    "owner/repo",
    " owner/repo@v1",
    "owner/repo@v1 ",
    "owner//repo@v1",
    "owner/repo@@v1",
    ["$", "{{ github.repository }}/action@v1"].join(""),
  ])("rejects non-executable, ambiguous, local, traversal, and malformed uses ref %p", (input) => {
    expect(() => classifyTaskV3Uses(input)).toThrow(/uses|executable|ref|action|agent|task/i);
  });
});

describe("strict task v3 source document", () => {
  test("exports the same pure trigger classifier used by complete task parsing", () => {
    expect(
      classifyTaskV3Triggers(
        {
          akm: { enabled: false },
          on: { schedule: [{ cron: "0 1 * * *" }], workflow_dispatch: {} },
        },
        { filePath: "/stash/workflows/nightly.yml" },
      ),
    ).toEqual({
      manual: true,
      schedules: [{ cron: "0 1 * * *", source: "on.schedule[0].cron", ordinal: 0 }],
    });
    expect(() => classifyTaskV3Triggers({ on: { push: {} } }, { filePath: "/stash/workflows/nightly.yml" })).toThrow(
      /unsupported local service event/,
    );
    expect(() =>
      classifyTaskV3Triggers({ on: { workflow_dispatch: {} }, jobs: {} }, { filePath: "/stash/workflows/nightly.yml" }),
    ).toThrow(/jobs.*unsupported field/);
  });

  test("preserves admitted false, zero, empty, and null values and delegates akm/command with parsing", () => {
    const parsed = parseTaskV3Document(
      scheduled({
        name: "",
        uses: "akm/command",
        with: { content: "", arguments: "" },
        env: { EMPTY: "", FALSE: false, ZERO: 0 },
        akm: {
          schedule: "@daily",
          enabled: false,
          description: "",
          when_to_use: "",
          tags: [],
          agent: null,
          engine: null,
          model: null,
          inference: null,
          outputSchema: null,
          tools: [],
          timeout: 0,
          redact: [],
          maxSteps: 1,
          maxRetries: 0,
        },
      }),
      { filePath: "/bundle/tasks/exact.yml" },
    );

    expect(parsed.version).toBe(3);
    expect(parsed.name).toBe("");
    expect(parsed.target).toEqual({
      kind: "uses",
      uses: { kind: "builtin-command", ref: "akm/command" },
      with: { content: "", arguments: "" },
      command: { kind: "inline", content: "", arguments: "" },
    });
    expect(parsed.env).toEqual({ EMPTY: "", FALSE: false, ZERO: 0 });
    expect(parsed.akm).toEqual({
      schedule: "@daily",
      enabled: false,
      description: "",
      when_to_use: "",
      tags: [],
      agent: null,
      engine: null,
      model: null,
      inference: null,
      outputSchema: null,
      tools: [],
      timeout: 0,
      redact: [],
      maxSteps: 1,
      maxRetries: 0,
    });
    expect(parsed.triggers).toEqual({
      manual: false,
      schedules: [{ cron: "@daily", source: "akm.schedule", ordinal: 0 }],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.getPrototypeOf(parsed.env)).toBeNull();
  });

  test("accepts the closed run/shell/working-directory contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-root-"));
    fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
    try {
      const parsed = parseTaskV3Document(
        scheduled({
          run: "printf '%s\\n' exact",
          shell: "bash",
          "working-directory": "packages/core",
        }),
        { filePath: path.join(root, "tasks", "run.yml"), workspaceRoot: root },
      );
      expect(TASK_V3_HOST_SHELLS).toContain("bash");
      expect(parsed.target).toEqual({
        kind: "run",
        run: "printf '%s\\n' exact",
        shell: "bash",
        workingDirectory: "packages/core",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires a workspace root whenever working-directory needs physical containment", () => {
    expect(() =>
      parseTaskV3Document(scheduled({ run: "echo exact", "working-directory": "packages/core" }), {
        filePath: "/bundle/tasks/run.yml",
      }),
    ).toThrow(/workspace root|physically|contain/i);
  });

  test("parses GitHub-style schedule and manual triggers into deterministic internal bindings", () => {
    const parsed = parseTaskV3Document(
      {
        version: 3,
        uses: "commands/review",
        with: { strict: false, attempts: 0, note: "" },
        on: {
          schedule: [{ cron: "0 6 * * *" }, { cron: "30 18 * * 1-5" }],
          workflow_dispatch: null,
        },
      },
      { filePath: "/bundle/tasks/review.yml" },
    );
    expect(parsed.triggers).toEqual({
      manual: true,
      schedules: [
        { cron: "0 6 * * *", source: "on.schedule[0].cron", ordinal: 0 },
        { cron: "30 18 * * 1-5", source: "on.schedule[1].cron", ordinal: 1 },
      ],
    });
  });

  test.each([
    [{ uses: "commands/x" }, "version"],
    [{ version: 2, uses: "commands/x", akm: { schedule: "@daily" } }, "version"],
    [scheduled({}), "exactly one"],
    [scheduled({ uses: "commands/x", run: "echo x" }), "exactly one"],
    [scheduled({ run: "echo x", with: {} }), "with"],
    [scheduled({ uses: "commands/x", shell: "bash" }), "shell"],
    [scheduled({ uses: "commands/x", "working-directory": "." }), "working-directory"],
    [scheduled({ uses: "commands/x", extra: true }), "extra"],
    [scheduled({ uses: "commands/x", akm: { schedule: "@daily", extra: true } }), "extra"],
    [scheduled({ uses: "" }), "uses"],
    [scheduled({ run: "   " }), "run"],
    [scheduled({ run: ["echo", "x"] }), "run"],
    [scheduled({ run: "echo x", shell: "bash -e {0}" }), "shell"],
    [scheduled({ run: "echo x", "working-directory": "/tmp" }), "working-directory"],
    [scheduled({ run: "echo x", "working-directory": "../escape" }), "working-directory"],
    [scheduled({ run: "echo x", "working-directory": "safe\0tail" }), "working-directory"],
    [scheduled({ uses: "commands/x", on: { workflow_dispatch: null } }), "one scheduling source"],
    [{ version: 3, uses: "commands/x" }, "scheduling source"],
    [{ version: 3, uses: "commands/x", on: {} }, "on"],
    [{ version: 3, uses: "commands/x", on: { schedule: [] } }, "non-empty"],
    [{ version: 3, uses: "commands/x", on: { schedule: [{ cron: "" }] } }, "cron"],
    [{ version: 3, uses: "commands/x", on: { workflow_dispatch: { inputs: {} } } }, "workflow_dispatch"],
    [{ version: 3, uses: "commands/x", on: { push: {} } }, "push"],
    [{ version: 3, uses: "commands/x", on: { schedule: "0 0 * * *" } }, "schedule"],
    [scheduled({ uses: "akm/command", with: { ref: "commands/x", content: "x" } }), "exactly one"],
    [scheduled({ uses: "akm/command", with: { content: "x", extra: true } }), "unsupported field"],
    [scheduled({ uses: "commands/x", env: { BAD: null } }), "env.BAD"],
    [scheduled({ uses: "commands/x", akm: { schedule: "@daily", timeout: "1s" } }), "timeout"],
  ] as Array<[Record<string, unknown>, string]>)("rejects invalid source %#", (input, message) => {
    expect(() => parseTaskV3Document(input, { filePath: "/bundle/tasks/invalid.yml" })).toThrow(message);
  });

  test("rejects v2 with the canonical migrate preview/apply hint", () => {
    let detail = "";
    try {
      parseTaskV3Yaml({
        yaml: "version: 2\nschedule: '@daily'\nprompt: hello\n",
        filePath: "/bundle/tasks/legacy.yml",
      });
    } catch (cause) {
      detail = taskV3SourceErrorDetail(cause);
    }
    expect(detail).toContain("TASK_SCHEMA_VERSION_UNSUPPORTED");
    expect(detail).toContain(TASK_V2_MIGRATION_HINT);
  });

  test("rejects physically escaping working-directory symlinks", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-outside-"));
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    try {
      expect(() =>
        parseTaskV3Document(scheduled({ run: "echo x", "working-directory": "escape" }), {
          filePath: path.join(root, "tasks", "escape.yml"),
          workspaceRoot: root,
        }),
      ).toThrow(/outside|contained|escape/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("task v3 hostile input and resource bounds", () => {
  test("rejects custom prototypes, accessors, non-enumerable fields, and symbols without invoking code", () => {
    expect(() => parseTaskV3Document(new Date(), { filePath: "bad.yml" })).toThrow(/plain|null prototype/i);

    let reads = 0;
    const accessor = Object.defineProperty(scheduled({ uses: "commands/x" }), "uses", {
      enumerable: true,
      get() {
        reads += 1;
        return "commands/x";
      },
    });
    expect(() => parseTaskV3Document(accessor, { filePath: "bad.yml" })).toThrow(/accessor|data property/i);
    expect(reads).toBe(0);

    const hidden = Object.defineProperty(scheduled({ uses: "commands/x" }), "hidden", {
      value: true,
      enumerable: false,
    });
    expect(() => parseTaskV3Document(hidden, { filePath: "bad.yml" })).toThrow(/non-enumerable|enumerable/i);
    expect(() =>
      parseTaskV3Document({ ...scheduled({ uses: "commands/x" }), [Symbol("extra")]: true }, { filePath: "bad.yml" }),
    ).toThrow(/symbol/i);
  });

  test("rejects proxies before invoking any proxy trap", () => {
    let traps = 0;
    const proxy = new Proxy(scheduled({ uses: "commands/x" }), {
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("proxy trap must not run");
      },
      ownKeys() {
        traps += 1;
        throw new Error("proxy trap must not run");
      },
    });
    expect(() => parseTaskV3Document(proxy, { filePath: "bad.yml" })).toThrow(/Proxy/i);
    expect(traps).toBe(0);
  });

  test("rejects nested hostile descriptors, sparse arrays, cycles, and excessive depth", () => {
    const nested = Object.create({ inherited: true }) as Record<string, unknown>;
    nested.value = "x";
    expect(() =>
      parseTaskV3Document(scheduled({ uses: "commands/x", with: { nested } }), { filePath: "bad.yml" }),
    ).toThrow(/plain|null prototype/i);

    const sparse = new Array(2);
    sparse[1] = "x";
    expect(() =>
      parseTaskV3Document(scheduled({ uses: "commands/x", akm: { schedule: "@daily", tags: sparse } }), {
        filePath: "bad.yml",
      }),
    ).toThrow(/dense/i);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => parseTaskV3Document(scheduled({ uses: "commands/x", with: cycle }), { filePath: "bad.yml" })).toThrow(
      /cycle/i,
    );

    let deep: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) deep = { child: deep };
    expect(() =>
      parseTaskV3Document(scheduled({ uses: "commands/x", with: { deep } }), { filePath: "bad.yml" }),
    ).toThrow(/depth|nesting/i);
  });

  test.each([
    "version: 3\nuses: commands/a\nuses: commands/b\nakm: { schedule: '@daily' }\n",
    "version: 3\nuses: commands/a\nakm: &a { schedule: '@daily' }\ncopy: *a\n",
    "version: 3\nuses: commands/a\nakm: !custom { schedule: '@daily' }\n",
    "version: 3\nuses: commands/a\nakm:\n  <<: { schedule: '@daily' }\n",
    "? [complex, key]\n: value\nversion: 3\nuses: commands/a\nakm: { schedule: '@daily' }\n",
  ])("rejects hostile YAML without expanding it", (yaml) => {
    expect(() => parseTaskV3Yaml({ yaml, filePath: "/bundle/tasks/hostile.yml" })).toThrow();
  });

  test("rejects source bytes above the published bound before YAML expansion", () => {
    const yaml = `version: 3\nuses: commands/a\nakm: { schedule: '@daily' }\n#${"x".repeat(TASK_V3_MAX_SOURCE_BYTES)}`;
    expect(() => parseTaskV3Yaml({ yaml, filePath: "/bundle/tasks/large.yml" })).toThrow(/resource|bytes|MiB/i);
  });

  test("bounds YAML depth, mapping width, and aggregate AST nodes before toJS", () => {
    let deep = "leaf: value\n";
    for (let index = 0; index < 70; index += 1) deep = `level${index}:\n${deep.replace(/^/gm, "  ")}`;
    expect(() =>
      parseTaskV3Yaml({
        yaml: `version: 3\nuses: commands/a\nakm: { schedule: '@daily' }\nwith:\n${deep.replace(/^/gm, "  ")}`,
        filePath: "/bundle/tasks/deep.yml",
      }),
    ).toThrow(/depth|nesting/i);

    const wide = Array.from({ length: 257 }, (_, index) => `  k${index}: ${index}`).join("\n");
    expect(() =>
      parseTaskV3Yaml({
        yaml: `version: 3\nuses: commands/a\nakm: { schedule: '@daily' }\nwith:\n${wide}\n`,
        filePath: "/bundle/tasks/wide.yml",
      }),
    ).toThrow(/mapping|key|256/i);

    const manyNodes = Array.from(
      { length: 220 },
      (_, index) => `  k${index}: [${Array.from({ length: 50 }, (_unused, item) => item).join(", ")}]`,
    ).join("\n");
    expect(() =>
      parseTaskV3Yaml({
        yaml: `version: 3\nuses: commands/a\nakm: { schedule: '@daily' }\nwith:\n${manyNodes}\n`,
        filePath: "/bundle/tasks/nodes.yml",
      }),
    ).toThrow(/node|10000/i);
  });

  test("bounds mapping-key strings before object publication and YAML expansion", () => {
    const oversizedKey = "k".repeat(TASK_V3_MAX_STRING_BYTES + 1);
    expect(() =>
      parseTaskV3Document(scheduled({ uses: "commands/a", with: { [oversizedKey]: true } }), {
        filePath: "/bundle/tasks/key-object.yml",
      }),
    ).toThrow(/key|string|262144|byte/i);

    const yaml = JSON.stringify(scheduled({ uses: "commands/a", with: { [oversizedKey]: true } }));
    expect(() => parseTaskV3Yaml({ yaml, filePath: "/bundle/tasks/key-yaml.yml" })).toThrow(/key|string|262144|byte/i);
  });

  test("source-located errors include the file and structural path", () => {
    expect(() =>
      parseTaskV3Yaml({
        yaml: "version: 3\nuses: commands/a\non:\n  push: {}\n",
        filePath: "/bundle/tasks/located.yml",
      }),
    ).toThrow(/\/bundle\/tasks\/located\.yml.*on\.push|on\.push.*\/bundle\/tasks\/located\.yml/i);
  });
});
