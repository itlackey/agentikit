#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Runtime guard: the akm-cli npm package bootstraps with Node.js >= 22
// (#465, #560), then its launcher prefers a working Bun >= 1.0 when available.
// The runtime boundary (src/runtime.ts, src/storage/database.ts) supports both.
// Under Node the CLI must be launched via the
// `dist/cli-node.mjs` wrapper, which registers the text-import loader hook
// before this module graph loads; running `node dist/cli.js` directly still
// works for code paths that touch no embedded text asset, but the wrapper is
// the supported entry. The hard floor is Node 22 (Node 20 support dropped 2026-07; `@clack/core` imports
// `node:util`'s `styleText` (added in Node 20.12) — Node 18 (EOL) throws at import.
{
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (!isBun) {
    const [major = 0] = (process.versions.node ?? "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const nodeOk = major >= 22;
    if (!nodeOk) {
      console.error(
        "\n  ERROR: the akm-cli npm package requires Node.js >= 22.\n" +
          `  Detected Node.js ${process.versions.node ?? "unknown"}.\n` +
          "  Bun >= 1.0 is optional for execution; it does not replace the Node.js bootstrap.\n" +
          "  Upgrade Node.js (https://nodejs.org), or install the runtime-free standalone binary:\n" +
          "    curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash\n",
      );
      process.exit(1);
    }
  }
}

// Global error handlers (#478) — route any async work outside the
// `runWithJsonErrors` envelope through the same JSON shape so users never see
// a raw stack trace. Background timers, fire-and-forget appendEvent writes,
// and lazy `import()` failures are the typical sources. Registered before
// any other top-level work so the startup IIFE banner and the stale-DB
// cleanup are also covered.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Unhandled rejection: ${err.message}`,
        code: "UNHANDLED_REJECTION",
        hint: "Re-run with AKM_DEBUG=1 for a stack trace, or report at https://github.com/itlackey/akm/issues with the failing command.",
      },
      null,
      2,
    ),
  );
  if (process.env.AKM_DEBUG === "1" && err.stack) console.error(err.stack);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Uncaught exception: ${err.message}`,
        code: "UNCAUGHT_EXCEPTION",
        hint: "Re-run with AKM_DEBUG=1 for a stack trace, or report at https://github.com/itlackey/akm/issues with the failing command.",
      },
      null,
      2,
    ),
  );
  if (process.env.AKM_DEBUG === "1" && err.stack) console.error(err.stack);
  process.exit(1);
});

import fs from "node:fs";
import { type ArgsDef, type CommandDef, defineCommand, parseArgs, runCommand, showUsage } from "citty";
import {
  type CittyArgsDefinitionForScan,
  findCittyTopLevelCommand,
  findCittyTopLevelCommandIndex,
  getParsedInvocation,
  parseAllFlagValues,
  resolveHelpMigrateVersionArg,
  setParsedInvocation,
} from "./cli/invocation";
import { EXIT_CODES, emitJsonError, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "./cli/shared";
import { agentCommand, lintCommand } from "./commands/agent/contribute-cli";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { configCommand } from "./commands/config-cli";
import { envCommand } from "./commands/env/env-cli";
import { secretCommand } from "./commands/env/secret-cli";
import { feedbackCommand } from "./commands/feedback-cli";
import { akmHealth } from "./commands/health";
import "./commands/health/renderers";
import type { WindowSpec } from "./commands/health/types";
import { parseWindowSpec } from "./commands/health/windows";
import { improveCommand } from "./commands/improve/improve-cli";
import { migrateCommand } from "./commands/migrate-cli";
import { mvCommand } from "./commands/mv-cli";
import { hintsCommand, logCommand } from "./commands/observability-cli";
import { proposalCommand } from "./commands/proposal/proposal-cli";
import { rememberCommand } from "./commands/read/remember-cli";
import { curateCommand, searchCommand, showCommand } from "./commands/read/search-cli";
import { registryCommand } from "./commands/registry-cli";
import { bundleCommand } from "./commands/sources/bundle-cli";
import { renderMigrationHelp } from "./commands/sources/migration-help";
import { cloneCommand, syncCommand, upgradeCommand } from "./commands/sources/sources-cli";
import { importKnowledgeCommand, indexCommand, infoCommand } from "./commands/sources/stash-cli";
import { taskCommand } from "./commands/tasks/tasks-cli";
import { workflowCommand } from "./commands/workflow-cli";
import { DEFAULT_CONFIG, loadConfig } from "./core/config/config";
import { UsageError } from "./core/errors";
import { assertNoPendingMigrationOperation } from "./core/migration-operation";
import { getConfigPath } from "./core/paths";
import { DURATION_UNITS, parseDuration } from "./core/time";
import { plainize } from "./core/tty";
import { info, isQuiet, setQuiet, setVerbose, warn } from "./core/warn";
import { disposeDispatchResources } from "./integrations/agent/runner-dispatch";
import { getOutputMode, initOutputMode } from "./output/context";
import { isFormatExemptCommand } from "./output/format-exempt";
import { consumeSchedulerContextArg } from "./tasks/scheduler-invocation";
import { pkgVersion } from "./version";

function applyEarlyStderrFlags(argv: string[]): void {
  const separator = argv.indexOf("--");
  const ownArgv = separator === -1 ? argv : argv.slice(0, separator);
  if (ownArgv.includes("--quiet") || ownArgv.includes("-q")) {
    setQuiet(true);
  }
  if (ownArgv.includes("--verbose")) {
    setVerbose(true);
  }
}

// resolveHelpMigrateVersionArg moved to ./cli/invocation (chunk-9 WI-9.9
// argv-normalization fold — it re-scanned process.argv, same as
// findCittyTopLevelCommand and parseAllFlagValues below).

/**
 * Stderr-only human-friendly hint after a non-interactive `setup` invocation.
 * Default --format is `json`, so a CI or piped consumer sees only the JSON on
 * stdout. But an interactive user running `akm setup --yes` would otherwise
 * see only the JSON blob with no obvious next step. When stderr is a TTY and
 * the JSON went to stdout, print a two-line summary to stderr telling the
 * user (a) where the stash landed and (b) what to run next.
 *
 * Silent when: stderr is not a TTY (CI, pipes), --format=text/yaml (the user
 * already gets readable output), --quiet, or the result is missing fields.
 */
function printSetupTtyHint(result: { bundleDir?: string; configPath?: string }): void {
  if (!process.stderr.isTTY) return;
  const mode = getOutputMode();
  if (mode.format !== "json" && mode.format !== "jsonl") return;
  if (isQuiet()) return;
  if (!result?.bundleDir) return;
  console.error(
    plainize(
      `\n✓ Bundle created at ${result.bundleDir}\n` +
        `  Next: \`akm bundle add github:itlackey/akm-stash\` then \`akm index\` to populate the bundle.`,
    ),
  );
}
/**
 * Module Naming:
 * - sources/*           : Asset operations (search, show, add, clone)
 * - sources/providers/* : Runtime data source providers (filesystem, git, website, npm)
 * - registry/*          : Discovery from remote registries (npm, GitHub)
 * - installed-stashes   : Unified source operations (list, remove, update)
 */

const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description:
      "Interactive configuration wizard. Configures embeddings/LLM connections (for indexing/enrichment), agent profiles (CLI agent, embedded SDK, or none), sources, and registries. Shows which features are enabled at the end. Use --config <json> or --yes for non-interactive/scripting mode.",
  },
  args: {
    config: {
      type: "string",
      description: 'Config JSON to apply non-interactively, e.g. \'{"llm":{"endpoint":"...","model":"..."}}\'',
    },
    from: {
      type: "string",
      description:
        "Path to a config file (JSON or YAML) to bootstrap from. Skips prompts for keys present in the file.",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Accept all defaults, skip all prompts. Idempotent — safe to run in CI.",
    },
    dir: {
      type: "string",
      description: "Bundle directory path (overrides defaultBundle in config or --config JSON)",
    },
    // Declared as the POSITIVE name with `default: true` so citty's native
    // `--no-<name>` negation (it strips a leading `--no-` from ANY token and
    // negates the remainder BEFORE consulting the declared-args table) does
    // the work, matching the `sync --push/--no-push` pattern. A flag
    // DECLARED as `no-init` can never be negated: `--no-init` parses as
    // "negate `init`", a name nothing declared, leaving the real key at its
    // default forever — see `search --no-project-context`'s identical fix.
    init: {
      type: "boolean",
      default: true,
      description: "Scaffold the bundle directory. Use --no-init to write configuration without scaffolding it.",
    },
    probe: {
      type: "boolean",
      default: false,
      description: "Probe LLM/embedding endpoints before writing config to verify connectivity",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const noInit = !args.init;
      if (args.from && args.config) {
        throw new UsageError("Pass either --from <file> or --config <json>, not both.", "INVALID_FLAG_VALUE");
      }
      if (args.from) {
        // File-based bootstrap. `loadSetupConfigFromFile` expands a leading
        // `~`, resolves relative paths against cwd, picks the YAML or JSON
        // parser based on the file extension, and surfaces any
        // read/parse/shape errors as ConfigError("INVALID_CONFIG_FILE").
        // `runSetupFromConfig` is fully non-interactive; with `--yes` it also
        // fills defaults for keys the file leaves missing.
        const { loadSetupConfigFromFile, runSetupFromConfig } = await import("./setup/setup");
        const loaded = await loadSetupConfigFromFile(args.from);
        const result = await runSetupFromConfig({
          configJson: loaded.configJson,
          dir: args.dir,
          noInit,
          probe: args.probe,
          applyDefaults: args.yes,
        });
        output("setup", result);
        printSetupTtyHint(result);
      } else if (args.config) {
        // Non-interactive config mode. With `--yes`, defaults fill any keys
        // the JSON blob leaves missing after the deep merge.
        const { runSetupFromConfig } = await import("./setup/setup");
        const result = await runSetupFromConfig({
          configJson: args.config,
          dir: args.dir,
          noInit,
          probe: args.probe,
          applyDefaults: args.yes,
        });
        output("setup", result);
        printSetupTtyHint(result);
      } else if (args.yes) {
        // Defaults mode — no prompts
        const { runSetupWithDefaults } = await import("./setup/setup");
        const result = await runSetupWithDefaults({
          dir: args.dir,
          noInit,
          probe: args.probe,
        });
        output("setup", result);
        printSetupTtyHint(result);
      } else {
        // Interactive wizard
        const { runSetupWizard } = await import("./setup/setup");
        await runSetupWizard({ dir: args.dir, noInit });
      }
    });
  },
});

const healthCommand = defineCommand({
  meta: { name: "health", description: "Check akm runtime health, artifacts, and improve metrics" },
  args: {
    // R-051: `health` is a raw `defineCommand` (not `defineJsonCommand`), so
    // it does not get `GLOBAL_OUTPUT_ARGS` for free. `--format`/`--detail`/
    // `--shape`/`--output` already parsed correctly here (this command has
    // no positional for a stray value to fall into), so this is purely a
    // `--help` visibility / consistency fix, not a behavior change.
    ...GLOBAL_OUTPUT_ARGS,
    since: {
      type: "string",
      description: "Rolling window start (ISO timestamp, date, epoch ms, or shorthand like 24h / 7d)",
    },
    "group-by": {
      type: "string",
      description: "Group rows by: run (one row per improve_runs entry). Omit for the default summary.",
    },
    "window-compare": {
      type: "string",
      description: "Compare current window vs prior window of the same duration (e.g. 24h, 7d, 30m)",
    },
    windows: {
      type: "string",
      description:
        "Explicit comparison window 'name=...,since=ISO,until=ISO' (repeatable, up to 4; mutually exclusive with --window-compare)",
    },
    report: {
      type: "boolean",
      description:
        "Fetch the full report dataset: per-run rows, trend deltas vs the prior window, and the pending proposal queue. Renders as the rich report under --format md/html and as complete data under any other format.",
      default: false,
    },
  },
  async run({ args }) {
    let resultStatus: "pass" | "warn" | "fail" | undefined;
    const exitCodeBeforeRun = process.exitCode;
    await runWithJsonErrors(async () => {
      // citty only surfaces the last value of a repeated flag, so read --windows
      // directly from argv to support multi-window comparison.
      const rawWindows = parseAllFlagValues("--windows");
      const windows: WindowSpec[] | undefined =
        rawWindows.length > 0 ? rawWindows.map((raw) => parseWindowSpec(raw)) : undefined;
      const groupBy = args["group-by"];
      const report = args.report === true;

      // `--report` is a DATA flag: it selects the richer read (per-run rows +
      // window-compare deltas + the proposal queue) and nothing about the read
      // depends on --format. The registered md/html renderers are pure
      // functions of the result — a report-shaped result renders as the rich
      // report, any other shape falls through to the generic rendering.
      //
      // The compare window defaults to the report's own `--since` window so the
      // deltas are like-for-like (e.g. last 7d vs the prior 7d). A fixed 24h
      // default made a `--since 7d` report compare its 7-day totals against a
      // 24-hour prior window, producing meaningless deltas.
      // Comparison-window precedence. An explicit `--window-compare` always
      // wins. Otherwise `--report` seeds a like-for-like comparison from
      // `--since`, but only when `--since` is a DURATION: `resolveWindowCompare`
      // parses durations only, so feeding it an absolute date, ISO timestamp, or
      // epoch value throws. And explicit `--windows` gets no implicit value at
      // all — the two are mutually exclusive, so synthesizing one turned a valid
      // invocation into a usage error.
      const explicitWindows = windows !== undefined && windows.length > 0;
      const sinceIsDuration = args.since !== undefined && parseDuration(args.since, DURATION_UNITS) !== null;
      const implicitCompare = explicitWindows ? undefined : ((sinceIsDuration ? args.since : undefined) ?? "24h");
      const windowCompare = report ? (args["window-compare"] ?? implicitCompare) : args["window-compare"];
      const base = akmHealth({
        since: args.since,
        groupBy: report ? "run" : (groupBy as "run" | undefined),
        windowCompare,
        windows,
      });
      const reportCompare =
        windowCompare ??
        (explicitWindows
          ? [...(base.windows ?? [])]
              .sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())
              .map((window) => window.name)
              .join(" → ")
          : undefined) ??
        "24h";
      resultStatus = base.status;
      if (report) {
        const { listPendingProposals } = await import("./commands/proposal/proposal");
        const { computeAcceptRateBySource } = await import("./commands/health/accept-rate");
        output("health", {
          ...base,
          report: {
            window: args.since ?? "24h",
            compare: reportCompare,
            comparisonMode: explicitWindows ? "custom" : "duration",
            pendingProposals: listPendingProposals().map(({ ref, source, createdAt }) => ({ ref, source, createdAt })),
            acceptRateBySource: computeAcceptRateBySource(),
          },
        });
        return;
      }
      output("health", base);
    });
    // R-067: `emitJsonError` (src/cli/shared.ts) no longer force-exits on the
    // error path — it sets `process.exitCode` and returns, so a `--report`
    // failure thrown AFTER `resultStatus` was already assigned (e.g. the
    // proposal-queue read above) would otherwise leave `resultStatus`
    // populated here too. Skip the status-derived exit entirely once
    // `runWithJsonErrors` has already recorded a classified failure, so it is
    // never clobbered by a mismatched health status.
    if (process.exitCode !== exitCodeBeforeRun) return;
    if (resultStatus === "fail") {
      process.exitCode = EXIT_GENERAL;
    }
    if (resultStatus === "warn") {
      process.exitCode = EXIT_HEALTH_WARN;
    }
  },
});

const helpCommand = defineCommand({
  meta: {
    name: "help",
    description: "Print focused help topics such as migration guidance for a release",
  },
  subCommands: {
    migrate: defineCommand({
      meta: {
        name: "migrate",
        description:
          "Print release notes and migration guidance for a version. Bundled notes live in docs/migration/release-notes/<version>.md; an unknown version lists what's available.",
      },
      args: {
        // Optional in citty so run() is invoked even when omitted; we
        // re-validate below to surface a structured UsageError (exit 2)
        // instead of citty's default help-banner exit-0.
        version: {
          type: "positional",
          description: "Version to review (for example 0.6.0, v0.6.0, 0.6.0-rc1, or latest)",
          required: false,
        },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const version = resolveHelpMigrateVersionArg(typeof args.version === "string" ? args.version : undefined);
          if (!version?.trim()) {
            throw new UsageError(
              "Usage: akm help migrate <version>.",
              "MISSING_REQUIRED_ARGUMENT",
              "Pass a version like `0.6.0`, `v0.6.0`, `0.6.0-rc1`, or `latest`.",
            );
          }
          process.stdout.write(renderMigrationHelp(version));
        });
      },
    }),
  },
});

const completionsCommand = defineCommand({
  meta: {
    name: "completions",
    description: "Generate or install shell completion script",
  },
  args: {
    install: {
      type: "boolean",
      description: "Install completions to the appropriate directory",
      default: false,
    },
    shell: {
      type: "string",
      description: "Shell type (bash)",
      default: "bash",
    },
  },
  run({ args }) {
    // R-052(b): this was a bare `run()` throwing directly, so an unsupported
    // `--shell` value escaped straight to citty's top-level error handling
    // instead of the standard JSON envelope — exit 1 with a raw stack trace
    // instead of the classified exit-2 usage error every other command
    // produces (`completions` is format-exempt, so it stays a raw
    // `defineCommand` rather than `defineJsonCommand`, but still needs the
    // same error-classification wrapper other bare `defineCommand`s in this
    // file use, e.g. `help migrate` below).
    return runWithJsonErrors(() => {
      if (args.shell !== "bash") {
        throw new UsageError(`Unsupported shell: ${args.shell}. Only bash is supported.`);
      }
      const script = generateBashCompletions(main);
      if (args.install) {
        const dest = installBashCompletions(script);
        info(`Completions installed to ${dest}`);
        info(`Restart your shell or run:  source ${dest}`);
      } else {
        process.stdout.write(script);
      }
    });
  },
});

export const main = defineCommand({
  meta: {
    name: "akm",
    version: pkgVersion,
    description:
      "Agent Knowledge Management — search, show, and manage assets from your bundle.\n\n" +
      "Exit codes:\n" +
      "  0   success\n" +
      "  1   not found / command-reported failure\n" +
      "  2   usage error\n" +
      "  4   health warn (akm health only)\n" +
      "  70  internal / unclassified error\n" +
      "  78  config error",
  },
  args: {
    format: { type: "string", description: "Output format (json|jsonl|text|yaml|md|html)", default: "json" },
    output: {
      type: "string",
      description: "Write rendered output to a file instead of stdout (all formats except jsonl)",
    },
    detail: {
      type: "string",
      description: "Detail level (verbosity): brief|normal|full. Default: brief.",
      default: "brief",
    },
    shape: {
      type: "string",
      description:
        "Output projection: human|agent|summary. 'agent' trims to agent-essential fields; " +
        "'summary' is only valid on 'akm show'. Default: human.",
    },
    quiet: {
      type: "boolean",
      alias: "q",
      description:
        "Suppress non-essential stderr output (banners, spinners, progress info). " +
        "Safety-critical output is never suppressed: errors, destructive-action confirmation prompts, " +
        "and auto-migration banners always appear regardless of --quiet.",
      default: false,
    },
    verbose: {
      type: "boolean",
      description: "Print per-spec diagnostics to stderr (also honours AKM_VERBOSE env var)",
      default: false,
    },
  },
  subCommands: {
    setup: setupCommand,
    index: indexCommand,
    health: healthCommand,
    info: infoCommand,
    bundle: bundleCommand,
    upgrade: upgradeCommand,
    search: searchCommand,
    curate: curateCommand,
    show: showCommand,
    workflow: workflowCommand,
    remember: rememberCommand,
    import: importKnowledgeCommand,
    sync: syncCommand,
    clone: cloneCommand,
    mv: mvCommand,
    registry: registryCommand,
    migrate: migrateCommand,
    config: configCommand,
    feedback: feedbackCommand,
    log: logCommand,
    agent: agentCommand,
    lint: lintCommand,
    improve: improveCommand,
    proposal: proposalCommand,
    help: helpCommand,
    hints: hintsCommand,
    completions: completionsCommand,
    env: envCommand,
    secret: secretCommand,
    task: taskCommand,
  },
});

const MAIN_TOP_LEVEL_ARGS = main.args as ArgsDef;

function isTaskRunWithId(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const commandIndex = findCittyTopLevelCommandIndex(args, MAIN_TOP_LEVEL_ARGS);
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  if (command !== "task") return false;
  const taskArgs = args.slice(commandIndex + 1);
  if (taskArgs[0] !== "run") return false;
  const runCommand = (taskCommand.subCommands as unknown as Record<string, { args?: ArgsDef }> | undefined)?.run;
  if (!runCommand?.args) return false;
  try {
    const parsed = parseArgs(taskArgs.slice(1), runCommand.args) as Record<string, unknown>;
    return typeof parsed.id === "string" && parsed.id.length > 0;
  } catch {
    return false;
  }
}

/** Recovery/setup surfaces must remain reachable when config.json is invalid. */
export function shouldBypassConfigStartup(argv: readonly string[]): boolean {
  const userArgs = argv.slice(2);
  const separator = userArgs.indexOf("--");
  const args = separator === -1 ? userArgs : userArgs.slice(0, separator);
  if (args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v")) return true;
  const commandIndex = findCittyTopLevelCommandIndex(args, MAIN_TOP_LEVEL_ARGS);
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  if (command === "setup" || command === "migrate") return true;
  if (isTaskRunWithId(argv)) return true;
  if (command !== "config") return false;
  const configIndex = args.indexOf("config");
  const subcommand = args.slice(configIndex + 1).find((arg) => !arg.startsWith("-"));
  return subcommand === "path";
}

// ── Exit codes ──────────────────────────────────────────────────────────────
// Canonical table lives in `src/cli/shared.ts` (EXIT_CODES). These aliases keep
// the local call sites terse. EXIT_HEALTH_WARN (4) is the `akm health` "warn"
// status — advisories fired but no hard failure; chosen to avoid colliding with
// GENERAL (1) and USAGE (2). CI monitors can map: 0=pass, 4=warn, 1=fail.
const EXIT_GENERAL = EXIT_CODES.GENERAL;
const EXIT_HEALTH_WARN = EXIT_CODES.HEALTH_WARN;

// ── Top-level driver (replaces citty's `runMain`) ───────────────────────────
//
// R-032: citty's own `runMain` catches EVERY error escaping `runCommand` —
// including its unexported `CLIError`, thrown for "Unknown command …", "No
// command specified.", "Missing required argument/positional …", and invalid
// enum values — and unconditionally calls `process.exit(1)`, regardless of
// error kind (node_modules/citty/dist/index.mjs). That collapsed usage
// mistakes (`akm totally-bogus`, `akm wiki list`, bare `akm log`) onto exit
// code 1 instead of the documented usage-error code 2 (STABILITY.md's
// exit-code table), and there is no way to override it from outside
// `runMain`'s own call frame: once it calls `process.exit`, nothing run
// afterward — including a `finally` further up the stack — gets a chance to
// execute. So the CLI drives citty's exported `runCommand` directly instead
// of `runMain`, replicating `runMain`'s `--help` / `--version`
// short-circuits and its CLIError → usage-banner rendering, but classifying
// a CLIError as USAGE (2) instead of GENERAL (1). Every other error escaping
// this boundary keeps the previous GENERAL (1) mapping — this only
// reclassifies the one error family citty itself throws before any of our
// own command bodies (and their `runWithJsonErrors` / `emitJsonError`
// classification) ever run.

const HELP_FLAGS = ["--help", "-h"];
const VERSION_FLAGS = ["--version", "-v"];

// biome-ignore lint/suspicious/noExplicitAny: citty command tree uses dynamic shapes (same precedent as src/commands/completions.ts and defineGroupCommand in src/cli/shared.ts)
type AnyCittyCommand = CommandDef<any>;

/**
 * Duck-types citty's internal, unexported `CLIError`
 * (node_modules/citty/dist/index.mjs) — the class `runCommand` throws for
 * "Unknown command …", "No command specified.", "Missing required
 * argument/positional …", and invalid enum values. citty does not export
 * this class, so `instanceof` isn't available; `name` is set in its
 * constructor (`this.name = "CLIError"`) and is stable across the pinned
 * `citty@^0.2.2` dependency.
 */
function isCittyCliError(error: unknown): error is Error {
  return error instanceof Error && error.name === "CLIError";
}

function findCittySubCommandByName(
  subCommands: Record<string, AnyCittyCommand>,
  name: string,
): AnyCittyCommand | undefined {
  if (name in subCommands) return subCommands[name];
  for (const sub of Object.values(subCommands)) {
    const alias = (sub.meta as { alias?: string | string[] } | undefined)?.alias;
    const aliases = Array.isArray(alias) ? alias : alias ? [alias] : [];
    if (aliases.includes(name)) return sub;
  }
  return undefined;
}

/**
 * Re-implementation of citty's own (unexported) `resolveSubCommand`: walks
 * `rawArgs` down the subcommand tree the same way its private
 * `findSubCommandIndex` / `_findSubCommand` do, so the usage banner rendered
 * on a CLIError names the deepest command the user was actually invoking —
 * matching what citty's own `runMain` would have shown, byte-for-byte.
 */
function resolveDeepestCittyCommand(
  cmd: AnyCittyCommand,
  rawArgs: readonly string[],
  parent?: AnyCittyCommand,
): [AnyCittyCommand, AnyCittyCommand | undefined] {
  const subCommands = cmd.subCommands as Record<string, AnyCittyCommand> | undefined;
  if (subCommands && Object.keys(subCommands).length > 0) {
    const idx = findCittyTopLevelCommandIndex(rawArgs, (cmd.args ?? {}) as CittyArgsDefinitionForScan);
    const name = idx >= 0 ? rawArgs[idx] : undefined;
    if (name !== undefined) {
      const sub = findCittySubCommandByName(subCommands, name);
      if (sub) return resolveDeepestCittyCommand(sub, rawArgs.slice(idx + 1), cmd);
    }
  }
  return [cmd, parent];
}

function resolveCittyCommandPath(
  cmd: AnyCittyCommand,
  rawArgs: readonly string[],
  path: readonly string[] = [],
): string[] {
  const subCommands = cmd.subCommands as Record<string, AnyCittyCommand> | undefined;
  if (!subCommands || Object.keys(subCommands).length === 0) return [...path];
  const index = findCittyTopLevelCommandIndex(rawArgs, (cmd.args ?? {}) as CittyArgsDefinitionForScan);
  const token = index >= 0 ? rawArgs[index] : undefined;
  if (token === undefined) return [...path];
  const sub = findCittySubCommandByName(subCommands, token);
  if (!sub) return [...path];
  const name = Object.entries(subCommands).find(([, candidate]) => candidate === sub)?.[0] ?? token;
  return resolveCittyCommandPath(sub, rawArgs.slice(index + 1), [...path, name]);
}

/**
 * The CLI's real startup sequence, extracted into a function so error paths
 * can `return` early — top-level `return` is a syntax error in an ES module,
 * and this used to rely on `emitJsonError`'s `never` return type (a
 * synchronous `process.exit`) to stop execution instead. Now that
 * `emitJsonError` (src/cli/shared.ts, R-067) only records `process.exitCode`
 * and returns, every direct call site here needs its own explicit `return;`
 * to stop the rest of startup from running after a fatal early error.
 */
async function runCli(): Promise<void> {
  try {
    process.argv = consumeSchedulerContextArg(process.argv);
  } catch (error: unknown) {
    emitJsonError(error);
    return;
  }
  // Mint the ParsedInvocation singleton from the (normalized) argv — the ONE
  // place argv is parsed for the whole process (plan §10.7 / chunk-9 WI-9.9).
  // Every out-of-cli.ts command module reads argv state through
  // `getParsedInvocation()` from here on instead of re-scanning process.argv.
  setParsedInvocation(process.argv);
  // Resolve output mode once at startup from the (normalized) argv and persisted
  // config. All subsequent output() calls read from this in-memory singleton.
  // `initOutputMode` can throw a UsageError when --format/--detail values are
  // invalid; surface it through the same JSON-error path the rest of the CLI uses
  // rather than letting the raw exception escape with a stack trace.
  try {
    applyEarlyStderrFlags(process.argv);
    if (isTaskRunWithId(process.argv)) assertNoPendingMigrationOperation();
    const bypassConfig = shouldBypassConfigStartup(process.argv);
    initOutputMode(process.argv, bypassConfig ? (DEFAULT_CONFIG.output ?? {}) : (loadConfig().output ?? {}));
  } catch (error: unknown) {
    emitJsonError(error);
    return;
  }

  // `--shape summary` is only meaningful on `akm show`. Reject it up front for
  // every other command so a write command (e.g. `akm proposal accept …`)
  // fails fast BEFORE performing its mutation, rather than throwing at
  // output-shaping time after the side effect has already happened. The
  // shape-registry gate in shapeForCommand() remains as defense-in-depth (and
  // covers the in-process test harness, which skips this startup block).
  const commandPath = resolveCittyCommandPath(main, process.argv.slice(2));
  const topLevelCommand = commandPath[0] ?? findCittyTopLevelCommand(process.argv.slice(2), MAIN_TOP_LEVEL_ARGS);
  if (getOutputMode().shape === "summary" && topLevelCommand !== "show") {
    emitJsonError(new UsageError("'--shape summary' is only valid on 'akm show'.", "INVALID_SHAPE_VALUE"));
    return;
  }

  // D7 — every command that renders through output() honours all six --format
  // values. The declared exempt set (src/output/format-exempt.ts) does not
  // render an envelope at all, so warn rather than pretend: silently ignoring
  // the flag is what made the old md/html behaviour so hard to discover. A
  // warning, not an error, because the flag is harmless here and scripts that
  // pass --format globally to a mixed batch of commands should still work.
  const invocation = getParsedInvocation();
  if (
    (invocation.hasFlag("--format") || invocation.getFlagValue("--format") !== undefined) &&
    isFormatExemptCommand(commandPath)
  ) {
    warn(`[output] '--format' has no effect on 'akm ${commandPath.join(" ")}' — its output is not a result envelope.`);
  }

  // First-time-user breadcrumb: when run with no subcommand AND no config
  // exists yet AND stderr is a TTY, print a friendly pointer to `akm setup`
  // above citty's auto-generated usage block. Triggers only when stdin/stderr
  // are interactive (so JSON-output users / CI consumers see nothing extra)
  // and stays silent for any flag-only invocation citty would handle itself
  // (--help, --version).
  (function maybePrintFirstTimeBanner(): void {
    const argv = process.argv.slice(2);
    // Fire only on completely bare `akm` invocation. Any explicit flag or
    // subcommand means the user knows what they want.
    if (argv.length > 0) return;
    if (!process.stderr.isTTY) return;
    try {
      if (fs.existsSync(getConfigPath())) return;
    } catch {
      // If we can't resolve the config path, assume non-fresh and stay silent.
      return;
    }
    console.error(
      plainize(
        "👋 First time with akm? Run `akm setup` to get started.\n   Docs: https://github.com/itlackey/akm#readme\n",
      ),
    );
  })();

  const rawArgs = process.argv.slice(2);
  try {
    // Mirrors citty's own builtin-flag short-circuit in `runMain` (main's own
    // args never declare `help`/`h`/`version`/`v`, so both stay the fixed
    // defaults citty would have computed too).
    //
    // Scan only akm's OWN arguments: everything after a literal `--` belongs to
    // the child process (`akm env run <ref> -- tool --help`, `akm secret run
    // <ref> -- tool -h`). Scanning the tail printed akm's usage and returned
    // without ever launching the requested command.
    const passthroughAt = rawArgs.indexOf("--");
    const ownArgs = passthroughAt === -1 ? rawArgs : rawArgs.slice(0, passthroughAt);
    if (HELP_FLAGS.some((flag) => ownArgs.includes(flag))) {
      const [resolved, parent] = resolveDeepestCittyCommand(main, rawArgs);
      await showUsage(resolved as CommandDef, parent as CommandDef | undefined);
      return;
    }
    if (rawArgs.length === 1 && VERSION_FLAGS.includes(rawArgs[0] as string)) {
      console.log(pkgVersion);
      return;
    }
    await runCommand(main, { rawArgs });
  } catch (error) {
    if (isCittyCliError(error)) {
      // R-032: reclassify citty's own "unknown command" / "no command
      // specified" / "missing required argument" family as USAGE (2) —
      // citty's `runMain` would have printed this same usage banner +
      // message, then unconditionally called `process.exit(1)`.
      const [resolved, parent] = resolveDeepestCittyCommand(main, rawArgs);
      await showUsage(resolved as CommandDef, parent as CommandDef | undefined);
      console.error(error.message);
      process.exitCode = EXIT_CODES.USAGE;
      return;
    }
    // Anything else escaping here is a genuinely unexpected failure outside
    // any command's own error handling — every command wraps its body in
    // `runWithJsonErrors`, `defineJsonCommand`, or `defineGroupCommand`, all
    // three of which route thrown errors through `emitJsonError` before they
    // could ever reach this boundary. Route it the same way rather than
    // hard-coding GENERAL(1): the CLI contract reserves 1 for general/not-found
    // and requires a non-`AkmError` throw to render the JSON failure envelope
    // with INTERNAL(70) (AGENTS.md "CLI Contract"), which is what lets
    // automation tell an internal defect apart from an ordinary failure.
    // `emitJsonError` classifies and sets `process.exitCode` itself.
    emitJsonError(error);
  } finally {
    await disposeDispatchResources();
  }
}

// Only run the CLI when this module is the direct entry point. When it is
// imported (e.g. by the in-process test harness in tests/_helpers/cli.ts),
// `import.meta.main` is false and we skip all startup side effects (argv
// mutation, output-mode init, index cleanup, banner, command dispatch) so
// importers can drive the `main` command themselves without the process
// exiting.
//
// Node path: this module carries a `#!/usr/bin/env bun` shebang and is launched
// under Node via the `dist/cli-node.mjs` wrapper, which `import()`s this file
// (so `import.meta.main` is false here even though the CLI is the real entry).
// The wrapper sets `AKM_NODE_ENTRY=1` to opt into the startup block. Compiled
// standalone binaries are the same shape: their entry is
// `scripts/akm-standalone.ts` (which also embeds the akm-migrate tool), and it
// sets `AKM_STANDALONE_ENTRY=1` before importing this file. The test harness
// sets neither, so importing cli.ts under Bun stays inert as before.
if (import.meta.main || process.env.AKM_NODE_ENTRY === "1" || process.env.AKM_STANDALONE_ENTRY === "1") {
  await runCli();
}
