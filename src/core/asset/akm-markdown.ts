// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parse as parseYaml } from "yaml";
import { UsageError } from "../errors";
import { serializeFrontmatter } from "./asset-serialize";
import { parseFrontmatterBlock } from "./frontmatter";

/** Ensure an AKM-authored Markdown concept is also a conformant OKF concept. */
export function ensureAkmMarkdownType(content: string, type: string): string {
  const block = parseFrontmatterBlock(content);
  if (!block) return `---\ntype: ${type}\n---\n${content}`;

  let parsed: unknown;
  try {
    parsed = block.frontmatter.trim() ? parseYaml(block.frontmatter) : {};
  } catch {
    throw new UsageError("AKM Markdown has malformed YAML frontmatter.", "INVALID_FLAG_VALUE");
  }
  if (parsed === null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("AKM Markdown frontmatter must be a YAML mapping.", "INVALID_FLAG_VALUE");
  }
  const data = parsed as Record<string, unknown>;
  if (data.type === type) return content;
  const { type: _priorType, ...rest } = data;
  return `---\n${serializeFrontmatter({ type, ...rest })}\n---\n${block.content}`;
}
