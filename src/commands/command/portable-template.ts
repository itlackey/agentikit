// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../../core/errors";

export const PORTABLE_ARGUMENTS_PLACEHOLDER = "$ARGUMENTS" as const;

export interface AppliedPortableCommandArguments {
  readonly template: string;
  readonly argumentInput?: string;
  readonly content: string;
}

interface UnsupportedTemplateConstruct {
  readonly label: string;
  readonly pattern: RegExp;
}

const UNSUPPORTED_TEMPLATE_CONSTRUCTS: readonly UnsupportedTemplateConstruct[] = Object.freeze([
  { label: "$" + "{...}", pattern: /\$\{/u },
  { label: "$(...)", pattern: /\$\(/u },
  { label: "$N", pattern: /\$\d/u },
  { label: "$NAME", pattern: /\$[A-Za-z_][A-Za-z0-9_]*/u },
  { label: "{{...}}", pattern: /\{\{|\}\}/u },
]);

function unsupportedTemplate(source: string, label: string): UsageError {
  return new UsageError(
    `Command ${JSON.stringify(source)} uses unsupported portable template construct ${label}.`,
    "INVALID_FLAG_VALUE",
    `AKM command execution supports only the literal ${PORTABLE_ARGUMENTS_PLACEHOLDER} placeholder. Invoke native-only templates through their owning tool instead.`,
  );
}

/**
 * Validate the deliberately small portable command-template language.
 *
 * The source identifier is safe to surface; template and argument bytes never
 * enter the error because they may contain user or secret material.
 */
export function validatePortableCommandTemplate(template: string, source: string): void {
  if (typeof template !== "string") throw new TypeError("command template must be a string");
  if (typeof source !== "string" || source.length === 0) throw new TypeError("command source must be a string");

  // Mask only the exact portable token. Everything else remains visible to the
  // unsupported-construct detectors, including `$ARGUMENTS_SUFFIX`.
  const portableMasked = template.replace(/\$ARGUMENTS(?![A-Za-z0-9_])/gu, "");
  for (const construct of UNSUPPORTED_TEMPLATE_CONSTRUCTS) {
    if (construct.pattern.test(portableMasked)) throw unsupportedTemplate(source, construct.label);
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
