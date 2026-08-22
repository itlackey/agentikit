# `akm health` advisory → action map

Run `akm health` (add `--json` for machine output). Overall exit is non-zero when any
**hard** check fails; **advisory** checks report `warn`/`unknown` but never gate the exit.
This table is the interpretive key for a second operator: what each named advisory measures
and whether to act. Some `warn`s below are *adjudicated, expected* states — treat them as
"no action" until the referenced condition changes.

| Advisory (name in output) | What it means | Action |
|---|---|---|
| `state-db-schema` | state.db is missing required tables. | Re-run `akm bundle create`; a fresh/older DB was opened. |
| `state-db-round-trip` | Append/read probe against state.db failed. | Check disk/permissions on the state.db path; the store is unwritable. |
| `task-log-backing` | task_history rows reference log files missing on disk. | Logs were pruned/moved out from under the DB; safe to ignore if intentional, else restore the log dir. |
| `active-runs` | A task run has exceeded the stale threshold (>15 min). | Inspect with `akm task history`; a lane is likely wedged — kill/re-run it. |
| `default-engine` | The configured general default agent, SDK, or LLM engine is missing or incomplete. | Correct `defaults.engine`; SDK operation requires the `opencode` binary on PATH (the npm SDK is an HTTP client and spawns `opencode serve`), while a fallback LLM is checked only when configured. |
| `model-map-files` | The installed or optional user `models.json` is missing, unreadable, or invalid. | Repair the installation for an installed-map failure; remove or correct the user overlay for a warning. |
| `selected-model-aliases` | A known selected alias lacks a mapping for its selected engine. Unknown model strings remain exact pass-through identifiers. | Add the missing alias/engine entry or select an exact model ID. |
| `default-llm-engine` | The independently configured LLM default is missing, incompatible, or lacks a required credential. | Correct `defaults.llmEngine`, its connection, and any symbolic credential binding. |
| `configured-engines` | Checks every explicitly configured engine and aggregates its deterministic availability. | Repair engines whose safe status is `warn`; no configured engines yields `unknown`. |
| `active-improve-strategy` | An enabled process in the effective improve strategy cannot resolve its engine or required credential. | Inspect the named unavailable process, then correct its process override, strategy triage engine, SDK fallback, or default LLM. |
| `task-fail-rate` | ≥5% of scheduled task runs failed in the window (exit 143/70 recurring). | Triage as a bug: `akm task doctor`, inspect failing lane logs; exit-143 = killed/timeout, exit-70 = internal error. |
| `stash-git-exposure` | `env/` or `secrets/` assets are git-tracked **and** a remote is set — `git push` can leak keys. | `git rm --cached` the files, add `env/`+`secrets/` to `.gitignore` (a rule alone does not untrack). |
| `semantic-search-runtime` | Semantic search is blocked; often a configured remote embedding endpoint is down. | Restore the endpoint, or set `semanticSearchMode` to `off`, or drop `embedding.endpoint` to use the local model. |
| `session-extraction` | Extraction ran but hit harness errors or produced zero proposals across ≥5 sessions. | Check the agent CLI and session-log source; extraction is degraded, not failing hard. |
| `pool-saturation` | <2% of the session pool was new — possible discovery/dedup bug. | Verify `akm proposal extract` still finds new sessions; a healthy steady state sits above 10%. |
| `auto-accept-validation` | Proposals passed the confidence gate but failed validation (bad frontmatter, truncation). | Review the affected pending proposals via `akm proposal list`; they were held, not lost. |
| `session-log-failures` | Informational only (pre-LLM keyword scan, false-positive prone). | No action — never gates; does not reflect the real extract pipeline. |
| `outcome-proxy-adequacy` | Retrieval proxy is *inverted* (corr < −0.3): popular assets are the most-needing-improvement. | Known WS-2 limitation; no live action — see plan §WS-2 / CONTEXT before tuning. |
| `outcome-proxy-dead` | Retrieval proxy is *dead* (\|corr\| < 0.1 at n≥500): outcome_score is noise. | **Adjudicated/expected** during the minting-shutdown re-baseline (12-D1); no action. |
| `salience-uniformity-collapse` | Gini across all positive, resolvable retrieval-salience values is below 0.08 — ranking no longer discriminates among assets with retrieval evidence. | Inspect the reported sample size and salience freshness; run `akm index` to refresh retrieval timestamps, then let the improve schedule recompute salience before tuning weights. |
| `enrichment-lane-minting` | Enrichment lanes minted new assets above threshold (5% warn / higher = fail). | Adjudicated against the ratified minting rules; act only if the share keeps climbing post-shutdown. |
| `improve-churn-ratio` | Accepted proposals rewrote the same few refs (ratio > 1.5) instead of covering the corpus. | Expected while coverage is low; watch the trend, do not retune on a single window. |
| `collapse-churn-detector` | R5 detector fired collapse/churn alerts (or `unknown` = no cycle rows yet). | Inspect recent collapse/churn cycle rows and the detector's advisory output before acting. |

> Adjudicated states (`outcome-proxy-dead`, `enrichment-lane-minting`)
> are the before/after instrument for the 12-D1 minting shutdown — do not "fix" them by retuning.
> When in doubt, prefer no action over panic-retuning (per the review-12 guard).

## Engine and model advisories

`selected-model-aliases` warns when a known selected alias is missing the selected engine mapping.
It checks explicit string model selections on sorted
configured engines against the merged installed/user model map. Unknown model
identifiers are exact pass-through values and are not reported as missing. An
invalid model map makes this check `unknown` with generic evidence rather than
copying parser text or authored values.

`configured-engines` covers every explicitly configured engine. It reuses the
same availability result as the default-engine projections and reports sorted
safe evidence containing only engine name and status. All available engines
pass; any unavailable engine warns; no explicitly configured engines is
`unknown`.

These health checks make no network or provider call. Agent checks inspect
local binary availability; SDK checks inspect the package/binary and any
configured fallback; LLM checks validate local configuration and symbolic
credential availability without contacting the endpoint.

Health evidence never includes endpoint values.
Health evidence never includes exact model IDs.
Health evidence never includes credential values.
Health evidence never includes provider output.

The salience Gini guardrails are calibrated against distribution shape, not a
top-ranked quantile: near-uniform `0.49/0.51` scores produce about `0.01`, a
balanced `0.25/0.75` spread produces `0.25`, and one dominant score among nine
`0.01` scores produces about `0.82`. Read-only full-observation snapshots were
also stable inside the neutral `0.08..0.35` band: `0.2613` across 1,209 assets
on 2026-07-12 and `0.2506` across 1,454 non-missing assets on 2026-08-17.
