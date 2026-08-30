#!/usr/bin/env bash
#
# Integration-test runner: shards tests/integration across separate OS
# processes (min(nproc, 8) concurrent `bun test` processes), same rationale
# as scripts/test-unit.sh (see its header for why neither `--isolate` nor
# `--parallel` is ever passed). Serial single-process runs cost ~9.5 min of
# wall clock for ~570s of test time; sharding cuts that to roughly the
# slowest shard.
#
# Sharding is done by EXPLICIT round-robin file lists, NOT bun's `--shard`:
# on bun 1.3.x that flag only slices when the positional path is the test
# root (`./tests`, where it slices at the TEST level); with a subdirectory
# positional like `./tests/integration` it is SILENTLY IGNORED and every
# process runs the full suite concurrently — 4x the work plus same-file
# collisions on fixture paths. File-granular lists also guarantee each test
# file runs in exactly one process.
#
# Per-process isolation here is STRICTLY STRONGER than the previous
# single-process run (files no longer share process.env or module state with
# every sibling), and cross-file isolation is already required by
# scripts/lint-tests-isolation.ts.
#
# Usage:  scripts/test-integration.sh            # auto shards (min(nproc, 8))
#         TEST_SHARDS=4 scripts/test-integration.sh
set -uo pipefail

cores="$(nproc 2>/dev/null || echo 4)"
N="${TEST_SHARDS:-$cores}"
[ "$N" -gt 8 ] && N=8
[ "$N" -lt 1 ] && N=1

bun run sweep:tmp >/dev/null 2>&1 || true

# Deterministic file list; sort so every machine shards identically.
mapfile -t files < <(find tests/integration -name '*.test.ts' | sort)
total="${#files[@]}"

# Floor on tests actually executed (pass + skip), checked after aggregation.
# The files-ran cross-check below cannot see this: a file whose every test is
# skipped still counts toward `across N files`. The header above records the bun
# `--shard` incident where shards 2-4 ran ZERO tests at exit 0 — this is the
# same hole reached through skips instead of sharding (#795). Set below the
# current integration count with room for churn; raise it as the suite grows.
#
# P4 (docs/plans/specs/p4-deletions-closeout.md §5.3/P4-N5, row B-62):
# RAISED 5000 -> 5500. Measured at Lane C's commit: 5825 pass / 57 skip
# (executed 5882), after the deletion families (§3) removed
# tests/integration/tasks-scheduler-sync-v3.test.ts (23 tests) and
# tests/integration/tasks-scheduling-characterization.test.ts (3 tests) — see
# the commit body for the per-suite deleted-test table. P4-N5's formula:
# floor(executed * 0.95 / 100) * 100 = floor(5882 * 0.95 / 100) * 100 =
# floor(55.879) * 100 = 5500.
#
# #861: RAISED 5500 -> 5700. release/0.9.5 measured a clean-TMPDIR run at
# 5950 pass / 53 skip (executed 6003) across two consecutive full runs.
# Same formula: floor(6003 * 0.95 / 100) * 100 = floor(57.0285) * 100 =
# 5700. Headroom below the measured 6003 is intentional (#866 already
# showed the suite legitimately loses tests to dead-code removal); raise
# again as the suite grows, argue about lowering it in review.
MIN_TESTS="${AKM_MIN_INTEGRATION_TESTS:-5700}"
if [ "$total" -eq 0 ]; then
  echo "── integration: no test files found under tests/integration" >&2
  exit 1
fi
[ "$N" -gt "$total" ] && N="$total"

# Shard logs live in an announced directory (not anonymous mktemp files) so a
# hung or long run can be watched live: `tail -f <dir>/shard-*.log`. Honors
# $TMPDIR; kept on failure for diagnosis, removed on success.
logdir="$(mktemp -d "${TMPDIR:-/tmp}/akm-integration-shards.XXXXXX")"
echo "── integration: ${N} shards over ${total} files; live logs: ${logdir}/shard-N.log"

declare -a pids tmps
for k in $(seq 0 $((N - 1))); do
  slice=()
  for i in "${!files[@]}"; do
    [ $((i % N)) -eq "$k" ] && slice+=("${files[$i]}")
  done
  t="${logdir}/shard-$((k + 1)).log"
  tmps+=("$t")
  runtime_home="${logdir}/runtime-home-$((k + 1))"
  mkdir -p "$runtime_home"
  # 120s per-test (vs 30s serial): under N-way process contention a heavy test
  # can legitimately run 3-4x its solo duration; the timeout exists to catch
  # HANGS, not to police performance, and 30s flaked real passes under load.
  ( HOME="$runtime_home" bun test --timeout=120000 "${slice[@]}" >"$t" 2>&1 ) &
  pids+=($!)
done

# Wait for every shard; a non-zero shard exit fails the run.
rc=0
for p in "${pids[@]}"; do
  wait "$p" || rc=1
done

# Aggregate and surface results.
pass=0 fail=0 skip=0 filecount=0
for t in "${tmps[@]}"; do
  p="$(grep -oE '[0-9]+ pass' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  f="$(grep -oE '[0-9]+ fail' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  s="$(grep -oE '[0-9]+ skip' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  c="$(grep -oE 'across [0-9]+ files' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  pass=$((pass + ${p:-0}))
  fail=$((fail + ${f:-0}))
  skip=$((skip + ${s:-0}))
  filecount=$((filecount + ${c:-0}))
  # Surface any real failures from this shard — summary lines first, then the
  # full tail so assertion diffs survive aggregation (a flake with no diff is
  # undiagnosable).
  if [ "${f:-0}" != "0" ] || ! grep -qE '[0-9]+ pass' "$t"; then
    grep -E "\(fail\)|^error:|panic" "$t" | head -10 || true
    echo "── shard log tail (last 80 lines) ──"
    tail -80 "$t"
  fi
done

echo "── integration: ${pass} pass / ${skip} skip / ${fail} fail across ${N} process-shards (${filecount}/${total} files)"
# `filecount` counts files RAN, not tests executed — a file whose every test is
# skipped still contributes to `across N files`, so it clears that check while
# asserting nothing. Pin the executed+skipped total against a floor so a suite
# that silently loses tests fails instead of just reporting a smaller number
# nobody diffs (#795). Raise the floor when the suite legitimately grows;
# LOWERING it is the thing to argue about in review.
executed=$((pass + skip))
if [ "$executed" -lt "$MIN_TESTS" ]; then
  echo "── integration: only ${executed} tests ran+skipped, floor is ${MIN_TESTS} — tests disappeared rather than failed."
  rc=1
fi
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ] || [ "$filecount" -ne "$total" ]; then
  echo "── integration: shard logs kept for diagnosis: ${logdir}"
  exit 1
fi
rm -rf "$logdir"
exit 0
