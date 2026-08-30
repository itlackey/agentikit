# Fixture: previous-release corpus

Real-shaped task source files from prior releases, read through
`tests/integration/previous-release-corpus.test.ts` — the upgrade-smoothness
guard rail. See that test file's header for the policy these fixtures exist
to enforce.

Files:
- `task-v2.yml` — a conformant task v2 file: `schedule`, `command`,
  `enabled`, `timeoutMs`, `name`, `description`, `when_to_use`, `tags`. Read
  via the in-memory v2->v3->v4 migration shim in
  `src/tasks/source/parse-task-source.ts`.
- `task-v3.yml` — a conformant task v3 file: `akm.schedule`,
  `uses: akm/command`, `with.content`. Read via the in-memory v3->v4
  migration shim, same file.

The proposals-state.db fixture (a pre-#858 legacy `metadata_json` row) is
built programmatically inside the test — it is DB state, not a file, so
there is nothing to check in here for it.

- `config-0.0.1.json` — SYNTHETIC (#863): unlike the fixtures above, `"0.9.0"`
  is the only `configVersion` akm has ever shipped, so there is no real prior
  release to take a shape from. This fixture stands in for one, establishing
  the `configVersion` read-shim mechanism (`src/core/config/config-version-shim.ts`)
  before a real bump ever needs it. Read via the in-memory `0.0.1`->`0.9.0`
  upgrade in that shim (root-level `defaultEngine` -> `defaults.llmEngine`).
  Delete this fixture and its shim entry once a real old `configVersion`
  fixture replaces it.
