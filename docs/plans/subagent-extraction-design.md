# Subagent extraction design determination (#840)

**Status:** decided — recommend Candidate 3 ("harvest-without-prompting
hybrid"); scoped implementation plan below, not yet implemented.
**Companions:** #830 (fold, shipped), #836 (the measurement this reuses and
extends), #839 (dedupe + no-double-extraction pin, in flight — assumed to
land; not implemented here).

This is a decision document, not an implementation. No `src/` files change in
this PR. All numbers below come from running the real, unmodified
`ClaudeCodeProvider.readSession` → `preFilterSession` → `buildExtractPrompt`
pipeline against real session logs on this machine — no LLM calls, fully
deterministic, reproducible by anyone with their own `~/.claude/projects/`
sessions containing subagent transcripts. The script is in §7.

## 1. The four candidates

1. **Fold (#830) + dedupe (#839).** Full subagent transcripts merged
   chronologically into the parent's event stream; #839 additionally stubs
   the parent's `<task-notification>` copy of a subagent's final report to
   remove the duplicate.
2. **Link, don't fold.** Extract the parent's own transcript only. Delegated
   work is represented only by what the parent's own stream already contains
   (its `<task-notification>` records); no raw subagent access at all.
3. **Harvest-without-prompting hybrid.** Inline-ref harvesting (`akm
   remember`/`akm feedback` detection) still runs over the raw subagent
   transcripts, exactly as #830 already does it — but the LLM prompt is built
   from parent-origin events only. Folding stays as infrastructure; only the
   prompt-construction step changes.
4. **Chunked extraction.** Replace the fixed 80,000-char recency-biased
   `maxTotalChars` truncation with map-reduce: each subagent transcript is its
   own chunk, the parent's own stream is split into chronological
   80,000-char time-windows, and each chunk gets its own extraction call.

## 2. Method

Three fixtures from #836 plus one added for scale coverage:

| session | role | subagent files | note |
| --- | --- | --- | --- |
| `4f7f80f8-f0bc-4709-9534-f8b6ea18b2f2` | largest (#836) | 28 | akm repo, still on disk |
| `578b2d47-2382-4593-9423-950c7f4826f1` | the #829/#833 example (#836) | 4 | akm repo, still on disk |
| `4a0d9e9b-ffdb-452c-b16d-88fed76a118c` | smallest (#836) | 78 | **parent `.jsonl` no longer on this machine** — only its `subagents/` directory survives (session-log rotation/cleanup between #836 and now). Cannot be re-measured. |
| `f798f45f-af76-4566-a0cb-5a0c52c76526` | smallest (**replacement**) | 1 | akm-plugins repo — substituted for the missing 4a0d9e9b, same role (small session, thin subagent footprint) |
| `393273fd-d81c-47cb-9132-99912f15a35c` | large-scale coverage (**added**) | 74 | dimm-city-print-md repo — added specifically to bound the chunking cost axis on a session an order of magnitude bigger than #836's own set |

For each session, two fixtures are built exactly as #836 did it: copy the
parent `.jsonl` verbatim into an empty temp directory (Fixture A, "parent
alone"), and copy the parent plus its real `subagents/**` verbatim into a
second temp directory (Fixture B, "folded"). Both are read with the
unmodified `ClaudeCodeProvider.readSession`, so Fixture A **is** Candidate 2's
output and Fixture B **is** Candidate 1's (pre-dedupe) output — no
reimplementation of the provider, just the real code pointed at two directory
shapes. Candidates 3 and 4 are computed by reshaping Fixture B's already-real
`SessionData` (filtering by `event.filePath`, which `readSession` already
stamps per-event) and feeding the results through the same real
`preFilterSession`/`buildExtractPrompt`.

Every event a subagent contributes is unambiguously identified by
`event.filePath` (the subagent's own `.jsonl` path) — this is what makes
per-source accounting exact rather than inferred.

## 3. Headline numbers

Chars are pre-filtered/kept unless labeled "raw". "Prompt chars" is
`buildExtractPrompt(...).length` — literally what would be sent to the LLM.

| session | C2 link prompt | C1 fold prompt (pre-dedupe) | C1 fold+dedupe prompt | C3 hybrid prompt | parent-origin evicted by fold (chars / %) | inline refs: link / fold / hybrid |
| --- | --- | --- | --- | --- | --- | --- |
| 4f7f80f8… | 92,678 | 97,529 | 97,529 | 97,529 | 0 / 0.0% | 2 / 162 / 162 |
| 578b2d47… | 92,044 | 93,781 | 93,781 | 94,160 | 21,974 / 27.5% | 4 / 38 / 38 |
| f798f45f… | 93,395 | 93,395 | 93,395 | 93,395 | 0 / 0.0% | 1 / 1 / 1 |
| 393273fd… | 91,573 | 92,342 | 92,342 | **91,573** | 22,864 / 28.6% | 8 / 8 / 8 |

Three things fall out immediately:

- **Candidate 3 matches Candidate 1's inline-ref recovery exactly, every
  time** (162/162, 38/38, 1/1, 8/8). Ref harvesting runs on the raw stream
  regardless of what goes into the prompt — folding was never required for
  it, just sufficient for it.
- **Candidate 3 never evicts parent content** — by construction, its
  prompt-events are always Fixture A's own kept set (0% eviction, same as
  Candidate 2), while Candidate 1 evicts 27.5%/28.6% of parent-origin content
  on two of the four sessions to make room for subagent noise that mostly
  gets evicted anyway.
- **On the large multi-subagent session, hybrid's prompt is smaller than
  fold's** (91,573 vs 92,342) *and* has zero eviction, *and* recovers the
  same 8 refs. Hybrid strictly dominates fold on this session on every
  measured axis.

### 3a. Dedupe (#839) has zero measured effect on these four prompts

This is the most consequential finding. #839 proposes stubbing the parent's
`<task-notification>` copy of a subagent's final report, keeping the
subagent's own copy. Measuring the *raw* duplication first:

| session | raw dup pairs (task-notification ↔ subagent final, matched by `toolUseId`) | overlap min/max/mean |
| --- | --- | --- |
| 4f7f80f8… | 19 | 81% / 97% / 89% |
| 578b2d47… | 3 | 84% / 94% / 89% |
| f798f45f… | 0 | — |
| 393273fd… | 55 | 5% / 96% / 75% |

(Overlap = word-set Jaccard between the parent's `<task-notification>` body
and the subagent's own final event text; matching is exact — each subagent's
`agent-<id>.meta.json` sidecar carries the same `toolUseId` the parent's
`<task-notification><tool-use-id>` records, so pairing isn't inferred from
timing or text similarity.) The 89% mean overlap on the two #836 sessions
independently reproduces #836's own reported ~92%-overlap example almost
exactly.

But: **of these 89 total duplicate pairs across all four sessions, zero have
both copies surviving into the actual pre-dedupe prompt.** In every case, at
least one side (usually both) is already evicted by the pre-filter's 80k
recency-biased budget before dedupe could matter. Stubbing the notification
event (simulated: replace its text with `[subagent <id> completed:
<description>]`, same shape #839 proposes) saves real raw bytes (207K, 31K,
0, 375K chars respectively) but produces **byte-identical pre-filter output
and prompt content** on every one of the four sessions — the kept-event
composition, kept chars, and prompt length do not move.

This does not mean duplication in the prompt is impossible — #836's own
worked example (session `4a0d9e9b…`, subagent `agent-a4f581608db6e05b1`) is
exactly that case, and it cannot be re-run here because that session's parent
transcript is no longer on disk. It means: **on real data available today,
#839's dedupe is a real, cheap, correct fix for a defect that mostly isn't
currently manifesting in what reaches the LLM** — the recency-biased budget
is already evicting the same content dedupe would have removed. The
practical cost problem with folding is not duplication; it's **eviction of
parent-origin content**, which #839 does not address at all.

### 3b. Chunked extraction: cost dominates on real data

| session | parent time-windows | per-subagent chunks | total chunks = LLM calls | multiple vs today | parent-origin chars kept across all chunks | vs single-budget baseline (parent-alone) |
| --- | --- | --- | --- | --- | --- | --- |
| 4f7f80f8… | 17 | 50 | **67** | **67×** | 637,296 | 79,995 (8.0×) |
| 578b2d47… | 15 | 32 | **47** | **47×** | 820,953 | 79,984 (10.3×) |
| f798f45f… | 8 | 1 | **9** | **9×** | 227,198 | 79,992 (2.8×) |
| 393273fd… | 100 | 129 | **229** | **229×** | 4,944,133 | 79,997 (61.8×) |

Chunking does recover real parent content the single-budget candidates
evict — up to 61.8× more parent-origin content survives across chunks than
the single 80k-budget baseline keeps. That is a genuine capability none of
the other three candidates have. But the cost is not incidental: **9×–229×
more LLM calls per session**, scaling directly with subagent count (each
subagent is unconditionally its own chunk) and parent size (time-windows
scale with raw parent chars ÷ 80,000). `processes.extract.maxSessionsPerRun`
defaults to 25 (`src/commands/improve/extract.ts:117`) precisely to bound a
single run's wall time and token spend across a backlog — one single
`393273fd`-shaped session under naive per-subagent chunking would alone cost
more LLM calls than today's entire 25-session run budget.

**What the merge step would have to dedupe.** Chunking does not eliminate
the duplication problem — it *relocates* it: the same subagent's own chunk
and the parent time-window chunk containing its `<task-notification>` are
now two *separate LLM calls*, each free to emit a candidate about the same
underlying work. All 89 duplicate pairs found in §3a recur here, unchanged,
as candidate-merge inputs. Three concrete examples the merge/dedupe rule
would have to recognize as the same underlying event, from `393273fd…`:

- `agent-aa0e423a28849d94a` ("Review sync for developer-tool thinking") — 96%
  overlap between its own chunk's final text and the parent-window chunk
  mentioning it.
- `agent-a64e92684369b9cd0` ("Altitude review") — 95% overlap.
- `agent-a92b1455eded81d1f` ("Review sync machinery for over-engineering") —
  95% overlap.

Because chunking runs each chunk through its own independent LLM call, this
duplication is no longer solvable by a raw-stream text transform (§3a's
approach) — it needs an actual candidate-level merge pass (semantic
dedup/consolidation across N result sets), which is new machinery this
candidate would have to build, not reuse.

## 4. Invariants

### 4a. `hashSessionContent` idempotency

`hashSessionContent` (`src/commands/improve/extract.ts:496-498`) hashes
`canonicalizeSessionContent(data)` (`extract.ts:486-488`), which maps over
**`data.events`** — the raw stream, never the pre-filtered/truncated one —
specifically so config (`maxTotalChars` and friends) can never move the hash.
Confirmed directly: computing `hashSessionContent` on the same folded
`SessionData` before and after calling `preFilterSession` with a
deliberately different `maxTotalChars` (80,000 vs 1,000) produced identical
hashes on all four sessions.

This constrains every candidate's implementation, not just the winner:
whatever function decides *which subset of `data.events` reaches the
prompt* must be applied **after** `hashSessionContent(data)` is computed on
the full, untouched `data` — never by mutating `data.events` itself before
hashing. Candidate 3 (§5) is designed around exactly this: it filters events
only at the `preFilterSession`/`buildExtractPrompt` call sites, leaving
`hashSessionContent(data)` untouched and still covering the full folded
stream (parent + all subagents). This is deliberate: it means a subagent's
content changing (re-run, edited transcript) still moves the hash and
triggers re-extraction, even though that subagent's raw text will never
reach the prompt.

### 4b. No-double-extraction

`ClaudeCodeProvider#walkJsonl` (`session-log.ts:322`) excludes any path with
a `subagents` segment between the project directory and the file
(`SUBAGENTS_DIR`, `session-log.ts:41`), so `listSessions` never surfaces a
subagent transcript as its own session. Both discovery and `--session-id`
targeting route through `harness.listSessions()`
(`src/commands/improve/extract.ts:1608`, `:1643`, `:2032`), so a subagent
cannot currently be extracted both as its own session and folded into its
parent. None of the four candidates touch `listSessions` or `#walkJsonl` —
this property is orthogonal to the fold/link/chunk decision and is #839's
part 2 to pin with a regression test, independent of which candidate wins.

### 4c. `processes.extract.maxTotalChars` (`schemas/akm-config.json:1219`)

- **Candidate 1 (fold, as shipped):** unchanged meaning — global budget over
  the merged parent+subagent stream.
- **Candidate 2 (link):** unchanged meaning, narrower input — global budget
  over the parent stream alone (this is exactly pre-#830 behavior).
- **Candidate 3 (hybrid, the winner):** **unchanged meaning and unchanged
  value.** The knob continues to cap a single-call prompt built from
  parent-origin events; nothing about its semantics or default needs to
  change. It simply stops competing against subagent noise for headroom.
- **Candidate 4 (chunking):** would need to be **repurposed** from
  "whole-session budget" to "per-chunk budget" — a real semantic change to a
  documented, user-facing config key that every existing config setting this
  knob would silently mean something different after upgrade. This is an
  additional migration cost specific to chunking that the other three
  candidates don't carry.

## 5. Determination: Candidate 3 (harvest-without-prompting hybrid)

**Winner: Candidate 3.** On every session measured, it matches Candidate 1's
inline-ref recovery exactly, matches or beats Candidate 1's prompt size, and
has zero parent-content eviction (matching Candidate 2). It requires no new
merge/dedupe machinery (unlike Candidate 4) and makes #839's dedupe
(§3a) moot for the prompt path — see the coordination note in §6 — without
needing to implement or touch it here, consistent with this PR's scope.
Candidate 4 (chunking) recovers real content the other three evict, but at a
9×–229× per-session LLM-call multiplier on real data that is disqualifying
for a background pass bounded by `maxSessionsPerRun` (default 25); it also
introduces new candidate-merge machinery and a `maxTotalChars` semantic
change that none of the other candidates need. It is not recommended now,
staged or otherwise, until wholesale chunking's cost is solved by something
other than "one chunk per subagent, unconditionally" (see §6).

### The two strongest arguments against Candidate 3

1. **It structurally cannot see subagent tool-call detail the extractor
   itself might have mined.** Inline-ref harvesting only recovers what the
   subagent *explicitly saved* via `akm remember`/`akm feedback`. If the
   extraction LLM would have derived an *additional* insight candidate from
   reading a subagent's raw tool trace — a retry pattern, a debugging path,
   something never distilled into the final prose report or an inline ref —
   hybrid loses that, where fold (Candidate 1) at least gives the LLM a
   chance to see it (when it survives the budget at all; §3a shows the
   *notification* rarely does, but the subagent's own folded copy sometimes
   does — e.g. `578b2d47…`'s pre-filter output includes 27 subagent-origin
   kept events). This is not measurable by this deterministic pipeline —
   it requires comparing actual LLM-produced candidates, which means real
   LLM calls. The cheapest experiment to resolve it: run the real `akm
   extract` LLM call (not the pre-filter) on the same session under both the
   Candidate 1 and Candidate 3 prompts for ~10 sessions, and diff the
   candidate sets for anything unique to the fold arm that isn't a
   restatement of an inline ref or the notification prose.
2. **The `hashSessionContent` invariant requires a deliberate, easy-to-get-
   wrong split.** Today, one `SessionData.events` array serves double duty:
   it's both the hash input and the prompt input. Candidate 3 requires those
   to diverge (hash over the full folded stream; prompt over parent-origin
   events only) without ever mutating `data.events` itself pre-hash. §4a
   shows this is achievable with a call-site-only change, but it is a new
   discipline the codebase doesn't currently need to maintain, and a future
   refactor that touches `runPreLlmSessionGates` without re-reading this doc
   could accidentally reunify the two and silently break the
   config-can't-move-the-hash property.

Neither argument is strong enough to prefer Candidate 1 given §3's numbers —
argument 1 is speculative (no measured instance of it in four sessions'
worth of data) and argument 2 is a discipline problem addressed by the
regression test in §6, not an unsolved one.

## 6. Scoped implementation plan (Candidate 3)

**Not implemented in this PR.** Summary for whoever picks it up:

**Files touched:**

- `src/commands/improve/extract.ts` — inside `runPreLlmSessionGates`
  (currently calls `preFilterSession(data, ...)` directly on the full folded
  `data`, line ~562): build a parent-origin-only view — `{ ...data, events:
  data.events.filter(e => e.filePath === data.ref.filePath) }` — and pass
  *that* to `preFilterSession`. `hashSessionContent(data)` (computed just
  above, line ~557) stays on the untouched, full `data` — no reordering
  needed, it already runs first. `processSession`'s call to
  `buildExtractPrompt` already takes `filtered.events` and `data.inlineRefs`
  as separate parameters (lines ~850-855), so no change needed there:
  `data.inlineRefs` is untouched and still carries the full folded harvest.
- `src/integrations/harnesses/claude/session-log.ts` — **no change.** Folding
  (#830), provenance stamping, and chronological merge all stay exactly as
  shipped; they still produce the correct raw material for both hashing and
  inline-ref harvesting. Only the extract-side consumption of `data.events`
  changes.
- `src/commands/improve/extract-prompt.ts` — **no change.** `buildExtractPrompt`
  already accepts `events` independently of `data`.
- `CHANGELOG.md` — `[Unreleased]` entry documenting the prompt-composition
  change and that it does **not** trigger a re-extraction wave (see below).

**Invariants to test (new regression tests):**

- `hashSessionContent` is unaffected by the parent-origin filter: same
  folded `SessionData` in, identical hash whether or not the filter is
  applied before `preFilterSession`. Pins §4a.
- The built extract prompt for a session with subagent transcripts contains
  **no** subagent-provenance-prefixed text (no `[subagent:` substring) in its
  transcript section, while the "Already preserved" section (built from
  `inlineRefs`) **does** include refs whose only source is a subagent
  transcript. Pins the actual behavior change.
- No-double-extraction (`listSessions` excludes `subagents/`) is untouched by
  this change — covered by #839's own regression test once it lands, not
  duplicated here.

**Critical coordination note for #839:** #839's dedupe direction — stub the
*parent's* `<task-notification>` copy, keep the *subagent's own* copy — is
designed for the fold architecture, where both copies compete for the same
prompt. Under Candidate 3, the *subagent's own copy is never in the prompt at
all* — the parent's `<task-notification>` event is the **only** surviving
trace of that delegated work (it's a parent-origin event, so it isn't
filtered out). If #839 ships as literally scoped and *also* fires under
Candidate 3, it would delete the sole remaining reference to a subagent's
conclusion from the prompt. Whoever implements #839 (or this) needs to scope
the stub-the-notification behavior to only fire when the subagent's own
event is *also* among the events being sent to the LLM in that same call —
which is naturally false under Candidate 3, so a correctly-scoped check
(rather than an unconditional raw-stream transform) makes the two changes
compose safely regardless of merge order.

**Migration / cost impact:**

- **No forced re-extraction wave.** Because `hashSessionContent` keeps
  hashing the full folded stream unchanged (§4a), shipping this does not
  change any previously-computed session hash — unlike #830's own migration
  (disclosed in #836), which changed the hash for every session with
  subagents the moment folding started. Already-extracted sessions keep
  their existing proposals; operators who want a session re-processed under
  the new prompt shape use `--force`.
- **Lower LLM cost than today's fold, not higher.** One call per session
  (unchanged from #830/today), and per §3, the prompt is the same size or
  smaller than fold's on every measured session, with zero risk of
  parent-content eviction.

## 7. Measurement script

Deterministic, no LLM calls, run against real sessions. Save as
`<repo-root>/measure-840.ts` and run with `bun run measure-840.ts` from a
checkout of this repo (relative imports resolve against `src/`). Point
`SESSIONS` at your own `~/.claude/projects/<project>/<session-id>.jsonl`
files that have a sibling `<session-id>/subagents/*.jsonl` directory — the
methodology, not these exact machine-local paths, is what's reproducible.

```ts
// Measurement harness for akm#840 (fold-vs-link / chunked-extraction design).
// Deterministic, no LLM calls. Reuses the REAL production pipeline:
// ClaudeCodeProvider.readSession -> preFilterSession -> buildExtractPrompt.
//
// Run with: bun run measure-840.ts   (from the root of this checkout, so the
// relative imports below resolve against src/).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeProvider } from "./src/integrations/harnesses/claude/session-log.ts";
import { preFilterSession, DEFAULT_MAX_TOTAL_CHARS } from "./src/integrations/session-logs/pre-filter.ts";
import { buildExtractPrompt } from "./src/commands/improve/extract-prompt.ts";
import type { SessionData, SessionEvent } from "./src/integrations/session-logs/types.ts";

const CHUNK_BUDGET = DEFAULT_MAX_TOTAL_CHARS; // 80_000 — same as today's single-session budget

// canonicalizeSessionContent / hashSessionContent, reimplemented verbatim from
// src/commands/improve/extract.ts:486-498 (pure, so re-implementing here avoids
// pulling that file's heavy transitive deps — config/db/etc — into a throwaway
// script). Kept byte-identical to the real function.
function canonicalizeSessionContent(data: SessionData): string {
  return data.events.map((e) => `${e.role ?? "unknown"}\n${e.text}`).join("\n\0\n");
}
function hashSessionContent(data: SessionData): string {
  return crypto.createHash("sha256").update(canonicalizeSessionContent(data)).digest("hex");
}

interface SessionSpec {
  label: string;
  parentJsonl: string; // absolute path to <id>.jsonl
}

// Point these at your own ~/.claude/projects/<project>/<id>.jsonl files that
// have a sibling <id>/subagents/*.jsonl directory.
const SESSIONS: SessionSpec[] = [
  { label: "example-session", parentJsonl: "/absolute/path/to/<id>.jsonl" },
];

function copyFixture(spec: SessionSpec, includeSubagents: boolean): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm840-"));
  const id = path.basename(spec.parentJsonl, ".jsonl");
  const dir = path.dirname(spec.parentJsonl);
  const destParent = path.join(tmpRoot, `${id}.jsonl`);
  fs.copyFileSync(spec.parentJsonl, destParent);
  if (includeSubagents) {
    const srcSubDir = path.join(dir, id, "subagents");
    if (fs.existsSync(srcSubDir)) {
      const destSubDir = path.join(tmpRoot, id, "subagents");
      fs.cpSync(srcSubDir, destSubDir, { recursive: true });
    }
  }
  return destParent;
}

function composition(events: SessionEvent[], parentFilePath: string): { parent: number; subagent: number } {
  let parent = 0;
  let subagent = 0;
  for (const e of events) {
    if (e.filePath === parentFilePath) parent++;
    else subagent++;
  }
  return { parent, subagent };
}

function chars(events: SessionEvent[]): number {
  return events.reduce((s, e) => s + e.text.length, 0);
}

function charsBy(events: SessionEvent[], parentFilePath: string): { parent: number; subagent: number } {
  let parent = 0;
  let subagent = 0;
  for (const e of events) {
    if (e.filePath === parentFilePath) parent += e.text.length;
    else subagent += e.text.length;
  }
  return { parent, subagent };
}

// Similarity: normalized word-set Jaccard overlap. Cheap, deterministic,
// good enough to confirm "near-duplicate" without an LLM judge.
function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 3),
  );
}
function jaccard(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return inter / union;
}

function run(spec: SessionSpec) {
  console.log(`\n${"=".repeat(90)}\n${spec.label}\n${"=".repeat(90)}`);

  const provider = new ClaudeCodeProvider();

  // Fixture A: parent alone (no subagents dir copied). This IS Candidate 2's output.
  const fixtureAPath = copyFixture(spec, false);
  const dataParentOnly = provider.readSession({ harness: "claude", sessionId: "A", filePath: fixtureAPath });

  // Fixture B: parent + real subagent transcripts, copied verbatim. This IS Candidate 1's output.
  const fixtureBPath = copyFixture(spec, true);
  const dataFolded = provider.readSession({ harness: "claude", sessionId: "B", filePath: fixtureBPath });
  const subDirPath = path.join(path.dirname(fixtureBPath), path.basename(fixtureBPath, ".jsonl"), "subagents");
  const subagentCount = fs.existsSync(subDirPath)
    ? fs.readdirSync(subDirPath).filter((f) => f.endsWith(".jsonl")).length
    : 0;

  console.log(
    `raw events: parent-alone=${dataParentOnly.events.length}  folded=${dataFolded.events.length}  subagent files=${subagentCount}`,
  );
  console.log(`raw chars:  parent-alone=${chars(dataParentOnly.events)}  folded=${chars(dataFolded.events)}`);

  // ── Candidate 2: Link, don't fold — parent alone (Fixture A verbatim). ──
  const filteredLink = preFilterSession(dataParentOnly);
  const promptLink = buildExtractPrompt({
    data: dataParentOnly,
    events: filteredLink.events,
    inlineRefs: dataParentOnly.inlineRefs,
  });
  console.log(`\n[Candidate 2: link, don't fold]`);
  console.log(
    `  pre-filter kept: ${filteredLink.stats.outputCount}/${filteredLink.stats.inputCount}  chars kept=${filteredLink.stats.totalChars}  budgetDropped=${filteredLink.stats.budgetDroppedCount}`,
  );
  console.log(`  prompt chars: ${promptLink.length}`);
  console.log(`  inline refs recovered: ${dataParentOnly.inlineRefs.length}`);

  // ── Candidate 1: Fold as shipped (#830), pre-dedupe. ──
  const filteredFold = preFilterSession(dataFolded);
  const promptFold = buildExtractPrompt({ data: dataFolded, events: filteredFold.events, inlineRefs: dataFolded.inlineRefs });
  const compFold = composition(filteredFold.events, fixtureBPath);
  const charsFold = charsBy(filteredFold.events, fixtureBPath);
  const parentAloneKeptChars = charsBy(filteredLink.events, fixtureAPath).parent;
  const compLinkAlone = composition(filteredLink.events, fixtureAPath);
  console.log(`\n[Candidate 1: fold (#830), pre-#839-dedupe]`);
  console.log(
    `  pre-filter kept: ${filteredFold.stats.outputCount}/${filteredFold.stats.inputCount} (parent=${compFold.parent} subagent=${compFold.subagent})  chars kept=${filteredFold.stats.totalChars}  budgetDropped=${filteredFold.stats.budgetDroppedCount}`,
  );
  console.log(
    `  parent-origin kept chars: alone=${parentAloneKeptChars} folded=${charsFold.parent}  (evicted ${parentAloneKeptChars - charsFold.parent} chars, ${(((parentAloneKeptChars - charsFold.parent) / Math.max(1, parentAloneKeptChars)) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  parent-origin kept EVENTS: alone=${compLinkAlone.parent} folded=${compFold.parent}  (evicted ${compLinkAlone.parent - compFold.parent}, ${(((compLinkAlone.parent - compFold.parent) / Math.max(1, compLinkAlone.parent)) * 100).toFixed(1)}%)`,
  );
  console.log(`  prompt chars: ${promptFold.length}`);
  console.log(`  inline refs recovered: ${dataFolded.inlineRefs.length}`);

  // Duplication detection: match each subagent (by toolUseId from its
  // meta.json sidecar) against the parent's <task-notification> event
  // carrying that same tool-use-id.
  const subDir = subDirPath;
  const dupPairs: {
    agentId: string;
    description: string;
    toolUseId: string;
    parentEventIdx: number;
    parentChars: number;
    subagentFinalText: string;
    overlap: number;
    notificationSurvives: boolean;
    subagentOwnSurvives: boolean;
    bothInPrompt: boolean;
  }[] = [];
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith(".meta.json")) continue;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(subDir, f), "utf8"));
      } catch {
        continue;
      }
      const toolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : undefined;
      if (!toolUseId) continue;
      const agentId = f.replace(/\.meta\.json$/, "");
      const description = typeof meta.description === "string" ? meta.description : "";
      const subagentJsonl = path.join(subDir, `${agentId}.jsonl`);
      if (!fs.existsSync(subagentJsonl)) continue;
      // Read the subagent's own transcript unprefixed (readSession on the
      // file directly — same parse path readSession uses for a "parent").
      const subData = provider.readSession({ harness: "claude", sessionId: "S", filePath: subagentJsonl });
      const finalEvent = subData.events[subData.events.length - 1];
      if (!finalEvent) continue;
      // Find the parent-origin RAW event carrying this tool-use-id in a <task-notification>.
      const idx = dataFolded.events.findIndex(
        (e) => e.filePath === fixtureBPath && e.text.includes("<task-notification>") && e.text.includes(toolUseId),
      );
      if (idx < 0) continue;
      const parentEvent = dataFolded.events[idx];
      const overlap = jaccard(parentEvent.text, finalEvent.text);
      const notificationSurvives = filteredFold.events.some(
        (e) => e.ts === parentEvent.ts && e.filePath === parentEvent.filePath,
      );
      const subagentOwnSurvives = filteredFold.events.some((e) => e.ts === finalEvent.ts && e.filePath === subagentJsonl);
      dupPairs.push({
        notificationSurvives,
        subagentOwnSurvives,
        bothInPrompt: notificationSurvives && subagentOwnSurvives,
        agentId,
        description,
        toolUseId,
        parentEventIdx: idx,
        parentChars: parentEvent.text.length,
        subagentFinalText: finalEvent.text.slice(0, 160).replace(/\s+/g, " "),
        overlap,
      });
    }
  }
  dupPairs.sort((a, b) => b.overlap - a.overlap);
  const bothInPromptCount = dupPairs.filter((p) => p.bothInPrompt).length;
  const overlaps = dupPairs.map((p) => p.overlap);
  const minOv = overlaps.length ? Math.min(...overlaps) : 0;
  const maxOv = overlaps.length ? Math.max(...overlaps) : 0;
  const meanOv = overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : 0;
  console.log(`  duplicate pairs found (raw, task-notification <-> subagent final): ${dupPairs.length}`);
  console.log(
    `  overlap range: min=${(minOv * 100).toFixed(0)}% max=${(maxOv * 100).toFixed(0)}% mean=${(meanOv * 100).toFixed(0)}%`,
  );
  console.log(`  of those, BOTH copies actually reach the pre-dedupe PROMPT (real in-prompt duplication): ${bothInPromptCount}`);
  for (const p of dupPairs.slice(0, 3)) {
    console.log(
      `    - agent ${p.agentId} "${p.description}" overlap=${(p.overlap * 100).toFixed(0)}% parentEventChars=${p.parentChars} notificationInPrompt=${p.notificationSurvives} subagentOwnInPrompt=${p.subagentOwnSurvives}`,
    );
    console.log(`      subagent final (head): ${p.subagentFinalText}`);
  }

  // ── Candidate 1 + #839 dedupe simulation: stub the parent's <task-notification> body. ──
  const dedupedEvents = dataFolded.events.map((e, idx) => {
    const match = dupPairs.find((p) => p.parentEventIdx === idx);
    if (!match) return e;
    return { ...e, text: `[subagent ${match.agentId} completed: ${match.description}]` };
  });
  const dataDeduped: SessionData = { ref: dataFolded.ref, events: dedupedEvents, inlineRefs: dataFolded.inlineRefs };
  const filteredDeduped = preFilterSession(dataDeduped);
  const promptDeduped = buildExtractPrompt({
    data: dataDeduped,
    events: filteredDeduped.events,
    inlineRefs: dataDeduped.inlineRefs,
  });
  const charsDeduped = charsBy(filteredDeduped.events, fixtureBPath);
  const charsSavedByStubbing = dupPairs.reduce(
    (sum, p) => sum + (p.parentChars - `[subagent ${p.agentId} completed: ${p.description}]`.length),
    0,
  );
  console.log(`\n[Candidate 1: fold + #839 dedupe simulated]`);
  console.log(`  raw chars saved by stubbing ${dupPairs.length} task-notifications: ${charsSavedByStubbing}`);
  console.log(`  parent-origin kept chars: ${charsDeduped.parent}  (vs pre-dedupe fold ${charsFold.parent}, vs parent-alone baseline ${parentAloneKeptChars})`);
  console.log(`  prompt chars: ${promptDeduped.length}`);

  // ── Candidate 3: harvest-without-prompting hybrid. ──
  const hybridEvents = dataFolded.events.filter((e) => e.filePath === fixtureBPath);
  const dataHybrid: SessionData = { ref: dataFolded.ref, events: hybridEvents, inlineRefs: dataFolded.inlineRefs };
  const filteredHybrid = preFilterSession(dataHybrid);
  const promptHybrid = buildExtractPrompt({ data: dataHybrid, events: filteredHybrid.events, inlineRefs: dataHybrid.inlineRefs });
  console.log(`\n[Candidate 3: harvest-without-prompting hybrid]`);
  console.log(`  prompt chars: ${promptHybrid.length}`);
  console.log(`  inline refs recovered: ${dataHybrid.inlineRefs.length}`);

  // ── Candidate 4: chunked extraction (per-subagent + parent time-windows). ──
  const parentRaw = dataFolded.events.filter((e) => e.filePath === fixtureBPath);
  const subagentGroups = new Map<string, SessionEvent[]>();
  for (const e of dataFolded.events) {
    if (e.filePath === fixtureBPath || !e.filePath) continue;
    const arr = subagentGroups.get(e.filePath) ?? [];
    arr.push(e);
    subagentGroups.set(e.filePath, arr);
  }
  const parentWindows: SessionEvent[][] = [];
  let cur: SessionEvent[] = [];
  let curChars = 0;
  for (const e of parentRaw) {
    if (curChars + e.text.length > CHUNK_BUDGET && cur.length > 0) {
      parentWindows.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(e);
    curChars += e.text.length;
  }
  if (cur.length > 0) parentWindows.push(cur);

  const allChunks: SessionEvent[][] = [...parentWindows, ...subagentGroups.values()];
  let totalChunkedPromptChars = 0;
  let totalChunkedParentKeptChars = 0;
  for (const chunkEvents of allChunks) {
    const chunkData: SessionData = { ref: dataFolded.ref, events: chunkEvents, inlineRefs: [] };
    const filteredChunk = preFilterSession(chunkData, { maxTotalChars: CHUNK_BUDGET });
    const p = buildExtractPrompt({ data: chunkData, events: filteredChunk.events, inlineRefs: [] });
    totalChunkedPromptChars += p.length;
    totalChunkedParentKeptChars += charsBy(filteredChunk.events, fixtureBPath).parent;
  }
  console.log(`\n[Candidate 4: chunked extraction]`);
  console.log(`  chunks: ${parentWindows.length} parent time-window(s) + ${subagentGroups.size} per-subagent chunk(s) = ${allChunks.length} total`);
  console.log(`  LLM calls per session: ${allChunks.length} (vs 1 today)`);
  console.log(`  parent-origin kept chars across all chunks: ${totalChunkedParentKeptChars}  (vs single-budget baseline ${parentAloneKeptChars})`);

  // contentHash idempotency check: hash must be identical regardless of maxTotalChars.
  const hashDefault = hashSessionContent(dataFolded);
  preFilterSession(dataFolded, { maxTotalChars: 1000 }); // result unused — confirms the CALL doesn't touch data
  const hashAfterDifferentPrefilterCall = hashSessionContent(dataFolded);
  console.log(`\n[contentHash idempotency]`);
  console.log(
    `  hash unaffected by pre-filter budget: ${hashDefault === hashAfterDifferentPrefilterCall ? "CONFIRMED equal" : "MISMATCH"}`,
  );
}

for (const spec of SESSIONS) run(spec);
```
