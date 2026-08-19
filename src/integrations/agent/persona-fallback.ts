// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LoweringNotice } from "../../execution/resolved-request";

export const PERSONA_FALLBACK_NOTICE_CODE = "persona-prompt-composed" as const;
export const PERSONA_FALLBACK_BEGIN = "<AKM_PERSONA>" as const;
export const PERSONA_FALLBACK_END = "</AKM_PERSONA>" as const;

export interface PersonaFallbackComposition {
  readonly prompt: string;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

function withTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Preserve a persona when a target has no native system/persona channel. */
export function composePersonaFallbackPrompt(
  persona: string,
  command: string,
  adapter: string,
): PersonaFallbackComposition {
  if (typeof persona !== "string" || typeof command !== "string") {
    throw new TypeError("persona fallback content must be strings");
  }
  if (typeof adapter !== "string" || adapter.length === 0) {
    throw new TypeError("persona fallback adapter must be a non-empty string");
  }
  const notice = Object.freeze({
    code: PERSONA_FALLBACK_NOTICE_CODE,
    severity: "info" as const,
    adapter,
    field: "persona",
    message: "The selected engine has no native persona channel; AKM composed the persona into the prompt.",
  });
  const notices = Object.freeze([notice]);
  return Object.freeze({
    prompt: `${PERSONA_FALLBACK_BEGIN}\n${withTrailingNewline(persona)}${PERSONA_FALLBACK_END}\n\n${command}`,
    notices,
  });
}
