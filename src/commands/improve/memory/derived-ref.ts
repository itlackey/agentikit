// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single, keyed-on-ref implementation of "is this a derived memory?" and
 * "which parent does it derive from?" (R12).
 *
 * Two divergent copies previously lived side by side — the CONSUMER
 * (`memory-improve.ts`, keyed on the memory name) and the PRODUCER
 * (`memory-contradiction-detect.ts`, keyed on the file path). The producer's
 * copy was strictly narrower: it ignored `derivedFrom` entirely and matched
 * `source:` through a separate parser. That let the producer and consumer
 * disagree on a memory's parent — the exact defect plan §6 calls out
 * ("producer/consumer cannot disagree").
 *
 * Both sides now share this one impl, keyed on the memory NAME (the stash-
 * relative path without the `.md` extension, e.g. `nested/foo.derived`). The
 * producer converts its file path to a name via `toMemoryRef` before calling
 * in. Adopting it on the producer side is an INTENTIONAL widening, pinned by
 * `tests/commands/improve/derived-ref.test.ts`:
 *   - `derivedFrom`-keyed families now resolve a parent (and so participate in
 *     contradiction detection); and
 *   - `source:` is parsed through `parseRefInput` so current bundle-qualified
 *     refs resolve consistently.
 *
 * Resolution order (source → derivedFrom → `.derived` suffix) matches the
 * consumer's prior behaviour exactly, so the consumer side is a pure move.
 */

import { conceptIdFromTypeName, parseRefInput } from "../../../core/asset/resolve-ref";
import { asNonEmptyString } from "../../../core/common";
import { DERIVED_SUFFIX } from "../../../core/recognition-util";

/**
 * Parse the belief-edge identity `memory:<name>` to its bare memory name.
 * Asset conceptIds are a separate channel and are not accepted here.
 */
export function parseMemoryName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const MEMORY_PREFIX = "memory:";
  if (!trimmed.startsWith(MEMORY_PREFIX)) return undefined;
  const name = trimmed.slice(MEMORY_PREFIX.length);
  return name.length > 0 ? name : undefined;
}

/**
 * Parse a current `source:` backref and return its canonical memory conceptId,
 * or `undefined` when it is empty, invalid, or not a memory ref.
 */
export function parseMemoryRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseRefInput(value.trim());
    return parsed.type === "memory" ? conceptIdFromTypeName("memory", parsed.name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format a bare memory name into the belief-edge IDENTITY channel ref
 * `memory:<name>` — the ONE implementation of that spelling.
 *
 * Belief-edge / identity
 * channel (`contradictedBy` / `supersededBy` / `currentBeliefRefs`, and a derived
 * memory's own `record.ref`) uses `memory:<name>` and is compared against a
 * derived memory's identity ref. This channel is separate from `source:` asset
 * refs, which use `memories/<name>`. Both `memory-improve.ts` (`refArray`) and
 * `memory-contradiction-detect.ts` (`toMemoryRef`) emit through here so the
 * identity spelling has one implementation.
 */
export function memoryIdentityRef(name: string): string {
  return `memory:${name}`;
}

/**
 * True when the named memory is a derived/inferred child — either it carries
 * `inferred: true` in its frontmatter or its name ends with the structural
 * `.derived` suffix.
 */
export function isDerivedMemory(name: string, frontmatter: Record<string, unknown>): boolean {
  return frontmatter.inferred === true || name.endsWith(DERIVED_SUFFIX);
}

/**
 * Resolve the parent (source) memory ref for a derived memory as a canonical
 * `memories/<name>` conceptId, or `undefined` when none
 * can be determined. Precedence:
 *   1. `frontmatter.source` (normalised through {@link parseMemoryRef});
 *   2. `frontmatter.derivedFrom` (a bare memory name → `memories/<name>`);
 *   3. the `.derived` name suffix, stripped → `memories/<name>`.
 */
export function resolveParentRef(name: string, frontmatter: Record<string, unknown>): string | undefined {
  const fromSource = parseMemoryRef(asNonEmptyString(frontmatter.source));
  if (fromSource) return fromSource;

  const derivedFrom = asNonEmptyString(frontmatter.derivedFrom);
  if (derivedFrom) return conceptIdFromTypeName("memory", derivedFrom);

  if (name.endsWith(DERIVED_SUFFIX)) {
    return conceptIdFromTypeName("memory", name.slice(0, -DERIVED_SUFFIX.length));
  }

  return undefined;
}
