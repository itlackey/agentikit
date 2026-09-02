// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #852 (following #815): the legacy `extraParams` -> first-class-field lift
 * used to run silently, in memory, on every config load and never write the
 * result back to disk. `findConfigExtraParamsLift` (status, read-only) and
 * `applyConfigExtraParamsLift` (apply, persists once) replace that with the
 * same one-time-migration shape as `./dead-residue.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyConfigExtraParamsLift,
  findConfigExtraParamsLift,
} from "../../scripts/akm-migrate/migrate/config-extra-params";

let root: string;
let configPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-config-extraparams-"));
  configPath = path.join(root, "config.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(value));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

describe("findConfigExtraParamsLift (status, read-only)", () => {
  test("reports nothing when the config file does not exist", () => {
    expect(findConfigExtraParamsLift(configPath)).toEqual({ lifted: [], conflicts: [] });
  });

  test("reports nothing for a config with no legacy extraParams keys", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { fast: { kind: "llm", endpoint: "https://example.test", model: "m" } },
    });
    expect(findConfigExtraParamsLift(configPath)).toEqual({ lifted: [], conflicts: [] });
    // Read-only: the file is untouched.
    expect(readConfig()).toMatchObject({ engines: { fast: { kind: "llm" } } });
  });

  test("reports a pending lift for a legacy extraParams key, without touching the file", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test",
          model: "m",
          extraParams: { reasoning_effort: "high" },
        },
      },
    });
    const plan = findConfigExtraParamsLift(configPath);
    expect(plan.conflicts).toEqual([]);
    expect(plan.lifted).toEqual(["engines.fast.extraParams.reasoning_effort -> engines.fast.reasoningEffort"]);
    expect((readConfig().engines as Record<string, unknown>).fast).toMatchObject({
      extraParams: { reasoning_effort: "high" },
    });
  });

  test("reports a conflict when extraParams and the first-class field disagree", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test",
          model: "m",
          reasoningEffort: "low",
          extraParams: { reasoning_effort: "high" },
        },
      },
    });
    const plan = findConfigExtraParamsLift(configPath);
    expect(plan.lifted).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        engine: "fast",
        key: "reasoning_effort",
        field: "reasoningEffort",
        extraParamsValue: "high",
        fieldValue: "low",
      },
    ]);
  });
});

describe("applyConfigExtraParamsLift (apply, persists once)", () => {
  test("does nothing when the config file does not exist", () => {
    expect(applyConfigExtraParamsLift(configPath)).toEqual({ applied: false, lifted: [], conflicts: [] });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("does nothing when there is nothing to lift", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { fast: { kind: "llm", endpoint: "https://example.test", model: "m" } },
    });
    const before = readConfig();
    expect(applyConfigExtraParamsLift(configPath)).toEqual({ applied: false, lifted: [], conflicts: [] });
    expect(readConfig()).toEqual(before);
  });

  test("persists the lift to disk, backing up the original first", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test",
          model: "m",
          extraParams: { reasoning_effort: "high", nested: { keep: true } },
        },
      },
    });

    const result = applyConfigExtraParamsLift(configPath);
    expect(result.applied).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.lifted).toEqual(["engines.fast.extraParams.reasoning_effort -> engines.fast.reasoningEffort"]);

    const after = readConfig();
    const fast = (after.engines as Record<string, unknown>).fast as Record<string, unknown>;
    expect(fast.reasoningEffort).toBe("high");
    // The unrelated extraParams key survives; only the lifted key is removed.
    expect(fast.extraParams).toEqual({ nested: { keep: true } });
  });

  test("leaves the file untouched and reports the conflict when extraParams and the first-class field disagree", () => {
    const original = {
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test",
          model: "m",
          reasoningEffort: "low",
          extraParams: { reasoning_effort: "high" },
        },
      },
    };
    writeConfig(original);

    const result = applyConfigExtraParamsLift(configPath);
    expect(result.applied).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(readConfig()).toEqual(original);
  });
});
