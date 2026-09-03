// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in deterministic triage policy presets (Proposal-Queue Triage, §3.1).
 *
 * These are the *only* "rule schema" we ship. Custom needs are served by the
 * single `--policy <path>` escape hatch, which zod-validates an external policy
 * file — not by a config-embedded rule engine (see §9, rejected alternatives).
 *
 * | preset           | accepts                                                   | rejects     | leaves pending                                     |
 * |------------------|-----------------------------------------------------------|-------------|----------------------------------------------------|
 * | `personal-stash` | extract (real content); reflect ≤80 lines; consolidate    | empty diffs | consolidate mid-band, distill dups, contradictions |
 * | `conservative`   | small extract + consolidate only                          | empty diffs | everything else                                    |
 * | `manual`         | nothing                                                   | empty diffs | everything else                                    |
 */

import fs from "node:fs";
import { z } from "zod";
import { UsageError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import type { DrainPolicy } from "./drain";
import { PROPOSAL_SOURCES } from "./repository";

// Valid `generator` values for a drain rule are exactly the canonical proposal
// `source` values (see {@link PROPOSAL_SOURCES} in src/commands/proposal/repository.ts). The
// engine matches rules via `policy.accept.find(r => r.generator === proposal.source)`,
// so a generator that is not a real source can never match — it would be a
// silent permanent no-op. Validate against the closed set to surface typos.
const GeneratorSchema = z.enum(PROPOSAL_SOURCES as unknown as [string, ...string[]], {
  errorMap: () => ({
    message: `must be one of the known proposal sources: ${PROPOSAL_SOURCES.join(", ")}`,
  }),
});

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

/**
 * `personal-stash` encodes the deterministic core of today's hand-rolled
 * rubric (the editable `contradicted` memory). It is shipped as a preset, never
 * hardcoded policy: edit a copy via `--policy <path>` to tune it.
 */
export const PERSONAL_STASH: DrainPolicy = {
  name: "personal-stash",
  accept: [
    // Extract proposals carry freshly-pulled real content — accept when present,
    // but cap the diff for parity with reflect(80)/consolidate(200): an
    // arbitrarily large extract should not auto-promote with zero LLM calls.
    { generator: "extract", minContentLines: 1, maxDiffLines: 200 },
    // Reflect refinements: accept small ones; larger refinements defer to review.
    { generator: "reflect", maxDiffLines: 80 },
    // Consolidate within the diff band; mid-band lands in `defer` below.
    { generator: "consolidate", maxDiffLines: 200 },
  ],
  rejectEmpty: true,
  // Mid-band consolidate, distill duplicates, and contradiction escalations are
  // the irreducibly-semantic tail — deferred to the (Phase 3) judgment tier.
  defer: ["consolidate", "distill"],
};

/** `conservative` accepts only small, low-risk extract + consolidate proposals. */
export const CONSERVATIVE: DrainPolicy = {
  name: "conservative",
  accept: [
    { generator: "extract", maxDiffLines: 80, minContentLines: 1 },
    { generator: "consolidate", maxDiffLines: 80 },
  ],
  rejectEmpty: true,
  defer: [],
};

/** `manual` accepts nothing; it only clears empty diffs. */
export const MANUAL: DrainPolicy = {
  name: "manual",
  accept: [],
  rejectEmpty: true,
  defer: [],
};

const BUILTIN_POLICIES: Record<string, DrainPolicy> = {
  "personal-stash": PERSONAL_STASH,
  conservative: CONSERVATIVE,
  manual: MANUAL,
};

/** Names of the built-in presets, for help text and validation messages. */
export const BUILTIN_POLICY_NAMES = Object.keys(BUILTIN_POLICIES);

// ---------------------------------------------------------------------------
// Custom policy file schema (`--policy <path>`)
// ---------------------------------------------------------------------------

// `.passthrough()`, not `.strict()`: a policy file carrying a `_comment` key,
// or one written for a newer akm version with a field this version does not
// know yet, used to fail closed with no escape hatch other than hand-editing
// the file back to a shape this exact version accepts. Unknown keys are kept
// (ignored, not acted on) and named in a one-time warning instead — the
// `extra-params` (#815/#816) template: the engine itself never reads them
// (rules are matched by the known fields only), so passing them through is
// inert, not silently wrong.
const DrainAcceptRuleSchema = z
  .object({
    generator: GeneratorSchema,
    maxDiffLines: z.number().int().positive().optional(),
    minContentLines: z.number().int().nonnegative().optional(),
    requireType: z.string().optional(),
  })
  .passthrough();

const DrainPolicySchema = z
  .object({
    name: z.string().min(1),
    accept: z.array(DrainAcceptRuleSchema),
    rejectEmpty: z.boolean(),
    defer: z.array(GeneratorSchema),
  })
  .passthrough();

/** Warn once (per file + field set) about policy keys akm parsed but ignored. */
function warnIgnoredPolicyKeys(filePath: string, label: string, raw: unknown, knownKeys: readonly string[]): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const extra = Object.keys(raw as Record<string, unknown>).filter((key) => !knownKeys.includes(key));
  if (extra.length === 0) return;
  warnOnce(
    `drain-policy-ignored-keys:${filePath}:${label}:${extra.join(",")}`,
    `[proposal] Policy file "${filePath}" has ${label} field(s) akm does not recognize and ignores: ${extra.join(", ")}. Check for a typo, or the file may be written for a newer akm version.`,
  );
}

const DRAIN_POLICY_KNOWN_KEYS = Object.keys(DrainPolicySchema.shape);
const DRAIN_ACCEPT_RULE_KNOWN_KEYS = Object.keys(DrainAcceptRuleSchema.shape);

/**
 * Resolve a `--policy <preset|path>` argument into a {@link DrainPolicy}.
 *
 *   - A bare preset name (`personal-stash` / `conservative` / `manual`) returns
 *     the matching built-in.
 *   - Anything else is treated as a filesystem path to a JSON policy file, which
 *     is read and zod-validated.
 *
 * Throws a {@link UsageError} on an unknown preset, a missing file, or a file
 * that fails schema validation.
 */
export function resolveDrainPolicy(arg: string | undefined): DrainPolicy {
  const value = (arg ?? "personal-stash").trim();
  const builtin = BUILTIN_POLICIES[value];
  if (builtin) return builtin;

  // Treat as a path to a custom policy file.
  if (!fs.existsSync(value)) {
    throw new UsageError(
      `Unknown policy "${value}". Use a built-in preset (${BUILTIN_POLICY_NAMES.join(", ")}) or a path to a policy file.`,
      "INVALID_FLAG_VALUE",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(value, "utf8"));
  } catch (err) {
    throw new UsageError(
      `Could not parse policy file "${value}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const validated = DrainPolicySchema.safeParse(parsed);
  if (!validated.success) {
    throw new UsageError(
      `Invalid policy file "${value}": ${validated.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  warnIgnoredPolicyKeys(value, "top-level", parsed, DRAIN_POLICY_KNOWN_KEYS);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as { accept?: unknown }).accept)
  ) {
    (parsed as { accept: unknown[] }).accept.forEach((rule, index) => {
      warnIgnoredPolicyKeys(value, `accept[${index}]`, rule, DRAIN_ACCEPT_RULE_KNOWN_KEYS);
    });
  }
  return validated.data;
}
