// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P1b's typed `prepareScriptTarget()` (spec
 * docs/plans/specs/p1b-model-extraction.md §4.3), which REPLACES
 * `directScript`'s synthetic-task-YAML fabrication
 * (src/workflows/ir/source-freeze-v4.ts:288-311, R-02) with a typed preparer
 * that shares its byte/interpreter capture with `prepareTaskV3Execution`'s
 * script arm (runtime-v3.ts:440-457) instead of duplicating it.
 *
 * Two independent things are pinned here, both RED until the replacement
 * lands:
 *
 *   1. Behavioral parity ("before/after shape"): `prepareScriptTarget()`,
 *      called directly with the script's owned identity (ref/file/
 *      bundleRoot — the exact input shape spec §4.3 assigns it), produces
 *      the same ref/sha256/interpreter/byteLength that today's CURRENT
 *      production path (directScript + prepareTaskV3Execution) freezes for
 *      the identical script. The "before" values are captured by actually
 *      running the P0 R-02 fixture workflow
 *      (tests/workflows/characterization-classification.test.ts:307-338)
 *      through today's real `startWorkflowRun` → frozen-plan path, not a
 *      hand-typed guess — so the pin is provably against CURRENT behavior.
 *   2. Mechanism removal (grep-provable, spec §4.3/§9): the synthetic-YAML
 *      fabrication — the literal `schedule: "@daily"` string, and the
 *      `parseTaskV3Yaml` call fed a `${asset.path}#${step.id}` fragment
 *      filePath — is gone from source-freeze-v4.ts's source text. Mirrors
 *      the acceptance criterion `rg -F 'schedule: "@daily"' src/` returning
 *      zero hits.
 *
 * `prepareScriptTarget` is loaded through a non-literal dynamic-import path
 * so this file stays type-checkable (`bunx tsc --noEmit` clean) before the
 * module exists — see tests/workflows/environment-v4-red.test.ts for the
 * established convention this mirrors. Section 1's fixture keeps this file
 * green on the *setup* side today (the CURRENT production path still works);
 * only the "after" half and the source-text scan are red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import type { FrozenDirectoryIdentity } from "../../src/execution/directory-identity";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const PREPARE_SCRIPT_TARGET_MODULE: string = "../../src/tasks/prepare/prepare-script-target";

/**
 * Hand-declared from spec §4.3's exact signature (no CURRENT symbol of this
 * name/shape exists to derive a `typeof` from — unlike prepare-split.test.ts,
 * which can tie its moved-function type to today's runtime-v3.ts export).
 * Field types otherwise borrow real, CURRENT project types
 * (`TaskV3ScriptInterpreter`, `FrozenDirectoryIdentity`) so this is not a
 * pure guess.
 */
interface PreparedScriptTarget {
  readonly ref: string;
  /**
   * `TaskV3ScriptInterpreter` at the source (scriptInterpreter()'s return
   * type), but widened to `string` here to match `before.interpreter`
   * (`FrozenWorkflowScriptTarget.interpreter: string`,
   * src/workflows/ir/schema-v4.ts:104) — the two are compared directly below.
   */
  readonly interpreter: string;
  readonly extension: string;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
  readonly cwdIdentity: FrozenDirectoryIdentity;
}

type PrepareScriptTargetModule = {
  readonly prepareScriptTarget: (input: {
    readonly ref: string;
    readonly file: string;
    readonly bundleRoot: string;
    readonly readFile: (file: string, bundleRoot?: string) => Uint8Array;
  }) => PreparedScriptTarget;
};

async function prepareScriptTargetModule(): Promise<PrepareScriptTargetModule> {
  return (await import(PREPARE_SCRIPT_TARGET_MODULE)) as PrepareScriptTargetModule;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

describe("prepareScriptTarget — replaces directScript's synthetic-YAML fabrication (P1b spec §4.3)", () => {
  describe("behavioral parity with the CURRENT frozen script target (before/after shape)", () => {
    let storage: IsolatedAkmStorage;
    const scriptBytes = "#!/bin/sh\nprintf direct-script\n";

    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      writeWorkflowTestConfig();
      resetConfigCache();
    });

    afterEach(() => {
      resetConfigCache();
      storage.cleanup();
    });

    test("ref / sha256 / interpreter / byteLength are byte-identical to today's directScript output, for the P0 R-02 script fixture", async () => {
      // "Before": the CURRENT production path — the identical fixture used
      // by characterization-classification.test.ts's R-02 test — proves
      // what today's directScript()+prepareTaskV3Execution actually freeze,
      // rather than asserting against a hand-typed guess.
      write(storage.stashDir, "scripts/exact.sh", scriptBytes);
      write(
        storage.stashDir,
        "workflows/script-step.yml",
        [
          "name: Script step",
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  main:",
          "    runs-on: [self-hosted]",
          "    steps:",
          "      - id: run-script",
          "        uses: scripts/exact.sh",
          "",
        ].join("\n"),
      );
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const started = await startWorkflowRun("workflows/script-step");
      const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
      const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
      const root = plan.steps[0]?.root;
      const before = root && root.kind !== "map" ? root.frozenTarget : undefined;
      expect(before?.kind).toBe("script");
      if (!before || before.kind !== "script") return;
      expect(before.ref).toMatch(/\/\/scripts\/exact\.sh$/);
      expect(Buffer.from(before.bytesBase64, "base64").toString("utf8")).toBe(scriptBytes);
      expect(before.interpreter).toBe("sh");

      // "After": prepareScriptTarget(), called directly with the script's
      // own owned identity (ref/file/bundleRoot) — the exact input shape
      // spec §4.3 assigns it (owned.ref/owned.file/owned.root), with a
      // plain filesystem read standing in for the collector's readBytes
      // (both read the identical bytes off the identical path).
      const { prepareScriptTarget } = await prepareScriptTargetModule();
      const scriptFile = path.join(storage.stashDir, "scripts", "exact.sh");
      const after = prepareScriptTarget({
        ref: before.ref,
        file: scriptFile,
        bundleRoot: storage.stashDir,
        readFile: (file) => fs.readFileSync(file),
      });

      // The four fields the spec names explicitly.
      expect(after.ref).toBe(before.ref);
      expect(after.sha256).toBe(before.contentHash);
      expect(after.interpreter).toBe(before.interpreter);
      expect(after.byteLength).toBe(before.byteLength);
      // The remaining fields spec §4.3 requires byte-identical (the full set
      // scriptResult() actually reads into FrozenWorkflowScriptTarget).
      expect(after.extension).toBe(before.extension);
      expect(after.bytesBase64).toBe(before.bytesBase64);
      expect(Buffer.from(after.bytesBase64, "base64").toString("utf8")).toBe(scriptBytes);
    });
  });

  describe("the synthetic-YAML fabrication is gone from source-freeze-v4.ts (grep-provable, spec §4.3/§9)", () => {
    const sourceFreezeV4Path = path.resolve(import.meta.dir, "../../src/workflows/ir/source-freeze-v4.ts");
    const source = fs.readFileSync(sourceFreezeV4Path, "utf8");

    // CHARACTERIZATION-INVERSE (red today, per P1b spec §4.3's acceptance
    // criterion: "rg -F 'schedule: \"@daily\"' src/ ... return zero hits").
    // Today's directScript() (source-freeze-v4.ts:296-298) fabricates
    //   `version: 3\nuses: ${owned.ref}\nakm:\n  schedule: "@daily"\n`
    // purely to satisfy R-06 (exactly-one-scheduling-source) on a document
    // nothing ever schedules. prepareScriptTarget() never builds a task
    // document at all, so this literal has nothing left to appear in.
    test("the literal fabricated schedule string is absent", () => {
      expect(source).not.toContain('schedule: "@daily"');
    });

    // Today's directScript() (source-freeze-v4.ts:297-299) builds
    //   filePath: `${context.asset.path}#${source.id}`
    // and feeds it, with the fabricated YAML above, through parseTaskV3Yaml.
    // Spec §4.3: prepareScriptTarget has "no parseTaskV3Yaml call, ... no
    // fabricated filePath fragment (${asset.path}#${step.id})".
    test("the fabricated fragment filePath fed to parseTaskV3Yaml is absent", () => {
      // Expressed as a regex rather than a plain string literal so biome's
      // noTemplateCurlyInString rule (a forgotten-backtick guard) does not
      // mistake this deliberate, literal `${...}` needle for a broken
      // template — this file scans SOURCE TEXT, so the needle intentionally
      // matches source-freeze-v4.ts's own unevaluated template-literal bytes.
      expect(source).not.toMatch(/\$\{context\.asset\.path\}#\$\{source\.id\}/);
      expect(source).not.toMatch(/parseTaskV3Yaml\(\{\s*yaml:\s*`version: 3\\nuses:/);
    });

    // Weaker, file-scoped restatement of the second acceptance grep
    // (`rg -F 'version: 3\nuses:' src/` → zero hits) so a passing run is
    // legible without shelling out to ripgrep from inside the test.
    test("the synthetic 'version: 3' task-document template is absent", () => {
      expect(source).not.toContain("version: 3\\nuses:");
    });
  });
});
