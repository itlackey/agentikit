// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `orphan-assets` advisory for `akm health` (#750).
 *
 * Deterministic, always-on orphan detection over the internal link graph:
 * an asset that no other indexed asset references (via body `bundle//conceptId`
 * refs, resolved wiki-page `links`, or frontmatter `xrefs`) is a curation
 * smell — nobody can navigate to it by reference; it survives only through
 * search. That is advisory, not an error, so this feeds `akm health`
 * (warn, exit code 4) rather than `akm lint` (which already flags DANGLING
 * refs as `missing-ref` findings — a different, fail-level concern).
 *
 * Scope is deliberately narrow: `memory`/`lesson`/`session`/`fact` assets are
 * retrieved by search, not by reference, and entry-point types
 * (`skill`/`command`/`agent`/`workflow`/`task`) are invoked by name from
 * outside the corpus — flagging either as "orphaned" would be noise, not
 * signal. Only `knowledge` assets and wiki `page` entries are checked.
 *
 * The reverse-reference index (which assets are targeted) is a byproduct of
 * one forward pass over every entry's outbound refs — not a second walk.
 */

import { BUNDLE_REF_RE } from "../../core/asset/asset-ref";
import type { HealthCheckResult } from "./types";

/** The minimal shape this check needs from an indexed `entries` row. */
export interface OrphanCheckEntry {
  id: number;
  filePath: string;
  itemRef: string;
  type: string;
  wikiRole?: string;
  content?: string;
  xrefs?: string[];
  links?: string[];
}

/** Injectable ref → entry-id resolver, so the pure collector needs no live db in tests. */
export type ResolveRefFn = (ref: string) => number | undefined;

/** Types eligible for orphan detection, beyond `wikiRole === "page"` (see module doc). */
const ORPHAN_SCOPE_TYPES = new Set(["knowledge"]);

function isOrphanCandidate(entry: OrphanCheckEntry): boolean {
  return ORPHAN_SCOPE_TYPES.has(entry.type) || entry.wikiRole === "page";
}

/** Every distinct outbound ref token an entry declares: xrefs, resolved wiki `links`, and body `bundle//conceptId` refs. */
function outboundRefTokens(entry: OrphanCheckEntry): string[] {
  const tokens = new Set<string>();
  for (const ref of entry.xrefs ?? []) tokens.add(ref);
  for (const ref of entry.links ?? []) tokens.add(ref);
  const re = new RegExp(BUNDLE_REF_RE.source, BUNDLE_REF_RE.flags);
  let match: RegExpExecArray | null;
  const body = entry.content ?? "";
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = re.exec(body)) !== null) tokens.add(match[1]!);
  return [...tokens];
}

/**
 * Build the reverse-reference index (byproduct of the forward scan below) and
 * return every in-scope entry with zero inbound references, sorted by path.
 */
export function collectOrphanAssets(
  entries: readonly OrphanCheckEntry[],
  resolveRef: ResolveRefFn,
): OrphanCheckEntry[] {
  const inboundIds = new Set<number>();
  for (const entry of entries) {
    for (const token of outboundRefTokens(entry)) {
      let targetId: number | undefined;
      try {
        targetId = resolveRef(token);
      } catch {
        continue;
      }
      if (targetId === undefined || targetId === entry.id) continue;
      inboundIds.add(targetId);
    }
  }
  return entries
    .filter((entry) => isOrphanCandidate(entry) && !inboundIds.has(entry.id))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

const MAX_DETAIL_LINES = 10;

/**
 * Build the `orphan-assets` advisory, or `undefined` when every in-scope
 * entry has at least one inbound reference. Always `status: "warn"` — an
 * unlinked-but-valid knowledge doc is a curation smell, not an error.
 */
export function buildOrphanAdvisory(
  entries: readonly OrphanCheckEntry[],
  resolveRef: ResolveRefFn,
  displayPath: (absPath: string) => string = (p) => p,
): HealthCheckResult | undefined {
  const orphans = collectOrphanAssets(entries, resolveRef);
  if (orphans.length === 0) return undefined;

  const lines = orphans.slice(0, MAX_DETAIL_LINES).map((o) => `${o.itemRef} (${displayPath(o.filePath)})`);
  if (orphans.length > MAX_DETAIL_LINES) lines.push(`+${orphans.length - MAX_DETAIL_LINES} more`);

  return {
    name: "orphan-assets",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `${orphans.length} knowledge/wiki-page asset(s) have zero inbound references: ${lines.join("; ")}`,
    evidence: {
      orphans: orphans.map((o) => ({ ref: o.itemRef, path: displayPath(o.filePath) })),
    },
  };
}
