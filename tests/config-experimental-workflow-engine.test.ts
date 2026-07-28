// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Q-05 — the `experimental.workflowEngine` opt-in key.
 *
 * Before Q-05 this key was documented (`STABILITY.md`) but did not exist: it
 * was absent from the schema, read nowhere in the runtime, and `akm config set
 * experimental.workflowEngine true` failed with `Unknown config key`. Because
 * the top-level config schema is `.passthrough()`, setting it anyway was
 * silently accepted and inert — the workflow-engine dispatch ran unconditionally
 * regardless of the key. These pin the key's existence, its default (absent
 * means off, mirroring `experimental.improveAutonomy`), and that a dotted
 * `config set` now actually resolves against the Zod schema instead of falling
 * through to the passthrough. The gating behaviour itself (refusal + doctor
 * reporting) is pinned by `tests/tasks-doctor-workflow-engine.test.ts` and
 * `tests/integration/commands/workflow-engine-gate.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { AkmConfigSchema } from "../src/core/config/config-schema";
import { configGet, configSet } from "../src/core/config/config-walker";
import { isWorkflowEngineEnabled, WORKFLOW_ENGINE_CONFIG_KEY } from "../src/workflows/exec/workflow-engine-gate";

const BASE = { configVersion: "0.9.0" as const };

describe("experimental.workflowEngine schema", () => {
  test("accepts the key and round-trips true", () => {
    const parsed = AkmConfigSchema.parse({ ...BASE, experimental: { workflowEngine: true } });
    expect(parsed.experimental?.workflowEngine).toBe(true);
  });

  test("accepts the key set to false", () => {
    const parsed = AkmConfigSchema.parse({ ...BASE, experimental: { workflowEngine: false } });
    expect(parsed.experimental?.workflowEngine).toBe(false);
  });

  test("rejects a non-boolean value rather than coercing it", () => {
    expect(() => AkmConfigSchema.parse({ ...BASE, experimental: { workflowEngine: "yes" } })).toThrow();
  });

  test("the whole section is optional", () => {
    expect(() => AkmConfigSchema.parse(BASE)).not.toThrow();
  });

  test("coexists with experimental.improveAutonomy in the same section", () => {
    const parsed = AkmConfigSchema.parse({
      ...BASE,
      experimental: { improveAutonomy: true, workflowEngine: false },
    });
    expect(parsed.experimental?.improveAutonomy).toBe(true);
    expect(parsed.experimental?.workflowEngine).toBe(false);
  });
});

describe("isWorkflowEngineEnabled", () => {
  test("is OFF when the section is absent — the engine is opt-in, never inferred", () => {
    expect(isWorkflowEngineEnabled({})).toBe(false);
  });

  test("is OFF when the section exists but the key does not", () => {
    expect(isWorkflowEngineEnabled({ experimental: {} })).toBe(false);
  });

  test("is OFF when explicitly false", () => {
    expect(isWorkflowEngineEnabled({ experimental: { workflowEngine: false } })).toBe(false);
  });

  test("is ON only when explicitly true", () => {
    expect(isWorkflowEngineEnabled({ experimental: { workflowEngine: true } })).toBe(true);
  });
});

describe("WORKFLOW_ENGINE_CONFIG_KEY", () => {
  test("is the dotted path the schema actually registers", () => {
    expect(WORKFLOW_ENGINE_CONFIG_KEY).toBe("experimental.workflowEngine");
  });
});

describe("`akm config set experimental.workflowEngine` (dotted-path resolution)", () => {
  // Dotted `config set`/`config get` paths are validated against the Zod
  // schema (`resolveSchemaAt`), NOT the top-level `.passthrough()` — an
  // unregistered key fails with `Unknown config key` (config-walker.ts:198)
  // rather than silently writing an inert value. Before Q-05,
  // `experimental.workflowEngine` was exactly that: documented but
  // unregistered, so this would have thrown.
  test("resolves and round-trips true", () => {
    const updated = configSet({}, WORKFLOW_ENGINE_CONFIG_KEY, "true");
    expect(configGet(updated, WORKFLOW_ENGINE_CONFIG_KEY)).toBe(true);
  });

  test("resolves and round-trips false", () => {
    const updated = configSet({}, WORKFLOW_ENGINE_CONFIG_KEY, "false");
    expect(configGet(updated, WORKFLOW_ENGINE_CONFIG_KEY)).toBe(false);
  });

  test("rejects a non-boolean value", () => {
    expect(() => configSet({}, WORKFLOW_ENGINE_CONFIG_KEY, "not-a-boolean")).toThrow();
  });
});
