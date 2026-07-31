# Manual Testing Checklist

Use this checklist to exercise akm `v0.9.x` in an isolated sandbox before
cutting a release. Pair it with `testing-workflow.md` and
`test-coverage-guide.md`.

This pass focuses on end-to-end CLI behavior that automated suites do not fully
cover:

- output shaping (`json`, `jsonl`, `text`, `yaml`)
- prompt/usage flows
- migration/error envelopes
- file-system side effects
- newer command surfaces and maintenance flows (`log`, `health`,
  `improve`, `proposal`, `task`, `llm-wiki` bundle format, `env`, `secret`)

Time budget:

- ~35 minutes for the core offline/local pass
- +20 to 30 minutes for the extended current-surface pass in section 17
- +10 to 15 minutes for network-backed source and registry checks
- +10 to 15 minutes for optional agent/LLM-backed `0.9.x` flows

This document was audited against current `0.9.x` behavior on 2026-07-31.

---

## 1. Safety Rules

Every step below assumes a throwaway environment. Do **not** run this against
your real config, real stash, real shell profile, or a globally installed `akm`
you care about.

- [ ] Use a disposable shell session.
- [ ] Isolate `HOME`, all four `XDG_*_HOME` variables, `AKM_CACHE_DIR`,
      `AKM_DATA_DIR`, `AKM_STATE_DIR`, and `AKM_BUNDLE_DIR` under one temp
      directory.
- [ ] Set `AKM_FORCE_SETUP_TMP_STASH=1` to explicitly authorize `akm setup`
      to persist the disposable bundle path. Without it, setup correctly rejects
      transient paths that the OS may reap.
- [ ] Invoke the CLI from this repo (`bun ./src/cli.ts` or the freshly built
      binary from this branch), not a previously installed global `akm`.
- [ ] Only add disposable local paths, test registries, and remotes you control.
- [ ] Do **not** run `akm upgrade` as an install action during manual QA.
      Only use `akm upgrade --check`.
- [ ] Do **not** run `akm completions --install` against your real shell setup.
      In this sandbox it is safe because `HOME` and `XDG_DATA_HOME` are
      isolated, but the default coverage path should still prefer stdout-only
      generation.

If any step would mutate something outside `$AKM_SANDBOX`, stop and fix the
environment before proceeding.

---

## 2. Sandbox Setup

```sh
# 2.1 Build from the current branch
bun install
bun run build

# 2.2 Create a fully isolated environment
export AKM_SANDBOX="$(mktemp -d /tmp/akm-sandbox.XXXXXX)"
export HOME="$AKM_SANDBOX/home"
export XDG_CONFIG_HOME="$AKM_SANDBOX/config"
export XDG_CACHE_HOME="$AKM_SANDBOX/cache"
export XDG_DATA_HOME="$AKM_SANDBOX/data"
export XDG_STATE_HOME="$AKM_SANDBOX/xdg-state"
export AKM_CACHE_DIR="$AKM_SANDBOX/cache-home"
export AKM_DATA_DIR="$AKM_SANDBOX/data-home"
export AKM_STATE_DIR="$AKM_SANDBOX/state-home"
export AKM_BUNDLE_DIR="$AKM_SANDBOX/stash"
export AKM_FORCE_SETUP_TMP_STASH=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$AKM_CACHE_DIR" "$AKM_DATA_DIR" "$AKM_STATE_DIR" "$AKM_BUNDLE_DIR"

# 2.3 Convenience alias for this shell only
alias akm='bun ./src/cli.ts'

# 2.4 Verify isolation
akm setup --yes | jq '.bundleDir'
akm config path --all
```

- [ ] `akm setup --yes` reports a stash path under `$AKM_SANDBOX`.
- [ ] `akm config path --all` reports config, stash, cache, and index/data paths
      under `$AKM_SANDBOX`.

### 2.5 Evidence and execution gates

Record the commit, CLI version, OS/architecture, Bun/Node versions, command,
exit code, and the relevant stdout/stderr or file diff for each failed check.
Do not mark a gated check as passed based only on an automated test or another
platform's prior result.

- [ ] Record `git rev-parse HEAD`, `bun --version`, `node --version`, and
      `uname -a` (or the native Windows equivalent) with the run.
- [ ] Mark a check `N/A` with its missing prerequisite rather than silently
      skipping it.
- [ ] Network checks require a disposable remote or local fixture server.
- [ ] Agent/LLM checks require a configured engine, disposable credentials,
      and an endpoint that permits test traffic.
- [ ] Scheduler checks require the native backend (`cron`, `launchd`, or
      `schtasks`) and a disposable OS account/container/VM.
- [ ] Crash/recovery checks require a disposable process or VM where `SIGKILL`
      and partial-file injection cannot affect real state.

---

## 3. Fixtures

The repo ships pre-built ranking fixtures at `tests/fixtures/stashes/ranking-baseline/`.
Use them as a synthetic stash so search/show output is deterministic.

```sh
# 3.1 Mirror the fixture stash into the sandbox
cp -r tests/fixtures/stashes/ranking-baseline/* "$AKM_BUNDLE_DIR/"
ls "$AKM_BUNDLE_DIR"
```

- [ ] Expected fixture top-level entries exist:
      `agents commands knowledge scripts skills MANIFEST.json`.

Fixture refs worth using throughout this doc:

| Type      | Ref                                   |
|-----------|---------------------------------------|
| skill     | `skills/k8s-deploy`                    |
| skill     | `skills/docker-homelab`                |
| knowledge | `knowledge/incident-response-runbook` |
| agent     | `agents/code-reviewer`                 |
| command   | `commands/release-manager`             |

---

## 4. First-Run Surface

- [ ] `akm info` returns JSON with `schemaVersion`, `version`, `bundleDir`,
      `defaultBundle`, `assetTypes`, `searchModes`, `semanticSearch`,
      `registries`, `sourceProviders`, and `indexStats` (incl. `byType`, a
      per-asset-type breakdown of `entryCount`).
- [ ] `akm config list` emits the `bundles` map and `defaultBundle`; it does not
      emit retired `stashDir`, `sources`, `stashes`, or `installed` config keys.
- [ ] `akm config path --all` returns sandbox-local paths only.
- [ ] `akm help agents` prints non-empty text.
- [ ] `akm help agents --full` prints the extended hint text.
- [ ] `akm help bundle`, `akm help env`, and `akm help task` print the same
      command usage available through each command's `--help` flag.
- [ ] `akm hints` prints the complete agent guide; `akm hints --detail brief`
      prints the short guide.
- [ ] `akm --help` lists the current command surface:
      `setup`, `index`, `health`, `info`, `bundle`, `upgrade`, `search`,
      `curate`, `show`, `workflow`, `remember`, `import`, `sync`, `clone`,
      `registry`, `config`, `feedback`, `log`, `agent`, `lint`, `improve`,
      `proposal`, `help`, `hints`, `completions`, `env`, `secret`, `task`. There is no
      `wiki` command (removed in 0.9.0 in favor of the `llm-wiki` bundle
      format). There are no top-level `init`/`add`/`list`/`remove`/`update`
      commands — see `akm bundle create`/`add`/`list`/`remove`/`update`.
      There is no top-level `mv` (removed outright — plain filesystem move +
      `akm index` + `akm lint`), `history` (folded into `akm health
      --report`), `graph` (summary counts folded into `akm health`), or
      `lessons` (the `lesson` asset type is read/written via
      `akm search`/`akm show`/the proposal queue, not a command group)
      command. There are no top-level `extract`/`propose` commands — see
      `akm proposal extract` / `akm proposal new`.
- [ ] `akm config enable` and `akm config disable` fail as unknown subcommands
      (removed in 0.9.0 — use `akm registry add|remove`).
- [ ] `akm upgrade --check` returns structured version/install-method info and
      does not modify the sandbox or the host install.
- [ ] `akm completions` prints a bash completion script to stdout.
- [ ] `akm completions --install` writes only inside the sandboxed
      `$XDG_DATA_HOME` / `$HOME` tree.

### 4.1 `akm setup` non-interactive paths

- [ ] `akm setup --yes` runs without prompts, writes config with sandbox paths,
      and exits zero.
- [ ] `akm setup --yes | jq '.bundleDir'` returns a path under `$AKM_SANDBOX`.
- [ ] `akm setup --config '{"engines":{"local":{"kind":"llm","endpoint":"http://localhost:1234/v1/chat/completions","model":"test-model"}},"defaults":{"llmEngine":"local"}}'`
      applies the JSON blob non-interactively and exits zero.
- [ ] `akm config get engines.local.endpoint` after the above returns
      `http://localhost:1234/v1/chat/completions`.
- [ ] `akm setup --config 'not-json'` fails with a structured usage error and
      exits non-zero.

---

## 5. Index and Search

- [ ] `akm index --full` reports a non-zero `totalEntries` and successful
      verification.
- [ ] `akm index --verbose` prints phase progress to stderr without corrupting
      stdout JSON.
- [ ] `akm search docker` returns hits under `hits[]`.
- [ ] `akm search docker --format json | jq '.hits | length'` matches the
      visible count.
- [ ] `akm search "code review" --type skill` returns only skill hits.
- [ ] `akm search code --from registry` emits `registryHits[]` and does not
      mix local hits into `hits[]`.
- [ ] `akm search code --from all` emits both `hits[]` and `registryHits[]`.
- [ ] `akm search docker --detail full` includes richer hit fields such as
      `ref`, `score`, optional `origin`, and ranking metadata.
- [ ] `akm search docker --shape agent` includes `ref` plus the smaller
      action-oriented field set.
- [ ] `akm search docker --format jsonl` emits one JSON object per line.
- [ ] `akm search docker --format yaml` is valid YAML and preserves the same
      envelope data.
- [ ] Re-run `akm index` with no flags; incremental indexing succeeds and keeps
      entry count stable.

### 5.1 Scoped memory search

- [ ] Create one scoped memory:
      `akm remember "scoped note" --name scoped-note --user alice --agent claude`.
- [ ] `akm search scoped --filter user=alice` returns the scoped memory.
- [ ] `akm search scoped --filter user=bob` excludes it.
- [ ] Repeating `--filter` AND-joins as documented.

---

## 6. Show

- [ ] `akm show skills/k8s-deploy` returns structured content including
      `type`, `name`, `action`, and `content`.
- [ ] `akm show skills/k8s-deploy --format text` renders a plain-text view that
      includes header/metadata lines plus the body content.
- [ ] `akm show skills/k8s-deploy --shape summary` returns the compact summary
      shape.
- [ ] `akm show skills/k8s-deploy --shape agent` returns the action-oriented
      shape.
- [ ] `akm show knowledge/incident-response-runbook` returns the whole
      document.
- [ ] `akm show knowledge/incident-response-runbook#severity-levels` narrows to
      that section.
- [ ] `akm show knowledge/incident-response-runbook#not-real` fails with
      `ASSET_NOT_FOUND` and lists the available fragment slugs.
- [ ] `akm show knowledge/incident-response-runbook toc` fails with a usage
      error that points at `#fragment`.
- [ ] `akm show skills/does-not-exist` fails with `ASSET_NOT_FOUND`, includes a
      structured JSON envelope on stderr, and exits non-zero.

### 6.1 Scoped show

- [ ] `akm show memories/scoped-note --filter user=alice` resolves the memory.
- [ ] `akm show memories/scoped-note --filter user=bob` fails to resolve it.
- [ ] `akm show memories/scoped-note --scope user=alice` fails loudly (exit 2 —
      `--scope` was removed in 0.9.0, not aliased).

---

## 7. Source Management

For each kind, perform add → list → search → update (where applicable) →
remove. Only use disposable targets.

### 7.1 Filesystem source

- [ ] `mkdir -p "$AKM_SANDBOX/extra-stash" && akm bundle add "$AKM_SANDBOX/extra-stash"`
      succeeds and triggers indexing.
- [ ] `akm bundle list --format json | jq '.sources[]'` includes the new source with a
      filesystem/local kind, path, and writable state.
- [ ] `akm bundle remove "$AKM_SANDBOX/extra-stash"` removes it cleanly.

### 7.2 Git source

- [ ] `akm bundle add github:<owner>/<repo>` against a small disposable public repo.
- [ ] `akm bundle list` shows the git source.
- [ ] `akm bundle update <name>` fetches successfully.
- [ ] `akm search <term-from-repo>` surfaces indexed content from the cloned
      source.
- [ ] `akm bundle remove <name>` cleans it up.

### 7.3 npm source

- [ ] `akm bundle add npm:<small-package>` succeeds.
- [ ] `akm bundle list` shows `kind: "npm"` or equivalent rendered npm source info.
- [ ] `akm bundle remove <name>` succeeds.

### 7.4 Website source

- [ ] `akm bundle add https://example-skills-site.dev --provider website --name docs-site` adds the
      source.
- [ ] `akm bundle list` shows the remote/website source.
- [ ] `akm bundle update docs-site` either refreshes it successfully or returns a
      structured non-updatable error that matches current behavior.

### 7.5 Writable rejection

- [ ] Edit `$XDG_CONFIG_HOME/akm/config.json` to set `"writable": true` on a
      `npm` or `website` source.
- [ ] `akm bundle list` fails with a `ConfigError` and actionable hint.
- [ ] Revert the edit; `akm bundle list` succeeds again.

---

## 8. Write Commands

These cover the shared write-target path and git-backed save behavior.

### 8.1 remember

- [ ] `akm remember "test memory body" --name test-memory` writes a plain
      memory.
- [ ] `akm show memories/test-memory` resolves it.
- [ ] `akm remember "another" --name test-2 --description "desc" --tag foo --tag bar`
      persists `description` and both tags in frontmatter.
- [ ] `echo "stdin body" | akm remember --name from-stdin` reads from stdin.
- [ ] `akm remember "vpn note" --name expiring --tag ops --expires 30d --source "skills/k8s-deploy"`
      persists frontmatter with `tags`, `expires`, and `source`.
- [ ] `akm remember "Found curl pipe" --name auto-note --auto` succeeds;
      heuristic tags may be absent when no signal is found.
- [ ] `akm remember "Long meeting notes" --name enrich-note --enrich` either
      enriches successfully when LLM config exists or fails in a documented,
      structured way without a stack trace.
- [ ] `akm remember "scope only" --name scoped-only --user alice --run run-42`
      succeeds without tags and persists scope frontmatter.

### 8.2 remember target resolution

- [ ] Add a second filesystem source:
      `mkdir -p "$AKM_SANDBOX/alt" && akm bundle add "$AKM_SANDBOX/alt"`.
- [ ] Confirm the source name via `akm bundle list --format json`.
- [ ] `akm remember "to alt" --name alt-mem --bundle <source-name>` writes to
      that source.
- [ ] `akm remember "x" --name y --bundle nonexistent` fails with
      `INVALID_FLAG_VALUE`.

### 8.3 defaultWriteTarget

- [ ] `akm config set defaultWriteTarget <source-name>` succeeds.
- [ ] `akm config get defaultWriteTarget` reads it back.
- [ ] `akm remember "via default" --name via-default` lands in that target.
- [ ] `akm config unset defaultWriteTarget` removes it.

### 8.4 import

- [ ] Create `$AKM_SANDBOX/incoming.md` with a heading and body.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --name imported-doc` writes a
      knowledge file into the default write target.
- [ ] `akm import - --name stdin-doc < "$AKM_SANDBOX/incoming.md"` works from
      stdin.
- [ ] `akm import http://127.0.0.1:<port>/docs/guide` fetches one URL and writes
      converted markdown into `knowledge/` using a URL-path-derived name.
- [ ] `akm import "$AKM_SANDBOX/incoming.md" --name to-alt --target <source-name>`
      lands in the alternate target.
- [ ] `akm import does-not-exist.md --name broken` fails cleanly with a
      structured usage error and no stack trace.

### 8.5 sync

- [ ] `akm sync --format json` on the primary sandbox stash returns either a
      commit result or a structured `skipped: true` no-op if the stash is not a
      git repo.
- [ ] If `akm setup` created a git repo, modify one file in the sandbox stash
      and run `akm sync -m "Manual QA sync test"`; verify it commits only inside
      the sandbox repo.
- [ ] Add a second git-backed sandbox source with an explicit slash-containing
      name (for example `team/sync-qa`), confirm that exact name via
      `akm bundle list --format json`, then run
      `akm sync team/sync-qa -m "Manual QA named sync"`
      and verify the commit lands in that repo, not the primary stash.
- [ ] If the named source is literally `json`, `akm sync json --format json`
      still saves that named stash; `akm sync --format json` with no positional
      still saves the primary stash.
- [ ] Do not point `akm sync` at any real repo or writable remote outside the
      sandbox.

---

## 9. Curate and Clone

- [ ] `akm curate "review this PR for security issues"` returns
      `{items, query, summary}`.
- [ ] `akm curate "review code" --format json | jq '.items | length'` is
      non-zero.
- [ ] `akm curate ""` now fails with `MISSING_REQUIRED_ARGUMENT` rather than
      returning ranked filler results.
- [ ] `akm clone skills/k8s-deploy --dest "$AKM_SANDBOX/clone-target"` copies the
      asset to the requested destination.
- [ ] `akm clone skills/k8s-deploy --name qa-copy --dest "$AKM_SANDBOX/clone-target"`
      renames the cloned output.
- [ ] `akm clone skills/does-not-exist --dest "$AKM_SANDBOX/clone-doomed"` fails
      with `ASSET_NOT_FOUND`.

---

## 10. Registry

These steps need network access.

- [ ] `akm registry list` shows the configured registries.
- [ ] `akm search docker --from registry --detail full` returns registry hits
      with `installRef` and score.
- [ ] `akm search docker --from registry --assets` includes asset-level
      matches if the provider supports them.
- [ ] `akm registry add https://registry.example/index.json --name test-reg`
      adds a test registry, `akm registry list` shows it, and
      `akm registry remove test-reg` removes it.
- [ ] `akm registry add http://registry.example/index.json` fails unless
      `--allow-insecure` is supplied.
- [ ] `akm registry add http://registry.example/index.json --allow-insecure`
      succeeds with a warning on stderr.
- [ ] Installing a hit still happens through `akm bundle add <installRef>`; there is
      no `registry add-kit` subcommand.

Building a registry index is a publisher/maintainer flow and is no longer a CLI
subcommand — it lives in `scripts/build-registry-index.ts`. Run it only in an
isolated working directory with disposable output paths.

---

## 11. Workflow

Workflows now include authoring, validation, execution, and recovery flows.

- [ ] `akm workflow list` is empty in a fresh sandbox.
- [ ] `akm workflow create test --print > "$AKM_BUNDLE_DIR/workflows/test.md"`
      prints a valid starter document without creating the workflow; the raw
      template includes `steps` frontmatter, an H1, preamble prose, and matching
      `## first-step` / `## second-step` sections.
- [ ] `akm workflow create test-created --from "$AKM_BUNDLE_DIR/workflows/test.md"`
      writes and indexes the workflow, confirming intro prose is accepted.
- [ ] `akm lint --type workflows` reports no `invalid-workflow-structure`
      finding for `workflows/test-created`.
- [ ] `akm workflow start workflows/test-created` returns a run with `id`,
      `workflowRef`, and steps.
- [ ] `akm workflow status <run-id>` returns the full run state.
- [ ] `akm workflow status workflows/test-created` resolves the most recent run
      for that ref.
- [ ] `akm workflow next workflows/test-created` returns the current actionable
      step. If no active run exists, it may auto-start one.
- [ ] `akm workflow complete <run-id> --step <step-id> --state blocked --notes "waiting"`
      marks the step blocked.
- [ ] `akm workflow resume <run-id>` flips the blocked run back to active.
- [ ] `akm workflow complete <run-id> --step <step-id> --state completed --summary "work completed" --notes "done"`
      succeeds after resume.
- [ ] `akm workflow create bad-name!` fails with a structured usage error.
- [ ] `akm workflow create test-created --force` fails unless paired with
      `--from` or `--reset`.

---

## 12. LLM Wiki (bundle format, no dedicated command family)

**[0.9.0 change]** The `akm wiki` command family (`list`/`create`/`show`/
`pages`/`search`/`stash`/`lint`/`ingest`/`remove`) was removed in the
0.9.0 bundle-adapter cutover. A wiki is now a plain bundle recognized
deterministically at install/index time by the `llm-wiki` adapter — a bundle
component whose root holds `schema.md` plus a `pages/` directory. There is
no `akm wiki` subcommand to test; verify the adapter surface instead:

- [ ] A directory with `schema.md` + `pages/<page>.md` + `raw/<source>.md`,
      registered as a `bundles` entry (or installed via `akm bundle add`), is
      recognized as an `llm-wiki` component on `akm index --full` — no
      manual registration step beyond the normal bundle config/install.
- [ ] `akm search <term-from-a-page>` returns the page as a hit (its `type`
      is the page's `pageKind`, default `note`, not `wiki`).
- [ ] `akm search <term-from-a-raw-source>` also returns a hit — `raw/**.md`
      files are indexed as first-class `wiki-source` documents, not just
      structural inputs.
- [ ] `akm show <bundle>//pages/<page-slug>` renders the page with the
      standard `akm show` machinery (`#fragment` section addressing, not the
      removed `toc`/`section`/`lines`/`frontmatter` view-mode grammar).
- [ ] `akm show <bundle>//raw/<slug>` renders the raw source directly.
- [ ] Page writes (create/append/xref/log) use the agent's native file-write
      tools, not an akm command — akm's role here is recognition and
      discovery only. No LLM calls or network access happen anywhere in this
      surface.

See [Wikis](../../guides/wikis.md) for the full page/raw/schema model.

---

## 13. Env and Secret

Env and secret surfaces are intentionally strict about not printing values.
Confirm that guarantee carefully.

- [ ] `akm env list` is empty initially.
- [ ] `akm env create test-env` creates `env/test-env.env`.
- [ ] Edit the file directly: `printf 'API_KEY=secret-value\n' >> "$AKM_BUNDLE_DIR/env/test-env.env"`.
- [ ] `akm show env/test-env` lists key names only; it exposes neither values
      nor comment text.
- [ ] `akm env list --format json` contains the env under `envs[]` with
      `keys` and no secret values.
- [ ] `akm env path env/test-env` prints the absolute env file path and not the
      secret values.
- [ ] `akm env run env/test-env -- bash -lc 'test "$API_KEY" = "secret-value"'`
      injects values into the subprocess environment.
- [ ] `printf '%s' "token-value" | akm secret set secrets/test-token` succeeds.
- [ ] `akm secret list --format json` contains `secrets/test-token` with only path
      output.
- [ ] `akm secret run secrets/test-token CI_TOKEN -- bash -lc 'test "$CI_TOKEN" = "token-value"'`
      injects only that variable.
- [ ] `akm secret path secrets/test-token` and `akm secret remove secrets/test-token`
      both exit 2 with `Unknown command` (removed in 0.9.0).
- [ ] Remove the `API_KEY=` line directly from `env/test-env.env` and confirm
      `akm env list --format json` no longer lists it under `keys`.
- [ ] `rm "$AKM_BUNDLE_DIR/secrets/test-token"` removes the secret (there is no
      `akm secret remove`).

---

## 14. Feedback, History, and Log

These are core auditability flows to validate in `0.9.x`.

- [ ] `akm feedback skills/k8s-deploy --positive` succeeds.
- [ ] `akm feedback skills/k8s-deploy --negative --reason "not specific enough"`
      succeeds.
- [ ] `akm feedback` with no ref fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm feedback skills/k8s-deploy --positive --negative` fails with a
      structured usage error.
- [ ] `akm log` shows appended mutation events.
- [ ] `akm log --type feedback --ref skills/k8s-deploy` filters correctly.
- [ ] `akm log --since 2026-01-01T00:00:00Z --format jsonl` emits one JSON
      object per line.

---

## 15. Proposal Queue and Agent-Backed Commands

These require configured engines and, for `distill`, an LLM engine.
Run only inside the sandbox.

### 15.1 Proposal queue (no external agent required if seeded by prior steps)

- [ ] `akm proposal list` returns a structured queue view.
- [ ] `akm proposal list --status pending` filters correctly.
- [ ] If any proposal exists, `akm proposal show <id>` renders metadata/body.
- [ ] If any proposal exists, `akm proposal diff <id>` renders the pending delta.
- [ ] If any valid proposal exists, `akm proposal accept <id>` promotes it
      through the normal write-target path and emits the expected mutation
      result without a stack trace.
- [ ] `akm proposal reject <id> --reason "manual qa"` archives it cleanly.

### 15.2 improve / proposal new

- [ ] `akm improve skills/k8s-deploy --task "tighten the description"` either
      queues a proposal successfully or fails with a structured config/usage
      envelope if no engine is configured.
- [ ] `akm proposal new skill qa-generated-skill --task "simple review helper"`
      either queues a proposal successfully or fails structurally if the agent
      runtime is not configured.
- [ ] Any successful `improve` emits a `improve_invoked` event.

### 15.3 improve / lesson

- [ ] `akm improve skills/k8s-deploy` returns `outcome: "skipped"` when
      `improve.strategies.default.processes.distill.enabled` is
      `false`, or queues a lesson proposal when enabled.
- [ ] `akm improve skills/k8s-deploy --dry-run --strategy quick --limit 1`
      returns a plan without modifying bundle files or queue entries.
- [ ] `akm improve skills/k8s-deploy --target nonexistent --dry-run` fails with
      `INVALID_FLAG_VALUE` and points to the renamed `--bundle` flag.
- [ ] Any successful `improve` emits a `improve_invoked` event.

---

## 16. Config and Migration

- [ ] `akm config list` reports current state.
- [ ] `akm config set engines.default '{"kind":"llm","endpoint":"http://localhost:1234/v1/chat/completions","model":"qwen3"}'`
      persists the whole named LLM engine entry.
- [ ] `akm config set engines.default.endpoint http://localhost:1234/v1/chat/completions`
      updates the subkey.
- [ ] `akm config get engines.default.endpoint` reads it back.
- [ ] `akm config unset engines.default.apiKey` removes the subkey cleanly.
- [ ] `akm config set defaultWriteTarget <source-name>` now works.
- [ ] `akm help migrate 0.6.0` prints bundled migration notes.
- [ ] `akm help migrate v0.6.0-rc1` normalizes to the stable note.
- [ ] `akm help migrate latest` prints the newest release guidance.
- [ ] `akm help migrate 9.9.9` prints a graceful fallback listing available
      notes.

### 16.1 Legacy config rejection

- [ ] Replace `$XDG_CONFIG_HOME/akm/config.json` with one using legacy
      `stashes[]`.
- [ ] `akm bundle list` fails with a structured `INVALID_CONFIG_FILE` error
      directing the operator to migrate the retired shape to `bundles`.
- [ ] Restore a valid config before continuing.

### 16.2 Retired provider rejection

- [ ] Inject a bundle entry with an `openviking` descriptor instead of exactly
      one supported descriptor (`path`, `git`, `website`, or `npm`).
- [ ] `akm bundle list` fails with a structured `INVALID_CONFIG_FILE` error;
      OpenViking is not accepted as a source provider.
- [ ] Remove it; normal commands work again.

### 16.3 New 0.8.0 surfaces

These cover surfaces introduced in 0.8.0 that previous revisions of this
checklist did not exercise.

#### `akm health` exit codes

- [ ] `akm health` on a healthy install exits 0 and emits a JSON envelope with
      `ok: true`.
- [ ] Point `AKM_DATA_DIR` at a fresh sandbox directory and run `akm health`;
      it initializes `state.db`, performs schema/round-trip checks, and does not
      report the initially absent database as corruption.
- [ ] `akm health --since 24h` filters telemetry to the last 24 hours.

#### `akm migrate` recovery

- [ ] With no config file, `akm migrate status` reports `status: "blocked"`,
      includes the missing source and target config states, exits nonzero, and
      does not create one.
- [ ] With a valid 0.9 config, `akm migrate status` reports `status: "current"`
      and leaves the file byte-for-byte unchanged.
- [ ] With a pre-0.9 profile config and no target, `akm migrate status` reports
      `status: "blocked"`, explains that profile-to-engine conversion is manual,
      exits nonzero, and does not rewrite or back up the file.
- [ ] `akm migrate apply --config <prepared> --dry-run` performs the same checks
      as status and leaves config and databases unchanged.
- [ ] `akm migrate apply --config <prepared>` creates a unique verified backup
      run, applies each pending database migration transactionally, and installs
      the prepared config last.
- [ ] A current config with pre-cutover databases is reported as mixed state and
      can be completed with the same prepared-config command.
- [ ] The 0.8-to-0.9 operator documentation does not claim the installed 0.8
      binary enforces a new guard. It directs the operator to make an independent
      backup, install/stage 0.9 manually, and invoke the new binary's migrate
      apply command.
- [ ] A 0.9+ future `akm upgrade --migration-config <prepared>` passes the target
      only to the installed binary's apply command; the current binary's status
      preflight receives no future config path.
- [ ] A standalone future upgrade runs both current-binary status without the
      future config and staged-binary status with it before replacement. Make
      staged status fail and verify the old executable remains byte-identical.
- [ ] Hold canonical state and workflow handles, then run migrate apply. It
      refuses before creating a backup and names the active maintenance blocker.
- [ ] SIGKILL apply after state, workflow, and config phases. Canonical opens
      fail closed, status reports the retained phase without mutation, and the
      next apply completes one current generation.
- [ ] Leave a prepared restore journal with a published database and quarantined
      predecessor. Config/database access refuses before accepting writes or
      recreating an absent peer database; apply recovers the journal first.
- [ ] Inject a crash after each prepared rollback destination, stage, sidecar,
      and pre-journal-delete boundary. Every retry authenticates the original
      fingerprint and completes; substituting a same-ledger database fails closed.
- [ ] Substitute a same-ledger database after an apply phase is journaled. Status,
      resume, and rollback reject the exact-generation mismatch without replacing
      the substituted file.
- [ ] SIGKILL immediately after each durable state/workflow/config mutation but
      before journal advancement. The operation marker or exact config target is
      recognized as one adjacent generation and apply resumes successfully.
- [ ] SIGKILL after rollback restore commits but before apply-journal deletion.
      The next apply authenticates the backup generation, removes the stale apply
      journal, and leaves restored artifacts byte-identical.
- [ ] Populate more than 100 active workflow leases/claims. Restore reports a
      capped sample plus an additional-blockers marker; it never materializes the
      unbounded result set.
- [ ] Use a valid prepared config just below the config read cap whose expanded
      target makes the apply journal exceed its cap. Apply rejects before writing
      the journal or mutating config/databases.
- [ ] `AKM_NO_AUTO_MIGRATE=1 akm config list` behaves exactly like the command
      without that retired variable: legacy config is rejected and disk is not
      modified.

#### Task `.md` → `.yml` migration verification

- [ ] Drop a pre-0.8.0 `.md` task with YAML frontmatter into
      `<stash>/tasks/<id>.md`. `akm search --type task` does **not** show it.
- [ ] Convert it to `<stash>/tasks/<id>.yml`. `akm search --type task` shows it.
- [ ] `akm show tasks/<id>.md` strips the suffix and resolves to the `.yml`
      file; missing `.yml` yields a structured "task not found", not a parse
      error.
- [ ] With `<stash>/tasks/legacy-check.md` present,
      `akm task add legacy-check --schedule '@daily' --command 'true' --disabled`
      fails with `RESOURCE_ALREADY_EXISTS`, writes no `.yml`, and makes no
      scheduler change; adding `--force` is required to proceed.

#### secret set --from-env / stdin behavior

`env` has no per-key write command (0.9 removed `env set`/`env unset` — you
edit the `.env` file directly and akm loads it; see the env-cli.ts model
statement). `secret set` still writes one secret at a time and keeps its
--from-env / stdin surface:

- [ ] `printf '%s' "secret" | akm secret set secrets/prod` writes via
      stdin.
- [ ] `AKM_VAL=secret akm secret set secrets/prod --from-env AKM_VAL`
      writes from the named env var; unset var exits with code 2.
- [ ] Piping a payload > 5 MB to `akm secret set` is rejected with a
      `UsageError`.

#### Proposal resolution by ref or UUID prefix

- [ ] `akm proposal accept <full-uuid>` works (regression check).
- [ ] `akm proposal accept <8-char prefix>` works.
- [ ] `akm proposal accept memories/my-note` resolves the pending proposal by ref.
- [ ] `akm proposal reject` / `akm proposal diff` accept the same forms.

#### Write-target flag uniformity

- [ ] `akm remember "note" --bundle <stash>` writes to the named target.
- [ ] `akm import ./file.md --target <stash>` writes to the named target.
- [ ] Legacy `--stash` on any of the above is rejected with a structured
      usage error.

---

## 17. Extended Current-Surface Pass

These checks cover current behavior that the original core pass did not reach.
They are deterministic and Linux-safe in the sandbox unless a check is
explicitly marked as gated.

### 17.1 Bundle identity and precedence

- [ ] Add two writable filesystem bundles named `precedence-a` and
      `precedence-b`, then write `memories/shared` with different bodies to
      each using `akm remember ... --bundle <name>`.
- [ ] `akm show precedence-a//memories/shared` and
      `akm show precedence-b//memories/shared` return the corresponding bodies;
      the fully qualified identity is preserved in each result.
- [ ] `akm show memories/shared` follows `defaultBundle` and installation
      precedence rather than selecting a random duplicate.
- [ ] `akm bundle list --kind filesystem` includes both bundles and no
      non-filesystem entries; `akm bundle show precedence-a` returns only its
      resolved descriptor and component state.

### 17.2 Write fidelity and correction metadata

- [ ] `akm remember "linked body" --name linked --path qa --xref skills/k8s-deploy`
      writes `memories/qa/linked.md` with `type`, `updated`, and one canonical
      `xrefs` entry while preserving the body bytes.
- [ ] Repeating the same write without `--force` fails with
      `RESOURCE_ALREADY_EXISTS`; adding `--force` replaces only that asset.
- [ ] Import a Markdown file containing custom nested frontmatter with
      `--xref skills/k8s-deploy`; the custom fields and body survive and the
      new `updated`/`xrefs` fields are merged without a nested frontmatter block.
- [ ] Write a correction using `--supersedes memories/test-memory`; the new
      asset links the old ref, and the old asset gains `beliefState:
      superseded` plus `supersededBy` without losing unrelated frontmatter.
- [ ] `akm search memory --type memory --belief current` returns the correction
      and hides the superseded asset; `--belief all` can return both.

### 17.3 Output formats and destinations

- [ ] `akm show skills/k8s-deploy --format md --output "$AKM_SANDBOX/show.md"`
      writes Markdown to the file and emits no result payload on stdout.
- [ ] `akm health --report --format html --output "$AKM_SANDBOX/health.html"`
      writes HTML containing the full report dataset.
- [ ] `akm info --format text` is plain key/value text, not JSON wearing a
      text flag.
- [ ] `akm search docker --shape summary` fails with `INVALID_SHAPE_VALUE` and
      exit 2 because `summary` is valid only for `show`.
- [ ] `akm env path env/test-env --format yaml` still prints one raw path and
      warns on stderr that this command is format-exempt.
- [ ] `akm search docker --format jsonl --output "$AKM_SANDBOX/ignored"`
      continues to stream JSONL to stdout and does not create the output file.

### 17.4 Lint and task schema

- [ ] In a disposable lint-only directory, create one frontmatter-bearing
      memory without `updated`; `akm lint --dir <dir> --fail-on-flagged` reports
      `missing-updated` and exits 1.
- [ ] `akm lint --dir <dir> --auto-fix` stamps `updated`, reports the issue as
      fixed, and a subsequent `--fail-on-flagged` run exits 0.
- [ ] `akm task doctor` reports the native backend, executable binding, log
      directory, and supported schedule subset without modifying the scheduler.
- [ ] Hand-write a disabled command-only `tasks/manual-run.yml`, then run
      `akm task run manual-run`; manual execution succeeds and
      `akm task history --id manual-run --limit 1` records the attempt.
- [ ] `akm task add invalid --schedule '@daily' --command true --prompt text`
      fails before writing or touching the scheduler because exactly one target
      is required.

### 17.5 Env lifecycle and filtering

- [ ] Seed a dedicated fixture with
      `printf 'API_KEY=secret-value\nSECOND_KEY=second-value\n' | akm env create extended-env --from-stdin`.
- [ ] `akm env export env/extended-env --out "$AKM_SANDBOX/extended-env.sh"`
      writes a mode-0600 shell file, prints no values, and safely single-quotes
      values.
- [ ] Run `akm env run env/extended-env --only API_KEY -- bash -lc 'test
      "$API_KEY" = secret-value && test -z "$SECOND_KEY"'`; it exits 0.
- [ ] `akm env run env/extended-env --only API_KEY --except SECOND_KEY -- true`
      fails with `INVALID_FLAG_VALUE` because the filters are mutually
      exclusive.
- [ ] Create a sensitive env from stdin; `akm env list` and normal search omit
      it, while `akm env path` can still resolve it.
- [ ] `akm env remove env/extended-env --yes` removes the env and any sensitive
      marker through the normal write boundary.

### 17.6 Tracking and durable log cursors

- [ ] Record tagged feedback with `--tag slice:manual --tag team:qa`, then inspect
      it with `akm log --include-tags slice:manual --limit 1 --detail full`; the
      event contains its numeric id, both tags, and structured feedback metadata.
- [ ] `akm log --exclude-tags slice:manual --detail full` excludes that event.
- [ ] Copy the event's numeric `id` and run `akm log --since @offset:<id>`;
      only later events are returned, proving the cursor survives a new process.
- [ ] Capture the latest event id, run
      `akm show skills/k8s-deploy --no-track-usage`, and verify no later usage
      event was appended for that read.
- [ ] `akm log --run <run-id>` returns only events whose metadata belongs to
      that workflow run.

### 17.7 Workflow terminal transitions and engine gate

- [ ] Copy `.run.id` from `akm workflow start`, then run
      `akm workflow list --active --ref workflows/test-created`; it returns only
      active runs for the normalized fully qualified ref. `akm workflow status
      <run-id> --units` includes a `units` collection without changing run state.
- [ ] `akm workflow abandon <run-id>` marks the run failed and removes it from
      `workflow list --active`; `akm workflow resume <run-id>` reopens it.
- [ ] Starting the same workflow again without `--force` fails with
      `RESOURCE_ALREADY_EXISTS`; `--force` creates a distinct parallel run.
- [ ] With `experimental.workflowEngine` unset/false, `akm workflow brief
      <run-id>`, `akm workflow run <run-id>`, and `akm workflow report <run-id>`
      fail with the documented config gate before acquiring an engine lease or
      changing the run.
- [ ] With the experiment enabled, `workflow brief`/`report` require a
      compatible seeded workflow and disposable run. Record the exact brief,
      report command, unit state, and terminal status. `workflow run` additionally
      requires a configured runner/engine.

### 17.8 Proposal dry-runs and archive lifecycle

- [ ] `akm proposal list --queue <source-name> --status pending --type memory`
      applies every filter without mutating the queue. Use an actual configured
      source name from `akm bundle list`; omit `--queue` for the default queue.
- [ ] `akm proposal accept --generator distill --dry-run` and
      `akm proposal reject --generator distill --reason "manual qa" --dry-run`
      require no prompt, report only matching proposals, and leave statuses
      unchanged.
- [ ] `akm proposal drain --policy manual --dry-run` reports accept/reject/defer
      decisions without writing assets or queue state.
- [ ] For an accepted update proposal with a backup,
      `akm proposal revert <full-uuid>` restores the exact prior bytes and
      changes archive status to `reverted`; a new-asset proposal without a
      backup fails structurally.

### 17.9 Setup bootstrap and config recovery

Run these in a second fully isolated sandbox so they cannot disturb the main
checklist state.

- [ ] `akm setup --from <valid.json> --yes --dir <new-bundle> --no-init`
      writes the requested config but does not scaffold `<new-bundle>`.
- [ ] The equivalent YAML bootstrap produces the same normalized config.
- [ ] Passing both `--from` and `--config` fails with `INVALID_FLAG_VALUE`
      before writing config.
- [ ] A malformed bootstrap file fails with `INVALID_CONFIG_FILE`, leaves any
      existing config byte-for-byte unchanged, and prints no stack trace.
- [ ] `akm config set semanticSearchMode auto --silent` and the matching
      `config unset semanticSearchMode --silent` modify config while leaving
      stdout empty.

### 17.10 Source limits and install safety

- [ ] Add a disposable local bundle containing an env file with `LD_PRELOAD` or
      `NODE_OPTIONS`; non-interactive `akm bundle add` blocks with
      `DANGEROUS_ENV_KEY`, rolls back the config entry, and emits no success
      envelope. `--allow-insecure` is required to bypass after review.
- [ ] **Network-gated:** add a controlled website with
      `--max-pages 2 --max-depth 1`; persisted `bundles.<name>.website` contains
      numeric values for both limits and the crawl does not exceed either bound.
- [ ] **Network-gated:** `akm bundle update <name> --force` refreshes the
      controlled remote; `bundle update --all` reports each processed bundle
      independently and does not alter filesystem-only bundles.
- [ ] **Network-gated:** provider `--options` accepts a JSON object and rejects
      malformed JSON or non-object JSON with a structured usage error.

### 17.11 Platform and credential gates

- [ ] **Agent/LLM-gated:** run `akm agent`, `proposal new`, `proposal extract`,
      and a non-dry-run `improve` with disposable credentials. Verify timeout,
      redaction, proposal provenance, and no credential text in logs/output.
- [ ] **Linux scheduler:** in a disposable container/account, `task add`,
      `sync`, scheduled execution, history, disable-by-file-edit, and removal
      operate only on the test crontab.
- [ ] **macOS scheduler:** repeat the scheduler lifecycle on launchd and retain
      generated plist plus `launchctl` evidence.
- [ ] **Windows scheduler:** repeat on `schtasks` and retain generated XML plus
      scheduler query evidence.
- [ ] **Runtime/release:** execute the packaged CLI on supported Node versions,
      the standalone binary matrix, npm upgrade path, semantic-search gate, and
      Docker install matrix. Record artifact digests and exact release commit.
- [ ] **Crash/recovery:** execute migration kill-point and rollback-journal cases
      only in the dedicated disposable recovery harness described in 16.3.

---

## 18. Error Handling

Spot-check that failures always arrive as structured JSON on stderr with
`{ok:false, error, code?, hint?}` and exit non-zero.

- [ ] `akm search` with no query browses indexed assets rather than failing or
      returning relevance-ranked filler for an invented query.
- [ ] `akm curate ""` fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm show foo` treats `foo` as a valid short concept id and fails with
      `ASSET_NOT_FOUND` when no such asset exists.
- [ ] `akm config set sources weird-thing` fails with a structured JSON/usage
      error.
- [ ] `akm help migrate` with no version fails with `MISSING_REQUIRED_ARGUMENT`.
- [ ] `akm workflow next definitely-not-a-run-id` fails structurally and does
      not dump a stack trace.
- [ ] `akm env path missing-env` fails with `ASSET_NOT_FOUND` or the
      current typed not-found envelope.

If any failure prints a bare stack trace, that is a regression.

---

## 19. Format Round-Trip

Confirm representative commands are parseable as JSON/YAML/JSONL.

```sh
akm bundle list --format json | jq -e . > /dev/null
akm search docker --format json | jq -e . > /dev/null
akm show skills/k8s-deploy --format json | jq -e . > /dev/null
akm info --format json | jq -e . > /dev/null
akm config list --format json | jq -e . > /dev/null
akm curate "review code" --format json | jq -e . > /dev/null
akm log --ref skills/k8s-deploy --format json | jq -e . > /dev/null
```

- [ ] All representative `--format json` commands parse successfully.
- [ ] At least one `search`/`log` path is verified with `--format jsonl`.
- [ ] At least one `info`/`show` path is verified with `--format yaml`.

---

## 20. Sandbox Cleanup

```sh
rm -rf "$AKM_SANDBOX"
unset AKM_SANDBOX HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR AKM_BUNDLE_DIR AKM_FORCE_SETUP_TMP_STASH
unalias akm
```

- [ ] Cleanup succeeds without errors.
- [ ] Real config (`~/.config/akm`), real shell completion dirs, and any real
      globally installed `akm` remain untouched.

---

## When to Run This

- **Before tagging a release**: full pass.
- **After CLI-surface changes**: sections 4, 5, 6, 17, 18, and 19 minimum.
- **After write-path or git-path changes**: sections 7, 8, 11, 12, 13, 15,
  and 17.1-17.2.
- **After runtime/dependency changes**: sections 5, 10, 14, 17.11, and 19.

Record results in `docs/migration/release-notes/<version>.md` under a
"Manual QA" subsection when the release includes user-visible changes.
