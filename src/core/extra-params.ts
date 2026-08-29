// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export const EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS = [
  "model",
  "messages",
  "temperature",
  "maxtokens",
  "responseformat",
  "stream",
  "streamoptions",
  "enablethinking",
  "reasoningeffort",
  "chattemplatekwargs",
] as const;

export const EXTRA_PARAMS_CREDENTIAL_KEYS = [
  "authorization",
  "headers",
  "apikey",
  "token",
  "password",
  "secret",
  "cookie",
  "setcookie",
] as const;

const PROTECTED_TOP_LEVEL_KEYS = new Set<string>(EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS);
const CREDENTIAL_KEYS = new Set<string>(EXTRA_PARAMS_CREDENTIAL_KEYS);

// ── Protected-key remedies (#852) ───────────────────────────────────────────
//
// `EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS` rightly stops a provider extra from
// shadowing an AKM-managed field, but naming the rule without naming the fix
// leaves the reader stuck (#852). Every protected key gets a one-line remedy
// baked into its issue message; keys with a genuine scalar first-class field
// are also eligible for the automatic config-load lift below.

/** normalizeExtraParamKey(key) -> the first-class engine field it shadows. */
const LEGACY_EXTRA_PARAMS_FIELD: Readonly<Record<string, string>> = {
  model: "model",
  temperature: "temperature",
  maxtokens: "maxTokens",
  enablethinking: "enableThinking",
  reasoningeffort: "reasoningEffort",
};

/**
 * Subset of {@link LEGACY_EXTRA_PARAMS_FIELD} that {@link liftLegacyEngineExtraParams}
 * will move onto the first-class field automatically. `model` is deliberately
 * excluded: unlike the others it was never a "no first-class field yet"
 * workaround (`model` has always been required on an LLM engine), so a
 * mismatch is far more likely a genuine mistake than a stale 0.9.1 config —
 * it stays a hard rejection rather than being silently reinterpreted.
 */
const LIFTABLE_EXTRA_PARAMS_KEYS = new Set<string>(["temperature", "maxtokens", "enablethinking", "reasoningeffort"]);

/** Remedies for protected keys with no scalar first-class field to lift onto. */
const EXTRA_PARAMS_NO_FIELD_REMEDY: Readonly<Record<string, string>> = {
  messages: "AKM builds the request messages internally — remove it from extraParams",
  responseformat: "AKM controls the response format internally — remove it from extraParams",
  stream: "AKM controls streaming internally — remove it from extraParams",
  streamoptions: "AKM controls streaming internally — remove it from extraParams",
  chattemplatekwargs: "set engines.<name>.enableThinking instead of chat_template_kwargs.enable_thinking",
};

function protectedKeyRemedy(normalized: string): string | undefined {
  const field = LEGACY_EXTRA_PARAMS_FIELD[normalized];
  if (field) {
    const note = normalized === "reasoningeffort" ? " (moved to a first-class field in 0.9.2)" : "";
    return `set engines.<name>.${field} instead${note}`;
  }
  return EXTRA_PARAMS_NO_FIELD_REMEDY[normalized];
}

export interface ExtraParamsIssue {
  path: (string | number)[];
  message: string;
}

export function normalizeExtraParamKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Validate provider extras without allowing them to override AKM fields or carry credentials. */
export function validateExtraParams(value: unknown): ExtraParamsIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: [], message: "must be an object" }];
  }

  const issues: ExtraParamsIssue[] = [];
  // A self-referential YAML anchor (`extraParams: &a { nested: *a }`) resolves
  // to a genuinely cyclic object — the yaml package's alias-count guard does not
  // catch cycles — so an unguarded walk overflowed the stack with a RangeError
  // that escaped task parsing. Track visited containers and stop at a revisit.
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, path: (string | number)[]): void => {
    if (Array.isArray(entry)) {
      if (seen.has(entry)) return;
      seen.add(entry);
      entry.forEach((child, index) => {
        visit(child, [...path, index]);
      });
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (seen.has(entry)) return;
    seen.add(entry);
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const normalized = normalizeExtraParamKey(key);
      if (path.length === 0 && PROTECTED_TOP_LEVEL_KEYS.has(normalized)) {
        const remedy = protectedKeyRemedy(normalized);
        issues.push({
          path: [key],
          message: remedy ? `${key} is protected by AKM — ${remedy}.` : `${key} is protected by AKM`,
        });
      }
      if (CREDENTIAL_KEYS.has(normalized)) {
        issues.push({ path: [...path, key], message: `${key} cannot carry credentials` });
      }
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
  return issues;
}

export function formatExtraParamsIssue(label: string, issue: ExtraParamsIssue): string {
  const suffix = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("");
  return `${label}${suffix} ${issue.message}`;
}

// ── Legacy extraParams -> first-class field lift (#852) ─────────────────────

/** One `engines.<name>.extraParams.<key>` vs `engines.<name>.<field>` mismatch found during the lift. */
export interface ExtraParamsLiftConflict {
  engine: string;
  key: string;
  field: string;
  extraParamsValue: unknown;
  fieldValue: unknown;
}

export interface LiftLegacyExtraParamsResult {
  /** The raw config, with liftable keys moved onto their first-class field. Same object when nothing changed. */
  config: Record<string, unknown>;
  /** One human-readable line per key actually lifted (or dropped as a redundant duplicate). */
  lifted: string[];
  /**
   * Engines where an `extraParams` key and its first-class field were both
   * set to different values. Non-empty means `config` was left untouched for
   * that engine — the caller should reject rather than guess which value wins.
   */
  conflicts: ExtraParamsLiftConflict[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lift legacy `extraParams` keys onto their first-class engine field before
 * schema validation runs, so a 0.9.1-shaped config using (e.g.)
 * `extraParams.reasoning_effort` keeps loading now that `reasoningEffort` is
 * a first-class — and therefore protected — field (#852, following #815).
 *
 * In-memory only: this never rewrites the config file. Callers should warn
 * using the returned `lifted` descriptions so the user knows to update the
 * file by hand, and reject using `conflicts` rather than silently preferring
 * either value.
 */
export function liftLegacyEngineExtraParams(raw: Record<string, unknown>): LiftLegacyExtraParamsResult {
  const lifted: string[] = [];
  const conflicts: ExtraParamsLiftConflict[] = [];
  const rawEngines = raw.engines;
  if (!isPlainObject(rawEngines)) {
    return { config: raw, lifted, conflicts };
  }

  const engines: Record<string, unknown> = {};
  let anyEngineChanged = false;

  for (const [name, engineValue] of Object.entries(rawEngines)) {
    if (!isPlainObject(engineValue) || !isPlainObject(engineValue.extraParams)) {
      engines[name] = engineValue;
      continue;
    }
    const engine: Record<string, unknown> = { ...engineValue };
    const extraParams: Record<string, unknown> = { ...(engineValue.extraParams as Record<string, unknown>) };
    let engineChanged = false;

    for (const [rawKey, value] of Object.entries(engineValue.extraParams as Record<string, unknown>)) {
      const normalized = normalizeExtraParamKey(rawKey);
      if (!LIFTABLE_EXTRA_PARAMS_KEYS.has(normalized)) continue;
      const field = LEGACY_EXTRA_PARAMS_FIELD[normalized];
      if (!field) continue;
      const existing = engine[field];
      if (existing !== undefined && existing !== value) {
        conflicts.push({ engine: name, key: rawKey, field, extraParamsValue: value, fieldValue: existing });
        continue;
      }
      delete extraParams[rawKey];
      engineChanged = true;
      if (existing === value) {
        lifted.push(
          `engines.${name}.extraParams.${rawKey} is redundant — engines.${name}.${field} is already set to the same value; dropped the extraParams entry`,
        );
        continue;
      }
      engine[field] = value;
      lifted.push(`engines.${name}.extraParams.${rawKey} -> engines.${name}.${field}`);
    }

    if (!engineChanged) {
      engines[name] = engineValue;
      continue;
    }
    anyEngineChanged = true;
    if (Object.keys(extraParams).length > 0) {
      engine.extraParams = extraParams;
    } else {
      delete engine.extraParams;
    }
    engines[name] = engine;
  }

  if (!anyEngineChanged) {
    return { config: raw, lifted, conflicts };
  }
  return { config: { ...raw, engines }, lifted, conflicts };
}
