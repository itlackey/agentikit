// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Schema-repair pass for `akm improve`.
 *
 * Attempts to patch missing frontmatter fields (`description`, `when_to_use`)
 * on assets that failed schema validation, using a single bounded in-tree LLM
 * call per asset. Results are recorded as `schema_repair_invoked` events.
 *
 * This module is extracted from `improve.ts` to make the repair logic
 * independently testable and to use the shared structured execution seam.
 */

import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { authoringRulesForType } from "../../core/authoring-rules";
import type { LlmConnectionConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { appendEvent, readEvents } from "../../core/events";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { info } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import type { RunnerSpec } from "../../integrations/agent/runner";
import type { ChatMessage, chatCompletion } from "../../llm/client";
import { callStructured, structuredLlmRunnerFromConnection } from "../../llm/structured-call";
import { createProposal, isProposalSkipped } from "../proposal/repository";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchemaRepairFailure {
  ref: string;
  reason: string;
}

/**
 * Schema-repair outcome values (M-3 / #387).
 *
 *   - `queued`  — LLM generated fields were written to the proposal queue.
 *   - `skipped` — Asset didn't need repair or was on cooldown.
 *   - `error`   — Provider/runtime call failed or JSON could not be parsed.
 *
 * Invalid configuration is not an outcome record: the original
 * {@link ConfigError} escapes before proposal or event persistence.
 */
export type SchemaRepairOutcome = "queued" | "skipped" | "error";

export interface SchemaRepairRecord {
  ref: string;
  reason: string;
  outcome: SchemaRepairOutcome;
  /** Proposal id when outcome is "queued". */
  proposalId?: string;
  error?: string;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface SchemaRepairOptions {
  /** Milliseconds since epoch when the surrounding improve run started (for budget checks). */
  startMs: number;
  /** Budget deadline in ms since epoch. */
  budgetMs: number;
  /** Legacy/test-only non-secret connection. Production passes llmRunner. */
  llmConfig?: LlmConnectionConfig;
  /** Pre-resolved symbolic LLM runner supplied by the improve plan. */
  llmRunner?: Extract<RunnerSpec, { kind: "llm" }>;
  /** Stash directory for proposal-queue writes. Required: schema-repair never writes directly. */
  stashDir?: string;
  /** Override the asset file-path resolver (test seam). */
  findFilePath?: (ref: string, stashDir?: string) => Promise<string | null> | string | null;
  /** Whether a given ref is a lesson candidate (affects which fields to repair). */
  isLessonCandidateFn?: (ref: string) => boolean;
  /** Override the LLM chat function (test seam). Production leaves it absent. */
  chatFn?: typeof chatCompletion;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum gap between schema-repair attempts on the same asset. */
const SCHEMA_REPAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Per-ref attempt cap (O-6 / #379): maximum number of schema-repair attempts
 * allowed within SCHEMA_REPAIR_WINDOW_MS. Prevents indefinite nightly re-repair
 * of assets whose source content is genuinely ambiguous or inconsistently
 * structured. After cap, the asset is skipped until the window rolls over.
 * Self-Refine arXiv:2303.17651 — iteration must be bounded.
 */
const SCHEMA_REPAIR_MAX_ATTEMPTS = 3;
const SCHEMA_REPAIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Run the schema-repair loop for a batch of validation failures.
 * Returns a list of per-asset outcome records and the set of refs whose live
 * files were repaired. Queued proposals never count as live repairs. Invalid
 * symbolic credentials reject with {@link ConfigError} before any repair
 * proposal or per-ref event is written.
 */
export async function runSchemaRepairPass(
  failures: SchemaRepairFailure[],
  options: SchemaRepairOptions,
): Promise<{ repairs: SchemaRepairRecord[]; repairedRefs: Set<string> }> {
  const repairs: SchemaRepairRecord[] = [];
  const repairedRefs = new Set<string>();

  const {
    startMs,
    budgetMs,
    stashDir,
    findFilePath = defaultFindFilePath,
    isLessonCandidateFn = defaultIsLessonCandidate,
    chatFn,
  } = options;
  const llmRunner =
    options.llmRunner ?? (options.llmConfig ? structuredLlmRunnerFromConnection(options.llmConfig) : null);
  if (!llmRunner) throw new Error("runSchemaRepairPass requires a resolved LLM runner");

  if (!stashDir) {
    throw new Error("runSchemaRepairPass requires stashDir so repairs route through the proposal queue");
  }

  for (const failure of failures) {
    if (Date.now() - startMs >= budgetMs) break;

    // Cooldown: skip repair if we ran it successfully recently.
    const recentRepairs = readEvents({ type: "schema_repair_invoked", ref: failure.ref });
    const lastRepair = recentRepairs.events
      .filter((e) => e.metadata?.outcome === "queued")
      .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
    if (lastRepair?.ts && Date.now() - new Date(lastRepair.ts).getTime() < SCHEMA_REPAIR_COOLDOWN_MS) {
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
      continue;
    }

    // O-6 / #379: Cap total attempts at SCHEMA_REPAIR_MAX_ATTEMPTS per SCHEMA_REPAIR_WINDOW_MS.
    // Prevents indefinite nightly re-repair of assets whose source is genuinely ambiguous.
    // After the cap is reached, the asset is skipped until the window rolls over.
    const windowStart = Date.now() - SCHEMA_REPAIR_WINDOW_MS;
    const attemptsInWindow = recentRepairs.events.filter(
      (e) => e.ts !== undefined && new Date(e.ts).getTime() >= windowStart,
    ).length;
    if (attemptsInWindow >= SCHEMA_REPAIR_MAX_ATTEMPTS) {
      repairs.push({
        ref: failure.ref,
        reason: failure.reason,
        outcome: "skipped",
        error: `schema-repair attempt cap reached (${attemptsInWindow}/${SCHEMA_REPAIR_MAX_ATTEMPTS} in 30d window)`,
      });
      continue;
    }

    const filePath = await findFilePath(failure.ref, stashDir);
    if (!filePath) {
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
      continue;
    }

    if (path.extname(filePath).toLowerCase() !== ".md") {
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
      continue;
    }

    let loweringNotices: readonly Readonly<LoweringNotice>[] = [];
    const noticeFields = (): { notices?: readonly Readonly<LoweringNotice>[] } =>
      loweringNotices.length > 0 ? { notices: loweringNotices } : {};
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const fm = parseFrontmatter(raw);

      const missingFields: string[] = [];
      if (!fm.data.description) missingFields.push("description");
      if (isLessonCandidateFn(failure.ref) && !fm.data.when_to_use) missingFields.push("when_to_use");

      if (missingFields.length === 0) {
        repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped", ...noticeFields() });
        continue;
      }

      const fieldList = missingFields.join(" and ");
      info(`[improve] schema-repair ${failure.ref} (${fieldList})`);

      const bodyPreview = (fm.content ?? raw).slice(0, 2000);
      // Standards "rulebook" for this target — wiki schema (wiki page) or stash
      // convention/meta facts (non-wiki asset). `resolveStandardsContext`
      // dispatches on the ref.
      const standardsContext = resolveStandardsContext(failure.ref, stashDir);
      const standardsSection = standardsContext.trim()
        ? `\n\nStandards to follow (the rulebook for this target):\n${standardsContext.trim()}`
        : "";
      const assetType = parseRefInput(failure.ref).type;
      const authoringRules = authoringRulesForType(assetType);
      const authoringRulesSection = authoringRules ? `\n\n${authoringRules}` : "";
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `You generate concise asset frontmatter fields. Respond with a JSON object containing only the missing fields. No prose, no markdown fences.`,
        },
        {
          role: "user",
          content: `Generate the missing frontmatter fields (${fieldList}) for this ${assetType} asset. Return ONLY valid JSON like {"description": "...", "when_to_use": "..."}${standardsSection}${authoringRulesSection}\n\n${bodyPreview}`,
        },
      ];
      const llmResponse = await callStructured<string>({
        feature: "schema_repair",
        runner: llmRunner,
        messages,
        ...(chatFn ? { request: { chat: chatFn } } : {}),
        onNotices: (value) => {
          loweringNotices = value;
        },
        parse: (rawResponse) => rawResponse ?? "",
        onError: () => "",
        fallback: "",
      });

      const parsed = parseEmbeddedJsonResponse<Record<string, string>>(llmResponse.trim());
      if (!parsed) {
        repairs.push({
          ref: failure.ref,
          reason: failure.reason,
          outcome: "error",
          error: "LLM returned unparseable JSON for schema repair",
          ...noticeFields(),
        });
        continue;
      }

      const newFm = { ...fm.data };
      if (parsed.description) newFm.description = parsed.description;
      if (parsed.when_to_use) newFm.when_to_use = parsed.when_to_use;
      const newContent = assembleAsset(newFm, fm.content);

      // M-3 / #387: Route through proposal queue instead of writing directly to
      // disk. This restores akm's safety invariant — the proposal queue is the
      // only path to a committed asset write. LLM-generated `description` /
      // `when_to_use` fields can be incorrect; routing through the queue makes
      // them human-reviewable before they affect search ranking and curate hints.
      // mem0 open gaps (arXiv:2504.19413) — any LLM write to a memory field
      // should be human-reviewable.
      const proposalResult = createProposal(stashDir, {
        ref: failure.ref,
        source: "schema-repair",
        // §23.6 fingerprint model-id term (WI-6.4).
        modelId: llmRunner.connection.model,
        payload: {
          content: newContent,
          ...(Object.keys(newFm).length > 0 ? { frontmatter: newFm } : {}),
        },
      });

      if (isProposalSkipped(proposalResult)) {
        info(`[improve] schema-repair proposal skipped for ${failure.ref}: ${proposalResult.message}`);
        repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped", ...noticeFields() });
        continue;
      }

      info(`[improve] schema-repair queued: ${failure.ref} (proposal id: ${proposalResult.id})`);
      appendEvent({
        eventType: "schema_repair_invoked",
        ref: failure.ref,
        metadata: {
          outcome: "queued",
          reason: failure.reason,
          proposalId: proposalResult.id,
          ...noticeFields(),
        },
      });
      repairs.push({
        ref: failure.ref,
        reason: failure.reason,
        outcome: "queued",
        proposalId: proposalResult.id,
        ...noticeFields(),
      });
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      appendEvent({
        eventType: "schema_repair_invoked",
        ref: failure.ref,
        metadata: { outcome: "error", reason: failure.reason, error: String(e), ...noticeFields() },
      });
      repairs.push({
        ref: failure.ref,
        reason: failure.reason,
        outcome: "error",
        error: String(e),
        ...noticeFields(),
      });
    }
  }

  return { repairs, repairedRefs };
}

// ── Default seam implementations ─────────────────────────────────────────────

function defaultIsLessonCandidate(ref: string): boolean {
  try {
    const parsed = parseRefInput(ref);
    return parsed.type === "lesson";
  } catch {
    return false;
  }
}

async function defaultFindFilePath(ref: string, stashDir?: string): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "index-first",
    directoryIndexNames: ["SKILL.md", "index.md", "README.md"],
    preserveDirectNameFallback: true,
  });
}
