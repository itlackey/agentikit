// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parse as parseYaml } from "yaml";
import { UsageError } from "../errors";
import { serializeFrontmatter } from "./asset-serialize";
import { parseFrontmatterBlock } from "./frontmatter";

/** `YYYY-MM-DD`, matching the `updated` spelling `akm lint` reads and writes. */
function formatUpdatedDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Ensure an AKM-authored Markdown concept is also a conformant OKF concept.
 *
 * Stamps BOTH `type` and `updated`, because both are required of a conformant
 * document and this is the one chokepoint every `.md` write passes through
 * (`core/write-source.ts`). Without the `updated` stamp, every asset akm
 * created for you — `akm remember`, `akm import`, accepted proposals,
 * authored workflows — was immediately flagged `missing-updated` by akm's own
 * `akm lint`, so the tool disagreed with itself about its own output.
 *
 * An existing `updated` is left alone: this fills a gap, it does not
 * re-stamp on every write (which would churn timestamps and manufacture
 * needless diffs in git-backed bundles).
 */
export function ensureAkmMarkdownType(content: string, type: string, now: Date = new Date()): string {
  const block = parseFrontmatterBlock(content);
  if (!block) return `---\ntype: ${type}\nupdated: ${formatUpdatedDate(now)}\n---\n${content}`;

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
  const needsUpdated = !("updated" in data);
  if (data.type === type && !needsUpdated) return content;
  const { type: _priorType, ...rest } = data;
  const next: Record<string, unknown> = { type, ...rest };
  if (needsUpdated) next.updated = formatUpdatedDate(now);
  return `---\n${serializeFrontmatter(next)}\n---\n${block.content}`;
}
