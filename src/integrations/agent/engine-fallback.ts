// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Implicit `opencode-sdk` engine fallback.
 *
 * A clean install that never ran `akm setup` — a bare container, a CI image, a
 * session where the operator IS an agent — has no `defaults.engine`, and every
 * dispatch surface used to fail closed on that (`INVALID_CONFIG_FILE`, exit
 * 78). That is the right answer only when nothing can run at all; when the
 * `opencode` binary is on PATH there IS a usable engine and akm should use it.
 *
 * The fallback is deliberately CONFIG-FREE. A synthesized `opencode-sdk` agent
 * engine carries no model, endpoint, or credential, so `buildSdkConfig()`
 * (`harnesses/opencode-sdk/sdk-runner.ts`) produces an EMPTY SDK config and
 * `opencode serve` resolves provider, model, and auth from opencode's own
 * configuration. akm never mirrors, parses, or validates that configuration —
 * if opencode cannot run, opencode says so. This keeps the failure condition
 * exactly where the owner specified it: no `opencode` binary, or opencode
 * itself has nothing usable configured.
 *
 * Resolution is by NAME only. A workflow step or task that explicitly names an
 * unconfigured engine is a real error and is never rescued by this path.
 */

import type { AkmConfig } from "../../core/config/config";
import { defaultWhich, type WhichFn } from "./detect";
import { OPENCODE_SDK_SERVER_BIN } from "./profiles";

/**
 * Engine name used for the synthesized entry. Matches the platform id so it
 * reads correctly in `akm workflow status`, frozen plans, and error messages.
 * A user-configured engine of the same name is preferred over synthesizing.
 */
export const FALLBACK_ENGINE_NAME = "opencode-sdk";

/** Announcement text, surfaced once per run/dispatch. */
export const FALLBACK_ANNOUNCEMENT =
  `No engine is configured; falling back to \`${FALLBACK_ENGINE_NAME}\` — ` +
  "provider, model, and auth come from opencode's own configuration. " +
  "Run `akm setup`, or set `defaults.engine`, to choose explicitly.";

/** Guidance used when the fallback itself is unavailable. */
export const NO_ENGINE_REMEDY =
  "Run `akm setup` to detect an installed agent, or set one explicitly: " +
  '`akm config set engines.claude \'{"kind":"agent","platform":"claude"}\'` ' +
  "then `akm config set defaults.engine claude`. " +
  `Installing \`${OPENCODE_SDK_SERVER_BIN}\` also works — akm falls back to it automatically.`;

export interface EngineFallbackResult {
  /** Config to resolve against — the input verbatim unless the fallback applied. */
  config: AkmConfig;
  /** Set only when the fallback applied; the caller surfaces it once. */
  announcement?: string;
}

/**
 * Return a config whose `defaults.engine` resolves, applying the implicit
 * `opencode-sdk` fallback when it does not and `opencode` is on PATH.
 *
 * Pure with respect to the input: never mutates `config`. Returns the input
 * object identity unchanged when no fallback is needed, so callers can cheaply
 * detect the common case.
 */
export function withEngineFallback(config: AkmConfig, whichFn: WhichFn = defaultWhich): EngineFallbackResult {
  if (config.defaults?.engine) return { config };
  if (!whichFn(OPENCODE_SDK_SERVER_BIN)) return { config };

  // An operator-configured engine of this name wins over a synthesized one —
  // theirs may carry a model, an llmEngine fallback, or a pinned bin.
  const existing = config.engines?.[FALLBACK_ENGINE_NAME];
  const engines = existing
    ? config.engines
    : { ...(config.engines ?? {}), [FALLBACK_ENGINE_NAME]: { kind: "agent", platform: "opencode-sdk" } };

  return {
    config: {
      ...config,
      engines,
      defaults: { ...(config.defaults ?? {}), engine: FALLBACK_ENGINE_NAME },
    } as AkmConfig,
    announcement: FALLBACK_ANNOUNCEMENT,
  };
}
