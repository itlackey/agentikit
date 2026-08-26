// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane B — `akm task explain <ref> [input flags]` (spec
 * docs/plans/specs/p2b-input-bindings.md §4.5, §1.7 B-N4, rows B-52..B-59).
 *
 * A NEW, read-only verb: it never prepares an execution that spawns
 * anything, never writes history, never touches the scheduler. It prints
 * (text + `--format json`): the task source path and owning bundle, input
 * declarations with defaults, supplied values WITH PROVENANCE (`default` |
 * `flag` | `schedule-binding`), the resolved target kind + ref, effective
 * execution settings with field-level provenance, and schedule bindings. It
 * is SECRET-FREE: never a resolved `env:` value, a credential, a prompt
 * body, or a `run:`/script body.
 *
 * RED TODAY: `akm task explain` does not exist as a subcommand at all —
 * `taskCommand.subCommands` (`src/commands/tasks/tasks-cli.ts`) has no
 * `explain` key, so every invocation below fails with citty's own
 * unknown-subcommand error instead of the behavior pinned here.
 *
 * No `// @ts-expect-error P2b red-phase` pins: every scenario is driven
 * through the REAL `akm` CLI (`runCliCapture`) with plain string argv — no
 * not-yet-existing TypeScript export is referenced directly. The one
 * existing, ALREADY-STABLE export this file touches (`isTaskRunWithId`,
 * `src/cli.ts`) is unaffected by P2b and is asserted as a preservation
 * canary (B-59), not a red assertion.
 *
 * Because the exact rendering layout is Implement's call (the spec pins the
 * CONTENT contract, not a literal template), this file's assertions are
 * deliberately CONTENT-presence checks — the same style
 * tests/integration/commands/tasks-input-flags.test.ts already uses for an
 * under-specified message shape ("check the whole serialized envelope, not
 * one specific field") — rather than a pin on exact text layout.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isTaskRunWithId } from "../../../src/cli";
import { resetConfigCache } from "../../../src/core/config/config";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
  tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

const ENV_SECRET_SENTINEL = "SENTINEL-ENV-VALUE-8f3c1a9d";
const PROMPT_BODY_SENTINEL = "RUN-SENTINEL-prose-1a2b3c4d";
const SCHEDULE_CRON = "0 9 * * 1";

/** A v4 task declaring inputs, a secret-shaped env binding, a command target, and one schedule binding with its own inputs. */
const EXPLAIN_DEMO_YAML = [
  "version: 4",
  "name: Explain demo",
  "description: A demo task for akm task explain.",
  "inputs:",
  "  scope:",
  "    type: string",
  "    default: changed",
  "  strict:",
  "    type: boolean",
  "    default: true",
  "  ticket:",
  "    type: string",
  "env:",
  `  API_KEY: "${ENV_SECRET_SENTINEL}"`,
  "uses: commands/explain-note",
  "schedule:",
  `  - cron: "${SCHEDULE_CRON}"`,
  "    inputs:",
  "      scope: all",
  "",
].join("\n");

function writeExplainDemoFixture(): void {
  write("commands/explain-note.md", `Echo the ${PROMPT_BODY_SENTINEL} note.\n`);
  writeTask("explain-demo", EXPLAIN_DEMO_YAML);
}

describe("akm task explain <ref> — text output (B-52)", () => {
  test("prints declarations+defaults, target kind+ref, effective execution settings, and schedule bindings", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo"]);

    expect(result.code).toBe(0);
    const text = result.stdout;

    // Declarations + defaults.
    expect(text).toContain("scope");
    expect(text).toContain("changed");
    expect(text).toContain("strict");
    expect(text).toContain("ticket");

    // Resolved target kind + ref.
    expect(text).toMatch(/command/i);
    expect(text).toContain("explain-note");

    // Effective execution settings: the config default engine resolves and
    // surfaces even though the task itself declares no engine:.
    expect(text).toContain("test-agent");

    // Schedule bindings: cron, and the binding's own inputs.
    expect(text).toContain(SCHEDULE_CRON);
    expect(text).toContain("all");
  });
});

describe("akm task explain <ref> --format json (B-53)", () => {
  test("prints one JSON object on stdout carrying the same fields", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);

    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope).toBeInstanceOf(Object);
    expect(Array.isArray(envelope)).toBe(false);

    const rendered = JSON.stringify(envelope);
    expect(rendered).toContain("scope");
    expect(rendered).toContain("changed");
    expect(rendered).toContain(SCHEDULE_CRON);
    expect(rendered).toContain("explain-note");
  });

  test("stable key order: two consecutive explain calls on the identical task produce byte-identical JSON", async () => {
    writeExplainDemoFixture();
    const first = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);
    const second = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });
});

/**
 * Locate every "provenance" tag attached to a supplied-value row for
 * `inputName`, recursively, tolerant of whichever concrete JSON SHAPE
 * Implement picks for the envelope — the spec pins the CONTENT contract
 * (B-N4), never a literal layout (this file's own header comment). Two
 * shapes are considered, since either is a reasonable reading of "one row
 * per declared input" (§4.5 B-N4):
 *
 *   (a) an array of `{name: "scope", provenance: "default", ...}` rows;
 *   (b) a map keyed BY input name: `{scope: {provenance: "default", ...}}`.
 *
 * A candidate must carry an OWN `provenance` key to count — this is what
 * makes the search STRUCTURAL rather than a whole-envelope substring probe
 * (P2b test-review finding #7): the input DECLARATION section also has a
 * node named "scope" (with its OWN `default` key, per B-N4's field list),
 * but that node has no `provenance` key, so it is never matched here.
 */
function suppliedValueProvenances(json: unknown, inputName: string): unknown[] {
  const found: unknown[] = [];
  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // Shape (a): this object IS the row — it names itself and carries its
    // own provenance.
    const nameField = obj.name ?? obj.input ?? obj.key;
    if (typeof nameField === "string" && nameField === inputName && Object.hasOwn(obj, "provenance")) {
      found.push(obj.provenance);
    }
    // Shape (b): this object HOLDS the row under a key equal to the input
    // name.
    if (Object.hasOwn(obj, inputName)) {
      const entry = obj[inputName];
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.hasOwn(entry as object, "provenance")
      ) {
        found.push((entry as Record<string, unknown>).provenance);
      }
    }
    for (const value of Object.values(obj)) visit(value);
  }
  visit(json);
  return found;
}

describe("akm task explain <ref> --<flag> — supplied-value provenance (B-54)", () => {
  test("an unflagged input's supplied value is attributed to its DEFAULT, structurally — not merely because the word 'default' appears anywhere in the envelope", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);
    const envelope = JSON.parse(result.stdout);

    // Not `rendered).toMatch(/default/i)` against the whole serialized
    // envelope — the input DECLARATION for "scope" carries its OWN
    // `default: "changed"` key regardless of provenance tracking, so that
    // whole-envelope probe is satisfiable by an envelope with NO provenance
    // at all (P2b test-review finding #7). Locate the SUPPLIED-VALUE row
    // instead and read its provenance field directly.
    expect(suppliedValueProvenances(envelope, "scope")).toContain("default");
  });

  test("--scope urgent overrides the default: the supplied value is attributed to FLAG provenance, structurally — and is no longer attributed to default", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--scope", "urgent", "--format", "json"]);
    const envelope = JSON.parse(result.stdout);

    const provenances = suppliedValueProvenances(envelope, "scope");
    expect(provenances).toContain("flag");
    // Negates a broken implementation that always labels the CURRENT
    // supplied-value row "default" regardless of where the value actually
    // came from.
    expect(provenances).not.toContain("default");
  });

  test("the schedule binding's own inputs are attributed to SCHEDULE-BINDING provenance — coexisting with, and distinct from, the CURRENT row's default/flag provenance for the identical input name", async () => {
    writeExplainDemoFixture();
    const unflagged = JSON.parse((await runCliCapture(["task", "explain", "explain-demo", "--format", "json"])).stdout);
    const flagged = JSON.parse(
      (await runCliCapture(["task", "explain", "explain-demo", "--scope", "urgent", "--format", "json"])).stdout,
    );

    // The fixture's ONE schedule entry supplies `scope: all` (line 96)
    // alongside the task's OWN `scope` declaration — an unflagged explain
    // call therefore carries TWO rows for the same input name "scope": the
    // CURRENT value (provenance "default") and the schedule entry's OWN
    // value (provenance "schedule-binding"). Finding BOTH tags attached to
    // the SAME input name in the SAME envelope is the direct, structural
    // proof that they are tracked as genuinely distinct provenance values,
    // not a single global tag for the whole explain call.
    const unflaggedScopeProvenances = suppliedValueProvenances(unflagged, "scope");
    expect(unflaggedScopeProvenances).toContain("schedule-binding");
    expect(unflaggedScopeProvenances).toContain("default");

    // The schedule entry's own provenance is unaffected by an unrelated
    // CLI flag on the CURRENT row — it is still "schedule-binding", never
    // reclassified to "flag", when --scope is supplied for this call.
    expect(suppliedValueProvenances(flagged, "scope")).toContain("schedule-binding");

    // All three vocabulary values the spec names (B-N4: "default | flag |
    // schedule-binding") are pairwise distinct, observed together across
    // the unflagged + flagged calls above.
    const observed = new Set([
      ...unflaggedScopeProvenances.filter((p) => p === "default" || p === "schedule-binding"),
      ...suppliedValueProvenances(flagged, "scope").filter((p) => p === "flag"),
    ]);
    expect(observed).toEqual(new Set(["default", "schedule-binding", "flag"]));
  });
});

describe("akm task explain <ref> --<undeclared> — UNKNOWN_FLAG (B-55)", () => {
  test("an undeclared flag fails UNKNOWN_FLAG, exit 2, {ok:false,error,code} on stderr", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--not-a-declared-input", "x"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNKNOWN_FLAG");
    expect(result.stderr).toContain("not-a-declared-input");
  });
});

describe("akm task explain <ref> — SECRET-FREE, enumerated bans (B-56, B-N4)", () => {
  test("never prints a resolved env: value, a prompt body, or a run:/script sentinel — in EITHER output format", async () => {
    writeExplainDemoFixture();
    const text = await runCliCapture(["task", "explain", "explain-demo"]);
    const json = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);

    expect(text.code).toBe(0);
    expect(json.code).toBe(0);

    for (const output of [text.stdout, text.stderr, json.stdout, json.stderr]) {
      expect(output).not.toContain(ENV_SECRET_SENTINEL);
      expect(output).not.toContain(PROMPT_BODY_SENTINEL);
    }
  });

  test("a shell task's run: command text never appears — only its target kind/ref", async () => {
    const RUN_SENTINEL = "RUN-COMMAND-TEXT-SENTINEL-9e7d";
    writeTask(
      "explain-shell",
      ["version: 4", "name: Explain shell", `run: echo ${RUN_SENTINEL}`, "shell: sh", ""].join("\n"),
    );
    const result = await runCliCapture(["task", "explain", "explain-shell", "--format", "json"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(RUN_SENTINEL);
    expect(result.stdout).toMatch(/shell/i);
  });
});

describe("akm task explain <ref> — a version: 3 task (B-57)", () => {
  test("works on a v3 task: no declared inputs, target kind/ref and execution settings still resolve", async () => {
    writeTask(
      "explain-v3",
      ["version: 3", "run: echo v3-explain", "shell: sh", "akm:", '  schedule: "@daily"', ""].join("\n"),
    );
    const result = await runCliCapture(["task", "explain", "explain-v3", "--format", "json"]);

    expect(result.code).toBe(0);
    const rendered = JSON.stringify(JSON.parse(result.stdout));
    expect(rendered).toMatch(/shell/i);
    expect(rendered).toContain("@daily");
  });
});

describe("akm task explain — no ref / an unknown ref (B-58)", () => {
  test("no ref at all: usage error, exit 2", async () => {
    const result = await runCliCapture(["task", "explain"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });

  test("an unknown ref: not-found error, exit 1", async () => {
    const result = await runCliCapture(["task", "explain", "does-not-exist"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });
});

describe("isTaskRunWithId — akm task explain never classifies as a task run (B-59, PRESERVE)", () => {
  test("`akm task explain <ref>` classifies false; `akm task run <ref>` is unaffected and still classifies true", () => {
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "explain", "explain-demo"])).toBe(false);
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "explain", "explain-demo", "--scope", "all"])).toBe(false);
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "run", "explain-demo"])).toBe(true);
  });
});
