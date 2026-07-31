// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contribution command cluster (`akm agent`, `akm lint`) — the asset
 * authoring / validation verbs. Extracted verbatim from src/cli.ts (WS6) so
 * the God Module shrinks; the `main.subCommands.{agent,lint}` keys and every
 * command's args / output shape stay byte-identical.
 *
 * These handlers branch on the result and set a non-zero `process.exitCode`
 * conditionally (exit 1 on a failed dispatch, or on `--fail-on-flagged` lint
 * findings) rather than emitting through the thrown-error path, so they keep
 * the inline `runWithJsonErrors` form rather than migrating to
 * `defineJsonCommand` (which is reserved for plain runWithJsonErrors+output
 * handlers). `process.exitCode` (not `process.exit()`) so the process still
 * exits via natural event-loop drain rather than skipping pending cleanup —
 * see R-067 / F4.
 *
 * NOTE: the asset-authoring `propose` verb (formerly here) moved to
 * `akm proposal new` (0.9 CLI overhaul, S8) — see
 * src/commands/proposal/propose-cli.ts.
 */

import { defineCommand } from "citty";
import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { EXIT_CODES, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { resolveUsageEventSource } from "../../indexer/usage/usage-events";
import { getHyphenatedBoolean } from "../../output/context";
import { akmLint } from "../lint/index";
import { akmAgentDispatch } from "./agent-dispatch";

const EXIT_GENERAL = EXIT_CODES.GENERAL;

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description:
      "Dispatch an agent CLI (opencode, claude, …) with an optional agent asset that provides the system prompt, model, and tool policy. Use <agent-ref> to embody a bundle agent, --model to override the model, and --prompt/--command/--workflow to provide the task.",
  },
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    "agent-ref": {
      type: "positional",
      description:
        "Optional agent asset ref (e.g. agents/code-reviewer). Loads system prompt, model, and tool policy from the bundle asset.",
      required: false,
    },
    prompt: { type: "string", description: "Task prompt to pass to the agent" },
    engine: { type: "string", description: "Agent engine to use (default: defaults.engine)" },
    command: { type: "string", description: "Load prompt from a command asset" },
    workflow: { type: "string", description: "Load prompt from a workflow asset" },
    model: {
      type: "string",
      description:
        "Model override — accepts aliases (opus, sonnet, haiku) or exact platform model IDs. Overrides the model specified in the agent asset.",
    },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
    cwd: {
      type: "string",
      description: "Working directory for the spawned agent (defaults to the current directory)",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");

      const config = loadConfig();
      const agentConfig = config;

      // Resolve agent asset ref → extract system prompt, model, and tool policy.
      const agentRef = getStringArg(args, "agent-ref");

      let systemPrompt: string | undefined;
      let assetModel: string | undefined;
      let assetTools: import("../../sources/types.js").ShowResponse["toolPolicy"] | undefined;

      if (agentRef) {
        const { akmShowUnified } = await import("../read/show.js");
        const asset = await akmShowUnified({ ref: agentRef, detail: "full", eventSource: resolveUsageEventSource() });
        systemPrompt = typeof asset.content === "string" ? asset.content : undefined;
        assetModel = typeof asset.modelHint === "string" ? asset.modelHint : undefined;
        assetTools = asset.toolPolicy;
      }

      // --model flag wins over the asset's modelHint.
      const model = getStringArg(args, "model") ?? assetModel;

      const promptText = getStringArg(args, "prompt");
      const commandRef = getStringArg(args, "command");
      const workflowRef = getStringArg(args, "workflow");
      const cwd = getStringArg(args, "cwd");

      // Only build a dispatch request when there is something to dispatch — a
      // prompt, an agent asset, or a model override. When none of these are
      // present the agent is launched interactively (no injected prompt, no
      // platform-specific flags beyond the profile's base args).
      const hasDispatchContent = !!(promptText ?? commandRef ?? workflowRef ?? systemPrompt ?? model ?? assetTools);

      const result = await akmAgentDispatch({
        engine: getStringArg(args, "engine"),
        prompt: promptText,
        commandRef,
        workflowRef,
        agentConfig,
        ...(hasDispatchContent
          ? {
              dispatch: {
                prompt: promptText ?? "",
                systemPrompt,
                model,
                tools: assetTools,
                ...(cwd ? { cwd } : {}),
              },
            }
          : {}),
        ...(cwd ? { cwd } : {}),
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });

      output("agent-result", result);

      if (!result.ok) {
        // R-067-style fix: this used to call `process.exit(EXIT_GENERAL)`
        // directly, which terminates synchronously and skips any pending
        // `finally`/cleanup up the call stack (including the dispatched
        // agent process' own bookkeeping). `output()` has already run above,
        // so there is nothing left in this handler that depends on
        // terminating immediately — `process.exitCode` + `return` (this is
        // the last statement anyway) lets the process exit naturally once
        // the event loop drains.
        process.exitCode = EXIT_GENERAL;
        return;
      }
    });
  },
});

export const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description:
      "Scan bundle .md files for structural issues (unquoted colons, missing updated field, orphaned stubs, placeholder stubs, missing name/type, stale paths, broken refs in body text and in refs/xrefs/supersededBy/contradictedBy frontmatter). Use --fix to auto-fix Tier 1 issues. Exits 0 on success regardless of findings; use --fail-on-flagged for CI fail-on-finding behavior.",
  },
  args: {
    // R-051: `lint` is a raw `defineCommand` (not `defineJsonCommand`), so it
    // does not get `GLOBAL_OUTPUT_ARGS` for free. `--format`/`--detail`/
    // `--shape`/`--output` already parsed correctly here (this command has no
    // positional for a stray value to fall into), so this is purely a
    // `--help` visibility / consistency fix, not a behavior change.
    ...GLOBAL_OUTPUT_ARGS,
    fix: {
      type: "boolean",
      description: "Apply auto-fixes in place",
      default: false,
    },
    // Declared as its own arg rather than `alias: "auto-fix"`: citty passes
    // aliases to mri, which only understands SINGLE-character ones. A
    // multi-char alias rendered in help as `-auto-fix` (one dash) and parsed
    // as a pile of junk single-char flags, so BOTH advertised spellings —
    // `-auto-fix` and `--auto-fix` — silently ran a plain lint while claiming
    // to fix. Two real boolean args, OR'd at the call site, work and render.
    "auto-fix": {
      type: "boolean",
      description: "Apply auto-fixes in place (same as --fix)",
      default: false,
    },
    dir: { type: "string", description: "Override bundle root directory (default: from config)" },
    "fail-on-flagged": {
      type: "boolean",
      description: "Exit non-zero when summary.flagged > 0 (CI-friendly). Default: exit 0 regardless of findings.",
      default: false,
    },
    type: {
      type: "string",
      description: "Only lint assets of this type (e.g. workflows, tasks, memories)",
      default: undefined,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = akmLint({
        fix: args.fix === true || getHyphenatedBoolean(args, "auto-fix"),
        dir: getStringArg(args, "dir"),
        typeFilter: getStringArg(args, "type"),
      });
      output("lint", result);
      if (args["fail-on-flagged"] && result.summary.flagged > 0) {
        process.exitCode = EXIT_GENERAL;
        return;
      }
    });
  },
});
