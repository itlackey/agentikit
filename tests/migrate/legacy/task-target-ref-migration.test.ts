// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { planTaskTargetRefMigration } from "../../../scripts/akm-migrate/migrate/legacy/task-target-ref-migration";
import type { AkmConfig } from "../../../src/core/config/config";
import { getLockfilePath } from "../../../src/core/paths";
import { parseTaskV3Yaml } from "../../../src/tasks/source-v3";
import { makeSandboxDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

function configFor(
  bundles: Record<string, { path?: string; git?: string; npm?: string; registryId?: string; writable?: boolean }>,
  defaultBundle = "stash",
): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles,
    defaultBundle,
  } as AkmConfig;
}

function writeBundle(root: string, workflow: string, tasks: Record<string, string>): void {
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "workflows", `${workflow}.md`), `# ${workflow}\n`);
  for (const [name, yaml] of Object.entries(tasks)) fs.writeFileSync(path.join(root, "tasks", `${name}.yml`), yaml);
}

test("plans legacy v1 tasks directly to strict v3 without writing", () => {
  const sandbox = makeSandboxDir("akm-task-target-migration-unit");
  try {
    const legacy = [
      "# published 0.8 task",
      'schedule: "@daily"',
      "workflow: 'workflow:ship' # preserve this comment",
      'params: \'{"channel":"stable"}\'',
      "enabled: true",
      "",
    ].join("\n");
    const current = ["version: 2", 'schedule: "@daily"', "workflow: workflows/current", "enabled: true", ""].join("\n");
    const manualV2Legacy = [
      "version: 2",
      'schedule: "@daily"',
      "workflow: workflow:operator-owned",
      "enabled: true",
      "",
    ].join("\n");
    writeBundle(sandbox.dir, "ship", {
      legacy,
      current,
      "manual-v2-legacy": manualV2Legacy,
    });

    const plan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir } }));
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({ from: "workflow:ship", to: "workflows/ship" });

    const migratedPath = path.join(sandbox.dir, "tasks", "legacy.yml");
    const rewrite = plan.rewrites[0];
    if (!rewrite) throw new Error("expected a planned v3 rewrite");
    expect(parseTaskV3Yaml({ yaml: rewrite.after.toString("utf8"), filePath: migratedPath })).toMatchObject({
      version: 3,
      target: { kind: "uses", uses: { kind: "workflow", ref: "workflows/ship" }, with: { channel: "stable" } },
      akm: { schedule: "@daily", enabled: true },
    });
    expect(fs.readFileSync(path.join(sandbox.dir, "tasks", "current.yml"), "utf8")).toBe(current);
    expect(fs.readFileSync(path.join(sandbox.dir, "tasks", "manual-v2-legacy.yml"), "utf8")).toBe(manualV2Legacy);
    expect(fs.readFileSync(migratedPath, "utf8")).toBe(legacy);
  } finally {
    sandbox.cleanup();
  }
});

test("resolves an origin-qualified legacy target to the configured bundle id", () => {
  const sandbox = makeSandboxDir("akm-task-target-origin-unit");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const team = path.join(sandbox.dir, "team");
    writeBundle(stash, "unused", {
      cross: 'schedule: "@daily"\nworkflow: github:org/team//workflow:ship\nenabled: true\n',
    });
    writeBundle(team, "ship", {});
    const plan = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        team: { path: team, registryId: "github:org/team" },
      }),
    );
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({
      from: "github:org/team//workflow:ship",
      to: "team//workflows/ship",
    });
  } finally {
    sandbox.cleanup();
  }
});

test("fails closed for ambiguous origins but rewrites a stale missing workflow target", () => {
  const sandbox = makeSandboxDir("akm-task-target-fail-closed-unit");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const first = path.join(sandbox.dir, "first");
    const second = path.join(sandbox.dir, "second");
    writeBundle(stash, "unused", {
      ambiguous: 'schedule: "@daily"\nworkflow: shared//workflow:ship\nenabled: true\n',
    });
    writeBundle(first, "ship", {});
    writeBundle(second, "ship", {});

    expect(() =>
      planTaskTargetRefMigration(
        configFor({
          stash: { path: stash, writable: true },
          first: { path: first, registryId: "shared" },
          second: { path: second, registryId: "shared" },
        }),
      ),
    ).toThrow(/ambiguous.*shared.*first.*second.*rerun `akm-migrate apply`/i);

    fs.writeFileSync(
      path.join(stash, "tasks", "ambiguous.yml"),
      'schedule: "@daily"\nworkflow: workflow:missing\nenabled: true\n',
    );
    const planMissing = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        first: { path: first },
        second: { path: second },
      }),
    );
    expect(planMissing.rewrites).toHaveLength(1);
    expect(planMissing.rewrites[0]).toMatchObject({ from: "workflow:missing", to: "workflows/missing" });
  } finally {
    sandbox.cleanup();
  }
});

test("rewrites plain origin-qualified targets containing @ or #", () => {
  const sandbox = makeSandboxDir("akm-task-target-origin-scalars-unit");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const pkg = path.join(sandbox.dir, "pkg");
    const team = path.join(sandbox.dir, "team");
    writeBundle(stash, "unused", {
      npm: 'schedule: "@daily"\nworkflow: npm:@scope/pkg//workflow:ship\n',
      github: 'schedule: "@daily"\nworkflow: github:owner/repo#v1//workflow:ship\n',
    });
    writeBundle(pkg, "ship", {});
    writeBundle(team, "ship", {});

    const plan = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        pkg: { path: pkg, registryId: "npm:@scope/pkg" },
        team: { path: team, registryId: "github:owner/repo#v1" },
      }),
    );
    expect(plan.rewrites.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "github:owner/repo#v1//workflow:ship", to: "team//workflows/ship" },
      { from: "npm:@scope/pkg//workflow:ship", to: "pkg//workflows/ship" },
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test("moves prompt and command compatibility into the v1 task migration", () => {
  const sandbox = makeSandboxDir("akm-task-v1-normalize-unit");
  try {
    writeBundle(sandbox.dir, "unused", {
      prompt: 'schedule: "@daily"\nprompt: Review changes\nprofile: reviewer\ntags: review, daily\n',
      improve: 'schedule: "@daily"\ncommand: akm improve --profile frequent --auto-accept safe --limit 5\n',
      explicit: 'schedule: "@daily"\ncommand: /opt/retained-0.8/akm improve --profile frequent --auto-accept safe\n',
      backup: 'schedule: "@daily"\ncommand: akm db backups\nenabled: true\n',
    });

    const plan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }));
    expect(plan.rewrites).toHaveLength(4);
    const read = (id: string) => {
      const filePath = path.join(sandbox.dir, "tasks", `${id}.yml`);
      const rewrite = plan.rewrites.find((candidate) => candidate.filePath === filePath);
      if (!rewrite) throw new Error(`missing planned rewrite for ${id}`);
      return parseTaskV3Yaml({ yaml: rewrite.after.toString("utf8"), filePath });
    };
    expect(read("prompt")).toMatchObject({
      version: 3,
      target: { kind: "uses", uses: { kind: "builtin-command", ref: "akm/command" } },
      akm: { tags: ["review", "daily"], engine: "reviewer" },
    });
    expect(read("improve").target).toMatchObject({ kind: "run", run: "akm improve --strategy frequent --limit 5" });
    expect(read("explicit").target).toMatchObject({
      kind: "run",
      run: "/opt/retained-0.8/akm improve --profile frequent --auto-accept safe",
    });
    expect(read("backup")).toMatchObject({
      target: { kind: "run", run: "akm db backups" },
      akm: { enabled: false },
    });
  } finally {
    sandbox.cleanup();
  }
});

test("resolves targets from a lock-materialized read-only bundle without rewriting that bundle", () => {
  const sandbox = makeSandboxDir("akm-task-target-materialized-unit");
  const dataHome = sandboxXdgDataHome();
  try {
    const stash = path.join(sandbox.dir, "stash");
    const materialized = path.join(sandbox.dir, "materialized-team");
    writeBundle(stash, "unused", {
      cross: 'schedule: "@daily"\nworkflow: github:org/team//workflow:ship\nenabled: true\n',
    });
    const readOnlyTask = 'schedule: "@daily"\nworkflow: workflow:ship\nenabled: true\n';
    writeBundle(materialized, "ship", { "read-only": readOnlyTask });
    fs.mkdirSync(path.dirname(getLockfilePath()), { recursive: true });
    fs.writeFileSync(
      getLockfilePath(),
      `${JSON.stringify([
        {
          id: "team",
          source: "git",
          ref: "github:org/team",
          localRoot: materialized,
        },
      ])}\n`,
    );

    const plan = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        team: { git: "https://github.com/org/team.git", registryId: "github:org/team" },
      }),
    );
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({ to: "team//workflows/ship" });
    expect(fs.readFileSync(path.join(materialized, "tasks", "read-only.yml"), "utf8")).toBe(readOnlyTask);
  } finally {
    dataHome.cleanup();
    sandbox.cleanup();
  }
});

test("rejects symlinked task roots and task files", () => {
  const sandbox = makeSandboxDir("akm-task-target-symlink-unit");
  try {
    const root = path.join(sandbox.dir, "bundle");
    writeBundle(root, "ship", {});
    const realTasks = path.join(sandbox.dir, "real-tasks");
    fs.mkdirSync(realTasks);
    fs.writeFileSync(path.join(realTasks, "ship.yml"), "workflow: workflow:ship\n");
    fs.rmSync(path.join(root, "tasks"), { recursive: true });
    fs.symlinkSync(realTasks, path.join(root, "tasks"), "dir");

    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: root, writable: true } }))).toThrow(
      /tasks.*symbolic link|symbolic.*tasks/i,
    );

    fs.rmSync(path.join(root, "tasks"));
    fs.mkdirSync(path.join(root, "tasks"));
    const victim = path.join(sandbox.dir, "victim.yml");
    fs.writeFileSync(victim, "workflow: workflow:ship\n");
    fs.symlinkSync(victim, path.join(root, "tasks", "ship.yml"));
    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: root, writable: true } }))).toThrow(
      /task migration does not follow symbolic links/i,
    );

    fs.rmSync(path.join(root, "tasks", "ship.yml"));
    fs.writeFileSync(path.join(root, "tasks", "ship.yml"), "workflow: workflow:ship\n");
    fs.rmSync(path.join(root, "workflows", "ship.md"));
    const outsideWorkflow = path.join(sandbox.dir, "outside-workflow.md");
    fs.writeFileSync(outsideWorkflow, "# Outside\n");
    fs.symlinkSync(outsideWorkflow, path.join(root, "workflows", "ship.md"));
    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: root, writable: true } }))).toThrow(
      /resolves outside bundle/i,
    );
  } finally {
    sandbox.cleanup();
  }
});

test("rejects invalid UTF-8 task bytes before planning a rewrite", () => {
  const sandbox = makeSandboxDir("akm-task-target-utf8-unit");
  try {
    writeBundle(sandbox.dir, "ship", {});
    fs.writeFileSync(
      path.join(sandbox.dir, "tasks", "invalid.yml"),
      Buffer.concat([Buffer.from("workflow: workflow:ship\n# "), Buffer.from([0xff])]),
    );
    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }))).toThrow(
      /invalid UTF-8/i,
    );
  } finally {
    sandbox.cleanup();
  }
});
