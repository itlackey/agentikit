// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PR #714 review follow-ups on workflow ref/extension handling.
 *
 * COMMENT A — `akm workflow create foo.yaml` must write AND validate a YAML
 * *program* (not the markdown template) so the created asset round-trips
 * through show/start/validate, which pick the program parser by the `.yaml`
 * extension. Regression: before the fix the create path wrote the markdown
 * template to `foo.yaml`, so `loadWorkflowAsset` (program parser) rejected it.
 *
 * COMMENT B — `workflows/foo.yaml` and the canonical `workflows/foo` address the
 * same file and MUST share ONE run identity: the active-run guard blocks the
 * alias spelling, and `list --ref` finds runs regardless of how the ref was
 * spelled. Regression: before the fix the stored `workflow_ref` kept the
 * extension, so the two aliases started parallel runs and later queries missed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { createWorkflowAsset, validateWorkflowProgramSource } from "../../../src/workflows/authoring/authoring";
import { buildWorkflowBrief } from "../../../src/workflows/exec/brief";
import { reportWorkflowUnit } from "../../../src/workflows/exec/report";
import {
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  startWorkflowRun,
} from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  writeSandboxConfig({
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
});

afterEach(() => storage.cleanup());

// ── COMMENT A: create foo.yaml → program asset that round-trips ──────────────

describe("workflow create with a .yaml/.yml name writes a YAML program", () => {
  test("create foo.yaml writes+validates a program and start/status round-trips", async () => {
    const created = createWorkflowAsset({ name: "foo.yaml" });

    // Canonical (extension-free) ref; the file keeps its .yaml suffix.
    expect(created.ref).toBe("workflows/foo");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "foo.yaml"));

    // The written body is a YAML program, not the markdown template.
    const written = fs.readFileSync(created.path, "utf8");
    expect(written).toContain("version: 2");
    expect(written).toContain("steps:");
    expect(written).not.toContain("# Workflow:");

    // Validates cleanly through the program parser+compiler (what `validate`
    // uses for a .yaml target).
    const { result } = validateWorkflowProgramSource(created.path);
    expect(result.ok).toBe(true);

    // Loads as a program (this is what threw before the fix — the markdown
    // template failed the program parser selected by the .yaml extension).
    const asset = await loadWorkflowAsset("workflows/foo");
    expect(asset.program).toBeDefined();
    expect(asset.document).toBeUndefined();

    // start → status round-trip on the canonical ref.
    const started = await startWorkflowRun("workflows/foo");
    const status = await getWorkflowStatus(started.run.id);
    expect(status.workflow.ref).toBe("stash//workflows/foo");
    expect(status.run.status).toBe("active");
  });

  test("create bar.yml also produces a program asset", async () => {
    const created = createWorkflowAsset({ name: "bar.yml" });
    expect(created.ref).toBe("workflows/bar");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "bar.yml"));

    const asset = await loadWorkflowAsset("workflows/bar");
    expect(asset.program).toBeDefined();
  });

  test("create foo (no extension) still writes a markdown document", async () => {
    const created = createWorkflowAsset({ name: "plain" });
    expect(created.ref).toBe("workflows/plain");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "plain.md"));
    const asset = await loadWorkflowAsset("workflows/plain");
    expect(asset.document).toBeDefined();
    expect(asset.program).toBeUndefined();
  });
});

// ── COMMENT B: one run identity across the alias spellings ───────────────────

describe("workflow_ref canonicalization collapses foo.yaml and foo", () => {
  test("the active-run guard blocks the aliased spelling", async () => {
    createWorkflowAsset({ name: "guard.yaml" });

    const first = await startWorkflowRun("workflows/guard");
    expect(first.run.status).toBe("active");

    // Starting the SAME workflow addressed with the .yaml alias must be
    // refused by the concurrency guard — not silently start a parallel run.
    await expect(startWorkflowRun("workflows/guard.yaml")).rejects.toThrow(/already has an active run/);
  });

  test("the guard also blocks the canonical spelling when the alias started the run", async () => {
    createWorkflowAsset({ name: "guard2.yaml" });

    await startWorkflowRun("workflows/guard2.yaml");
    await expect(startWorkflowRun("workflows/guard2")).rejects.toThrow(/already has an active run/);
  });

  test("list --ref finds the run regardless of how the ref is spelled", async () => {
    createWorkflowAsset({ name: "listed.yaml" });
    const started = await startWorkflowRun("workflows/listed");

    const byCanonical = await listWorkflowRuns({ workflowRef: "workflows/listed" });
    const byAlias = await listWorkflowRuns({ workflowRef: "workflows/listed.yaml" });

    expect(byCanonical.runs.map((r) => r.id)).toContain(started.run.id);
    expect(byAlias.runs.map((r) => r.id)).toContain(started.run.id);

    // Both spellings resolve to exactly the same (single) run; the stored ref
    // is canonical.
    expect(byAlias.runs).toEqual(byCanonical.runs);
    for (const run of byCanonical.runs) expect(run.workflowRef).toBe("stash//workflows/listed");
  });

  test("short and qualified sequential starts share the resolved bundle identity", async () => {
    createWorkflowAsset({ name: "qualified.yaml" });

    const started = await startWorkflowRun("workflows/qualified");
    expect(started.run.workflowRef).toBe("stash//workflows/qualified");
    await expect(startWorkflowRun("stash//workflows/qualified.yaml")).rejects.toThrow(/already has an active run/);
  });

  test("canonical and historical exact refs form one latest-updated active set", async () => {
    createWorkflowAsset({ name: "history.yaml" });
    const historical = await startWorkflowRun("workflows/history");
    const newer = await startWorkflowRun("stash//workflows/history", {}, { force: true });

    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET workflow_ref = ?, updated_at = ? WHERE id = ?").run(
        "workflows/history",
        "2026-01-01T00:00:00.000Z",
        historical.run.id,
      );
      db.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", newer.run.id);
    } finally {
      db.close();
    }

    const listed = await listWorkflowRuns({ workflowRef: "workflows/history" });
    expect(listed.runs.map((run) => run.id)).toEqual([newer.run.id, historical.run.id]);
    expect((await getNextWorkflowStep("workflows/history")).run.id).toBe(newer.run.id);
    expect((await getNextWorkflowStep("stash//workflows/history")).run.id).toBe(newer.run.id);
  });

  test("brief and report select the latest forced run across canonical and historical refs", async () => {
    createWorkflowAsset({ name: "driver-history.yaml" });
    const historical = await startWorkflowRun("workflows/driver-history");
    const newer = await startWorkflowRun("stash//workflows/driver-history", {}, { force: true });
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET workflow_ref = ?, updated_at = ? WHERE id = ?").run(
        "workflows/driver-history",
        "2026-01-01T00:00:00.000Z",
        historical.run.id,
      );
      db.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", newer.run.id);
    } finally {
      db.close();
    }

    const brief = await buildWorkflowBrief("workflows/driver-history");
    expect(brief.run.id).toBe(newer.run.id);
    const unitId = brief.workList.units[0]?.unitId;
    if (!unitId) throw new Error("fixture requires one reportable unit");
    const reported = await reportWorkflowUnit({
      target: "workflows/driver-history",
      unitId,
      status: "running",
    });
    expect(reported.runId).toBe(newer.run.id);
    expect(await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(historical.run.id))).toEqual([]);
  });

  test("detached exact history remains listable but an unresolved short active row is not rebound", async () => {
    const created = createWorkflowAsset({ name: "detached.yaml" });
    const started = await startWorkflowRun("workflows/detached");
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET workflow_ref = ? WHERE id = ?").run("workflows/detached", started.run.id);
    } finally {
      db.close();
    }
    fs.rmSync(created.path);

    expect((await listWorkflowRuns({ workflowRef: "workflows/detached" })).runs.map((run) => run.id)).toEqual([
      started.run.id,
    ]);
    await expect(getNextWorkflowStep("workflows/detached")).rejects.toThrow(/not found/i);
  });

  test("a detached qualified active ref remains an exact lookup", async () => {
    const created = createWorkflowAsset({ name: "detached-qualified.yaml" });
    const started = await startWorkflowRun("stash//workflows/detached-qualified");
    fs.rmSync(created.path);

    expect((await getNextWorkflowStep("stash//workflows/detached-qualified")).run.id).toBe(started.run.id);
    const brief = await buildWorkflowBrief("stash//workflows/detached-qualified");
    expect(brief.run.id).toBe(started.run.id);
    const unitId = brief.workList.units[0]?.unitId;
    if (!unitId) throw new Error("fixture requires one reportable unit");
    expect(
      (await reportWorkflowUnit({ target: "stash//workflows/detached-qualified", unitId, status: "running" })).runId,
    ).toBe(started.run.id);
  });

  test("a qualified exact active row survives when its bundle is absent from current config", async () => {
    createWorkflowAsset({ name: "config-detached.yaml" });
    const started = await startWorkflowRun("stash//workflows/config-detached");
    const detachedRef = "native//workflows/config-detached";
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET workflow_ref = ? WHERE id = ?").run(detachedRef, started.run.id);
    } finally {
      db.close();
    }

    expect((await getNextWorkflowStep(detachedRef)).run.id).toBe(started.run.id);
    expect((await buildWorkflowBrief(detachedRef)).run.id).toBe(started.run.id);
    expect((await listWorkflowRuns({ workflowRef: detachedRef })).runs.map((run) => run.id)).toEqual([started.run.id]);
  });

  test("brief and report fail closed for a detached historical short ref", async () => {
    const created = createWorkflowAsset({ name: "driver-detached.yaml" });
    const started = await startWorkflowRun("workflows/driver-detached");
    const brief = await buildWorkflowBrief(started.run.id);
    const unitId = brief.workList.units[0]?.unitId;
    if (!unitId) throw new Error("fixture requires one reportable unit");
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET workflow_ref = ? WHERE id = ?").run(
        "workflows/driver-detached",
        started.run.id,
      );
    } finally {
      db.close();
    }
    fs.rmSync(created.path);

    await expect(buildWorkflowBrief("workflows/driver-detached")).rejects.toThrow(/not found/i);
    await expect(
      reportWorkflowUnit({ target: "workflows/driver-detached", unitId, status: "running" }),
    ).rejects.toThrow(/not found/i);
  });

  test("a qualified bundle does not adopt a colliding historical short ref owned by the current default bundle", async () => {
    const betaAsset = createWorkflowAsset({ name: "collision.yaml" });
    const alphaRoot = path.join(path.dirname(storage.stashDir), "alpha-bundle");
    const alphaPath = path.join(alphaRoot, "workflows", "collision.yaml");
    fs.mkdirSync(path.dirname(alphaPath), { recursive: true });
    fs.copyFileSync(betaAsset.path, alphaPath);
    writeSandboxConfig({
      bundles: {
        beta: { path: storage.stashDir, writable: true },
        alpha: { path: alphaRoot, writable: true },
      },
      defaultBundle: "beta",
    });

    const beta = await startWorkflowRun("workflows/collision");
    expect(beta.run.workflowRef).toBe("beta//workflows/collision");
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET workflow_ref = ?, updated_at = ? WHERE id = ?").run(
        "workflows/collision",
        "2026-01-02T00:00:00.000Z",
        beta.run.id,
      );
    } finally {
      db.close();
    }

    const alphaRun = await startWorkflowRun("alpha//workflows/collision");
    expect(alphaRun.run.workflowRef).toBe("alpha//workflows/collision");
    expect((await getNextWorkflowStep("alpha//workflows/collision")).run.id).toBe(alphaRun.run.id);
    expect((await buildWorkflowBrief("alpha//workflows/collision")).run.id).toBe(alphaRun.run.id);
    expect((await listWorkflowRuns({ workflowRef: "alpha//workflows/collision" })).runs.map((run) => run.id)).toEqual([
      alphaRun.run.id,
    ]);
  });
});

// ── COMMENT C (Codex round-3 finding C): reject cross-extension shadows ───────

describe("workflow create rejects a canonical-name collision across extensions", () => {
  test("creating foo.yaml is refused when foo.md already exists (would shadow it)", () => {
    const md = createWorkflowAsset({ name: "dup" });
    expect(md.path).toBe(path.join(storage.stashDir, "workflows", "dup.md"));

    // The `.md` resolves BEFORE `.yaml`, so a `dup.yaml` would be shadowed by
    // `dup.md` under the canonical `workflows/dup` ref — refuse and name the file.
    let err: unknown;
    try {
      createWorkflowAsset({ name: "dup.yaml" });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toContain("already exists as");
    expect(String((err as Error).message)).toContain("dup.md");
    // No shadowing file was written.
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "dup.yaml"))).toBe(false);
  });

  test("creating foo.md is refused when foo.yaml already exists (the other direction)", () => {
    createWorkflowAsset({ name: "dup2.yaml" });

    let err: unknown;
    try {
      createWorkflowAsset({ name: "dup2" }); // no extension ⇒ resolves to dup2.md
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toContain("already exists as");
    expect(String((err as Error).message)).toContain("dup2.yaml");
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "dup2.md"))).toBe(false);
  });

  test("--force does NOT punch through a different-extension shadow", () => {
    createWorkflowAsset({ name: "dup3.md" });
    expect(() => createWorkflowAsset({ name: "dup3.yaml", force: true })).toThrow(/already exists as/);
  });

  test("--force still overwrites the SAME extension (classic behavior preserved)", () => {
    createWorkflowAsset({ name: "same.yaml" });
    // Same target extension: force is allowed to overwrite.
    expect(() => createWorkflowAsset({ name: "same.yaml", force: true })).not.toThrow();
  });
});
