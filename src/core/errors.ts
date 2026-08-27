// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Typed error classes for structured exit code classification.
 *
 * - ConfigError  -> exit 78  (configuration / environment problems)
 * - UsageError   -> exit 2   (bad CLI arguments or invalid input)
 * - NotFoundError -> exit 1  (requested resource missing)
 *
 * Each error carries a machine-readable `code` field. Codes are stable
 * identifiers safe to consume from scripts and JSON output. Existing throw
 * sites without an explicit code receive a default code per error class so
 * older call sites continue to compile and behave unchanged.
 *
 * Each error also exposes a `hint()` method returning an actionable hint
 * string (or `undefined`). Hints can be supplied at construction time or
 * derived from the error `code` via the per-class default mapping below.
 * The CLI surfaces this via `error.hint()` rather than message-regex parsing.
 */

/** Stable, machine-readable codes for ConfigError. */
export type ConfigErrorCode =
  | "CONFIG_DIR_UNRESOLVABLE"
  | "STASH_DIR_NOT_FOUND"
  | "STASH_DIR_NOT_A_DIRECTORY"
  | "STASH_DIR_UNREADABLE"
  // The index/state database exists (or may exist) but this process cannot read
  // it — a permission or ownership mismatch, not a missing index. Distinct from
  // "not built yet" precisely so a read can fail loudly instead of returning an
  // empty-but-successful result for an index that is sitting right there (#791).
  | "DATA_DIR_UNREADABLE"
  | "INDEX_SCHEMA_INCOMPATIBLE"
  | "EMBEDDING_NOT_CONFIGURED"
  | "LLM_NOT_CONFIGURED"
  | "INVALID_CONFIG_FILE"
  | "UNSUPPORTED_CONFIG_VERSION"
  // Defense-in-depth sentinel raised by `akm bundle create` under `bun test`
  // to refuse persisting a temp-dir stashDir to the user's real config.
  // See src/commands/sources/init.ts.
  | "INIT_TMP_STASH_REFUSED"
  | "SETUP_TMP_STASH_REFUSED"
  | "UNKNOWN_IMPROVE_STRATEGY"
  | "DANGEROUS_ENV_AUDIT_FAILED"
  | "EXECUTION_NOT_AUTHORIZED"
  // Refused stashDir that would clobber a sensitive system path or the user's
  // home directory (#473). Triggered by `akm bundle create`/`akm setup` when the
  // explicit `--dir` argument resolves to e.g. `/`, `$HOME`, `~/.config`,
  // `/etc`, etc.
  | "UNSAFE_STASH_DIR"
  // Defense-in-depth sentinel raised under `bun test` / NODE_ENV=test
  // when a test sets AKM_BUNDLE_DIR but forgets to also point
  // XDG_DATA_HOME / AKM_DATA_DIR (and XDG_STATE_HOME / AKM_STATE_DIR)
  // at temp directories. See src/core/paths.ts.
  | "TEST_ISOLATION_MISSING"
  // The host platform/architecture has no supported build for a requested
  // binary operation (e.g. `akm upgrade` on an unreleased platform target).
  | "UNSUPPORTED_PLATFORM"
  // `akm upgrade` refused: the environment blocks the upgrade (version
  // contract, filesystem permissions, or leftover upgrade state). The error
  // message carries the specific remediation.
  | "UPGRADE_BLOCKED";

/** Stable, machine-readable codes for UsageError. */
export type UsageErrorCode =
  | "INVALID_FLAG_VALUE"
  | "INVALID_SOURCE_VALUE"
  | "INVALID_FORMAT_VALUE"
  | "INVALID_DETAIL_VALUE"
  | "INVALID_SHAPE_VALUE"
  | "INVALID_JSON_CONFIG_VALUE"
  | "UNKNOWN_CONFIG_KEY"
  | "INVALID_JSON_ARGUMENT"
  | "MISSING_REQUIRED_ARGUMENT"
  | "MISSING_OR_AMBIGUOUS_TARGET"
  | "TARGET_NOT_UPDATABLE"
  | "PATH_ESCAPE_VIOLATION"
  | "RESOURCE_ALREADY_EXISTS"
  | "TASK_SCHEMA_VERSION_UNSUPPORTED"
  | "WORKFLOW_IR_VERSION_UNSUPPORTED"
  | "INVALID_PROPOSAL"
  | "NON_INTERACTIVE_REQUIRES_YES"
  // citty's own CLIError (unknown top-level command or subcommand), reclassified
  // by src/cli.ts so it flows through the same JSON envelope as every other
  // usage error instead of citty's raw usage-banner + console.error path.
  | "UNKNOWN_COMMAND"
  // A flag the resolved command does not declare. citty (node:util parseArgs,
  // strict: false) silently ignores these, so a typo used to parse
  // "successfully" and exit 0 — a `--fail-on-flaged`
  // in CI meant the gate never fired.
  | "UNKNOWN_FLAG"
  // P1a (docs/plans/specs/p1a-with-rejection-classifier.md §2.1, D7): a
  // workflow step authors with: on a target that cannot bind it. The
  // authored mapping used to be silently dropped at freeze; now it is
  // rejected instead (the fail-closed correction). P2b
  // (docs/plans/specs/p2b-input-bindings.md §1.7 A-N5) narrows this to a
  // tasks/<ref> target that declares no inputs: at all, and grows it to
  // commands/<ref> and scripts/<ref> targets, which are never binding
  // surfaces. Thrown from src/workflows/freeze/targets/task.ts's
  // taskDispatch and src/workflows/freeze/resolve-steps.ts's resolveStep.
  | "COMPOSITION_INVALID"
  // P1a: the sourceError funnel in src/tasks/source-v3.ts, re-coded from
  // INVALID_FLAG_VALUE. Message text, field-path rendering (`$` for the
  // empty path), and the file:line location string are unchanged.
  | "TASK_SOURCE_INVALID"
  // P1a: src/execution/target-ref.ts's classifyTargetRef rejects any value
  // that is not a canonical commands/, scripts/, tasks/, or workflows/ asset
  // ref (fragments, malformed shapes, non-canonical spellings, other asset
  // families, GitHub locators, etc).
  | "TARGET_REF_INVALID"
  // P1a: declared only in this phase — wired to workflow source validation
  // (e.g. `akm workflow validate`) in a later phase.
  | "WORKFLOW_SOURCE_INVALID"
  // P1a: declared only in this phase — wired in P2b when with: bindings are
  // validated against a target's declared inputs.
  | "INPUT_BINDING_INVALID"
  // P1b (docs/plans/specs/p1b-model-extraction.md, diagnostic-codes ratchet
  // remedy): src/tasks/source/parse-v3-adapter.ts's taskDefinitionFromV3
  // rejects a validly-parsed task-v3 `uses:` kind (builtin-command,
  // github-action) that has no representation in P1b's closed
  // TaskDefinitionTarget vocabulary yet. Distinct from INVALID_FLAG_VALUE:
  // the input is not malformed, it is a recognized construct this phase's
  // model does not model. Not yet reachable from any production path — the
  // adapter is additive in P1b (spec §3.4).
  | "TASK_TARGET_UNSUPPORTED";

/** Stable, machine-readable codes for NotFoundError. */
export type NotFoundErrorCode =
  | "ASSET_NOT_FOUND"
  | "STASH_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "WORKFLOW_NOT_FOUND"
  | "PROPOSAL_NOT_FOUND"
  | "DANGEROUS_ENV_KEY"
  | "FILE_NOT_FOUND";

/**
 * Default hint for each ConfigError code. Keep these short, actionable, and
 * imperative. Returning undefined means "no canned hint".
 */
const CONFIG_HINTS: Partial<Record<ConfigErrorCode, string>> = {
  STASH_DIR_NOT_FOUND: "Run `akm setup` to create and configure your bundle, or configure a defaultBundle path.",
  STASH_DIR_NOT_A_DIRECTORY:
    "The configured default bundle path exists but isn't a directory. Update it to point at a folder.",
  STASH_DIR_UNREADABLE: "Check the path exists and your user has read permission, or update the default bundle path.",
  DATA_DIR_UNREADABLE:
    "The data directory is not readable by the user running akm. Check its owner and mode, or point AKM_DATA_DIR / XDG_DATA_HOME somewhere this user owns.",
  INDEX_SCHEMA_INCOMPATIBLE:
    "Run `akm index --full` to rebuild the derived index from the currently materialized sources.",
  EMBEDDING_NOT_CONFIGURED: 'Run `akm config set embedding \'{"endpoint":"...","model":"..."}\'` to enable embeddings.',
  LLM_NOT_CONFIGURED:
    'Run `akm setup` or configure an `engines` entry with `kind: "llm"`, then select it with `defaults.llmEngine`.',
  TEST_ISOLATION_MISSING:
    "Under bun test, when AKM_BUNDLE_DIR is set you MUST also set XDG_DATA_HOME (or AKM_DATA_DIR) and XDG_STATE_HOME (or AKM_STATE_DIR) to temp directories so the test does not touch the developer's real ~/.local/share/akm or ~/.local/state/akm.",
  SETUP_TMP_STASH_REFUSED:
    "Use a persistent directory, or set AKM_FORCE_SETUP_TMP_STASH=1 to opt in to a sandboxed setup (setup also pre-sets AKM_BUNDLE_DIR so config and cache writes auto-isolate into $stashDir/.akm/ — host config is preserved).",
  UNSAFE_STASH_DIR:
    "Choose a path inside your home directory (e.g. ~/akm) or another empty workspace. The bundle directory cannot be the filesystem root, your home directory itself, or a sensitive system path like /etc, /var, ~/.config, or ~/.ssh.",
  UNKNOWN_IMPROVE_STRATEGY:
    "Pass one of the listed strategy names to `--strategy`, or define it under `improve.strategies`. Names are case-sensitive.",
  EXECUTION_NOT_AUTHORIZED: "Change the selected tools or update the machine/user execution policy, then retry.",
};

/** Default hint for each UsageError code. */
const USAGE_HINTS: Partial<Record<UsageErrorCode, string>> = {
  INVALID_FLAG_VALUE: "Run `akm <command> --help` to see accepted values.",
  INVALID_SOURCE_VALUE: "Pick one of: local, registry, all, or a configured source name.",
  INVALID_FORMAT_VALUE: "Pick one of: json, jsonl, yaml, text, md, html.",
  INVALID_DETAIL_VALUE: "Pick one of: brief, normal, full. For agent/summary projections use --shape.",
  INVALID_SHAPE_VALUE: "Pick one of: human, agent, summary (summary is only valid on `akm show`).",
  INVALID_JSON_CONFIG_VALUE:
    'Quote JSON values in your shell, for example: akm config set embedding \'{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}\'.',
  MISSING_OR_AMBIGUOUS_TARGET:
    "Use `akm bundle update --all` or pass a target like `akm bundle update npm:@scope/pkg` (not both).",
  TARGET_NOT_UPDATABLE: "Run `akm bundle list` to view your sources, then retry with one of those values.",
  MISSING_REQUIRED_ARGUMENT:
    "Refs use the form [bundle//]conceptId, e.g. `akm show knowledge/guide.md` or `akm show skills/deploy`.",
  UNKNOWN_COMMAND: "Run `akm --help` to see available commands.",
  UNKNOWN_FLAG: "Run the command with `--help` to see its accepted flags.",
  // P2b (docs/plans/specs/p2b-input-bindings.md §1.7 A-N5, §7 F-A3): the
  // "arrives in a later 0.9.x release" promise is gone now that task-call
  // inputs are implemented. Names the two real rejection causes instead:
  // (1) a task target that declares no inputs: at all, (2) commands/<ref> /
  // scripts/<ref>, which are never binding surfaces. F-A3 authorizes this
  // edit and the matching pinned-string update in
  // tests/core/errors-usage-hints.test.ts in the same commit.
  COMPOSITION_INVALID:
    "Remove the with: block, or target a tasks/<ref> whose source declares inputs: — commands/<ref> and scripts/<ref> steps are not binding surfaces.",
  TASK_SOURCE_INVALID: "Fix the task source at the reported path and line, then re-run.",
  TARGET_REF_INVALID:
    "Targets are canonical asset refs: `commands/review`, `scripts/build.sh`, `tasks/nightly`, `workflows/release`.",
  WORKFLOW_SOURCE_INVALID: "Run `akm workflow validate <ref>` to see the failing source location.",
  INPUT_BINDING_INVALID: "Check the step's with: keys against the target's declared inputs.",
  TASK_TARGET_UNSUPPORTED:
    "Task definitions support command, script, workflow, and shell (run:) targets in this version; akm/command and GitHub-action targets are not yet representable here.",
};

/** Default hint for each NotFoundError code. */
const NOT_FOUND_HINTS: Partial<Record<NotFoundErrorCode, string>> = {
  ASSET_NOT_FOUND: "Run `akm search <query>` or `akm index` to refresh the index.",
  SOURCE_NOT_FOUND: "Run `akm bundle list` to view your sources, then retry with one of those values.",
  WORKFLOW_NOT_FOUND: "Run `akm workflow list --active` to see runs.",
  // A proposal is addressed by id or ref, never by path — reusing
  // FILE_NOT_FOUND here handed users "check the path exists and is readable"
  // for a mistyped id, which points at the wrong thing entirely.
  PROPOSAL_NOT_FOUND: "Run `akm proposal list` to see pending proposals and their ids.",
  FILE_NOT_FOUND: "Check the path exists and is readable.",
};

/**
 * Discriminant identifying which concrete akm error class an instance is,
 * independent of `instanceof` (which can break across realm / bundle
 * boundaries). `classifyExitCode` switches exhaustively on this `kind`, so
 * adding a new error class forces a compile-time error at the switch until a
 * case is added — there is no silent `default` fall-through to a wrong code.
 */
export type AkmErrorKind = "config" | "usage" | "not-found";

/**
 * Base class for all akm-thrown, classified errors. Carries the `kind`
 * discriminant consumed by the CLI exit-code classifier. Errors that are NOT
 * instances of `AkmError` are treated as genuinely unexpected (INTERNAL).
 */
export abstract class AkmError extends Error {
  abstract readonly kind: AkmErrorKind;
  /** Stable, machine-readable code surfaced in the JSON error envelope. */
  abstract readonly code: string;
  /** Actionable hint string, or undefined when none applies. */
  abstract hint(): string | undefined;
}

/** Raised when configuration or environment is invalid or missing. */
export class ConfigError extends AkmError {
  readonly kind = "config" as const;
  readonly code: ConfigErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: ConfigErrorCode = "INVALID_CONFIG_FILE", hint?: string) {
    super(msg);
    this.name = "ConfigError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? CONFIG_HINTS[this.code];
  }
}

/** Raised when the user supplies invalid arguments or input. */
export class UsageError extends AkmError {
  readonly kind = "usage" as const;
  readonly code: UsageErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: UsageErrorCode = "INVALID_FLAG_VALUE", hint?: string) {
    super(msg);
    this.name = "UsageError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? USAGE_HINTS[this.code];
  }
}

/** Raised when a requested resource (asset, entry, file) is not found. */
export class NotFoundError extends AkmError {
  readonly kind = "not-found" as const;
  readonly code: NotFoundErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: NotFoundErrorCode = "ASSET_NOT_FOUND", hint?: string) {
    super(msg);
    this.name = "NotFoundError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? NOT_FOUND_HINTS[this.code];
  }
}

/**
 * Test-isolation guard helper.
 *
 * `src/core/paths.ts` throws `ConfigError("TEST_ISOLATION_MISSING")` under
 * `bun test` when `AKM_BUNDLE_DIR` is set without a paired data-dir or
 * state-dir override. That throw must never be swallowed by best-effort
 * catches around DB/data-dir operations — otherwise the guard's loud failure
 * silently degrades into a "no result" outcome (cold cache, missing snapshot,
 * etc.) and the underlying test leak goes undetected.
 *
 * Call `rethrowIfTestIsolationError(err)` from any catch block that returns
 * a fallback value (null, [], empty result) after touching DB or data-dir
 * paths. It re-throws when the caught error is the guard violation, otherwise
 * does nothing so the existing benign-fallback path can proceed unchanged.
 *
 * Usage:
 *   try {
 *     const db = openDatabase();
 *     // ...
 *   } catch (err) {
 *     rethrowIfTestIsolationError(err);
 *     // existing benign-fallback handling
 *   }
 */
export function isTestIsolationError(err: unknown): boolean {
  return err instanceof ConfigError && err.code === "TEST_ISOLATION_MISSING";
}

export function rethrowIfTestIsolationError(err: unknown): void {
  if (isTestIsolationError(err)) {
    throw err;
  }
}

/**
 * Unreadable-data-dir guard helper — the #791 sibling of the test-isolation
 * pair above, and it exists for the same reason.
 *
 * `DATA_DIR_UNREADABLE` says "this path is there and I am not allowed to read
 * it". It is raised by `assertIndexPathReadable` and friends precisely so a
 * permission fault stops being indistinguishable from "nothing indexed yet".
 * That distinction is destroyed again the moment a best-effort `catch` around
 * the open collapses it into the same `null`/`[]`/`0` the absent case returns —
 * which is how `akm search` came to answer "No search index available. Run
 * 'akm index'" at exit 0 for a populated index sitting right there on disk.
 *
 * Call `rethrowIfDataDirUnreadable(err)` from any catch block that returns a
 * fallback value after touching a data-dir path. Absent stays absent; a fault
 * the operator has to fix keeps travelling.
 */
export function isDataDirUnreadableError(err: unknown): err is ConfigError {
  return err instanceof ConfigError && err.code === "DATA_DIR_UNREADABLE";
}

export function rethrowIfDataDirUnreadable(err: unknown): void {
  if (isDataDirUnreadableError(err)) {
    throw err;
  }
}
