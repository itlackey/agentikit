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

GitHub only offers a scheduled or manually dispatched workflow after its file
exists on the default branch. When validating the commit that first introduces
or changes this workflow, create a unique lightweight candidate tag at the
recorded SHA:

```sh
candidate_sha="$(git rev-parse HEAD)"
candidate_short_sha="$(git rev-parse --short=12 HEAD)"
candidate_version="$(node -p 'require("./package.json").version')"
candidate_tag="gated-ci/candidate-${candidate_version}-${candidate_short_sha}"
git tag "$candidate_tag" "$candidate_sha"
git push origin "refs/tags/$candidate_tag"
```

Verify that the tag target is the exact candidate commit recorded in step 1.
The `gated-ci/candidate-*` trigger runs every gated suite from the workflow in
that tagged commit. The resolver checks that the checkout equals the immutable
event SHA, and the final evidence job records both that SHA and the tag ref.
Never force-move or reuse a candidate tag; a changed commit needs a new tag and
a new run.

After **Gated CI** exists on the default branch, manual dispatch is an
equivalent exact-SHA path. From the repository's Actions page, choose **Run
workflow** and supply:

- `candidate_sha`: the full 40-character SHA recorded above, never a branch or
  tag name;
- `gated_suite`: `all`.

The manual request rejects abbreviated SHAs and checks out that immutable
commit for every gate. Wait for all of these stable checks to succeed on either
candidate path:

- `Gated / Semantic Search`
- `Gated / Docker Install`
- `Gated / Native Scheduler / Linux`
- `Gated / Native Scheduler / macOS`
- `Gated / Native Scheduler / Windows`
- `Gated / Release Candidate Evidence`

The final evidence job records the requested and resolved SHA, the trigger ref,
each suite's result, and a run link in the workflow summary. A weekly run is
drift detection, not release evidence, because it may cover a different
commit.

Manual and tagged candidate runs are cache restore-only. Only a successful
scheduled run of the workflow on the repository's default branch may save the
HuggingFace model cache; its key identifies both the embedding model and the
source/lock inputs. This prevents candidate-controlled workflow code from
publishing cache entries while still avoiding repeated model downloads.

Copy the successful run URL (for example,
`https://github.com/itlackey/akm/actions/runs/<run-id>`) and the exact candidate
SHA into both the release PR and its milestone/parent tracker. Do not publish
from a candidate whose evidence link names a different SHA, whose final
evidence job is skipped, or whose run was re-run after the candidate changed.

## 3. The focused gate on a pull request

Heavy gated suites do not run in full on every push or pull request — but each
one now runs itself automatically on a PR whose diff touches its surface. The
`Gated / Detect Changed Paths` job inspects the PR's changed files and turns on
only the suite(s) that surface actually needs:

| Changed surface | Suite that runs automatically |
| --- | --- |
| Embedding provider, semantic index/search, Transformers dependency, `package.json`/lockfile | `semantic` |
| Setup/install providers, packaging scripts, `package.json`/lockfile | `docker` |
| `src/tasks/**`, `src/runtime.ts`, `src/core/subprocess.ts`/`state-db.ts`, standalone/asset build scripts | `native-scheduler` |

A PR touching none of these paths gets a fast, green `Gated CI` run with every
suite skipped — nothing else to do. Nothing to dispatch by hand: this closed
the gap where "remember to dispatch the relevant suite" was an unenforced
checklist rule. Manual `workflow_dispatch` (`gated_suite: <name>`) is still
there for re-running one suite in isolation (a transient failure, or checking
a fix before opening the PR) and `all` for combined evidence, especially for a
release candidate — see step 2. This keeps heavyweight model downloads,
container builds, and paid macOS/Windows runner time off routine commit CI
while making the "did the relevant suite run" question a CI status, not a
memory test.

The candidate-tag trigger is reserved for release evidence and workflow
rollout: it always runs `all`, because a tag-push workflow is the path available
before the workflow file reaches the default branch.

## 4. Publish

After the exact-SHA gated run and local release check are green, trigger the
Release workflow with the version already committed in `package.json`. Keep the
candidate SHA and Gated CI run URL in the release record so the published
artifact's validation can be audited later.
