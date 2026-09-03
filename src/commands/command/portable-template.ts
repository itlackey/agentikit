// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { warn } from "../../core/warn";

export const PORTABLE_ARGUMENTS_PLACEHOLDER = "$ARGUMENTS" as const;

export interface AppliedPortableCommandArguments {
  readonly template: string;
  readonly argumentInput?: string;
  readonly content: string;
}

// akm expands exactly one token, the literal `$ARGUMENTS` placeholder, by a
// single split/join pass; it never rescans or interprets anything else in the
// template. Every other construct that used to be rejected here (`$NAME`,
// `$N`, `${...}`, `$(...)`, `@file`, `{{...}}`, native shell/file
// interpolation) is ordinary prose to akm and was producing false positives
// ("Budget is $5 per run", "$HOME/.config/akm", "mention @alice"). Only
// `$ARGUMENTS[N]` — the one spelling that looks like the supported
// placeholder but isn't — is worth flagging, and only as a warning: akm still
// runs the template with the literal text left in place.
const INDEXED_ARGUMENTS_PATTERN = /\$ARGUMENTS\s*\[/u;

/**
 * Warn when a template uses `$ARGUMENTS[N]`-style indexed placeholders, which
 * akm does not support or expand (it only ever replaces the bare literal
 * `$ARGUMENTS`). The construct is left in the template untouched; this never
 * blocks execution.
 *
 * The source identifier is safe to surface; template and argument bytes never
 * enter the warning because they may contain user or secret material.
 */
export function validatePortableCommandTemplate(template: string, source: string): void {
  if (typeof template !== "string") throw new TypeError("command template must be a string");
  if (typeof source !== "string" || source.length === 0) throw new TypeError("command source must be a string");

  if (INDEXED_ARGUMENTS_PATTERN.test(template)) {
    warn(
      `Command ${JSON.stringify(source)} uses "$ARGUMENTS[N]", which akm does not support. Only the literal $ARGUMENTS placeholder is expanded; the indexed form is left as-is.`,
    );
  }
}

/**
 * Apply literal `$ARGUMENTS` replacement once. `split`/`join` is intentional:
 * unlike `String.replace`, caller bytes such as `$&` have no replacement-string
 * semantics, and inserted `$ARGUMENTS` text is never rescanned.
 */
export function applyPortableCommandArguments(
  template: string,
  argumentInput: string | undefined,
  source: string,
): AppliedPortableCommandArguments {
  validatePortableCommandTemplate(template, source);
  if (argumentInput !== undefined && typeof argumentInput !== "string") {
    throw new TypeError("command argument input must be a string or omitted");
  }
  const content = template.split(PORTABLE_ARGUMENTS_PLACEHOLDER).join(argumentInput ?? "");
  return Object.freeze({
    template,
    ...(argumentInput === undefined ? {} : { argumentInput }),
    content,
  });
}
