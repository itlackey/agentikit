# Release Checklist

Use this checklist for every release candidate. Local release validation and
scheduled CI are useful inputs, but neither substitutes for a successful gated
run of the exact commit that will be published.

## 1. Freeze the candidate

1. Finish the version, changelog, migration-note, and release-PR changes.
2. Record `git rev-parse HEAD`. This is the full 40-character release-candidate SHA.
3. Run `bun run release:check` locally. If Docker is unavailable, run
   `./tests/release-check.sh --skip-docker` and rely on the gated Docker job
   below for the container matrix.

Any commit added after this point creates a new candidate and invalidates the
gated evidence collected for the previous SHA.

## 2. Collect exact-SHA gated evidence

From the repository's Actions page, open **Gated CI**, choose **Run workflow**,
and supply:

- `candidate_sha`: the full 40-character SHA recorded above, never a branch or
  tag name;
- `gated_suite`: `all`.

The request rejects abbreviated SHAs and checks out that immutable commit for
every gate. Wait for all of these stable checks to succeed:

- `Gated / Semantic Search`
- `Gated / Docker Install`
- `Gated / Native Scheduler / Linux`
- `Gated / Native Scheduler / macOS`
- `Gated / Native Scheduler / Windows`
- `Gated / Release Candidate Evidence`

The final evidence job records the requested and resolved SHA, each suite's
result, and a run link in the workflow summary. A weekly run is drift detection, not release evidence,
because it may cover a different commit.

Copy the successful run URL (for example,
`https://github.com/itlackey/akm/actions/runs/<run-id>`) and the exact candidate
SHA into both the release PR and its milestone/parent tracker. Do not publish
from a candidate whose evidence link names a different SHA, whose final
evidence job is skipped, or whose run was re-run after the candidate changed.

## 3. Request a focused gate before merge

Heavy gated suites do not run on ordinary pushes or pull requests. When a
change touches one of these surfaces, dispatch the relevant suite against the
change's full commit SHA before merge:

| Changed surface | `gated_suite` |
| --- | --- |
| Embedding provider, semantic index/search, Transformers dependency | `semantic` |
| Dockerfiles, install scripts, packaging, Linux runtime dependencies | `docker` |
| Task scheduling, launcher binding, standalone/package entrypoints | `native-scheduler` |

Use `all` only when the combined evidence is needed, especially for a release
candidate. This keeps heavyweight model downloads, container builds, and paid
macOS/Windows runner time off routine commit CI.

## 4. Publish

After the exact-SHA gated run and local release check are green, trigger the
Release workflow with the version already committed in `package.json`. Keep the
candidate SHA and Gated CI run URL in the release record so the published
artifact's validation can be audited later.
