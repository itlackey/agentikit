# Tests Directory Review

Review date: 2026-07-26

## Scope And Method

This was a read-only review of the `tests/` tree, test runners, test helpers,
fixtures, release scripts, CI configuration, and the relevant production code
needed to validate test claims. Seven read-only explore agents were dispatched
in parallel for organization, duplication, assertion value, runtime, isolation,
runner/fixture design, and broad quality review. No tests were changed, and no
test or source files were modified.

Inventory from the tracked tree:

- 596 tracked `*.test.ts` files.
- 225 files are selected by the unit runner; 371 are selected by the integration runner.
- 78 test files sit directly under `tests/`.
- `tests/integration/` has 237 test files at its root and 134 below subdirectories.
- `tests/integrations/` has 3 test files, but is not selected by the integration runner.
- Fixture namespaces contain 5 executable test files: 4 under `tests/_fixtures/` and 1 under `tests/fixtures/`.

Severity means:

- **High**: can make a green test run materially misleading, or violates the documented default test contract.
- **Medium**: creates meaningful flake, maintenance, classification, or coverage risk.
- **Low**: mainly reduces discoverability or adds avoidable maintenance cost.

## Executive Summary

The main structural problem is that directory names and runner boundaries do not
agree. The unit runner treats everything outside the singular
`tests/integration/` directory as unit scope, while documentation says that
`tests/commands/` and `tests/workflows/` are integration scope. This leaves a
plural `tests/integrations/` directory, fixture directories containing runnable
tests, real package installation work in the unit target, and a default unit
suite containing tests documented as taking 8-9 minutes.

There are no exact duplicate test files, but there are many high-confidence
near-duplicates. The strongest candidates are repeated target-routing cases,
repeated unknown-builder rejection cases, copied agent-output blocks, direct
helper assertions repeated at integration level, and a second copy of the
removed `akm vault` command check.

Several tests are materially weaker than their names imply. The most serious
examples are a min-score test that never observes the production default, a
vector-search test that only calls FTS, and an `assembleInfo` test that only
checks that a function exists. There are also key-only CLI goldens, conditional
success/error assertions, and real subprocess/network calls that are not
controlled by the test.

## Organization And Discovery Findings

### ORG-01: Documented suite boundaries do not match executable boundaries [High]

`AGENTS.md:22-27` says integration covers `tests/integration/`,
`tests/commands/`, and `tests/workflows/`. The actual scripts contradict that:

- `scripts/test-unit.sh:40-43` selects every `*.test.ts` outside `tests/integration/`.
- `scripts/test-integration.sh:34-35` selects only `tests/integration/**/*.test.ts`.

Therefore `tests/commands/` and `tests/workflows/` run as unit tests, not
integration tests. The documented `<60s` unit contract and the intended meaning
of the two test targets are both unreliable. New tests can be placed according
to the documentation and silently run in the other target.

### ORG-02: The plural `tests/integrations/` directory is outside integration discovery [High]

These files are in `tests/integrations/agent/`, not `tests/integration/agent/`:

- `tests/integrations/agent/runner.test.ts`
- `tests/integrations/agent/runner-dispatch.test.ts`
- `tests/integrations/agent/prompts-confidence.test.ts`

The integration runner never sees them. They run in the unit target despite the
directory name. Their contents are mostly resolver, dispatch-seam, and prompt
tests, so the intended destination is also unclear. The directory typo is a
real discovery defect regardless of the eventual classification.

### ORG-03: The root of `tests/` is an unclassified bucket [Medium]

There are 78 root-level test files covering pure helpers, CLI behavior, setup,
package installation, output contracts, and evaluation workflows. The
directory does not communicate whether a file is unit, command-contract,
acceptance, or integration coverage. `tests/package-install.test.ts` is a
particularly clear mismatch: it performs package packing/install work but is
selected by the unit runner. This makes the root location hide runtime and
environment requirements from the target that executes it.

### ORG-04: Executable tests are stored in fixture namespaces [Medium]

The following files are tests, not fixture data or helper modules:

- `tests/_fixtures/migration/cutover-rekey-property-gate.test.ts`
- `tests/_fixtures/migration/cutover-rekey-property.test.ts`
- `tests/_fixtures/migration/migration-fixtures.test.ts`
- `tests/_fixtures/migration/rekey-merge-property.test.ts`
- `tests/fixtures/stashes/load.test.ts`

The runner includes them based on filename, while the directory names imply
support data. The placement obscures ownership and makes it easy to miss these
tests when reviewing a suite by feature. The migration gate is also an 8-9
minute default unit test, which makes this placement operationally important.

### ORG-05: Integration contains files that explicitly describe themselves as unit tests [Medium]

Examples include:

- `tests/integration/graph-extraction-queue.test.ts:9-12`
- `tests/integration/graph-extraction-topn.test.ts:7-12`
- `tests/integration/project-context.test.ts:1-7`
- `tests/integration/graph-boost-cache-reset.test.ts:1-23`
- `tests/integration/standards-prompt-injection.test.ts:5-26`
- `tests/integration/commands/consolidate/consolidate-chunks.test.ts:1-12`
- `tests/integration/commands/consolidate/consolidate-op-handlers.test.ts:28-31`
- `tests/integration/commands/improve/outcome-loop.test.ts:5-20`
- `tests/integration/commands/improve/salience.test.ts:5-15`

Some of these have legitimate SQLite, filesystem, or HTTP boundaries, so this
is not an automatic move recommendation. It is evidence that the repository
does not have a stable unit/integration classification rule.

### ORG-06: Command grouping is inconsistent [Medium]

Some command tests are directly under `tests/commands/`, others are grouped by
command below `tests/commands/<command>/`, and the same pattern is repeated
below `tests/integration/commands/`. For example, improve and consolidate have
deep subdirectories while other command suites remain at the command root.
With 237 integration tests at the integration root and only 134 nested below
it, the layout is primarily historical rather than discoverable by feature.

### ORG-07: Benchmark and characterization naming has no separate execution boundary [Low]

The tree uses both `.characterization.test.ts` and `-characterization.test.ts`.
`tests/commands/distill/distill-promotion-policy.bench.test.ts` is the only
benchmark-suffixed test and is still included in the normal unit target. The
suffix therefore communicates a runtime/intent distinction that the runner does
not enforce.

### ORG-08: Fixture discovery has two incompatible systems [Low]

`tests/fixtures/stashes/load.ts:37-50` uses MANIFEST-based fixture discovery and
`load.test.ts:95-99` expects the manifest list. The
`tests/fixtures/stashes/curate-golden/` corpus is copied manually by
`tests/integration/curate-golden-eval.test.ts:36,54-61` and is not part of the
same fixture namespace contract. A stash-like fixture can therefore exist in
the fixture tree without being visible to `listFixtures()` or the shared
loader.

### ORG-09: Test documentation contains stale commands and ambiguous runner semantics [Low]

`AGENTS.md:25` and `tests/integration/semantic-search-e2e.test.ts:9` document
`tests/semantic-search-e2e.test.ts`, but the file is actually under
`tests/integration/`. `package.json:61-63` defines `bun run test` as the unit
runner, while `docs/architecture/testing/testing-workflow.md:27` presents bare
`bun test` as the fast full-project command and `tests/release-check.sh:122`
uses bare `bun test` for the full suite. The same command name therefore has
different documented meanings in different files.

### ORG-10: Duplicate test titles reduce failure discoverability [Low]

`tests/config-cli.test.ts:224-230` contains two tests with the identical title
`parseConfigValue rejects retired boolean semanticSearchMode values`. The
inputs differ, but a failure report does not identify which value failed.

## Duplicate And Redundant Coverage

No exact duplicate `*.test.ts` file contents were found. The following are
high-confidence duplicate or near-duplicate cases within the test behavior.

### DUP-01: Import target scenarios are repeated in one file [High]

`tests/integration/commands/import.test.ts:94-147` and
`:149-224` repeat the same success, unknown-target, and read-only-target
scenarios. Only fixture names and text differ. The second block adds no target
resolution branch.

### DUP-02: Remember target scenarios are repeated in one file [High]

`tests/commands/remember.test.ts:69-123` and `:126-191` both cover writable
target, unknown target, and read-only target behavior. The first block adds a
default-target distinction, but the three target-error cases are duplicated
with renamed fixtures.

### DUP-03: `runAgent` result paths are tested in both unit and architecture suites [Medium]

`tests/agent/agent-spawn.test.ts:102-165` and
`tests/architecture/agent-spawn-seam.test.ts:113-177,179-225` both cover
captured success, non-zero exit, spawn failure, parse failure, and timeout.
The architecture suite has unique interactive-stdio and timer-clearing
assertions, so only the common result-path cases are redundant.

### DUP-04: Unknown command-builder rejection is asserted four times [High]

`tests/agent/agent-builders.test.ts:284-287`, `:380-383`, and `:419-422`
all call `getCommandBuilder("unknown-platform")` and assert the same error.
`:578-581` repeats the same registry branch with a different unknown string.
The custom-string distinction may be useful once; four copies are not.

### DUP-05: Agent-shaped output assertions and fixtures are repeated [High]

`tests/integration/agent-output.test.ts:64-152` and `:233-279` each create an
architect/release stash and test agent-shaped search/show projections. The
later WS2 block repeats the essential-field and allowed-key checks from the
earlier block. The first block's additional negative-field and content tests
are distinct; the repeated projection checks are not.

### DUP-06: Truncation helper behavior is repeated at integration level [High]

The shared helper is comprehensively tested in
`tests/core/text-truncation.test.ts:15-59`. The integration file
`tests/integration/commands/consolidate/consolidate-pipeline-fixes.test.ts:220-254`
imports the same helper and repeats the complete-sentence, punctuation,
ellipsis, and connector cases without exercising consolidate pipeline wiring.

### DUP-07: Proactive cooldown cases are duplicated [Medium]

`tests/commands/improve/proactive-maintenance.test.ts:32-58` tests never
reflected and recently reflected selector behavior. The same cases appear in
`tests/cooldown-select-fix.test.ts:175-200`, while the post-lock filter cases
in `:57-168` are the distinct behavior. The selector regression block should
not repeat the same selector cases unless it is intentionally a separate
contract suite.

### DUP-08: Process-runner resolution is duplicated [Medium]

`tests/agent/agent-process-config.test.ts:19-49` and
`tests/integrations/agent/runner.test.ts:58-99` both cover default-engine
fallback, explicit process-engine selection, timeout behavior, and rejection of
an agent engine for an LLM process. The plural integration file adds overlay
coverage, but the common resolution cases remain duplicated and are also in
the wrong target.

### DUP-09: Removed `akm vault` command rejection is tested twice [High]

`tests/integration/env.test.ts:563-573` and
`tests/integration/env-path-run.test.ts:162-177` both only assert that the
top-level `vault` verb exits non-zero. The `vault:` reference behavior in
`env.test.ts:575-587` is distinct and valuable; the second top-level command
check is not.

### DUP-10: Unknown registry-provider warning is tested through two paths [Medium]

`tests/integration/registry-search.test.ts:565-571` and `:770-777` both assert
empty hits, one warning, and the provider name for an unknown provider. The
environment-variable parsing path is meaningfully different, so this is a
parameterization candidate rather than an outright deletion candidate.

### DUP-11: Several secondary overlaps are weaker copies of existing contracts [Medium]

- `tests/commands/consolidate/consolidate-wave2-d.test.ts:77-107` checks error class identity, while `tests/cli/exit-code-classification.test.ts:59-98` tests the actual exit envelope and code mapping.
- `tests/commands/consolidate/consolidate-wave2-e.test.ts:60-102` overlaps the registry shape cases in `tests/output-shapes-unit.test.ts:134-174`.
- `tests/commands/consolidate/consolidate-wave2-e.test.ts:107-139` overlaps the YAML/frontmatter cases in `tests/remember-unit.test.ts:36-97`.
- `tests/commands/consolidate/consolidate-wave2-e.test.ts:148-155` overlaps the info integration test in `tests/integration/info-command.test.ts:171-184` while adding only a function-existence check.

### DUP-12: CLI envelope setup is copied across many files [Low]

Nearly identical `runCli`, sandbox, and JSON-envelope setup appears in:

- `tests/commands/config-cli-envelope.test.ts:24-38`
- `tests/commands/contribute-cli-envelope.test.ts:27-41`
- `tests/commands/sources-cli-envelope.test.ts:30-44`
- `tests/commands/observability-cli-envelope.test.ts:34-48`
- `tests/integration/commands/env-cli-envelope.test.ts:25-41`

This is not duplicate behavior by itself, but it creates a large maintenance
hotspot where isolation or envelope changes must be repeated manually.

### Intentional overlap that should not be removed without a contract decision

- Golden proposal behavior is intentionally represented in both command and integration suites.
- Golden crash recovery and durable-recovery suites repeat execution to pin separate recovery surfaces.
- Adapter conformance files repeat the recognition/placement/render/lint matrix for each adapter.
- `tests/core/asset-serialize.test.ts:147-261` repeats serialization checks at historical call sites by design.

These are runtime and maintenance costs, but they are not accidental duplicates
on the current evidence.

## Tests With Little Or Misleading Value

### VALUE-01: The min-score default test does not test the min-score default [High]

`tests/commands/consolidate/consolidate-wave2-bc.test.ts:284-292` is named as a
test of the `0.2` `db-search` default, but only asserts that
`config.search?.minScore` is `undefined`. A production change from `0.2` to any
other internal default would still pass. The test explicitly avoids the
function where the default is applied.

### VALUE-02: The vector-only test never invokes vector search [High]

`tests/integration/parallel-search.test.ts:255-281` inserts an embedding and
sets `hasEmbeddings`, but calls `searchFts()` and asserts only that FTS returns
no rows. It never invokes `akmSearch`, `searchLocal`, `searchVec`, or the
hybrid/vector path. A completely broken vector-only search implementation can
pass this test.

### VALUE-03: `assembleInfo` coverage is a function-existence smoke test [High]

`tests/commands/consolidate/consolidate-wave2-e.test.ts:148-155` says it tests
that `sourceProviders` is populated, then only asserts
`typeof assembleInfo === "function"`. The integration counterpart,
`tests/integration/info-command.test.ts:171-175`, only asserts that
`sourceProviders` is an array. Missing provider entries or wrong provider
fields can pass both tests.

### VALUE-04: Output-shape fixtures are already compliant and include a tautology [Medium]

`tests/commands/consolidate/consolidate-wave2-e.test.ts:17-103` supplies
`path`, `editable`, `name`, `installRef`, and `score` in the input fixture, so a
pass-through implementation satisfies most of the shape assertions. The
`Object.keys(out).length > 0` assertion at `:91-94` adds no behavior because
the fixture is non-empty. Missing-field and field-filtering inputs are needed
to prove the shape helper does work.

### VALUE-05: Ollama failure behavior is not asserted [Medium]

`tests/integration/setup.test.ts:169-180` is named as an unavailable/failure
case, but accepts either `available` value and checks only types. It also lets
the production code fall through to a real `ollama list` command. The test can
pass when the fallback succeeds, fails, or is unavailable.

### VALUE-06: Observability coverage depends on ambient index state [Medium]

`tests/commands/observability-cli-envelope.test.ts:60-80` accepts either the
success envelope or an internal-error envelope based on whether an index exists
from prior suite state. A regression in either branch can be hidden. The
dedicated `tests/integration/lessons-coverage.test.ts:58-65,99-110` already
demonstrates deterministic state setup.

### VALUE-07: Migration-path test reimplements the production path calculation [Medium]

`tests/integration/migration-help.test.ts:89-108` constructs a temp directory,
calls `path.resolve`, and reads the expected file directly. It does not call
the migration loader. The test can pass while the loader uses a different path
or fails to load the file.

### VALUE-08: Exit-code classification is tested as class naming, not classification [Medium]

`tests/commands/consolidate/consolidate-wave2-d.test.ts:79-107` checks
`name` and `instanceof`, despite its title promising exit-code classification.
The actual mapping is covered by `tests/cli/exit-code-classification.test.ts:59-98`.
The wave-2 tests are a weaker duplicate, not an independent exit-code contract.

### VALUE-09: Ref-boundary test never supplies the claimed legacy spelling [High]

`tests/integration/commands/ref-input-boundary.test.ts:6-19` claims to cover
legacy `type:name`, short concept IDs, and qualified refs. Its actual
`SPELLINGS` at `:43-44` are `"knowledge/guide"`, `"knowledge/guide"`, and
`"catalog//knowledge/guide"`. The legacy spelling is absent, so all three
commands at `:79-105` fail to exercise the claimed legacy boundary.

### VALUE-10: CLI goldens pin keys, not values [Medium]

`tests/commands/goldens-cli-output.test.ts:17-20` explicitly defines key-only
baselines. Examples include `tests/fixtures/goldens/cli/a-search.json:1-6`
and `a-list.json:1-4`. Wrong refs, names, paths, counts, or content can pass
as long as the key set remains unchanged. This may be intentional for a
migration baseline, but it provides weak regression protection and should not
be treated as behavioral output coverage.

### VALUE-11: CLI global error handlers have no direct behavior coverage [Medium]

The handlers in `src/cli.ts:33-71` are explicitly skipped by
`tests/commands/goldens-cli-output.test.ts:22-29`. The real-entrypoint coverage
in `tests/integration/show-argv-entrypoint.test.ts:50-60` does not exercise an
unhandled rejection or uncaught exception. The advertised JSON envelope for
these paths can regress without a focused test.

### VALUE-12: The LLM stateless seam cannot detect the private state it claims to guard [Medium]

`tests/architecture/llm-stateless-seam.test.ts:36-100` checks exports and
function arity. It cannot observe the private mutable
`chatCompletionOverride` in `src/llm/client.ts:259-275`, even though the test
claims to protect against hidden module state. The test proves module shape, not
stateless behavior or reset behavior.

### VALUE-13: Registry-index success is invoked twice for one assertion [Low]

`tests/integration/registry-build-index.test.ts:280-300` first calls
`buildRegistryIndex` only to assert `resolves.toBeDefined()`, then calls the
same operation again to inspect the result. The first invocation adds runtime
and network/server work without additional coverage.

### VALUE-14: Benign workflow-parameter test does not inspect the returned brief [Low]

`tests/integration/workflows/params-validation.test.ts:136-146` asserts only
`resolves.toBeDefined()`. It does not verify that the edited parameters are
accepted, that the brief contains the expected values, or that the integrity
error is absent from the returned object.

### VALUE-15: Special-character serialization test does not parse serialized data [Low]

`tests/commands/consolidate/consolidate-wave2-e.test.ts:132-139` only checks
that the output contains `description:`. It does not verify quoting, newline
preservation, YAML parseability, or that a newline cannot inject another key.
Those stronger checks already exist in `tests/remember-unit.test.ts:65-83`.

### VALUE-16: Cache tests only prove that clearing does not throw [Low]

`tests/integration/parallel-search.test.ts:183-194` has both a single-call and
repeated-call test, and every assertion is `not.toThrow()`. The repeated call
subsumes the single-call smoke test and neither proves that cached values were
discarded or recomputed.

### VALUE-17: Several status-only assertions do not lock the intended error contract [Low]

Examples are `tests/config-cli-silent-layer.test.ts:129-133`,
`tests/completions.test.ts:146-151`, and
`tests/commands/remember.test.ts:111-123,178-190`. They assert only non-zero
status or a broad error fragment where the surrounding contract distinguishes
usage, config, and general failures. These tests can pass with the wrong exit
classification or wrong error envelope.

## Runtime, Flakiness, And Test Design Findings

### RUNTIME-01: The 8-9 minute property gate runs in the default unit suite [High]

`tests/_fixtures/migration/cutover-rekey-property-gate.test.ts:18-20` says the
gate is slow-listed and requires `AKM_RUN_SLOW_TESTS=1`. The file defines
`GATE_SEED_COUNT = 1000` at `:34`, uses a 20-minute timeout at `:75`, and has no
environment guard. `scripts/test-unit.sh:40-43` deliberately includes every
non-integration test. `AKM_RUN_SLOW_TESTS` is therefore dead documentation, and
the default unit/check path pays the full property-gate cost.

### RUNTIME-02: A 10,000-item map expansion is also in the default unit suite [High]

`tests/workflows/engine-ir-v3.test.ts:670-697` constructs and validates 10,000
items. The test documents roughly 8 seconds alone, roughly 18 seconds under
shard contention, and up to 60 seconds on a loaded box, with a 180-second
timeout. This directly contradicts the documented fast unit target and makes
shard duration sensitive to host size.

### RUNTIME-03: Package installation work is classified as unit work [Medium]

`tests/package-install.test.ts:188-221` calls package packing, npm global
installation, launcher verification, and uninstall flows. The implementation
uses real npm commands in `scripts/package-install.ts:169-179,412-457`. This
depends on host tooling and filesystem/process behavior while running in the
unit target.

### RUNTIME-04: A fixture helper hides a real CLI subprocess from the unit target [Medium]

`tests/fixtures/stashes/load.ts:107-139` runs `Bun.spawnSync` for `akm index`.
`tests/fixtures/stashes/load.test.ts:19,57` invokes it, so a unit test starts a
real CLI process even though the test file itself contains no spawn call. The
isolation linter scans test files in `scripts/lint-tests-isolation.ts:291-303`
and does not inspect helper implementations for this rule. A stalled helper
can block a shard beyond the JavaScript test timeout.

### RUNTIME-05: A source test performs real website/DNS work [Medium]

`tests/integration/source-source.test.ts:607-615` calls
`ensureSourceCaches` with `https://example.invalid/docs` without mocking the
website provider. The call reaches provider sync at
`src/indexer/search/search-source.ts:382-388` and website fetch/retry logic at
`src/sources/snapshot-fetchers/website-ingest.ts:353-374`. The test is expected
to warn rather than throw, but DNS and retry behavior remain environment- and
latency-dependent.

### RUNTIME-06: Host Ollama detection can add a 10-second subprocess timeout [Medium]

The failure case in `tests/integration/setup.test.ts:169-180` mocks fetch but
not the CLI fallback. Production invokes `ollama list` with a 10-second timeout
at `src/setup/detect.ts:84-103`. The result depends on the host's PATH and
Ollama state, and the test can spend the full fallback timeout.

### RUNTIME-07: Near-deadline and real-process timing assertions are scheduler-sensitive [Medium]

Examples include:

- `tests/integration/llm-client.test.ts:847-874`, which waits 460ms against a 500ms timeout.
- `tests/integration/reflect-propose-http-timeout.test.ts:45-106`, which uses real localhost servers and 1ms timeouts.
- `tests/integration/opencode-sdk-managed-server.test.ts:75-81,109-115`, which polls process state and asserts a 500ms close bound.
- `tests/integration/commands/events.test.ts:169-174` and `tests/integration/proposals.test.ts:967-971,988-995,1046-1051`, which use narrow wall-clock windows.

The runners intentionally create contention with parallel shards, increasing
the chance that these tests fail or pass for scheduling reasons rather than
behavior.

### RUNTIME-08: Timeout tests leave delayed work running after the assertion [Low]

`tests/llm-feature-gate.test.ts:181-193,213-230` uses promises that resolve
200ms after the gate returns. Production has no cancellation path at
`src/llm/feature-gate.ts:188-199`. The late work is harmless in the current
cases but can keep handles alive, interleave logs, or become observable when a
test later adds shared state.

### RUNTIME-09: Backup-pruning coverage busy-spins to create unique timestamps [Low]

`tests/integration/config.test.ts:366-375` performs ten saves and spins for
10ms after each save. Production already adds sequence suffixes for timestamp
collisions at `src/core/config/config-io.ts:121-133`, so the delay is both
expensive and unnecessary for the behavior under test.

### RUNTIME-10: Golden tests intentionally re-execute scenarios [Medium]

The following suites rerun scenarios to capture independent golden fixtures:

- `tests/commands/consolidate/goldens-consolidate-ops.test.ts:960-966`
- `tests/commands/goldens-mv-txn.test.ts:481-487`
- `tests/commands/proposal/goldens-proposal-txn.test.ts:620-624`

This is defensible for fixture isolation, but it materially adds default-suite
work and should be counted as a deliberate performance cost rather than normal
unit coverage.

### RUNTIME-11: Release sub-suites omit the required explicit Bun timeout [Medium]

`bunfig.toml:9-14` documents that Bun 1.3.14 ignores the configured timeout and
requires a CLI flag. `tests/release-check.sh:96,110,113,120` runs focused
`bun test` commands without `--timeout`; only `:122` passes
`--timeout=30000`. The same test can therefore have a 5-second default in one
release step and a 30-second or 120-second timeout in another runner.

### RUNTIME-12: Opt-in gates treat `=0` as enabled [Low]

`tests/integration/semantic-search-e2e.test.ts:30` and
`tests/integration/docker-install.test.ts:102` use `!!process.env...`. A user
who sets `AKM_SEMANTIC_TESTS=0` or `AKM_DOCKER_TESTS=0` still enables the
expensive suite, contrary to the documented `=1` convention.

## Isolation And Shared-State Findings

### ISOLATION-01: `FAST_API_KEY` is not restored [Medium]

`tests/engine-resolution.test.ts:105-109` assigns `process.env.FAST_API_KEY`
without restoring it. The preload harness does not include this arbitrary
credential name in its managed set, and production reads credential names from
the environment at `src/integrations/agent/engine-resolution.ts:234-244`.
Later tests can inherit the synthetic `engine-secret` value.

### ISOLATION-02: `USERPROFILE` is deleted without restoration [Medium]

`tests/integration/setup.test.ts:98-115` deletes and sets `USERPROFILE` while
testing Windows fallback behavior, then only deletes it. The standard sandbox
helper manages `HOME` but not `USERPROFILE` (`tests/_helpers/sandbox.ts:187-192`),
so a pre-existing value can be lost for later tests.

### ISOLATION-03: `HF_HOME` is set and not restored [Medium]

`tests/integration/semantic-search-e2e.test.ts:272-275` sets `HF_HOME` to a
path under the sandbox HOME when absent. Its cleanup at `:314-317` restores the
standard environment but not `HF_HOME`. The local embedder reads this variable
at `src/llm/embedders/local.ts:229-233`. The leak is especially likely when
the semantic gate is enabled in a shared process.

### ISOLATION-04: Registry provider registrations are process-global [Low]

`tests/provider-registry.test.ts:11-18` and
`tests/integration/registry-search.test.ts:890-984` register custom providers.
The registry map in `src/registry/factory.ts:23-33` has no unregister/reset
operation. Current names are mostly unique, but the suite's behavior depends on
global registrations persisting and creates order/collision risk for future
tests.

### ISOLATION-05: Graph ranking tests reuse and mutate one SQLite fixture [Low]

`tests/integration/graph-boost-ranking.test.ts:86-121` builds one per-file
database in `beforeAll`, and `:263-307` mutates the stored graph. The current
`beforeEach` clears the graph cache but does not recreate the database. A new
test that mutates the DB without reinstalling the graph can become order
dependent.

### ISOLATION-06: The isolation linter does not inspect helper-side process spawns [Medium]

The runner's Rule 5 scans test files outside `tests/integration/` at
`scripts/lint-tests-isolation.ts:420-444`, but the real spawn in
`tests/fixtures/stashes/load.ts:126-139` is in a helper. This creates a gap
between the stated unit no-real-spawn invariant and what the linter can detect.

### ISOLATION-07: The isolation allowlist contains paths that no longer exist [Low]

`scripts/lint-tests-isolation.ts:154-158,238-239` allowlists
`tests/integration/ripgrep.test.ts` and
`tests/integration/tasks-legacy-md-warning.test.ts`, but neither file exists in
the tracked tree. `tests/lint-isolation-ratchet.test.ts:20-27` checks only the
combined allowlist size, not that every allowlisted path exists. A future test
recreated at either path would inherit a stale exemption silently.

### ISOLATION-08: Lint coverage is narrower than the harnessed environment [Low]

The isolation linter's `AKM_ENV_VARS` list is only
`AKM_STASH_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and
`HOME` (`scripts/lint-tests-isolation.ts:81-82`). The preload contract also
manages state/config/data directories, verbosity, LLM keys, embedding keys,
registry URLs, and npm registry values (`AGENTS.md:30-33`). The tripwire helps
at runtime, but direct assignments to the additional variables are not caught
by the static isolation rule.

## Test Harness, Release, And CI Findings

### INFRA-01: Docker smoke test uses the retired ref grammar [High]

`tests/docker/smoke-test.sh:101-108,203-204` creates a script and calls
`akm show script:deploy/deploy-app.sh`. The current ref grammar is
`[bundle//]conceptId`; the old `type:name` grammar is migrator-only according
to `src/core/asset/asset-ref.ts:31-36,139-180`. The Docker matrix is opt-in, so
this broken assertion is normally invisible.

### INFRA-02: Docker execution can pass with zero variants or masked failures [High]

`tests/docker/run-docker-tests.sh:81-86,119-135` warns and skips missing
Dockerfiles, then exits successfully when `FAILED=0`, including when no variant
ran. In `tests/docker/smoke-test.sh:30-58`, output assertions suppress command
failures with `|| true`, and `:214-217` explicitly converts a failed `akm list`
into a pass. A typo, missing image variant, or failed command can therefore
produce a green Docker gate.

### INFRA-03: The Alpine binary fixture is tracked but omitted from both matrices [Medium]

`tests/docker/Dockerfile.alpine-binary` is documented in
`docs/architecture/testing/testing-workflow.md:296-305`, but is absent from
`tests/docker/run-docker-tests.sh:16-24,30-35` and
`tests/integration/docker-install.test.ts:90-92,127-156`. The tracked fixture
has no default automated coverage, and the shell and Bun runners maintain
separate variant lists that can drift.

### INFRA-04: CI does not exercise gated semantic, Docker, native scheduler, or real-platform coverage [Medium]

The main CI job runs only Ubuntu `bun run check` and build at
`.github/workflows/ci.yml:29-42`. Docker and semantic suites are skipped unless
their environment gates are set, and native scheduler tests require disposable
macOS/Windows runners at `tests/integration/native-scheduler.test.ts:16-23`.
Green CI does not establish coverage for real embeddings, container installs,
or native schedulers.

### INFRA-05: Release validation mutates the checkout and omits repository lint rules [Medium]

`tests/release-check.sh:95-99` runs `bunx biome check --write src/ tests/`, so a
validation command can modify source and test files. It also does not run the
full `package.json:72` lint command, which includes isolation, license,
runtime-boundary, SQL, golden, ref-literal, shipped-asset, and schema checks.
The release script can pass while leaving a dirty tree and missing custom lint
failures.

### INFRA-06: Integration failure logs are deleted before the runner exits [Low]

`scripts/test-integration.sh:43-47` says shard logs are kept for diagnosis, but
`:82-92` prints a tail and `:87` deletes each log unconditionally, including on
failure. The unit runner retains logs on failure at
`scripts/test-unit.sh:97-102`. Integration flakes therefore lose the detailed
artifact the runner advertises.

### INFRA-07: Semantic test cache and command documentation are unreliable [Medium]

The semantic test documentation points to the wrong path as noted in ORG-09.
The test also derives `HF_HOME` from the sandboxed HOME at
`tests/integration/semantic-search-e2e.test.ts:272-286`, while the preload
creates and later removes that HOME. Unless a user supplies `HF_HOME`, model
downloads are not retained between runs, and the test can unexpectedly pay the
download cost again.

### INFRA-08: Release and normal runners use materially different timeout policies [Medium]

The normal shard scripts pass `--timeout=120000` at
`scripts/test-unit.sh:65-68` and `scripts/test-integration.sh:57-60`, while
focused release steps omit the flag and the Bun config value is known to be
ignored (`bunfig.toml:9-14`). This makes timeout behavior depend on which entry
point a developer or CI job chooses.

## Prioritized Triage

The findings with the highest risk to the credibility of a green run are:

1. Align runner discovery and documentation, and remove the plural integration directory ambiguity (`ORG-01`, `ORG-02`).
2. Gate or relocate the 1,000-case property test and the 10,000-item expansion (`RUNTIME-01`, `RUNTIME-02`).
3. Replace the false min-score, vector-only, info, and legacy-ref tests with assertions that reach the claimed production paths (`VALUE-01`, `VALUE-02`, `VALUE-03`, `VALUE-09`).
4. Stop Docker from passing with zero tests or swallowed failures, and update its retired ref grammar (`INFRA-01`, `INFRA-02`).
5. Remove or isolate real network, host-tool, and package-install work from the default unit target (`RUNTIME-03`, `RUNTIME-04`, `RUNTIME-05`, `RUNTIME-06`).
6. Restore unmanaged environment variables and make the static isolation rules cover helper-side process execution (`ISOLATION-01` through `ISOLATION-06`).
7. Consolidate the repeated target, builder, output, truncation, cooldown, and removed-command cases (`DUP-01` through `DUP-10`).
