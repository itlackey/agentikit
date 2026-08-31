// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Previous-release upgrade-smoothness guard rail.
 *
 * POLICY: a schema bump (task source v2/v3/v4, the proposals `metadata_json`
 * envelope, or anything else a prior release wrote to disk/state.db) must
 * NEVER turn into a headless upgrade break — a user's real, already-scheduled
 * artifact reading successfully today must keep reading successfully after
 * `npm i -g akm@latest` (or the container image bump), even if the release
 * notes say "run the migrator." Deterministic transforms are the tool's job,
 * not the user's; the migrator (`akm migrate apply`) stays available to
 * rewrite the file on disk and silence the resulting deprecation warning,
 * but it must never be REQUIRED just to keep reading.
 *
 * Every fixture below is a REAL-SHAPED artifact from a prior release — not a
 * synthetic minimal case. When a future schema bump lands, add the OLD shape
 * here BEFORE shipping. If this suite fails, an upgrade break was about to
 * ship: either restore read compatibility (preferred — add/extend the
 * auto-shim) or, if the break is genuinely intentional, delete the fixture
 * here in the SAME change that removes support for it, with the reason
 * spelled out in the commit message.
 *
 * Current coverage:
 *   - task source v2 (`fixtures/task-v2.yml`) — read via the in-memory
 *     v2->v3->v4 migration shim in `src/tasks/source/parse-task-source.ts`.
 *   - task source v3 (`fixtures/task-v3.yml`) — read via the in-memory v3->v4
 *     migration shim, same file.
 *   - pre-envelope proposal rows (`metadata_json` missing `changes`,
 *     `proposedTarget`, `beforeHash`, `eligibilitySource`, `backupContent` —
 *     the REAL shape pulled from a live 24,358-row archive during the #859
 *     reopening, not a single deleted key) — read via `listStateProposals`,
 *     which decodes each absent field as omitted rather than failing the row
 *     or the whole list (`src/storage/repositories/proposals-repository.ts`).
 *     #859 was reopened because the 0.9.4 fix, verified only against a
 *     synthetic single-field fixture, still broke on the real archive's next
 *     missing field — this fixture is the guard rail against that recurring.
 *   - pre-`metadataVersion` `task_history` rows (no `metadataVersion` at all,
 *     58% of a real install's rows; and rows carrying the additive
 *     `profile`/`repairReason` fields two prior releases wrote, 88 more real
 *     rows) — read via `readTaskHistory()` (the `akm task history` path) and
 *     `akmHealth()` (the `akm health --report` path), which decode the
 *     legacy/additive shapes instead of throwing
 *     (`src/storage/repositories/task-history-repository.ts`'s
 *     `decodeTaskHistoryMetadata`).
 *   - the `AKM_BUNDLE_DIR`-synthesized duplicate `stash` bundle entry
 *     (#870) — read via `scripts/akm-migrate/task-migrate.ts`'s `taskRoots`,
 *     which reconciles two bundle ids resolving to the same content root
 *     instead of double-enumerating and throwing `duplicate task migration
 *     file path`.
 *   - a real-shaped 0.8 config carrying the retired `stashDir`/`sources[]`/
 *     `installed[]` trio together (#863) — deliberately NOT read-shimmed
 *     (unlike every fixture above); this one instead guards that the break
 *     stays loud and actionable (`src/core/config/config-schema.ts`) rather
 *     than degrading into a silent load or an opaque crash.
 *   - downstream-consumer fixtures for OpenPalm (a real, if unofficial,
 *     integration point, #880): a `config.json` `bundles` shape and four
 *     task source v4 files exercising its grammar (`run:`/`shell:`,
 *     `uses:`/`with:`, `timeout:`, optional `schedule:`) — static files
 *     proving akm doesn't tighten its schema in a way that breaks a real
 *     consumer.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectMigrationPlan } from "../../scripts/akm-migrate/task-migrate";
import { akmHealth } from "../../src/commands/health";
import { createProposal as createProposalImpl, isProposalSkipped } from "../../src/commands/proposal/repository";
import { loadConfig, loadUserConfig, parseAndValidateConfigText, resetConfigCache } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { getConfigPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { resetQuiet, setQuiet } from "../../src/core/warn";
import { listStateProposals } from "../../src/storage/repositories/proposals-repository";
import { upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { readTaskHistory } from "../../src/tasks/run/task-history";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures", "previous-release-corpus");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("previous-release corpus — upgrade must not break reads", () => {
  describe("task source v2/v3 (auto-shimmed to v4)", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // The harness sets quiet=true by default (tests/_preload.ts); opt into
      // real warn() output so the spy actually observes the deprecation line.
      setQuiet(false);
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      resetQuiet();
    });

    test("a real-shaped task v2 file (schedule/command/enabled/timeoutMs/tags) reads without error", () => {
      const filePath = path.join(FIXTURES_DIR, "task-v2.yml");
      const yaml = readFixture("task-v2.yml");
      const result = parseTaskSource({ yaml, filePath });
      expect(result.version).toBe(4);
      expect(result.v4.schedule.length).toBeGreaterThan(0);
      expect(result.v4.target.kind).toBe("run");
      // Deprecation warning on stderr, never on the return value / stdout path.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("schema v2");
    });

    test("a real-shaped task v3 file (akm.schedule/akm/command/with) reads without error", () => {
      const filePath = path.join(FIXTURES_DIR, "task-v3.yml");
      const yaml = readFixture("task-v3.yml");
      const result = parseTaskSource({ yaml, filePath });
      expect(result.version).toBe(4);
      expect(result.v4.schedule.length).toBeGreaterThan(0);
      expect(result.v4.target.kind).toBe("uses");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("schema v3");
    });
  });

  describe("proposals state.db — pre-#858 legacy envelope", () => {
    let storage: IsolatedAkmStorage;

    beforeEach(() => {
      storage = withIsolatedAkmStorage();
    });

    afterEach(() => {
      storage.cleanup();
    });

    // Real `metadata_json` blobs pulled read-only from a 24,358-row live
    // archive during the #859 reopening investigation (content/refs
    // redacted to generic placeholders; shape and key set are verbatim).
    // These are the ACTUAL pre-envelope shape prior releases wrote — not a
    // single deleted key. #859 was reopened specifically because a synthetic
    // fixture missing only `changes` shipped a fix that still broke on the
    // real archive's next missing field (`proposedTarget`, 93% of rows), so
    // this fixture exists to catch exactly that class of gap.
    const REAL_ACCEPTED_NO_ENVELOPE =
      '{"sourceRun":"consolidate-1780479673158","review":{"outcome":"accepted","decidedAt":"2026-06-03T10:07:02.238Z"},"confidence":0.92}';
    const REAL_REJECTED_NO_ENVELOPE =
      '{"sourceRun":"reflect-1778513697852","review":{"outcome":"rejected","reason":"clearing prior improve run proposals before test run","decidedAt":"2026-05-11T20:34:12.500Z"}}';
    const REAL_ACCEPTED_WITH_GATE_NO_TARGET =
      '{"sourceRun":"consolidate-1781322542465","review":{"outcome":"accepted","decidedAt":"2026-06-13T04:04:01.412Z"},"confidence":0.92,"gateDecision":{"outcome":"auto-accepted","reason":"policy-accept","gate":"triage:personal-stash","decidedAt":"2026-06-13T04:04:01.373Z"}}';

    test("real-shaped legacy rows (no changes, proposedTarget, beforeHash, eligibilitySource, or backupContent) are read, not fatal", () => {
      const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-corpus-proposal-"));
      for (const dir of ["lessons"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
      try {
        const healthy = createProposalImpl(
          stash,
          {
            ref: "lessons/corpus-healthy",
            source: "reflect",
            force: true,
            payload: {
              content:
                "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg over grep.\n",
            },
            target: { source: "stash", root: path.resolve(stash) },
          },
          undefined,
        );
        if (isProposalSkipped(healthy)) throw new Error("unexpected skip for the healthy fixture");

        // Insert real-shaped legacy rows directly (createProposal always
        // mints the full current envelope — it cannot produce these shapes;
        // they only exist on rows a PRIOR release wrote).
        const db = openStateDatabase();
        const legacyIds = {
          accepted: "corpus-legacy-accepted-real-shape",
          rejected: "corpus-legacy-rejected-real-shape",
          acceptedGated: "corpus-legacy-accepted-gated-real-shape",
        };
        try {
          const insert = db.prepare(
            `INSERT INTO proposals
             (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          );
          insert.run(
            legacyIds.accepted,
            path.resolve(stash),
            "akm//knowledge/corpus-legacy-accepted",
            "accepted",
            "consolidate",
            "2026-06-03T10:07:02.000Z",
            "2026-06-03T10:07:02.238Z",
            "legacy accepted content",
            REAL_ACCEPTED_NO_ENVELOPE,
          );
          insert.run(
            legacyIds.rejected,
            path.resolve(stash),
            "akm//commands/corpus-legacy-rejected",
            "rejected",
            "reflect",
            "2026-05-11T20:34:12.000Z",
            "2026-05-11T20:34:12.500Z",
            "legacy rejected content",
            REAL_REJECTED_NO_ENVELOPE,
          );
          insert.run(
            legacyIds.acceptedGated,
            path.resolve(stash),
            "akm//knowledge/corpus-legacy-gated",
            "accepted",
            "consolidate",
            "2026-06-13T04:04:01.000Z",
            "2026-06-13T04:04:01.412Z",
            "legacy gated content",
            REAL_ACCEPTED_WITH_GATE_NO_TARGET,
          );
        } finally {
          db.close();
        }

        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        let listed: ReturnType<typeof listStateProposals> = [];
        try {
          const listDb = openStateDatabase();
          try {
            expect(() => {
              listed = listStateProposals(listDb, { stashDir: path.resolve(stash) });
            }).not.toThrow();
          } finally {
            listDb.close();
          }
        } finally {
          warnSpy.mockRestore();
        }

        const byId = new Map(listed.map((p) => [p.id, p]));
        expect(byId.has(healthy.id)).toBe(true);
        // #858/#859 decision: a legacy row (missing the whole pre-envelope
        // shape — changes, proposedTarget, beforeHash, eligibilitySource,
        // backupContent all absent) is a REAL accepted/rejected proposal
        // whose per-file detail was never captured. It must still be
        // listed — because dropping it silently under-counts history (the
        // exact defect #859 documented in improve's outcome-score
        // salience) — with those fields simply omitted, not defaulted to
        // fabricated values.
        for (const id of Object.values(legacyIds)) {
          expect(byId.has(id)).toBe(true);
          const p = byId.get(id);
          expect(p?.changes).toEqual([]);
          expect(p?.proposedTarget).toBeUndefined();
          expect(p?.beforeHash).toBeUndefined();
          expect(p?.eligibilitySource).toBeUndefined();
          expect(p?.backupContent).toBeUndefined();
        }
        // The gated row's gateDecision (present in real data even without
        // proposedTarget) still round-trips.
        expect(byId.get(legacyIds.acceptedGated)?.gateDecision?.outcome).toBe("auto-accepted");
      } finally {
        fs.rmSync(stash, { recursive: true, force: true });
      }
    });
  });

  describe("task_history state.db — legacy metadata_json (no metadataVersion / additive fields)", () => {
    let storage: IsolatedAkmStorage;

    beforeEach(() => {
      storage = withIsolatedAkmStorage();
    });

    afterEach(() => {
      storage.cleanup();
    });

    const baseRow = {
      status: "completed",
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:00:00.000Z",
      failed_at: null,
      log_path: null,
      target_kind: "shell",
      target_ref: null,
    };

    test("a real-shaped row with no metadataVersion (the 8,508-row live shape) reads via `akm task history` and `akm health --report` without throwing", () => {
      const db = openStateDatabase();
      try {
        upsertTaskHistory(db, {
          ...baseRow,
          task_id: "corpus-legacy-no-version",
          metadata_json: JSON.stringify({ durationMs: 48557, detail: { exitCode: 0 } }),
        });
      } finally {
        db.close();
      }

      const rows = readTaskHistory({ id: "corpus-legacy-no-version" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.durationMs).toBe(48557);

      expect(() => akmHealth({ since: "7d" })).not.toThrow();
    });

    test("real-shaped rows carrying the additive `profile`/`repairReason` fields (88 live rows) read without throwing", () => {
      const db = openStateDatabase();
      try {
        upsertTaskHistory(db, {
          ...baseRow,
          task_id: "corpus-legacy-profile",
          metadata_json: JSON.stringify({ durationMs: 1, detail: { exitCode: 0 }, profile: "opencode" }),
        });
        upsertTaskHistory(db, {
          ...baseRow,
          task_id: "corpus-legacy-repair-reason",
          metadata_json: JSON.stringify({
            metadataVersion: 2,
            durationMs: 1,
            detail: { exitCode: 1 },
            repairReason: "manual",
          }),
        });
      } finally {
        db.close();
      }

      expect(readTaskHistory({ id: "corpus-legacy-profile" })).toHaveLength(1);
      expect(readTaskHistory({ id: "corpus-legacy-repair-reason" })).toHaveLength(1);
      expect(() => akmHealth({ since: "7d" })).not.toThrow();
    });
  });

  // #867: the existing "task source v2/v3" describe above only covers the
  // plain `command: /path/to/akm ...` shape. On a real 0.9.4 install, every
  // v2 task whose `command:` started with `env NAME=value... cmd args...`
  // (a common, ordinary way to write a cron command) hit
  // TASK_SCHEMA_VERSION_UNSUPPORTED instead of being auto-shimmed — this is
  // exactly the gap that shipped in 0.9.4. Kept as its own block per #867's
  // instructions (other agents may be editing the describes above).
  describe("task source v2 — env-prefixed command (#867)", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setQuiet(false);
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      resetQuiet();
    });

    test("a real-shaped task v2 file whose command starts with `env NAME=value...` reads without error", () => {
      const filePath = path.join(FIXTURES_DIR, "task-v2-env-prefixed.yml");
      const yaml = readFixture("task-v2-env-prefixed.yml");
      const result = parseTaskSource({ yaml, filePath });
      expect(result.version).toBe(4);
      expect(result.v4.schedule.length).toBeGreaterThan(0);
      expect(result.v4.target.kind).toBe("run");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("schema v2");
    });
  });
});

// ── AKM_BUNDLE_DIR synthesized "stash" bundle duplicate (#870) ─────────────
//
// #870's root cause: `AKM_BUNDLE_DIR` pointing at a directory already
// configured under a different bundle id (e.g. `openpalm`) registered a
// SECOND bundle for it (auto-named `stash`, promoted to `defaultBundle`) —
// the real shape a broken prior release wrote to a user's `config.json`.
// Fixed by matching registration on the resolved content root
// (`bundleContentRoot`/`bundleKeyForContentRoot` in
// `src/core/config/config-sources.ts`) instead of the bare configured
// `path`; `scripts/akm-migrate/task-migrate.ts`'s `taskRoots` reconciles the
// two ids on the read/enumeration side. See
// `tests/migrate/duplicate-bundle-registration.test.ts` for the mechanism's
// full unit coverage — this corpus entry proves the exact real-shaped,
// on-disk `config.json` (both bundle ids literally named `openpalm`/`stash`,
// `defaultBundle: "stash"`) converges through `akm migrate`'s inspection
// instead of throwing `duplicate task migration file path`.
describe("previous-release corpus — AKM_BUNDLE_DIR duplicate 'stash' bundle (#870)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => {
    storage.cleanup();
  });

  test("a home with a pre-#870 duplicate 'stash' bundle entry converges instead of throwing", () => {
    fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "demo.yml"),
      "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n",
      { mode: 0o640 },
    );
    writeSandboxConfig({
      defaultBundle: "stash",
      bundles: {
        openpalm: { path: storage.stashDir, writable: true },
        stash: { path: storage.stashDir, writable: true },
      },
    });

    let plan: ReturnType<typeof inspectMigrationPlan> | undefined;
    expect(() => {
      plan = inspectMigrationPlan();
    }).not.toThrow();
    // Reconciled: the shared task file is enumerated once, not once per
    // duplicate bundle id.
    expect(plan?.taskV3Migration.files).toHaveLength(1);
    expect(plan?.taskV3Migration.files[0]?.filePath).toBe(path.join(storage.stashDir, "tasks", "demo.yml"));
  });
});

// ── Retired 0.8 source-config keys (`stashDir`/`sources[]`/`installed[]`) ──
//
// Unlike every other fixture in this file, the 0.9.0 cutover deliberately
// does NOT read-shim these — `bundles` + `defaultBundle` fully replaced them
// (see the module doc in `src/core/config/config-schema.ts` and the
// dedicated coverage in `tests/integration/config.test.ts`). A real 0.8
// config carried all three together. The compatibility guarantee here is
// narrower than "reads cleanly": it's that this real combined shape still
// fails LOUDLY with actionable per-key guidance (pointing at `bundles`)
// rather than a generic/opaque parse error or, worse, a silent passthrough
// that drops the user's source configuration without telling them.
describe("previous-release corpus — retired 0.8 source-config keys (configVersion shim territory, #863)", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  test("a real-shaped 0.8 config (stashDir + sources[] + installed[] together) fails with actionable guidance, not a silent load or opaque crash", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        stashDir: "/home/user/.akm-stash",
        sources: [{ type: "filesystem", path: "/home/user/.akm-stash", name: "primary" }],
        installed: [
          {
            id: "npm:left-pad",
            source: "npm",
            ref: "npm:left-pad",
            stashRoot: "/home/user/.akm-stash/left-pad",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    let caught: unknown;
    try {
      loadConfig();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain("stashDir is not supported");
    expect(message).toContain("bundles");
  });
});

// ── Downstream consumer: OpenPalm (#880) ────────────────────────────────────
//
// OpenPalm is a real, if unofficial, integration point (see #870/#867's
// issue bodies). These are STATIC fixtures standing in for the shapes its
// `akm-sources.ts` writes and the task source v4 grammar it schedules
// against — copied in to prove akm does not tighten its schema in a way
// that breaks a real downstream consumer. Nothing here wires up live to
// another repo; these are plain files read the same way any other corpus
// fixture is.
describe("previous-release corpus — downstream consumer: OpenPalm (#880)", () => {
  const OPENPALM_DIR = path.join(FIXTURES_DIR, "openpalm-consumer");

  test("OpenPalm's config.json shape (bundles + one-component-per-bundle) parses without throwing", () => {
    const text = fs.readFileSync(path.join(OPENPALM_DIR, "config.json"), "utf8");
    let config: ReturnType<typeof parseAndValidateConfigText> | undefined;
    expect(() => {
      config = parseAndValidateConfigText(text);
    }).not.toThrow();
    expect(config?.defaultBundle).toBe("openpalm");
    expect(config?.bundles?.openpalm?.path).toBe("/srv/openpalm/stash");
  });

  test("OpenPalm's `uses:`/`with:` task source v4 file (builtin command target) parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "reddit-leads-ingest.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("uses");
    expect(result.v4.execution.timeout).toBe(120000);
    expect(result.v4.manualOnly).toBe(false);
  });

  test("OpenPalm's `run:`/`shell:` task source v4 file (scheduled) parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "discord-wiki-articles-ingest.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("run");
    expect(result.v4.execution.timeout).toBe(300000);
  });

  test("OpenPalm's `uses:` task source v4 file with no `timeout:` and no top-level `enabled:` parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "health-report.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("uses");
    expect(result.v4.execution.timeout).toBeUndefined();
  });

  test("OpenPalm's manual (unscheduled) `run:`/`shell:` task source v4 file parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "manual-reindex.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("run");
    expect(result.v4.manualOnly).toBe(true);
    expect(result.v4.schedule).toHaveLength(0);
  });
});

// ── configVersion (#863) ─────────────────────────────────────────────────
//
// SYNTHETIC entry, appended as its own top-level block per the merge note in
// #863: `"0.9.0"` is the only `configVersion` akm has ever shipped, so there
// is no REAL prior-release shape to add here yet (unlike every fixture
// above). `config-0.0.1.json` stands in for one to prove out the
// `configVersion` read-shim mechanism (`src/core/config/config-version-shim.ts`)
// BEFORE a real bump ever needs it — see that file's module doc and
// `tests/fixtures/previous-release-corpus/README.md`. Replace this fixture
// with a real one, and this comment, the day a real `configVersion` bump ships.
describe("previous-release corpus — configVersion (#863, synthetic placeholder)", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  test("a synthetic pre-0.9.0 config.json (root-level defaultEngine) reads via `loadUserConfig()` without throwing", () => {
    const fixture = readFixture("config-0.0.1.json");
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, fixture);

    setQuiet(false);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let config: ReturnType<typeof loadUserConfig> | undefined;
      expect(() => {
        config = loadUserConfig();
      }).not.toThrow();
      expect(config?.configVersion).toBe("0.9.0");
      expect(config?.defaults?.llmEngine).toBe("fast");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      resetQuiet();
    }
  });
});
