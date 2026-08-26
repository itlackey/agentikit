// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P1b's `prepare/` split (spec
 * docs/plans/specs/p1b-model-extraction.md §4, Lane B / D4 module map).
 *
 * `prepareTaskV3Execution` (src/tasks/runtime-v3.ts:346-458) moves
 * body-intact to `src/tasks/prepare/prepare.ts`, "keep[ing] the exported
 * name/signature ... via a thin re-export from runtime-v3.ts so the THREE
 * production callers keep compiling" (spec §1.1, D4). Those three callers,
 * each constructing a differently-shaped `PrepareTaskV3ExecutionContext`:
 *
 *   - src/tasks/runner.ts:174-194            (bundleName/bundleRoot/config +
 *     a `resolveAsset({bundle,type,name})` callback, `schedulerContext` only
 *     when `options.scheduled`)
 *   - src/tasks/scheduler-sync.ts:485-502     (+ `readFile` and
 *     `commandSourceLoader`, no `resolveAsset` in the common case)
 *   - src/workflows/ir/source-freeze-v4.ts's taskDispatch (§4.2: caller
 *     line drifted from :223 to :237 since D4 was written; verified here at
 *     head) (+ `commandSourceLoader`, `resolveAsset({ref,type})`, and a
 *     `readFile` whose second parameter defaults to `owned.root`)
 *
 * This file pins that each caller's EXACT context shape — as literally
 * constructed at its call site today — still produces the identical
 * `PreparedTaskV3Execution` once routed through the moved `prepare/prepare`
 * entry point. The context objects are typed against
 * `PrepareTaskV3ExecutionContext` imported from the CURRENT runtime-v3.ts (a
 * real, tsc-checked type — not a hand-rolled guess), and the moved function
 * is typed as `typeof prepareTaskV3Execution` from that same live import —
 * so a caller-shaped context literal that does not structurally satisfy the
 * real parameter type fails `tsc`, not merely a runtime assertion. This is
 * the "type-level usage" proof: if the moved entry's signature drifts from
 * today's, every test below stops compiling before it ever runs.
 *
 * `src/tasks/prepare/prepare.ts` does not exist yet, so it is loaded through
 * a non-literal dynamic-import path — this file stays type-checkable
 * (`bunx tsc --noEmit` clean) while every test below reports its own
 * missing-implementation failure at runtime instead. Mirrors the established
 * convention in tests/workflows/environment-v4-red.test.ts.
 *
 * Every fixture below is a bare `run:` (shell) task-v3 document: it needs no
 * `config.engines`, no stored command/workflow/script asset, and — critically
 * — never invokes `resolveAsset`/`readFile`/`commandSourceLoader` (those
 * branches belong to the command/workflow/script arms). That isolates this
 * file's one concern — did the MOVE preserve each caller's context shape and
 * behavior — from prepareTaskV3Execution's per-kind behavior, which is
 * already characterized elsewhere (tests/tasks-runtime-v3.test.ts, the P0/P1a
 * suites, and this phase's Lane A/C tests). Each stub below throws if
 * invoked, so an accidental call is itself a loud test failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeBundleRef } from "../../src/core/asset/asset-ref";
import type { AkmConfig } from "../../src/core/config/config-types";
import { type PrepareTaskV3ExecutionContext, prepareTaskV3Execution } from "../../src/tasks/runtime-v3";
import { parseTaskV3Yaml } from "../../src/tasks/source-v3";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

/** Non-literal on purpose (see file header) — keeps this file tsc-clean before the module exists. */
const PREPARE_MODULE: string = "../../src/tasks/prepare/prepare";

/**
 * Tied to the CURRENT export via `typeof`, not hand-typed: once
 * `prepare/prepare.ts` exists with the spec-required unchanged signature,
 * this type is exactly right; if the signature drifts, every caller-shaped
 * context literal below stops satisfying `PrepareTaskV3ExecutionContext` and
 * `tsc` — not just a runtime assertion — reports it.
 */
type PrepareModule = { readonly prepareTaskV3Execution: typeof prepareTaskV3Execution };

async function movedPrepare(): Promise<PrepareModule> {
  return (await import(PREPARE_MODULE)) as PrepareModule;
}

/** No `config.engines`/`defaults` needed — the shell/`run:` arm never reads them. */
const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

/** A real, empty directory — `bundleRoot` must physically exist for directory-identity capture. */
function sandboxRoot(): string {
  const made = makeSandboxDir("akm-prepare-split");
  sandboxes.push(made);
  return made.dir;
}

/** The minimal valid task-v3 shell document every shape mirror below shares (mirrors tests/tasks-runtime-v3.test.ts's fixture style). */
function shellDocument(root: string) {
  return parseTaskV3Yaml({
    yaml: 'version: 3\nrun: printf ok\nakm:\n  schedule: "@daily"\n',
    filePath: `${root}/tasks/nightly.yml`,
    workspaceRoot: root,
  });
}

describe("the moved prepare/prepare.ts entry — three-caller shape parity (P1b spec §4.1/§4.2, D4)", () => {
  test("runner.ts:174's context shape — bundleName/bundleRoot/config + resolveAsset({bundle,type,name})", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      // runner.ts:183-193's resolveAsset destructures {bundle, type, name}.
      // Never invoked for a run: task — a call here is itself a failure.
      resolveAsset: async ({ bundle, type, name }) => {
        throw new Error(`unexpected resolveAsset(${bundle}, ${type}, ${name}) while preparing a run: task`);
      },
    };

    const before = await prepareTaskV3Execution(document, context);
    expect(before).toMatchObject({ kind: "shell", command: "printf ok" });

    const { prepareTaskV3Execution: moved } = await movedPrepare();
    const after = await moved(document, context);
    expect(after).toEqual(before);
  });

  test("scheduler-sync.ts:485's context shape — readFile + commandSourceLoader, no resolveAsset", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      // scheduler-sync.ts:492-501's readFile/commandSourceLoader. Neither is
      // invoked for a run: task — a call here is itself a failure.
      readFile: (file, bundleRootArg) => {
        throw new Error(`unexpected readFile(${file}, ${bundleRootArg}) while preparing a run: task`);
      },
      commandSourceLoader: (ref, kind) => {
        throw new Error(`unexpected commandSourceLoader(${ref}, ${kind}) while preparing a run: task`);
      },
    };

    const before = await prepareTaskV3Execution(document, context);
    expect(before).toMatchObject({ kind: "shell", command: "printf ok" });

    const { prepareTaskV3Execution: moved } = await movedPrepare();
    const after = await moved(document, context);
    expect(after).toEqual(before);
  });

  test("source-freeze-v4.ts taskDispatch's context shape — commandSourceLoader + resolveAsset({ref,type}) + a defaulted readFile", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      commandSourceLoader: (ref, kind) => {
        throw new Error(`unexpected commandSourceLoader(${ref}, ${kind}) while preparing a run: task`);
      },
      // taskDispatch (source-freeze-v4.ts:244-248) destructures {ref, type}
      // (ignoring bundle/name) and always returns the {file, bundleRoot}
      // object form, never the bare-string form of the union return type.
      resolveAsset: async ({ ref, type }) => {
        throw new Error(`unexpected resolveAsset(${ref}, ${type}) while preparing a run: task`);
      },
      // taskDispatch's readFile (source-freeze-v4.ts:249) defaults its
      // second parameter to owned.root via a default parameter, not `??`.
      readFile: (file, bundleRootArg = root) => {
        throw new Error(`unexpected readFile(${file}, ${bundleRootArg}) while preparing a run: task`);
      },
    };

    const before = await prepareTaskV3Execution(document, context);
    expect(before).toMatchObject({ kind: "shell", command: "printf ok" });

    const { prepareTaskV3Execution: moved } = await movedPrepare();
    const after = await moved(document, context);
    expect(after).toEqual(before);
  });
});
