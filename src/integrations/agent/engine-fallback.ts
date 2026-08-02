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
 *
 * Applied at every surface that resolves `defaults.engine` and would otherwise
 * fail closed, so an engine-less install is usable everywhere or nowhere —
 * never a confusing mix:
 *
 *   • `workflow run`   — `workflows/ir/freeze.ts` (the freeze boundary)
 *   • `task run`       — `tasks/runner.ts` (prompt targets)
 *   • `task add|sync`  — `tasks/validator.ts` (must agree with the runner, or
 *                        validation rejects what the runner would execute)
 *   • `akm agent`      — `commands/agent/agent-dispatch.ts`
 *   • `propose`        — `commands/proposal/propose.ts`
 *   • `improve` reflect — `commands/improve/reflect.ts` (agent arm)
 *
 * Two DIAGNOSTIC surfaces resolve the same effective view so they never report
 * "no engine" on an install where dispatch actually succeeds:
 * `task doctor` (`commands/tasks/tasks.ts`) and `akm health`'s default-engine
 * probe (`commands/health/checks.ts`).
 *
 * Deliberately NOT applied in `setup/*`: setup's job is to DETECT engines and
 * write `defaults.engine`, so a fallback there would mask what it is meant to
 * discover and persist a synthesized entry the operator never chose.
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

/**
 * Failure suffix for every surface that needs an engine and found none.
 * Owned HERE, beside the probe whose outcome it describes: the probe follows a
 * configured `bin` when one is pinned, so a consumer restating "not on PATH"
 * would misdescribe a missing absolute path.
 */
export const NO_ENGINE_MESSAGE_SUFFIX = `has no selected engine, and no usable \`${OPENCODE_SDK_SERVER_BIN}\` binary was found to fall back to.`;

/** Guidance used when the fallback itself is unavailable. */
export const NO_ENGINE_REMEDY =
  "Run `akm setup` to detect an installed agent, or set one explicitly: " +
  '`akm config set engines.claude \'{"kind":"agent","platform":"claude"}\'` ' +
  "then `akm config set defaults.engine claude`. " +
  `Installing \`${OPENCODE_SDK_SERVER_BIN}\` also works — akm falls back to it automatically.`;

export interface EngineFallbackResult {
  /** Config to resolve against — the input verbatim unless the fallback applied. */
  config: AkmConfig;
  /**
   * Name of the engine the fallback installed as `defaults.engine`, when it
   * applied. This is a CANDIDATE, not a decision: `defaults.engine` is the
   * LOWEST-precedence selector, so a prompt task's `engine:` or a workflow's
   * document/unit `engine:` still wins. Callers announce only after observing
   * that the engine they actually selected is this one — see
   * {@link fallbackAnnouncement}.
   */
  fallbackEngineName?: string;
}

/**
 * Return a config whose `defaults.engine` resolves, applying the implicit
 * `opencode-sdk` fallback when it does not and an opencode binary is present.
 *
 * Pure with respect to the input: never mutates `config`. Returns the input
 * object identity unchanged when no fallback is needed, so callers can cheaply
 * detect the common case.
 */
export function withEngineFallback(config: AkmConfig, whichFn: WhichFn = defaultWhich): EngineFallbackResult {
  if (config.defaults?.engine) return { config };

  // An operator-configured engine of this name wins over a synthesized one —
  // theirs may carry a model, an llmEngine fallback, or a pinned bin. Probe
  // THAT bin rather than the bare command: a configured absolute path outside
  // PATH is still a usable engine, and reporting it as missing would contradict
  // the operator-configured-wins rule.
  const existing = config.engines?.[FALLBACK_ENGINE_NAME] as { bin?: string } | undefined;
  if (!whichFn(existing?.bin ?? OPENCODE_SDK_SERVER_BIN)) return { config };

  const engines = existing
    ? config.engines
    : { ...(config.engines ?? {}), [FALLBACK_ENGINE_NAME]: { kind: "agent", platform: "opencode-sdk" } };

  return {
    config: {
      ...config,
      engines,
      defaults: { ...(config.defaults ?? {}), engine: FALLBACK_ENGINE_NAME },
    } as AkmConfig,
    fallbackEngineName: FALLBACK_ENGINE_NAME,
  };
}

/**
 * The announcement, but only when the fallback candidate is the engine that
 * actually won selection. Returns `undefined` otherwise, so an explicitly
 * selected engine never triggers a claim that opencode supplied the model.
 */
export function fallbackAnnouncement(
  fallbackEngineName: string | undefined,
  selectedEngineName: string | undefined,
): string | undefined {
  if (!fallbackEngineName || selectedEngineName !== fallbackEngineName) return undefined;
  return FALLBACK_ANNOUNCEMENT;
}
