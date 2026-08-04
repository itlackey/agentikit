// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isScalar, parseDocument } from "yaml";

/**
 * Report a colon-bearing description only when YAML parsed it as a plain
 * scalar. Quoted and block scalars may span physical lines and remain valid.
 */
export function checkUnquotedDescriptionColon(frontmatterText: string | null): string | null {
  if (!frontmatterText) return null;

  const document = parseDocument(frontmatterText);
  const description = document.get("description", true);
  if (
    document.errors.length === 0 &&
    isScalar(description) &&
    description.type === "PLAIN" &&
    typeof description.value === "string" &&
    description.value.includes(":")
  ) {
    return `description value contains unquoted colon: ${description.value}`;
  }

  // Preserve the existing finding for malformed plain scalars that YAML cannot
  // construct, while letting valid multiline quoted/block scalars pass above.
  if (document.errors.length > 0) {
    const line = frontmatterText.split(/\r?\n/).find((candidate) => candidate.startsWith("description:"));
    const value = line?.slice("description:".length).trim();
    if (value?.includes(":")) return `description value contains unquoted colon: ${value}`;
  }

  return null;
}
