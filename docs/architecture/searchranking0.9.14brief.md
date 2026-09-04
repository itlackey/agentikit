# Search ranking and fragment indexing: brief for 0.9.14

**Status:** investigation complete, no code changed. Written after #929 was
implemented, measured, and held out of 0.9.13.
**Scope:** #933, #929, #930, #748, and the two graph gaps it exposed (#935, #936).
**Companions:** [`benchmark-tuning-findings.md`](./benchmark-tuning-findings.md)
is the source of truth for every benchmark figure not measured here.
**Preserved work:** `issue/0.9.13-search` at `8c61f1f0` — correct in isolation,
reuse it, do not rewrite it.

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

**Do not re-attempt #929 as a recall fix.** It is a correctness fix (the tiers
genuinely are alternatives today, which is wrong) with a measured precision cost
and no measured benefit. It becomes worth shipping only after the two defects
underneath it are fixed, and it must be re-measured then.

## 2. The measured regression

Probed on `akm-eval`'s deterministic, LLM-free harness (`bin/probe <version>`),
`#931` branch against stock `release/0.9.12` as control. The control matched
committed reference values on all 8 metrics, so every delta is attributable to
the change alone.

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
legitimately surfaces. That assertion encodes the bug; rewrite it when #929
lands. Do not treat it as evidence against the change.

## 3. Root cause: three issues, one failure

#933, #929 and #930 are three views of a single retrieval pipeline that cannot
surface a fact stated in the middle of a long document. They must be worked in
dependency order, not in issue-number order.

```
#933  normalizeFtsScores is set-dependent   →  blocks everything that widens the pool
  └─ #929  tier union (recall plumbing)     →  safe only after #933; measure again
       └─ #930  bm25 column weights         →  a recall lever, not an ordering lever
            └─ #748  fragment indexing      →  the only fix for the actual burial mechanism
                 └─ #936  fragment-level graph nodes and edges

#935  deterministic graph (no LLM)          →  independent; land before #936
```

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
returns a single tier. The moment two tiers contribute it breaks, because each
tier's bm25 values are on their own scale — which is exactly why the #929 branch
had to **fabricate score offsets**, nudging each looser tier's rows past the
worst collected so far. The ranker then consumes partly synthetic bm25 values.
That workaround is not shippable and must be **deleted, not adapted**, once (a)
is fixed.

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

### 3.2 #930 — the weights gate recall, not order

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

Ship #930 as a **modest** rebalance, expect a **modest** effect, and do not
expect it to fix the burial. Concretely:

- Compress the spread (something like `4, 3, 2, 2, 1.5`) rather than inverting
  it. The current top end is past the saturation knee and is buying almost
  nothing.
- Treat the win as *recall*: measure `evidenceRecall@5` and `recallAtK`, because
  the weights gate the `LIMIT` (§3.2).
- **`description` is not a trustworthy signal at 5x.** When frontmatter carries
  no description, `applyPostContributorFields` (`metadata.ts:1315`) synthesizes
  one from the filename and drops `confidence` to 0.55. For the memory corpora
  it is effectively the document's opening — which is precisely the "a document's
  opening should not be a proxy for its relevance" complaint in #930. A
  synthesized description should not carry the same weight as an authored one;
  the entry already records `source: "filename"` and a lowered `confidence`, so
  the information needed to distinguish them is already in the index.

## 5. Fragment indexing, and whether the graph can join fragments

### 5.1 Current state, verified

| | today |
|---|---|
| FTS rows per entry | **exactly one** — `index-fts-repository.ts:21` inserts one `entries_fts` row per entry, whole body in `content` |
| embedding vectors per entry | **exactly one** — `embeddings(id INTEGER PRIMARY KEY REFERENCES entries(id))` |
| body length bound | `MARKDOWN_CONTENT_MAX_CHARS = 1_000_000` — effectively unbounded; a 1 MB body is one FTS row |
| heading boundaries | **already computed and stored** — `parseMarkdownToc` (`core/asset/markdown.ts:51`) returns `{level, text, line}`, persisted as `entry.toc` |
| fragment addressing | **already implemented** — `akm show <ref>#<slug>`, via `extractSection` and `markdownHeadingSlug` |
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
splitting). Reconciling them into one splitter that returns
`{ slug, startLine, endLine, text }` is a prerequisite step, and it is mostly
deletion.

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

### 5.2 Can the graph join fragments? Not as it stands. (#936)

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
- Adding the anchor is cheap **at extract time and free at migration time**:
  `splitBodyIntoChunks` already knows which chunk each entity came from, and it
  is thrown away in `mergeGraphExtractions`. Carrying a `chunk_index` (or a line
  range) through to `graph_file_entities` is a few lines plus a column.
- **`index.db` is a regenerable cache with generation-based invalidation.**
  `rebuildIncompatibleIndexGeneration` drops and rebuilds every derived table
  when the stored generation is older than `CANONICAL_INDEX_DB_VERSION`. Schema
  changes here need a generation bump, **not** a hand-written migration. Say this
  out loud in the PR so nobody writes one.

### 5.3 The honest limits of a graph join (#935)

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

**The realistic role for the graph is document-level reassembly, not fragment
discovery.** When a fragment wins, its parent document's other fragments and its
graph-connected documents become *cheap, ranked context* rather than additional
independent hits. That is genuinely valuable — it is how you answer a multi-fact
question from fragment hits — but it is a packing and presentation change, not a
retrieval change, and it should be scoped and measured separately from the
chunked index itself. Do not bundle it into the first chunking PR.

### 5.4 The trap that would sink a naive chunking PR

**LongMemEval sessions are chat transcripts. They have no Markdown headings.**
A heading-boundary chunker produces exactly one chunk for a 3000-token
headingless transcript — i.e. no change at all, on the precise corpus where the
problem was measured. `splitBodyIntoChunks` already handles this (it falls
through to paragraph and then word-boundary splits), which is another reason to
reuse it rather than write a heading-only splitter from #748's description.

Verify the fragment-count distribution on both corpora **before** measuring
retrieval. If the mean fragments-per-document on LongMemEval is ~1, the chunker
is not doing anything and any retrieval number you take is measuring noise.

## 6. Recommended order of work

Each step is independently measurable. Do not merge two of them into one probe
round — the whole reason this investigation exists is that #929 and #930 were
ranked the wrong way round and their effects were never separated.

**Step 1 — #933(a): derive real min/max.** Replace the endpoint reads in
`normalizeFtsScores` with an actual min/max over the array. Small, safe,
independently correct. Expected probe delta: zero (it holds today by accident).
Ship on its own.

**Step 2 — #933(b): set-independent lexical scoring.** Replace min-max with a
stable monotone map from bm25 into the score range, so a document's lexical score
means the same thing regardless of what else matched — and is comparable across
queries, which min-max never was. This is the load-bearing change. It should
resolve the graph-boost saturation in §2 by construction. Re-examine
`BELIEF_STATE_SCORE_CEILINGS` **after** it lands; the goal is deleting those
constants, not retuning them.

**Step 3 — #929: land the preserved union.** Cherry-pick `8c61f1f0` from
`issue/0.9.13-search`, then **delete the synthetic bm25 offsets outright** — they
exist only to satisfy the assumption Step 1 removed. Rewrite `improve-memory`'s
runner-up assertion (§2). Re-probe: with Steps 1–2 in place, the precision loss
should shrink; if `recallAtK` is still flat, say so plainly in the PR rather than
shipping on the correctness argument alone.

**Step 4 — #930: rebalance the weights, measured as recall.** Sweep with
`bin/probe`, which is free. Watch `evidenceRecall@5` and `recallAtK` first,
`precisionAtK` second. Expect a modest effect (§4) and do not chase a large one
by pushing `content` past the point where body mentions beat title matches.

**Step 5 — fragment indexing.** The actual fix for §4's Finding 3, and the
largest change here. Sequence it as:

  a. Reconcile the two existing splitters into one that returns
     `{ slug, startLine, endLine, text }`. Mostly deletion.
  b. Add fragment rows to the FTS path only, keeping one `entries` row per asset
     (a child `entry_fragments` table feeding `entries_fts`, parent id carried on
     each row). Generation bump, no migration.
  c. Roll fragment hits up to their parent asset before ranking, so the existing
     type/utility/recency/graph boosts still apply at asset level — #748 calls
     this out and it is right: a highly-used document must not lose its utility
     boost because the match landed mid-body.
  d. Resolve a winning fragment to `bundle//conceptId#heading-slug` through the
     existing `show` fragment path.
  e. **Only then** consider the semantic half (#748's original scope) and the
     graph-anchored reassembly of §5.3 (#936).

**Step 6 — the graph gaps, filed separately.** #935 (populate the graph
deterministically from declared refs, so it exists without an LLM engine) is
independent of everything above and can run in parallel; it should land before
#936 (anchor graph entities and relations to fragments), which additionally
needs #933 for its boosts to be observable and #748 for fragment identity to
exist at all.

  Re-mint the collapse detector's canary sets (`bun scripts/refresh-canary-set.ts
  --refresh`) — `search-fields.ts` carries an explicit warning that changing what
  is indexed shifts the detector's recall baseline for every existing canary set.

## 7. Testing and measurement

**Free and deterministic, run on every step:** `bin/probe <version>` in
`akm-eval`. LLM-free, minutes, grades `recallAtK` / `precisionAtK` / `mrr` /
`ndcgAtK` on two frozen corpora against committed reference values and exits
nonzero on regression. There is no excuse for shipping a retrieval change
unmeasured.

**Establish the control every time.** The #929 measurement was trustworthy
because stock `release/0.9.12` was probed first and matched committed reference
values on all 8 metrics. Without that, a delta is not attributable. Re-probe the
control on the current base at the start of each step.

**Probe changes independently.** #930's own text says it: if two candidate-
generation changes ship together, any judged round attributes to "retrieval
changes" rather than to either one.

**Unit-level regressions to keep green:**

- `tests/integration/graph/graph-boost-ranking.test.ts` — the maxHops=2 assertion
  is the canary for score saturation. It should go green *without being touched*
  when Step 2 lands. If you find yourself editing it, Step 2 is not done.
- `tests/integration/fts/fts-progressive-retrieval.test.ts` — tier attribution
  and dedupe for the union.
- `tests/integration/fuzzy-search.test.ts` — the `"deploy kube"` precision case.
  This is the test that caught the naive union appending a *deploy docker*
  document on the shared word "deploy". It is the cheapest precision tripwire in
  the tree.
- `tests/integration/commands/improve-memory.test.ts` — rewrite the runner-up
  assertion in Step 3, do not weaken the position-0 assertion.
- `tests/curate-relevance-eval.test.ts`, `tests/curate-search-for-curation.test.ts`
  — both encode the old candidate-starved recall as intentional; `8c61f1f0`
  already updated them, reuse those edits.

**Performance:** `searchFts` has exactly two callers — `db-search.ts:612` (the
per-query path) and `collapse-detector.ts:249` (`scoreCanary`, a bounded loop,
`DEFAULT_CANARY_COUNT = 40`, once per `akm improve` consolidate cycle). No
indexer-time or per-entry path calls it. This is not a hot path; it needs no
cache and no knob. Fragment indexing does change indexer-time cost — measure
`akm index` wall time on a large stash before and after Step 5.

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
   is the single most dangerous undocumented invariant in the search path. It
   cost the #929 branch a whole fabricated-offset mechanism. Step 1 removes it;
   until then, assume any change to `searchFts`'s output ordering silently
   corrupts every score.
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
10. **The graph cannot be load-bearing.** It is LLM-gated, covers two asset types,
    and is capped at 32 entities / 32 relations / 1 hop. Design fragment
    retrieval to work with no graph at all, then let the graph improve it
    (#935 removes the LLM gate; #936 adds the fragment anchors).
11. **akm parses typed relations and discards every one of them.** `xrefs`,
    `links`, `supersededBy`, `contradictedBy`, `derivedFrom`, memory `refs:` and
    `sources:` are all parsed at index time and none reach the graph tables —
    `entry.links` is computed, assigned at `scan/doc-to-entry.ts:68`, serialized
    into `document_json`, and read by nothing. Before adding a signal, check
    whether the codebase already extracts it and throws it away. (#935)
12. **Chat transcripts have no headings.** A heading-boundary chunker is a no-op
    on the corpus this work is being measured against (§5.4). Check the
    fragment-count distribution before you check retrieval.
13. **`index.db` is regenerable.** Schema work here is a generation bump and a
    rebuild, never a hand-written migration. `rebuildIncompatibleIndexGeneration`
    already drops and recreates every derived table.
14. **Don't write a third chunker.** Two exist. Reconcile them.

---

## Appendix — file map

| concern | file |
|---|---|
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
| heading parse / section extract | `src/core/asset/markdown.ts:51`, `:82` |
| the existing body chunker | `src/llm/graph-extract.ts:215` |
| chunk→file collapse | `src/llm/graph-extract.ts:276` (`mergeGraphExtractions`) |
| graph tables (no position anchor) | `src/storage/repositories/index-schema.ts:131-160` |
| per-file graph boost | `src/indexer/graph/graph-boost.ts:276` |
| declared relations nothing reads (#935) | `scan/doc-to-entry.ts:68` (`links`), `metadata.ts:474`, `:169-172`, `:193`, `lint/base-linter.ts:479` |
| preserved #929 work | branch `issue/0.9.13-search` @ `8c61f1f0` |
