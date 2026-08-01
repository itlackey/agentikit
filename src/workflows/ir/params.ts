// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run-parameter validation against the frozen plan's param schemas. A workflow
 * can declare `params.files: { type: array }`; supplying a non-array through
 * the exact-name `--files` flag must be rejected at start rather than silently
 * flowing into a unit prompt. The schemas are frozen into the plan, so
 * validation is a pure function of the frozen plan and supplied params.
 *
 * Uses the same bounded {@link validateJsonSchemaSubset} the engine applies to
 * unit output. Internal callers may validate partial parameter objects; the CLI
 * separately rejects flags that do not exactly name declared parameters.
 *
 * Pure module: no IO, no engine imports.
 */

import { UsageError } from "../../core/errors";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { PROGRAM_PARAM_NAME_PATTERN } from "../program/schema";
import type { WorkflowPlanGraph } from "./schema";

export interface WorkflowParameterFlag {
  name: string;
  value: string | boolean;
}

/**
 * Materialize exact-name CLI parameter flags against the plan being frozen for
 * the run. The CLI deliberately carries raw values to this boundary so type
 * coercion cannot race or drift from the persisted plan's schemas.
 */
export function materializeWorkflowParameterFlags(
  plan: WorkflowPlanGraph,
  flags: readonly WorkflowParameterFlag[],
): Record<string, unknown> {
  if (flags.length === 0) return {};

  const declared = new Set(plan.params ?? Object.keys(plan.paramSchemas ?? {}));
  const grouped = new Map<string, Array<string | boolean>>();
  for (const flag of flags) {
    if (!PROGRAM_PARAM_NAME_PATTERN.test(flag.name) || !declared.has(flag.name)) {
      const available = [...declared]
        .sort()
        .map((name) => `--${name}`)
        .join(", ");
      throw new UsageError(
        `Unknown workflow parameter "--${flag.name}". Parameter flags must exactly match a declared workflow parameter.`,
        "UNKNOWN_FLAG",
        available ? `Declared parameters: ${available}.` : "This workflow declares no parameters.",
      );
    }
    const values = grouped.get(flag.name) ?? [];
    values.push(flag.value);
    grouped.set(flag.name, values);
  }

  const entries: Array<[string, unknown]> = [];
  for (const [name, values] of grouped) {
    const schema = plan.paramSchemas?.[name];
    entries.push([name, materializeFlagValues(name, values, schema)]);
  }
  const params = Object.fromEntries(entries);
  const errors = validateWorkflowParams(plan, params);
  if (errors.length > 0) {
    throw new UsageError(
      `Workflow parameter flags do not satisfy the workflow's declared schemas:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  return params;
}

function materializeFlagValues(
  name: string,
  values: readonly (string | boolean)[],
  schema: Record<string, unknown> | undefined,
): unknown {
  const types = schemaTypes(schema);
  if (types.includes("array")) {
    if (values.length === 1 && typeof values[0] === "string" && values[0].trim().startsWith("[")) {
      const parsed = parseJsonFlag(name, values[0]);
      if (!Array.isArray(parsed)) throw invalidParameter(name, "must be a JSON array");
      return parsed;
    }
    const itemSchema = isRecord(schema?.items) ? schema.items : undefined;
    return values.map((value) => coerceFlagValue(name, value, itemSchema));
  }

  if (values.length > 1) {
    throw invalidParameter(name, "was provided more than once but is not declared as an array");
  }
  return coerceFlagValue(name, values[0] as string | boolean, schema);
}

function coerceFlagValue(name: string, raw: string | boolean, schema: Record<string, unknown> | undefined): unknown {
  const types = schemaTypes(schema);
  if (types.length === 0) return raw;

  if (typeof raw === "boolean") {
    if (types.includes("boolean")) return raw;
    if (types.includes("string")) return String(raw);
    throw invalidParameter(name, `requires a value of type ${types.join(" | ")}`);
  }

  // A union that permits strings keeps the user's exact text. This prevents a
  // value such as "001" from being silently converted to a number.
  if (types.includes("string")) return raw;

  for (const type of types) {
    switch (type) {
      case "boolean":
        if (raw === "true") return true;
        if (raw === "false") return false;
        break;
      case "number": {
        const value = Number(raw);
        if (raw.trim() !== "" && Number.isFinite(value)) return value;
        break;
      }
      case "integer": {
        const value = Number(raw);
        if (raw.trim() !== "" && Number.isSafeInteger(value)) return value;
        break;
      }
      case "null":
        if (raw === "null") return null;
        break;
      case "object": {
        const parsed = parseJsonFlag(name, raw);
        if (isRecord(parsed)) return parsed;
        break;
      }
      case "array": {
        const parsed = parseJsonFlag(name, raw);
        if (Array.isArray(parsed)) return parsed;
        break;
      }
    }
  }
  throw invalidParameter(name, `must be ${types.join(" | ")}; received ${JSON.stringify(raw)}`);
}

function schemaTypes(schema: Record<string, unknown> | undefined): string[] {
  const declared = schema?.type;
  if (typeof declared === "string") return [declared];
  return Array.isArray(declared) ? declared.filter((value): value is string => typeof value === "string") : [];
}

function parseJsonFlag(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidParameter(name, "must contain valid JSON");
  }
}

function invalidParameter(name: string, message: string): UsageError {
  return new UsageError(`Workflow parameter "--${name}" ${message}.`, "INVALID_FLAG_VALUE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a run's supplied params against the plan's frozen param schemas.
 * Returns a flat list of human-readable, path-prefixed error strings (empty =
 * valid). Params the plan does not declare a schema for are not constrained.
 */
export function validateWorkflowParams(plan: WorkflowPlanGraph, params: Record<string, unknown>): string[] {
  const schemas = plan.paramSchemas;
  if (!schemas || Object.keys(schemas).length === 0) return [];
  // Validate the params object as a whole against a synthetic object schema
  // whose `properties` are the declared param schemas. Missing declared params
  // are NOT required (params may be optional / defaulted downstream); only a
  // PRESENT param that violates its declared schema is an error.
  // Re-root the validator's `$` JSON-pointer prefix to `params` for messages
  // that read naturally in a start/CLI error (e.g. `params.files: expected …`).
  return validateJsonSchemaSubset(params, { type: "object", properties: schemas }).map((e) =>
    e.replace(/^\$/, "params"),
  );
}

/**
 * Brief/report integrity assert (reviewer #12): the journaled `params_json`
 * row must STILL satisfy the frozen param schemas. `startWorkflowRun` already
 * validated the params it stored, so a violation here means the row was edited
 * after the run started — loud corruption, exactly like the frozen-plan hash
 * mismatch and the tampered-params replay-divergence path. Refuse to describe
 * or drive the run rather than resolve prompts from schema-violating params.
 */
export function assertRunParamsSatisfyPlan(
  runId: string,
  plan: WorkflowPlanGraph,
  params: Record<string, unknown>,
): void {
  const errors = validateWorkflowParams(plan, params);
  if (errors.length === 0) return;
  throw new UsageError(
    `Workflow run ${runId} failed the frozen param-schema integrity check: the journaled params row no longer ` +
      `satisfies the workflow's declared parameter schemas (edited after the run started). Refusing to execute it. ` +
      `Start a new run.\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}
