// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Commands whose output is not an envelope, and therefore not formattable (D7).
 *
 * D7 makes all six `--format` values work on every command that renders through
 * `output()`. A small set does not render an envelope at all: they emit a shell
 * script, drive an interactive prompt, hand stdout to a child process, or print
 * a document that IS the payload. Passing `--format` to one of those cannot do
 * anything useful.
 *
 * The point of declaring the set here is that the exemption stops being
 * implicit. Before D7 you discovered it by getting JSON when you asked for
 * Markdown, or an exit 2 when you asked for HTML. Now the list is one grep away,
 * it is documented in `STABILITY.md`, and asking for a format on an exempt
 * command warns instead of silently doing something else.
 *
 * Names are the top-level command token, so a group name covers its
 * subcommands (`completions`); where only one subcommand is exempt the entry is
 * the space-joined pair the invocation actually starts with.
 */

/**
 * Top-level command tokens whose entire surface is format-exempt.
 */
const EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  // Emits shell completion script source for eval.
  "completions",
  // Interactive wizard: prompts and progress, not a result envelope.
  "setup",
  // Hands stdout to a child process; the child's output is not ours to shape.
  "agent",
  // Both subcommands (`status`, `apply`) are also a child-process passthrough:
  // `runMigrationTool` (src/commands/migration-tool.ts) spawns the standalone
  // `scripts/akm-migrate.ts` tool and writes its stdout/stderr verbatim — the
  // spawned script always emits its own fixed JSON shape and never consults
  // `--format`. Found while verifying F1 (D7 B1): the finding's repro list
  // named `akm migrate status --format text` alongside `secret list` as the
  // SAME defect (missing text renderer inside `output()`), but `migrate
  // status`/`apply` never reach `output()` at all, so that fix cannot and
  // does not change their behavior — this is the `env run`/`secret run`
  // passthrough pattern, not the generic-text-fallback one.
  "migrate",
  // Document payload, exactly like `workflow template` / `help migrate`
  // below: prints the embedded CLI-reference guide verbatim
  // (`src/commands/observability-cli.ts`), not a result envelope.
  "hints",
]);

/**
 * `<command> <subcommand>` pairs that are exempt while the rest of the group
 * formats normally.
 */
const EXEMPT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // Child-process passthrough (the env/secret groups otherwise format fine).
  "env run",
  "secret run",
  // Document payloads: the document is the output, not a field within one.
  "workflow template",
  "help migrate",
  // B3/B4 (W1-F): a bare absolute filesystem path IS the payload — the
  // documented shell-substitution primitive (`$(akm env path <ref>)`,
  // Docker `_FILE` / `--env-file`) — not a field worth wrapping in an
  // envelope. Wrapping it broke every existing substitution silently: the
  // CLI's default format is `json`, so an un-flagged `akm env path <ref>`
  // (exactly how the substitution is always written) started emitting
  // `{"path":"..."}` instead of the raw path. Unlike `config path`, this
  // command has no `--all`-style multi-field variant, so the whole surface
  // can be exempt without wrongly warning on a real envelope case.
  "env path",
]);

/**
 * True when `--format` cannot meaningfully apply to this invocation.
 *
 * `command` is the top-level token; `subcommand` the next positional when there
 * is one.
 */
export function isFormatExemptCommand(command: string | undefined, subcommand?: string): boolean {
  if (command === undefined) return false;
  if (EXEMPT_COMMANDS.has(command)) return true;
  return subcommand !== undefined && EXEMPT_SUBCOMMANDS.has(`${command} ${subcommand}`);
}

/** The declared exempt set, for docs generation and tests. */
export function formatExemptSurfaces(): { commands: readonly string[]; subcommands: readonly string[] } {
  return { commands: [...EXEMPT_COMMANDS], subcommands: [...EXEMPT_SUBCOMMANDS] };
}
