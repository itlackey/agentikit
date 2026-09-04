# Search ranking and fragment indexing: brief for 0.9.14

**Status:** critically reviewed against `main` and the live milestone on
2026-09-04; execution is in progress on `release/0.9.14` via PR #939. Written
after #929 was implemented, measured, and held out of 0.9.13.
**0.9.14 scope:** #934, #933, #940, #930, and #937. #929 is resolved by rejection
after its measured zero-recall/large-precision regression. Semantic fragments
(#748) and graph expansion (#935/#936) move to 0.10.0.
**Companions:** [`benchmark-tuning-findings.md`](./benchmark-tuning-findings.md)
is the source of truth for every benchmark figure not measured here.
**Preserved negative result:** `issue/0.9.13-search` at `8c61f1f0` and draft
PR #931. Keep the branch as evidence; do not merge or reuse the union unless a
new measurement overturns the result below.

---

## 1. What happened, in one paragraph

#929 was filed as a recall bug: `searchFts` returned from the first FTS tier
that produced any hit, so a query whose strict conjunctive form matched one
document received exactly one document. The fix — union the tiers into a shared
pool up to `limit` — was implemented, reviewed, and then **measured against the
frozen corpora, where it produced zero recall gain and a large precision loss**.
It was held. The premise was wrong: the missing documents were not missing
because the pool was truncated. They were missing because they rank below the
cutoff, and they rank below the cutoff because the fact lives mid-body in a long
document. Widening the pool admits more non-evidence; it cannot promote evidence
that BM25 has already buried.

**Do not re-attempt #929 as a recall fix.** The cascade is an intentional
precision gate: strict conjunction first, relaxed OR only when strict retrieval
misses. Calling a progressive union “more correct” is a preference, not a
contract, and the only implementation tested produced no recall benefit. Close
#929 and PR #931 as a measured rejection. A future proposal may reopen the
decision only with a new failing user contract and an A/B that improves it.

## 2. The measured regression

Probed on `akm-eval`'s deterministic, LLM-free harness (`bin/probe <version>`),
`#931` branch against stock `release/0.9.12` as control. The pair matched on
recall and exposed the precision regression below. The absolute control values
also matched the then-committed reference, but #940/akm-eval PR #16 later proved
that saturated filename tie order made that historical reference unstable.
Preserve this as a paired result, not as the baseline for 0.9.14.

| metric | stock | with the #929 union | change |
|---|---|---|---|
| locomo `evidenceRecall@5` | 0.590 | 0.590 | **0** |
| locomo `recallAtK` | 0.497917 | 0.497917 | **0** |
| locomo `precisionAtK` | 0.232917 | 0.147500 | **−37%** |
| longmemeval `evidenceRecall@5` | 0.950 | 0.950 | **0** |
| longmemeval `recallAtK` | 0.950000 | 0.950000 | **0** |
| longmemeval `precisionAtK` | 0.676667 | 0.275000 | **−59%** |

Recall did not move by a single question. Every added candidate was
non-evidence.

**Be precise about what this proves.** Recall is unchanged and precision fell,
which means the added documents filled slots that were previously *empty* — the
union did not push evidence out of the result set. So the direct harm to answer
quality is the weaker half of the case: the same benchmark round found retrieved
noise correlates with correctness at only r = −0.078, while recall correlates at
+0.42. The strong half of the case is that **the change delivered exactly none of
the benefit it was built for**, and cost two other things:

1. Precision, as above.
2. Ranking expressiveness. `tests/integration/graph/graph-boost-ranking.test.ts`
   "maxHops=2 enables bounded multi-hop boost" fails on the branch with
   `Expected: > 1 / Received: 1`. Both hop distances saturate the score clamp.
   The graph boost is applied and has no headroom to express anything. On query
   `"database outage recovery"`, three of four results are pinned at exactly
   `1.0`.

Three costs, zero benefit. That is the whole argument for holding it.

One test failure on that branch is **not** a regression and has been
mischaracterised once already:
`tests/integration/commands/improve-memory.test.ts` "prefers the current derived
memory" still passes its headline assertion at position 0. Only the runner-up
changed, because a parent memory that the starvation bug used to hide now
legitimately surfaces. It is not evidence against the experiment, but #929 is
rejected on corpus results and the main-branch assertion should remain unchanged.

## 3. Root cause and milestone disposition

#933, #940, #930, and #937 address different parts of a retrieval pipeline that cannot
reliably surface a fact stated in the middle of a long document. #934 is an
independent read-path correctness fix. #929 was a plausible but falsified
mechanism and is not implementation work.

```
#934  classify incompatible read generations → independent, small, ship first

#933  stable lexical scoring                 → blocks every candidate-population change
  └─ #940  preserve relevance through the relaxed ceiling
       ├─ #930  bounded weight experiment    → ship only if the probe improves
       └─ #937  lexical fragment indexing    → fixes the measured length penalty

#929  tier union                             → close rejected; zero recall gain

0.10.0 follow-through:
#748  semantic fragments                     → reuse #937's fragment substrate
#935  deterministic graph design             → independent of retrieval closeout
#936  fragment-aware graph                   → requires #937 identity; follows #935's graph decision
```

Live tracker after this review:

| issue | disposition |
|---|---|
| #934 | 0.9.14, open — incompatible read generations |
| #933 | 0.9.14, open — stable lexical scoring prerequisite |
| #940 / PR #941 | 0.9.14, open — preserve body relevance inside relaxed-score ties; PR #941 superseded by the compound-safe adaptation in PR #939 |
| #930 | 0.9.14, open — measured experiment with rejection path |
| #937 | 0.9.14, open — lexical fragment retrieval |
| #929 / PR #931 | closed — measured rejection; branch retained |
| #748 / #935 / #936 | 0.10.0, open — non-blocking follow-through |

### 3.0 #934 — do not hand a known-incompatible schema to callers

The current opener warns and returns the database handle anyway. The issue's
direction is correct—classify once and skip queries—but “return the same signal
as missing” is too imprecise for the current APIs and wrong for a newer
generation. `openExistingDatabase` returns a database or throws;
`openReadonlyExistingDatabase` alone uses `undefined` for absence, and many
callers use these low-level functions directly.

Preserve three distinct states:

- **absent:** existing missing-index behavior;
- **older/unknown:** one actionable “index not usable; run `akm index`” result;
- **newer:** one actionable “this akm is older; upgrade akm” result, never advice
  to rebuild the newer index with the older binary.

Use a typed classification/result at the command boundary or a typed error that
commands map once. Do not key behavior on SQLite message text and do not return
a handle after the generation is known to be incompatible. Unreadable and
corrupt-path behavior is separate and must stay unchanged.

### 3.1 #933 — a document's score depends on what else matched

```ts
// src/indexer/search/ranking.ts:71-86
const bestBm25  = results[0]!.bm25Score;
const worstBm25 = results[results.length - 1]!.bm25Score;
const range = bestBm25 - worstBm25;
const normalized = range !== 0 ? (result.bm25Score - worstBm25) / range : 1.0;
const ftsScore = 0.3 + normalized * 0.7;
```

Two defects.

**(a) It reads the endpoints instead of deriving min/max.** Nothing in the type
or signature enforces sorted input. It holds today only because `searchFts`
returns a single BM25-sorted tier. The #929 branch exposed the invariant and
worked around it with fabricated cross-tier offsets. Since #929 is rejected,
there is no reason to land that workaround. Cover unsorted input while replacing
the normalization in (b); a standalone endpoint-to-min/max edit would retain the
set-dependence and has no user-visible value.

**(b) Min-max makes the score set-dependent.** Best maps to `1.0` and worst to
`0.3` regardless of absolute quality, so adding a weak candidate rewrites every
other document's score. Holding three leaders fixed and adding three genuinely
weaker candidates:

| | leaders' ftsScore | leader separation |
|---|---|---|
| 3 candidates | `1.0000`, `0.9300`, `0.3000` | `0.0700` |
| + 3 weaker ones | `1.0000`, `0.9892`, `0.8923` | `0.0108` |

85% of the separation disappears and mid-pack documents are pushed into the
`Math.min(1, Math.max(0, score))` clamp at `db-search.ts:577`, where they become
indistinguishable. This is the mechanism behind the graph-boost saturation in §2.

**This is already known and already worked around.**
`src/indexer/search/ranking-contributors.ts:165-186` documents the same
pathology, and `BELIEF_STATE_SCORE_CEILINGS` (`deprecated: 0.28`,
`superseded: 0.25`, …) exists solely to force demotions the additive penalties
cannot achieve against a clamp-pinned base. Those constants are a symptom.
After (b) lands they should be **reconsidered for removal**, not retuned.

**Do not over-claim the replacement.** Raw FTS5 BM25 magnitude depends on the
query and corpus statistics (`idf`, `avgdl`), so a fixed monotone transform can
make a score stable when weaker candidates are added to the *same query*, but it
does not automatically make scores comparable across unrelated queries or FTS
tables. Cross-query comparability is not a 0.9.14 requirement.

The #933 PR must choose and justify a calibration against the existing cosine
path (`FTS_WEIGHT = 0.7`, `VEC_WEIGHT = 0.3`) and pin these invariants:

- monotonicity: a better BM25 hit never receives a lower lexical score;
- append stability: adding strictly weaker candidates leaves existing scores
  unchanged within tolerance;
- finite bounded output for empty, singleton, tied, and extreme BM25 inputs;
- headroom: the untouched `maxHops=2` graph canary observes a larger score than
  `maxHops=1`; and
- hybrid balance: lexical-only, semantic-only, and hybrid fixtures retain a
  deliberate, documented ordering.

Only after those pass should `BELIEF_STATE_SCORE_CEILINGS` be evaluated. Keep
or delete them from behavior evidence; do not assume a new base scale makes the
demotion contract unnecessary.

### 3.2 #940 — preserve relevance through the relaxed ceiling

The relaxed OR path clamps every body-only candidate whose name has no query
token to the same raw ceiling. On LoCoMo's opaque turn names, 24 of 40 questions
had a fully tied returned top five, so the final filename fallback selected the
pool that survived top-K. This is a recall bug as well as an ordering bug.

Retain the pre-clamp body score as ordering evidence while keeping the ceiling's
visibility policy. Do not reuse the belief-state `preCeilingScore`: a candidate
can be both relaxed and archived/superseded, and the later belief ceiling must
not overwrite the relevance signal. The implementation in PR #939 therefore
uses a separate relaxed-ceiling field and covers the compound case. The public
score is still the bounded projection introduced by #933; `0.65` is an internal
raw ceiling, not the displayed score.

PR #941's isolated branch reported `evidenceRecall@5` 0.564 → 0.692,
`recall@5` 0.485417 → 0.591667, and `precision@5` 0.227917 → 0.257917, with
LongMemEval unchanged. That result does **not** reproduce after composition with
#933. A same-environment paired attribution at evaluator commit `ddb3624e`
measured:

| build | LoCoMo ev@5 / P@5 / R@5 | LongMemEval ev@5 / P@5 / R@5 |
|---|---|---|
| published 0.9.13 / pre-#933 control | .564 / .227917 / .485417 | .950 / .676667 / .950 |
| #933 only (`11fb1f21`) | .333 / .182917 / .260417 | .850 / .656667 / .850 |
| #933 + compound-safe #940 (`d1b88cb3`) | .667 / .262917 / .591667 | .900 / .666667 / .900 |

#940 recovers and improves LoCoMo, but #933's calibration remains a hard
LongMemEval regression. Reopen #933's calibration decision; do not waive the
no-regression gate or publish PR #941's isolated result as the release result.

### 3.3 #930 — the weights gate recall, not order

`runFtsQuery` ends in:

```sql
ORDER BY bm25Score, e.id ASC
LIMIT ?
```

So the per-column weights decide **which rows come back at all**, not merely how
they sort. #930's own text says the needed document "was never a candidate at all
rather than being ranked too low" — that is a direct consequence of this
`LIMIT`. Treat #930 as a recall change and measure it as one.

## 4. The title-vs-body weighting question, measured

The hunch behind this investigation was that the weights are wrong for title vs
body. **The weights are wrong, but not in the way the ratio suggests, and fixing
the ratio cannot fix the problem.** Three findings, each measured.

The probe is reproducible in isolation — it needs nothing from akm beyond the
schema, which it recreates:

```ts
// bun <file>.ts — recreates the shipped entries_fts schema in :memory:
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
db.run(`CREATE VIRTUAL TABLE fts USING fts5(entry_id UNINDEXED, name, description,
        tags, hints, content, tokenize='porter unicode61')`);
const filler = (n: number, off = 0) =>
  Array.from({ length: n }, (_, i) => `filler${(i + off) % 400}`).join(" ");
// term in the NAME of a short doc
db.run(`INSERT INTO fts VALUES (?,?,?,?,?,?)`,
  ["title-hit", "quixotic deploy guide", "how to deploy", "ops", "", filler(80)]);
// term ONCE, mid-body, in a ~3000-token doc — the LongMemEval session shape
db.run(`INSERT INTO fts VALUES (?,?,?,?,?,?)`,
  ["buried", "weekly standup notes", "notes from the weekly standup", "meeting", "",
   `${filler(1500)} quixotic ${filler(1500, 7)}`]);
for (let i = 0; i < 35; i++)
  db.run(`INSERT INTO fts VALUES (?,?,?,?,?,?)`,
    [`noise${i}`, `doc ${i}`, `desc ${i}`, "misc", "", filler(300, i)]);
const show = (label: string, w: number[]) =>
  console.log(label, db.query(
    `SELECT entry_id, bm25(fts, ${w.join(",")}) AS s FROM fts WHERE fts MATCH 'quixotic' ORDER BY s`
  ).all());
show("shipped        ", [0, 10, 5, 3, 2, 1]);
show("content 10x    ", [0, 1, 1, 1, 1, 10]);
show("content 100x   ", [0, 1, 1, 1, 1, 100]);
```

(FTS5 `bm25()` returns a **negative** score; more negative is better, which is
why every query in the codebase is `ORDER BY bm25Score ASC`.)

### Finding 1 — the 10:1 weight ratio buys about 1.4x, not 10x

Same document, same single term occurrence in `name`, only the `name` weight
changing:

| `name` weight | score |
|---|---|
| 10 (shipped) | −4.3355 |
| 3 | −3.9161 |
| 1 | −3.0682 |

A **10x weight produces a 1.41x score advantage.** FTS5 puts the column weight
*inside* BM25's term-frequency saturation:

```
score = Σ_phrases  idf · (w·tf · (k1+1)) / (w·tf + k1 · (1 − b + b·D/avgdl))
```

As `w` grows the expression asymptotes to `idf·(k1+1)`. Past roughly 10 the
weights stop doing much of anything. Anyone who reads `10.0, 5.0, 3.0, 2.0, 1.0`
as "titles matter ten times as much" is reading a number that the scoring
function does not honour.

### Finding 2 — changing `content`'s weight cannot reorder body matches

Three documents whose only match is in `content` — short, long-with-5-hits,
long-with-1-hit — score **identically under every weight scheme tested**
(`−3.0682`, `−1.9643`, `−0.6009` under shipped, flat, and 3:1 alike). A scalar
on a column multiplies every body-only match by the same factor. Raising the
`content` weight changes only body-vs-title contests, and it changes those
through the saturating, weak lever of Finding 1.

### Finding 3 — length normalization is the real burial mechanism, and it is 5x

Two documents, one single occurrence of the term in `content` each, differing
only in body length:

| document | score |
|---|---|
| short body (~80 tokens) | −3.0682 |
| long body (~3000 tokens) | −0.6009 |

**A 5.1x penalty from length alone** — larger than anything the column weights
can express. That is the `b·D/avgdl` term, with `b = 0.75` and `D` the *whole
row's* token count. FTS5 exposes no way to configure `b` and no way to exclude a
column from `D`.

The end-to-end picture, competing a buried fact against a title match:

| indexing | title-hit | buried fact | deficit |
|---|---|---|---|
| whole body, shipped weights | −5.554 | −0.680 | **8.2x** |
| whole body, `content` weight 10x | −3.865 | −3.321 | 1.16x (still loses) |
| whole body, `content` weight 100x | −3.865 | −5.426 | buried finally wins |
| **200-token fragments, shipped weights unchanged** | −6.185 | **−2.952** | **2.1x** |

Read the last two rows together. To rescue a buried fact by weights alone you
need a `content` weight around **100x**, at which point *any* body mention beats
*any* title match and the index is useless for finding a document by its name.
Fragmenting the same body into 200-token rows closes most of the same gap
**without touching the weights at all**, because it removes the `D/avgdl`
penalty by making `D` roughly `avgdl`.

### What this means for #930

#930 is an **experiment with a rejection path**, not a promised weight change.
The original issue title read the literal `10.0:1.0` ratio as a 10x effect,
which the measurement disproves, and no measured candidate weight set exists
yet.

- Sweep a small pre-declared matrix after #933, including the unchanged control.
  A set like `(4,3,2,2,1.5)` is a candidate, not a recommendation.
- Treat the outcome as recall-sensitive because the weights act before `LIMIT`,
  but report precision and name-lookup behavior at the same time.
- Ship a new set only if a frozen probe improves beyond tolerance without a
  regression on the other pack/metrics or the exact-name contract. Otherwise
  close #930 as rejected and leave the weights unchanged.
- Test authored and synthesized descriptions separately. The brief previously
  claimed synthesized descriptions are “effectively the document opening,” but
  current `main` records a filename-derived fallback with lower confidence. Do
  not design around the opening-text claim without a corpus-level provenance
  check.

Even a winning weight set is only a modest complement to #937. It cannot remove
whole-row length normalization and is not allowed to delay the fragment fix.

## 5. Fragment indexing, and whether the graph can join fragments

### 5.1 Current state, verified

| | today |
|---|---|
| FTS rows per entry | **exactly one** — `index-fts-repository.ts:21` inserts one `entries_fts` row per entry, whole body in `content` |
| embedding vectors per entry | **exactly one** — `embeddings(id INTEGER PRIMARY KEY REFERENCES entries(id))` |
| body length bound | `MARKDOWN_CONTENT_MAX_CHARS = 1_000_000` — effectively unbounded; a 1 MB body is one FTS row |
| heading boundaries | **already computed and stored** — `parseMarkdownToc` (`core/asset/markdown.ts:51`) returns `{level, text, line}`, persisted as `entry.toc` |
| fragment addressing | **heading-only** — `akm show <ref>#<slug>` cannot address fallback chunks |
| a body chunker | **already implemented** — `splitBodyIntoChunks` (`llm/graph-extract.ts:215`) |
| graph position anchors | **none** |

The two most useful facts here are the last two.

**akm already has a chunker, and throws its output away.**
`splitBodyIntoChunks` splits on `\n(?=#{1,6}\s)` (heading boundaries), falls back
to paragraph splits, then to word-boundary splits at `MAX_CHUNK_BODY_CHARS =
1600`. It exists to feed the graph-extraction LLM within a token budget, and
`mergeGraphExtractions` immediately collapses the per-chunk results back to
per-file — using chunk agreement only as a confidence signal
(`CONSISTENCY_WEIGHT = 0.4`). The chunk identity is discarded.

So do **not** write a third chunker. #748 already warns against adding a second
heading parser; there are now two half-implementations of this in the tree
(`parseMarkdownToc` + `extractSection` for addressing, `splitBodyIntoChunks` for
splitting). Reconcile them into one core splitter.

The result cannot be only `{slug,startLine,endLine,text}`. A headingless
transcript has no slug, content before the first heading has no slug, and one
oversized heading section produces multiple chunks with the same slug. The
shared model needs a deterministic, unique within-revision `fragmentId`,
ordinal, range, optional heading slug, text, and hash. `#heading-slug` remains a
friendly alias for an unsplit heading, not the universal storage identity.

### 5.1a #748's stated scope is backwards, and the measurement says so

#748 scopes itself to the semantic/vector path and explicitly defers the lexical
one:

> `buildSearchText` can stay whole-document if lexical search over the full doc
> is still wanted; this issue is scoped to the *semantic/vector* path only, to
> limit blast radius.

§4's measurements do not support that. The burial mechanism is BM25 length
normalization, which lives entirely on the **lexical** path, and chunking is the
only lever inside FTS5 that reaches it. The FTS half is also the cheaper half:
it needs no embedding provider, no vector schema, and no re-embedding pass.

Scope the FTS fragments first and treat the vector half as the follow-on. The
blast-radius argument was reasonable when #748 was written; it is not what the
numbers say now.

That means issue ownership changes: #937 owns the shared identity plus lexical
FTS path in 0.9.14; #748 keeps its original semantic/vector purpose and moves to
0.10.0, reusing the substrate rather than defining a competing chunk model.

### 5.1b Parent roll-up must happen before top-K

A naive child-row design has a second starvation bug: if `LIMIT ?` applies to
fragment rows, ten matching fragments from one document can consume all ten
slots before results are deduped to their parent. Parent roll-up after ranking
is too late.

#937 must return top-K **distinct parent assets**, carrying one deterministic
winning fragment per parent. Roll up before the candidate limit and before
`normalizeFtsScores`; its map is keyed by parent entry id, so duplicate fragment
rows would otherwise overwrite each other. Default to the best fragment score,
not a sum that rewards repetition, unless corpus measurements justify another
aggregation.

The FTS layout also needs an explicit answer for metadata duplication. Copying
the same weighted name/description/tags onto every fragment changes document
frequency and can penalize long documents merely because they have more chunks.
Keeping parent metadata and fragment bodies in separate scoring populations
creates a different calibration problem because raw BM25 magnitudes are not
comparable across FTS tables. Evaluate the layout deliberately; do not let the
DDL make the ranking policy accidentally.

### 5.2 Can the graph join fragments? Not as it stands. (#936, 0.10.0)

```sql
CREATE TABLE graph_file_entities (
  stash_root TEXT, file_path TEXT, body_hash TEXT,
  entity_order INTEGER, entity_norm TEXT, entity TEXT,
  PRIMARY KEY (stash_root, file_path, body_hash, entity_order)
);
CREATE TABLE graph_file_relations (
  ... relation_order INTEGER, from_entity_norm, to_entity_norm, relation_type, confidence
);
```

`entity_order` is extraction order, not a position. The graph records **which
file** mentions an entity, never **where**. `computeGraphBoost(context,
filePath)` (`graph-boost.ts:276`) is per-file by construction: it looks the file
up in `nodesByPath` and sums capped direct and one-hop boosts over the file's
entity list.

Consequences, all of which have to be designed around rather than discovered
later:

- A fragment cannot inherit "the entities that appear in *it*" — only "the
  entities that appear somewhere in its file". Every fragment of a document
  would receive the identical graph boost, which makes the graph useless as a
  *fragment* discriminator even though it stays useful as a document-level prior.
- Capturing an anchor is cheap **at extract time and free at migration time**:
  `splitBodyIntoChunks` already knows which chunk each entity came from, and it
  is thrown away in `mergeGraphExtractions`. Carrying a `chunk_index` (or a line
  range) through extraction is straightforward. Making that anchor a durable,
  resolvable fragment identity is not “a few lines”: it depends on #937's
  headingless/oversized selector contract and must not invent a second key.
- **`index.db` is a regenerable cache with generation-based invalidation.**
  `rebuildIncompatibleIndexGeneration` drops and rebuilds every derived table
  when the stored generation is older than `CANONICAL_INDEX_DB_VERSION`. Schema
  changes here need a generation bump, **not** a hand-written migration. Say this
  out loud in the PR so nobody writes one.

### 5.3 The honest limits of a graph join (#935, 0.10.0)

Three constraints that make "join fragments via graph connections" a weaker lever
than it sounds, and none of them are fixable inside this work:

1. **The graph is LLM-gated.** Extraction requires a configured engine. Users
   without one have no graph at all, and `loadGraphBoostContext` returns `null`.
   Fragment retrieval therefore cannot *depend* on the graph — the graph can only
   improve it where present.
2. **The graph covers two asset types.**
   `DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES = ["memory", "knowledge"]`.
3. **It is heavily capped.** `MAX_ENTITIES_PER_ASSET = 32`,
   `MAX_RELATIONS_PER_ASSET = 32`, `GRAPH_MAX_HOPS = 1` by default
   (hard cap 3), `GRAPH_DIRECT_BOOST_CAP = 0.75`, `GRAPH_HOP_BOOST_CAP = 0.3`.
   And per §3.1 those boosts currently cannot be observed at all once the score
   saturates.

**The realistic role for the graph in this milestone is document-level prior,
not fragment discovery.** When a fragment wins, sibling/connected fragments may
later become ranked context, but that is a packing and presentation change, not
the lexical retrieval fix. Do not bundle it into #937.

#935 also should not assume asset refs can simply be inserted as free-text
entities in the existing tables. The current query path token-matches extracted
entity names, and the related-file path self-joins shared entities. A typed
asset-to-asset link graph has different identity and traversal semantics. Its
design must either model those edges separately or add explicit node kind and
provenance with tests proving the existing LLM graph behavior is unchanged.

### 5.4 The trap that would sink a naive chunking PR

**LongMemEval sessions are chat transcripts. They have no Markdown headings.**
A heading-boundary chunker produces exactly one chunk for a 3000-token
headingless transcript — i.e. no change at all, on the precise corpus where the
problem was measured. `splitBodyIntoChunks` already handles this (it falls
through to paragraph and then word-boundary splits), which is another reason to
reuse it rather than write a heading-only splitter from #748's description.

The existing `show <ref>#slug` path does **not** handle those fallback chunks.
Every search-returned fragment selector must round-trip through `show` to the
exact indexed text. Verify this for headingless bodies, duplicate headings,
preamble text, and multiple chunks under one oversized heading before treating
fragment addressing as complete.

Verify the fragment-count distribution on both corpora **before** measuring
retrieval. If the mean fragments-per-document on LongMemEval is ~1, the chunker
is not doing anything and any retrieval number you take is measuring noise.

## 6. Recommended order of work

Keep each retrieval change independently measurable. The prior plan mixed a
falsified union, an uncalibrated weight recommendation, and the real length fix.

**Phase 0 — tracker/evidence triage (complete in this review).** #929 and draft
PR #931 are closed with their measured result and the branch retained.
#748/#935/#936 are on 0.10.0. #937 is the only fragment-indexing deliverable in
0.9.14. The paired 0.9.13 control has been reproduced at evaluator PR #16's
head; the final comparator SHA remains pending the diagnostic corrections in
§7. Re-run that control beside every candidate measurement.

**Phase 1 — #934: incompatible read generations.** Classify the generation
before any query. Older/unknown generations take one “no usable index; run
`akm index`” path; newer generations take one “upgrade akm” path. Do not advise
an older binary to rebuild a newer index, and do not conflate unreadable paths
with absent ones. No known-incompatible handle reaches a query.

**Phase 2 — #933: stable lexical scoring.** Design and implement the mapping in
one PR with the invariants from §3.1. The endpoint/min-max cleanup is part of
that PR, not an independently shipped pseudo-fix. Leave #929 out. Re-probe and
require the untouched graph-hop canary to regain headroom. The first fixed-log
calibration (`a33b569c` through `11fb1f21`) failed the paired corpus gate above;
it is implementation evidence, not an accepted calibration.

**Phase 3 — #940: relaxed-ceiling relevance.** Keep the existing ceiling but
order tied relaxed results by their pre-clamp relevance. Preserve that signal
separately from belief-state ceiling evidence and re-probe the reported LoCoMo
gain before moving the acceptance baseline. The release diagnostic exposed a
second identity boundary before the comparator: `searchFts` applies its
candidate limit before type, graph, project, utility, and belief contributors.
If the limit cuts through an exact BM25 tie, return the whole boundary-tied set
and let the one final comparator apply every contributor. Do not replace the
SQLite row-id fallback with a content sort before `LIMIT`; that can discard a
type-boosted result before the type contributor sees it. The expansion is
intentionally data-bound for a dense exact tie and needs a stress measurement.

**Phase 4 — #930: bounded weight experiment.** Run the pre-declared matrix from
an isolated branch anchored after #940 and before #937. Merge a weight change
only if it clears the gate in §4, then verify the winner again in combination
with #937; otherwise close the issue as rejected. Do not attribute a combined
weights-plus-fragments result to either change.

**Phase 5 — #937: lexical fragments.** In reviewable commits: extract the
shared fragment model; define fallback selectors and `show` round-trip; add
regenerable fragment/FTS storage; atomically maintain it; return distinct parent
assets with one winning fragment; then measure quality, latency, index size, and
fragment distribution. Bump the index generation and add the prior-release
fixture in the same change.

**Phase 6 — release closeout.** Re-mint collapse-detector canaries for the
test/evaluation installation and add an operator-facing release note explaining
why existing installations should do the same. Freeze one candidate commit,
run release acceptance, dispatch gated CI against that exact 40-character SHA,
and add no commits after evidence is collected.

## 7. Testing and measurement

**Pin the external harness.** The probe is in `itlackey/akm-eval`, not this
repository's `scripts/akm-eval`. Record the comparator commit for every result.
PR #16 at `ddb3624e5feb63deece09b85cf59112ce6e446db` first added a
`tiedTopKRate` diagnostic. Review found that implementation insufficient: it
used the known-stale historical reference as a release verdict, treated guard
trips as warnings, counted underfilled result sets, and had no direct tests.
The corrected evaluator work lives on `release/0.9.14-eval-readiness`; pin its
final reviewed commit, not the original PR head, before collecting release
evidence.

**Use the pre-release command form.** `bin/probe <version>` installs a published
npm version and cannot test an unshipped checkout. From the pinned `akm-eval`
checkout use:

```sh
bin/probe --cmd '["bun","/absolute/path/to/akm/src/cli.ts"]'
```

The corrected paired gate grades `zeroHitRate`, `evidenceRecallAt5`,
`precisionAtK`, `recallAtK`, MRR, and nDCG for both packs. It requires matching
evaluator/runtime/corpus context, clean target and evaluator revisions, and
`guardTripped=0` on both sides. `scoreSaturatedTopKRate` counts only a full K of
equal finite public scores and remains disclosure, not a verdict, because it
cannot see #940's hidden pre-ceiling relevance.

The separate storage-name permutation check must isolate the identity surface
it claims to test. Do **not** replace `MemoryDocument.id`: the AKM evaluator
materializes that value into a `sourceId` tag and H1, so changing it changes the
FTS corpus and BM25 itself. Instead, keep caller ids, tags, headings, metadata,
text, corpus order, evidence, and query order fixed; index twice under forward
and reverse equal-shape opaque storage-name assignments; map both result sets
back through the unchanged caller ids; and fail on a rank or per-query metric
change. Duplicate caller ids must retain the adapter's upsert semantics.

**Establish a paired control every time.** The committed LoCoMo reference no
longer reproduces even from the same cached 0.9.10 binary: the saturated result
was partly selecting by filename. Do not grade 0.9.14 against that historical
JSON. Run published 0.9.13 and the candidate under the same pinned evaluator
commit, runtime, corpus bytes, environment, and clean data directories; record
both artifact directories, then compare them with the evaluator's paired
artifact grader. The aggregate verdict must retain both target identities,
contexts, saturation rates, metric deltas, guard counts, and storage-name
diagnostic. A control/candidate delta is attributable only when repeated runs
are deterministic and the control itself is recorded.

**Probe changes independently.** If scoring, weights, and fragments ship in one
measurement round, no delta is attributable. Probe after #933, after the #930
experiment, and after #937.

**Unit-level regressions to keep green:**

- `tests/integration/graph/graph-boost-ranking.test.ts` — the maxHops=2 assertion
  is the canary for score saturation. It should regain headroom *without being
  touched* when #933 lands.
- `tests/integration/fuzzy-search.test.ts` — keep the `"deploy kube"` precision
  case unchanged; it is the cheapest tripwire against reintroducing #929.
- #937's focused suite must cover headingless, preamble, duplicate-heading,
  oversized-section, distinct-parent top-K, fragment round-trip, incremental
  replacement, and parent-level ranking behavior.
- `tests/integration/previous-release-corpus.test.ts` must include the released
  0.9.13 index shape before the generation bump ships.

**Performance:** `searchFts` has two callers — the user query path and a bounded
collapse-detector loop. #937 changes both query work and indexer work. Measure
index wall time, index bytes, user-query p50/p95, canary-cycle wall time, and
fragment-count p50/p95/max. Avoid adding an operator knob unless the measured
cost requires one.

The first evaluator-shaped structural measurement at #937 commit `2dda2e4b`
(Bun 1.4.0; 419 LoCoMo turns plus 980 sessions from the first 20 LongMemEval
questions; 1,397 indexed parents) produced 8,378 fragments. LongMemEval's
fragment distribution was mean 8.85 and p50/p95/max `9/15/25`; LoCoMo was
`1/1/1`, so the headingless fallback is doing real work. Against release commit
`d88437d5`, cold index p50 changed 5.060s → 12.093s, `index.db` 37.60MB →
66.56MB, and in-process FTS p50/p95 0.913/2.871ms → 3.244/9.832ms. The absolute
query latency remains small, but the CTE scans and sorts the complete fragment
match set (observed up to 918 fragments / 407 parents), so record this as a
deliberate data-bound tradeoff and repeat the measurement on the frozen combined
candidate. The low-sample canary timing (103.31ms → 94.25ms) is inconclusive.

**Repository and release gates:** run focused tests during each phase, then
`bun run check`. On the frozen candidate run
`./tests/release-check.sh --skip-docker`, then dispatch `.github/workflows/gated-ci.yml`
with the candidate's exact 40-character SHA and require semantic search, Docker
install, native scheduler, and `release-candidate-evidence` to succeed. Record
the SHA and run URL in the milestone description before release.

## 8. Lessons learned, and traps

**On the investigation itself:**

1. **A plausible mechanism is not a measured one.** #929 was filed off a real
   signal (the `{1: 35, 2: 12, 3: 1, 4: 0, 5: 152}` result-count distribution is
   genuinely a switch, not a threshold) and the inferred cause was still wrong.
   The distribution proved the tiers were alternatives; it did not prove that
   fixing them would surface the missing evidence. Probe before implementing when
   the probe is free.
2. **Recall and precision must be reported together, and neither alone is the
   verdict.** "Precision fell 59%" overstates the harm; "recall was flat"
   understates it. The verdict is that the change bought nothing.
3. **Do not relay another agent's characterisation of a test failure without
   reading the output.** Both #929 failures were described as ranking-quality
   tradeoffs. One was; the other still passed its headline assertion. That
   correction had to be published twice.
4. **A worked-around pathology is a filed bug that nobody filed.**
   `ranking-contributors.ts:165-186` has described #933's exact mechanism in a
   comment for releases, with `BELIEF_STATE_SCORE_CEILINGS` compensating for it.
   Nothing surfaced it until an unrelated change made it fail a test. When you
   write a constant to work around a scoring pathology, open the issue.

**On the code:**

5. **`normalizeFtsScores` requires a bm25-sorted array and nothing says so.** It
   cost the #929 branch a fabricated-offset mechanism. #933 removes it; until
   then, assume any change to `searchFts` output ordering can silently corrupt
   every score.
6. **`ORDER BY bm25Score … LIMIT ?` makes every ranking knob a recall knob.**
   Nothing in the search path can promote a document that the `LIMIT` excluded.
   Treat "ranking" and "candidate generation" as the same subsystem here.
7. **FTS5 column weights saturate.** Reading `10.0` as "10x" is wrong (§4,
   Finding 1). Any future weight tuning should be measured, never reasoned about
   from the ratio.
8. **FTS5's `b` is not configurable and `D` spans all columns.** Length
   normalization is the dominant burial mechanism (§4, Finding 3) and no weight
   change reaches it. Fragmentation is the only lever available inside FTS5.
9. **A widened pool is a ranking change.** Anything that changes how many
   candidates reach the ranker — the tier union, a weight change, a `topK` bump —
   perturbs every normalized score until #933(b) lands. This gates a `topK`
   increase too, which is worth remembering the next time one looks like an easy
   win.
10. **The graph cannot be load-bearing for #937.** It is LLM-gated, covers two
    asset types, and is capped at 32 entities / 32 relations / 1 hop. Design
    fragment retrieval with no graph dependency; #935/#936 are 0.10.0 work.
11. **akm parses typed relations and does not feed them to graph ranking.** `xrefs`,
    `links`, `supersededBy`, `contradictedBy`, `derivedFrom`, memory `refs:` and
    `sources:` are all parsed at index time and none reach the graph tables —
    `entry.links` is computed, assigned at `scan/doc-to-entry.ts:68`, serialized
    into `document_json`, and has no graph reader. That does not mean asset refs
    are interchangeable with the graph's free-text entities; #935 must specify
    typed node/edge semantics before choosing storage.
12. **Chat transcripts have no headings.** A heading-boundary chunker is a no-op
    on the corpus this work is being measured against (§5.4). Check the
    fragment-count distribution before you check retrieval.
13. **`index.db` is regenerable.** Schema work here is a generation bump and a
    rebuild, never a hand-written migration. `rebuildIncompatibleIndexGeneration`
    already drops and recreates every derived table.
14. **Don't write a third chunker.** Two exist. Reconcile them.
15. **Fragment identity is not a heading slug.** Headingless transcripts,
    preamble text, duplicate headings, and oversized sections all disprove that
    shortcut. Every returned selector must round-trip through `show`.
16. **Deduping after `LIMIT` is starvation in a new form.** Fragment search must
    select top-K distinct parents before the candidate budget is exhausted.
17. **Pin the evaluator, not just the product.** The `bin/probe` named here lives
    in a separate repository and changes independently. Use `--cmd` for local
    candidates, record its SHA, and treat `guardTripped` as a failure manually.

---

## Appendix — file map

| concern | file |
|---|---|
| incompatible read generation (#934) | `src/storage/repositories/index-connection.ts:119-230` |
| min-max normalization (#933) | `src/indexer/search/ranking.ts:71-86` |
| its consumer | `src/indexer/search/db-search.ts:440` |
| the score clamp | `src/indexer/search/db-search.ts:577` |
| the documented workaround | `src/indexer/search/ranking-contributors.ts:165-186` |
| tier cascade + bm25 query (#929, #930) | `src/storage/repositories/index-fts-repository.ts` |
| FTS5 schema / column order | `src/storage/repositories/index-schema.ts:272-280` |
| generation rebuild | `src/storage/repositories/index-schema.ts:186-201` |
| per-field indexing projection | `src/indexer/search/search-fields.ts` |
| body projection + its 1 MB bound | `src/indexer/passes/metadata.ts:882-893` |
| synthesized filename description | `src/indexer/passes/metadata.ts:1315` |
| heading parse / section extract | `src/core/asset/markdown.ts` |
| the existing body chunker | `src/llm/graph-extract.ts:215` |
| chunk→file collapse | `src/llm/graph-extract.ts:276` (`mergeGraphExtractions`) |
| graph tables (no position anchor) | `src/storage/repositories/index-schema.ts:131-160` |
| per-file graph boost | `src/indexer/graph/graph-boost.ts:276` |
| declared relations not fed into graph (#935) | `scan/doc-to-entry.ts:68` (`links`), `metadata.ts:474`, `:169-172`, `:193`, `lint/base-linter.ts:479` |
| lexical fragment implementation (#937) | shared splitter, `index-fts-repository.ts`, `show.ts`, index schema |
| rejected #929 experiment | branch `issue/0.9.13-search` @ `8c61f1f0`, draft PR #931 |
| retrieval probe | paired attribution audited at `itlackey/akm-eval` PR #16 `ddb3624e`; final comparator pending saturation-test and identity-permutation corrections |
