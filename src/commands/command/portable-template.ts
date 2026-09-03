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

const INDEXED_ARGUMENTS_PATTERN = /\$ARGUMENTS\s*\[/u;

/**
 * Validate the deliberately small portable command-template language.
 *
 * The source identifier is safe to surface; template and argument bytes never
 * enter the error because they may contain user or secret material.
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
