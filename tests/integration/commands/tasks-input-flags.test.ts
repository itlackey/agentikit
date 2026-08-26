// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2a Lane C — `akm task run`'s exact-name input flags (spec
 * docs/plans/specs/p2a-task-source-v4.md §5.1, §1.4 "Lane C — CLI + schema +
 * docs"). This lane owns ONLY this file plus the AUTHORIZED updates to
 * tests/integration/tasks-schema.test.ts (§6 F-1).
 *
 * RED phase: task source v4 (`src/tasks/source/task-source-v4.ts`, Lane A),
 * the shared input contract (`src/execution/input-contract.ts`, Lane B), and
 * this lane's own additions — `RunTaskOptions.inputFlags` on
 * `src/tasks/run/task-result.ts`, plus this file's own test-only
 * `captureInputBindings` seam on that same options bag — do not exist yet.
 * Every reference to one of those not-yet-existing names carries a
 * directly-preceding
 *
 *   // @ts-expect-error P2a red-phase: <symbol> lands in Implement
 *
 * directive, per the task brief's RED-PHASE TYPE PINS contract. This mirrors
 * the convention `tests/tasks/source-v4.test.ts` and
 * `tests/execution/input-contract.test.ts` already established for this
 * phase: one pin exactly where `tsc` reports the diagnostic (the module
 * specifier line for an unresolved import; the assignment line for a
 * property TypeScript does not yet know about on an existing type), verified
 * empirically against this repo's tsconfig — never a second pin on a
 * downstream use once the name is bound.
 *
 * §0 of the spec ("What P2a is not") is binding for the first test below: a
 * *valid* input flag set is not delivered anywhere in P2a and leaves the
 * run's OBSERVABLE result byte-identical to the same run without those
 * flags (B-26). That means the claim "akm task run <id> --scope all --strict
 * passes literal inputs into the invocation" cannot be read off
 * `TaskRunResult`, stdout, or the run log — every one of those is required
 * to stay unchanged by a valid flag set. The task brief anticipates exactly
 * this and offers two ways to assert it: "the run result/log or an injected
 * seam". This file uses the seam: `RunTaskOptions.captureInputBindings`,
 * called with the literal `TaskInputBinding[]` Stage 2 (load-task.ts)
 * materializes, once — before dispatch, never read back by production code.
 * It is modeled on the already-existing test-only overrides on that same
 * interface (`beforeNativeDispatch`, `spawnFn`, `runAgentImpl`, …,
 * src/tasks/run/task-result.ts) and is this test's OWN addition, not a name
 * the spec itself pins — if Implement satisfies the "passes literal inputs
 * into the invocation" requirement through a differently-shaped seam, update
 * this test's call site and pins to match rather than re-deriving intent.
 *
 * IMPORTANT FINDING, recorded for Implement (out of scope for this
 * test-only lane to fix): `src/cli/unknown-flags.ts`'s `assertKnownFlags`
 * rejects, BEFORE a command's own body ever runs, any flag the resolved
 * command's declared `args` does not name. Today it carves out exactly one
 * dynamic per-command flag namespace — `known.path.join(" ") ===
 * "workflow run"` (`dynamicWorkflowParams`, unknown-flags.ts:225,270) — and
 * `task run` is not in it. The spec's Lane C file list never names
 * unknown-flags.ts, but `task run`'s exact-name input flags need the
 * identical carve-out: without it, EVERY input flag on `akm task run`,
 * declared or not, valid or not, is rejected by this generic gate before
 * `materializeInputFlags` ever sees it — and (a separate, pre-existing gap,
 * see `tests/integration/cli-errors.test.ts`'s "retired flags..." test
 * comment) that specific rejection path does not even render the
 * `{ok:false,error,code}` JSON envelope through this repo's in-process CLI
 * test harness (`tests/_helpers/cli.ts`'s `runCliCapture`), only through a
 * real subprocess. The three envelope-asserting tests below drive `akm task
 * run` through `runCliCapture` and will only go green once `task run` joins
 * `assertKnownFlags`'s passthrough set (so the eventual UNKNOWN_FLAG /
 * INPUT_BINDING_INVALID is raised from INSIDE the command body, where
 * `runWithJsonErrors` already renders the proper envelope) — verified
 * empirically: today, `akm task run <id> --scope all` on a plain v3 task
 * exits 2 with the bare text `Unknown flag "--scope".` on stderr, not a JSON
 * envelope, confirming both gaps are still open at the time this file was
 * written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type {
  TaskInputBinding,
  // @ts-expect-error P2a red-phase: src/execution/input-contract.ts lands in Implement (whole module is new; tsc reports the diagnostic on the module-specifier line directly below)
} from "../../../src/execution/input-contract";
import { loadPreparedTask } from "../../../src/tasks/run/load-task";
import type { RunTaskOptions } from "../../../src/tasks/run/task-result";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

/**
 * A task source v4 document with two OPTIONAL, defaulted inputs — no flag is
 * ever required to run it. `run:`/`shell:` (rather than `uses:
 * commands/...`) so preparation needs no engine/agent config (mirrors
 * tests/integration/tasks-runtime-v3-runner.test.ts's `run: exit 7\nshell:
 * sh` fixtures).
 */
const REVIEW_TASK_YAML = [
  "version: 4",
  "name: Review",
  "inputs:",
  "  scope:",
  "    type: string",
  "    enum: [changed, all]",
  "    default: changed",
  "  strict:",
  "    type: boolean",
  "    default: true",
  'run: "true"',
  "shell: sh",
  "",
].join("\n");

/** The same two optional inputs, plus one REQUIRED `ticket` input (B-28/B-29). */
const TICKETED_TASK_YAML = [
  "version: 4",
  "name: Ticketed review",
  "inputs:",
  "  scope:",
  "    type: string",
  "    enum: [changed, all]",
  "    default: changed",
  "  strict:",
  "    type: boolean",
  "    default: true",
  "  ticket:",
  "    type: string",
  "    required: true",
  'run: "true"',
  "shell: sh",
  "",
].join("\n");

describe("akm task run — exact-name input flags materialize literal bindings (P2a spec §5.1)", () => {
  test('"--scope all --strict" materializes both as literal TaskInputBinding entries before dispatch (B-06, B-30, B-31)', async () => {
    writeTask("review", REVIEW_TASK_YAML);
    let captured: readonly TaskInputBinding[] | undefined;

    // Stage 1 (the CLI's parseTaskInputFlags, tasks-cli.ts) would produce
    // exactly this InputFlag[] for `akm task run review --scope all
    // --strict`: a following non-flag token is consumed as the value
    // ("all"); a trailing boolean flag with no following value materializes
    // `true` (mirrors parseWorkflowParameterFlags,
    // src/commands/workflow-cli.ts:277-287). Constructed by hand here so
    // this test exercises Stage 2 (materialize + attach) in isolation from
    // Stage 1's own argv-scanning, which the envelope tests below exercise
    // for real through the actual CLI.
    const options: RunTaskOptions = { bundleDir: storage.stashDir, bundleName: "fixture" };
    // @ts-expect-error P2a red-phase: RunTaskOptions.inputFlags lands in Implement (src/tasks/run/task-result.ts, spec §5.1)
    options.inputFlags = [
      { name: "scope", value: "all" },
      { name: "strict", value: true },
    ];
    // @ts-expect-error P2a red-phase: RunTaskOptions.captureInputBindings (this test's own seam, see file header) lands in Implement (src/tasks/run/task-result.ts)
    options.captureInputBindings = (bindings: readonly TaskInputBinding[]) => {
      captured = bindings;
    };

    await loadPreparedTask("review", options);

    if (!captured)
      throw new Error(
        "captureInputBindings was never called — Stage 2 did not run, or the seam is wired to a different name",
      );
    const byName = [...captured].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName).toEqual([
      { kind: "literal", name: "scope", value: "all" },
      { kind: "literal", name: "strict", value: true },
    ]);
  });

  test("an input flag the task does not declare fails UNKNOWN_FLAG with exit 2 (B-27)", async () => {
    writeTask("review", REVIEW_TASK_YAML);
    const result = await runCliCapture(["task", "run", "review", "--not-a-declared-input", "x"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNKNOWN_FLAG");
    expect(typeof envelope.error).toBe("string");
    expect(envelope.error.length).toBeGreaterThan(0);
  });

  test("a value that violates its input's declared schema fails INPUT_BINDING_INVALID with exit 2 (B-28)", async () => {
    writeTask("ticketed", TICKETED_TASK_YAML);
    // `scope` is declared `enum: [changed, all]`; "bogus" satisfies neither.
    // `--ticket` is supplied so this fails on the VALUE, not the separate
    // missing-required path the next test covers.
    const result = await runCliCapture(["task", "run", "ticketed", "--ticket", "T-1", "--scope", "bogus"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INPUT_BINDING_INVALID");
    expect(typeof envelope.error).toBe("string");
    expect(envelope.error.length).toBeGreaterThan(0);
  });

  test("omitting a required: true input with no flag at all fails INPUT_BINDING_INVALID, naming the missing input (B-29)", async () => {
    writeTask("ticketed", TICKETED_TASK_YAML);
    const result = await runCliCapture(["task", "run", "ticketed"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INPUT_BINDING_INVALID");
    // B-29 (spec §2): "detail names the missing input" — the missing input's
    // own name must appear somewhere in the rendered envelope.
    expect(JSON.stringify(envelope)).toContain("ticket");
  });
});
