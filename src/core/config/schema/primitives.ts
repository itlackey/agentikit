// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared atomic Zod schemas and small helpers used across the config-schema
 * modules. Extracted verbatim from the former `config-schema.ts` monolith — no
 * behavior change (see `./index` re-export barrel at `../config-schema.ts`).
 */
import { z } from "zod";
import { validateExtraParams } from "../../extra-params";
import { warnOnce } from "../../warn";
import { ENGINE_NAME_PATTERN_SOURCE } from "../engine-semantics";

/** Persisted config schema version. Package prerelease/patch versions do not change this value. */
export const CURRENT_CONFIG_VERSION = "0.9.0" as const;

// ── Reusable atomic schemas ─────────────────────────────────────────────────

/** Positive integer (used for tokens, timeouts, batch sizes). */
export const positiveInt = z.number().int().positive();

/** Non-negative finite number (used for scores, weights, days). */
export const nonNegativeNumber = z.number().finite().min(0);

/** Non-empty string (rejects "" and whitespace-only). */
export const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, { message: "expected a non-empty string" });

/** HTTP(S) URL string. */
export const httpUrl = z.string().refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
  message: "endpoint must start with http:// or https://",
});

const ENGINE_NAME_PATTERN = new RegExp(ENGINE_NAME_PATTERN_SOURCE);
export const ENV_REFERENCE_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export const engineName = z
  .string()
  .max(63)
  .regex(ENGINE_NAME_PATTERN, "names must be lowercase kebab-case and must not begin with reserved akm-");

/**
 * A `$VAR`/`${VAR}` symbolic credential reference is the documented way to
 * configure an apiKey. A literal secret typed into config.json is the most
 * common thing anyone hand-edits, and used to hard-reject the WHOLE config —
 * every akm command exits 78 over a value the reader must still use. Warn
 * once (per schema site — `label` distinguishes the LLM-engine field from the
 * embedding field, not each individual engine name, since schemas are
 * defined once and reused across every named engine) and use it as given;
 * `akm config set` (`config-walker.ts`) still refuses a literal outright,
 * since a human typing it right now can be told the better way immediately.
 */
export function symbolicOrWarnApiKey(label: string) {
  return z.string().superRefine((value) => {
    if (ENV_REFERENCE_PATTERN.test(value)) return;
    warnOnce(
      `config:literal-api-key:${label}`,
      `A ${label} in config.json is a literal API key, not a $VAR/\${VAR} reference; using it as configured. Prefer \`akm config set ...apiKey '$VAR'\` (with the corresponding env var set) — see docs/reference/data-and-telemetry.md.`,
    );
  });
}

/**
 * A chat-completions endpoint only needs to be a real http(s) URL — Azure
 * OpenAI's mandatory `?api-version=` query string, and endpoints that don't
 * literally end `/chat/completions` (proxies, gateways), are real shapes and
 * must load. Embedded userinfo and a non-`/chat/completions` path are worth
 * flagging (a copy-pasted credential, a likely typo) but not worth bricking
 * config load over — warn once naming the endpoint instead of rejecting it.
 */
export const chatCompletionsEndpoint = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must be a complete URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must use http:// or https://" });
    return;
  }
  if (url.username || url.password) {
    warnOnce(
      `chatCompletionsEndpoint:userinfo:${value}`,
      `Config endpoint "${value}" embeds a username/password; consider moving the credential to the engine's apiKey field instead.`,
    );
  }
  if (!url.pathname.endsWith("/chat/completions")) {
    warnOnce(
      `chatCompletionsEndpoint:path:${value}`,
      `Config endpoint "${value}" does not end in /chat/completions; using it as configured.`,
    );
  }
});

export const ExtraParamsSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  for (const issue of validateExtraParams(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});

// ── Shared connection/invocation building blocks ────────────────────────────

export const LlmInvocationOverridesSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
    reasoningEffort: nonEmptyString.optional(),
  })
  .passthrough();
