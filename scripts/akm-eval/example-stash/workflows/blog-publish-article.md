---
type: workflow
description: End-to-end workflow to deeply research, SEO-plan, draft, multi-review, quality-gate, publish (as a dev.to draft), and notify approvers for a brand-aligned technical blog article. Self-contained — embeds the rules and quality gates from the blog-writing skill so any agent can execute it without loading additional assets.
tags: [blog, content, publishing, seo, devto]
params:
  topic: { type: string, description: "The article topic. If empty, propose 5 candidates from the brand pillars and ask the user to pick." }
  pillar: { type: string, description: "Optional pillar name from brand.yaml to anchor the topic. If empty, the researcher selects the best fit." }
  brand_config_path: { type: string, description: "Path to the YAML brand config. Defaults to skills/blog-writing/config/brand.yaml, then brand.example.yaml." }
  workspace_dir: { type: string, description: "Directory for brief + draft artifacts. Defaults to workspace/blog." }
  notify_channel: { type: string, description: "Apprise tag that routes to the reviewer channel. Defaults to publishing.approval.notify_channel from brand.yaml (e.g. blog-approvals)." }
  literary_voice: { type: string, description: "Optional literary or stylistic north star for prose texture and rhythm. Use only as high-level guidance; never imitate copyrighted phrasing or recognizable passages." }
  max_review_rounds: { type: number, description: "Maximum review-and-rewrite rounds before escalation. Defaults to 4." }
  use_topic_swarm: { type: boolean, description: "If true, run topic-swarm ideation and scoring even when a topic was provided. Defaults to false." }
  max_swarm_topics: { type: number, description: "Maximum number of candidate article topics to explore in swarm mode. Defaults to 10." }
steps:
  - id: load-config
  - id: select-topic
    inputs: [steps.load-config.output]
  - id: research
    inputs: [steps.select-topic.output]
  - id: seo-voice-plan
    inputs: [steps.research.output]
  - id: draft
    inputs: [steps.seo-voice-plan.output]
  - id: edit
    inputs: [steps.draft.output]
    # Retry lives here, not in a backward route: a rejected gate re-runs
    # THIS step (review board + quality checklist) with the judge's
    # feedback, bounded by max_loops (mirrors the `max_review_rounds`
    # parameter's default). If it still isn't ship-ready after that, the
    # step — and the run — fails; a human decides whether the draft needs
    # a fresh `akm workflow start` from `draft` or just another look.
    gate: { max_loops: 4 }
  - id: publish-draft
    inputs: [steps.edit.output]
  - id: notify
    inputs: [steps.publish-draft.output]
  - id: report
    inputs: [steps.notify.output]
---

# Publish a Quality Blog Article

This workflow turns a topic (or pillar) into a publish-ready, SEO-optimized
draft on dev.to with a canonical URL pointed at the product blog, then sends
an approver notification. It encapsulates the full process from
`skills/blog-writing/SKILL.md` so it can be executed end-to-end without
loading additional assets, while still pointing at the underlying agents and
references when richer context is needed.

Pipeline summary:

```
LOAD-CONFIG → SELECT-TOPIC (direct or swarm) → RESEARCH → SEO-VOICE-PLAN → DRAFT → EDIT (review board + quality-gate loop) → PUBLISH-DRAFT → NOTIFY → REPORT
```

Hard rules that apply to every step:

- Brand-agnostic. Never hardcode product names, pillars, voice rules, or
  CTAs in the article — read them from the resolved brand config.
- The product is an example, not the subject. Do not build the post around a
  product pitch.
- No fabricated sources, numbers, or benchmarks. Every performance / scale /
  adoption claim must trace to a source captured in the brief.
- If the `literary_voice` parameter is provided, use it only for high-level
  stylistic guidance such as pacing, sentence texture, or observational
  stance. Never mimic signature phrasing, structure, or copyrighted
  passages.
- Code must run as written: pin versions, include imports, show expected
  output.
- Publishing is a human decision. This workflow always finishes at
  `published: false`. Never flip it to `true`.

## load-config

Resolve the brand config in this priority order and load it into memory:

1. `$BLOG_BRAND_CONFIG` (absolute path) if set
2. The `brand_config_path` parameter
3. `./brand.yaml` in the current working directory
4. `skills/blog-writing/config/brand.yaml`
5. `skills/blog-writing/config/brand.example.yaml` (fallback)

Extract and treat as ground truth for the rest of the workflow:

- `product` — `name`, `domain`, `blog_url`, `tagline`, `one_liner`
- `pillars[]` — `name`, `description`, `example_topics`
- `audience` — `primary`, `secondary`, `seniority`
- `voice` — `person`, `tone`, `allow_humor`, `banned_phrases`, `require`
- `seo` — `canonical_strategy`, `internal_link_targets`,
  `min_internal_links_per_1000_words`, `devto_default_tags`
- `cta` — `primary`, `secondary`
- `publishing` — `devto.default_published`, `approval.notify_channel`,
  `approval.approver_mention`

Verify required environment:

- `DEVTO_API_KEY` is set (publish step will fail without it).
- An apprise tag matching `publishing.approval.notify_channel` (or the
  `notify_channel` parameter) is configured to reach the reviewer.

Ensure the directory named by the `workspace_dir` parameter exists (default
`workspace/blog`); create it if not.

### gate

- Brand config loaded; the resolved path is recorded for the report.
- `DEVTO_API_KEY` present in the environment (or explicitly noted as missing
  with a plan to set it before the publish step).
- Notify channel resolved and confirmed routable.
- `workspace_dir` exists and is writable.

## select-topic

Resolve the article subject, building on the brand config loaded by
`load-config`, attached to this unit as input.

Choose between direct selection mode and swarm mode:

- Use **swarm mode** if the `use_topic_swarm` parameter is `true`.
- Use **swarm mode** if the `topic` parameter is empty.
- Otherwise use **direct selection mode**.

1. If `topic` is provided, validate it maps cleanly to at least one
   `pillars[].name`. If it doesn't, stop and report the mismatch — do not
   invent a pillar.
2. If `topic` is provided and the `pillar` parameter is also provided,
   confirm they are compatible. If they conflict, block and ask the user
   which constraint wins.

Create these artifacts under `workspace_dir`:

- `topic-swarm.md`
- `topic-scorecard.md`

Generate and score candidate article topics using the loaded brand config,
audience, and SEO requirements.

Candidate generation rules:

- If `pillar` is provided, constrain the swarm to that pillar first, then
  allow closely related adjacent topics only when they are clearly stronger.
- If `topic` was provided and `use_topic_swarm` is `true`, treat the
  provided topic as one candidate in the swarm, not as an automatic winner.
- Explore up to `max_swarm_topics` candidates across:
  - configured pillar examples
  - adjacent search queries a real reader would use
  - contrarian or under-covered angles
  - high-intent problem statements rather than generic overviews

For each candidate, score:

- pillar fit
- audience relevance
- SEO opportunity
- source richness
- originality or differentiated angle
- product-hook naturalness
- premium-writing potential

Reject candidates that are too broad, too generic, too salesy, poorly
sourced, or already saturated without a better angle.

Select exactly one winning topic unless the candidate set is too weak to
justify writing. Record why it won and why the nearest alternatives lost.

Each topic candidate must:

- Be specific enough to scope a 1500–3000 word article.
- Make a concrete claim or solve a concrete problem (not "an overview of X").
- Front-load a primary keyword a real reader would search for.
- Have enough credible source depth to survive the research and review
  phases.

Record the chosen topic and its primary pillar (and optional secondary
pillar).

### gate

- A single topic is chosen and recorded.
- The chosen topic maps to at least one configured pillar.
- A `slug` is derived (kebab-case, 3–5 words, no dates, primary keyword
  present) and recorded for downstream artifact naming.
- If swarm mode ran, `topic-swarm.md` and `topic-scorecard.md` exist and
  record the winner plus the rejected alternatives.

## research

Dispatch `agents/blog/researcher.md` (or perform the role inline if the
agent isn't loaded) with the topic and pillar selected by `select-topic`,
attached to this unit as input, plus the loaded brand config. The researcher
produces a brief at `<slug>-brief.md` (under `workspace_dir`) plus supporting
research artifacts that include:

1. **Pillar fit** stated in plain English. Hard stop if the topic does not
    fit any pillar.
2. **Reader** — one sentence describing who this post is for and the
    decision/task they are on when they find it (drawn from `audience`).
 3. **SERP & intent scan** — for the primary keyword and the 2-4 most
    relevant secondary queries:
    - search intent (informational | commercial | comparison |
      transactional)
    - dominant format among top 5 (tutorial | deep-dive | comparison |
      listicle | pillar-guide)
    - common H2s across top 5 results
    - the gap the top 5 skip (where you earn the ranking)
    - estimated word count (median of top 5 ± 20%)
    - PAA / "People Also Ask" questions (each becomes an H3 or FAQ entry)
 4. **Source pack** — 8-15 credible sources, each with URL, publisher, year,
    a one-sentence summary, and which claim it supports. Prefer official
    docs, vendor engineering blogs, peer-reviewed papers, reproducible
    benchmarks. For version-, benchmark-, or vendor-specific claims, prefer
    sources < 24 months old. Mark unverified sources explicitly.
 5. **Contradictions and caveats** — where sources disagree, where data is
    stale, where definitions differ, and which claims need careful
    language.
 6. **Narrative raw material** — expert quotes, unusual examples, metaphors,
    tensions, historical context, or scenes that could make the article
    feel premium instead of generic. If `literary_voice` is set, identify
    what kind of observational detail, pacing, and rhetorical restraint fit
    that voice without imitation.
 7. **Product hooks** — 2–3 places where the product is a natural example
    (drawn from `pillars[].description`, `product.one_liner`, and
    `seo.internal_link_targets`). For each, state the section, the concept
    it illustrates, the framing (demo → concept or concept → demo), and the
    internal link target + anchor hint.
 8. **Title candidates** — 3 candidates, each ≤ 65 chars, primary keyword
    front-loaded, making a specific claim.
 9. **Meta description candidates** — 2 candidates, 105–160 chars, primary
    keyword present, with a clear payoff.
 10. **Outline** with TL;DR slot, H2s, FAQ if commercial intent, and
    closing.
 11. **Risks / gaps** — anything you couldn't verify or a claim the writer
    should handle carefully.

Create these explicit artifacts under `workspace_dir`:

- `<slug>-brief.md` — the main article brief
- `<slug>-sources.md` — structured source pack with notes
- `<slug>-serp.md` — SERP, query, and intent analysis
- `<slug>-research-gaps.md` — contradictions, unknowns, and phrasing
  cautions

Research must continue recursively until the researcher can answer both:

- "What is the strongest version of the article's thesis?"
- "What is the strongest credible objection or limitation to that thesis?"

Do not hand off to the writer while those remain vague.

For richer guidance, the researcher may consult
`skills/blog-writing/references/ai-seo.md` for AEO/GEO patterns when the
intent is commercial or comparison.

### gate

- Brief written to `<slug>-brief.md` matching the structure in
   `agents/blog/researcher.md`.
- Pillar fit confirmed; if not, the workflow halts here.
- 8-15 sources captured with URLs and one-sentence summaries.
- `-sources.md`, `-serp.md`, and `-research-gaps.md` artifacts exist.
- 3 title candidates and 2 meta description candidates produced.
- 2–3 product hooks identified with section + internal link + anchor hint.

## seo-voice-plan

Turn the research pack produced by `research`, attached to this unit as
input, into a concrete SEO and prose plan before drafting.

Create `<slug>-content-plan.md` (under `workspace_dir`) with:

1. **Primary keyword** and 4-8 secondary or adjacent keywords.
2. **Search intent contract** — what the reader expects by the end and what
   the article must avoid wasting time on.
3. **SERP differentiation plan** — the angle, format, and evidence depth
   that make the article more useful than the current top-ranking pages.
4. **Heading map** — H1, H2s, likely H3s, FAQ usage, and internal-link
   targets.
5. **Snippet plan** — title candidate to use, meta description candidate to
   use, likely excerpt/TL;DR hooks, and where the answer to the primary
   query appears in the first 100 words.
6. **Voice plan** — how `voice.person`, `voice.tone`, `voice.require`, and
   the optional `literary_voice` parameter should affect sentence length,
   openings, transitions, imagery, and rhetorical restraint.
7. **Evidence placement plan** — where the strongest source-backed claims,
   benchmarks, quotes, or diagrams will appear.

If `literary_voice` is provided, reduce it to non-infringing stylistic
notes such as:

- cadence (compressed, expansive, precise, meditative)
- observational distance (detached, warm, analytic)
- metaphor density (low, medium, high)
- paragraph length tendencies
- tolerance for wit or aphorism

Do not ask the writer to imitate a living author or reproduce a recognizable
voiceprint. The goal is premium prose discipline, not mimicry.

### gate

- `<slug>-content-plan.md` exists.
- Primary/secondary keywords, heading map, snippet plan, and evidence
  placement plan are explicit.
- If `literary_voice` was provided, it has been translated into safe
  stylistic guidance.

## draft

Dispatch `agents/blog/writer.md` with the brief and content-plan produced by
`seo-voice-plan`, attached to this unit as input, and the loaded brand
config. The writer produces `<slug>.md` (under `workspace_dir`) following
this contract:

Frontmatter (for `devto-cli.ts` to consume):

```yaml
---
title: "<one of the brief's title candidates, or a sharper version>"
description: "<meta description, 105–160 chars, primary keyword present>"
tags: <3–4 tags from seo.devto_default_tags or keyword-derived>
slug: "<from the brief>"
cover_image: "<optional URL>"
canonical_url: "<{product.blog_url}/<slug>>"
published: false
---
```

Body structure:

1. **Opening** (2–3 sentences): state the problem or the conclusion. Never
   open with company history, hype, or "In today's fast-paced world."
2. **TL;DR** (80–100 words). Self-contained — an LLM quoting only this
   paragraph should still get the whole point. Include the primary keyword
   once, naturally.
3. **Informative H2s** — write headings that state what the section
   argues, not generic labels like "Background" or "Conclusion".
4. **FAQ** (only if `search_intent` is `commercial` or `comparison`) using
   the PAA questions from the brief, with short, self-contained answers.
5. **What to try next** — one concrete next step: doc link, repo, demo, or
   CTA from `cta`.

Voice and SEO discipline (enforced from `brand.yaml` and
`<slug>-content-plan.md`):

- `voice.person` and `voice.tone` apply throughout.
- No phrase from `voice.banned_phrases`.
- Satisfy every rule in `voice.require` (specific numbers, trade-offs
  surfaced, versions pinned, diagram for >2-component systems).
- If `literary_voice` is set, apply only the approved stylistic guidance
  from the content plan. The draft should feel intentional and literary in
  rhythm, not derivative.
- Primary keyword in: title, H1, first 100 words, meta description, slug.
- 2–3 H2s include the primary keyword or close secondary.
- Keyword density 0.5–2.5% — never stuff.
- Internal links: use `seo.internal_link_targets` with the suggested anchor
  hints. Hit `seo.min_internal_links_per_1000_words`. Never "click here".
- Self-contained paragraphs (no "as mentioned above").
- Numbered lists for any process; definitions lead each section.

Code blocks:

- Language tag on every fence.
- Imports, setup, and `cd` steps present where a reader would need them.
- Versions pinned. Mark untested snippets clearly so the editor catches
  them.
- Show expected output after long snippets.
- Mermaid (or described diagram) for any system with >2 components.

Product hooks: use exactly the hooks in the brief. Roughly one hook per
600–800 words. Hooks are worked examples — never interruptions, never
opening or closing pitches.

Premium-writing expectations:

- Lead with a concrete tension, surprising observation, or hard-earned
  lesson, not generic exposition.
- Avoid filler transitions and obvious throat-clearing.
- Vary sentence length deliberately.
- Prefer precise nouns and verbs over hype adjectives.
- Make each section worth reading even if extracted alone.

For pattern depth, the writer may consult
`skills/blog-writing/references/blog-writing-specialist.md` (post-type
templates), `devrel-content.md` (code conventions), `content-patterns.md`
(reusable AEO/GEO blocks), and `platform-ranking-factors.md`.

### gate

- Draft written to `<slug>.md`.
- Frontmatter complete with `title`, `description`, `tags` (≤ 4), `slug`,
  `canonical_url` set to `{product.blog_url}/<slug>`, and
  `published: false`.
- Word count within ±20% of the brief's `target_word_count`.
- Writer has returned a list of any flagged issues (untested snippets,
  unverified sources, brief items deliberately not included and why).

## edit

Run a formal multi-review board, not a single editor pass, against the
draft produced by `draft`, attached to this unit as input. This is an
internal loop between reviewers and the writer that may repeat up to the
`max_review_rounds` parameter times. Preserve an audit trail in
`<slug>-reviews.md` and `<slug>-review-round-<n>.md` (under `workspace_dir`).

Each round includes these independent reviewers:

1. **Research reviewer** — checks factual grounding, source quality,
   contradiction handling, and whether the article over-claims beyond the
   brief.
2. **SEO reviewer** — checks keyword targeting, SERP fit, snippet quality,
   heading structure, internal links, scannability, AEO/GEO readiness, and
   whether the article is likely to outperform generic summaries.
3. **Literary voice reviewer** — checks prose quality, rhythm,
   specificity, texture, cliche avoidance, and whether any optional
   `literary_voice` guidance was used tastefully and safely.
4. **Technical reviewer** — checks code correctness, setup completeness,
   version pinning, diagram quality, link accuracy, and practical
   usefulness.
5. **Managing editor** — checks argument structure, pacing, originality,
   audience fit, product-hook discipline, and whether the article feels
   premium rather than competent-but-generic.

Each reviewer must return one of:

- `approve`
- `request_changes`
- `block`

Each review must cite section headings or line ranges and explain the issue
in terms of the workflow rules or content plan.

Round protocol:

1. Reviewers evaluate the draft independently.
2. Aggregate comments into a single prioritized fix list grouped by
   severity: blocking, major, polish.
3. The writer revises the draft using that list and records what changed.
4. Re-run the full review board on the revised draft.

Stop conditions, all evaluated inside this same step — there is no separate
step to route to:

- **ship** — every reviewer returns `approve` in the same round *and* every
  non-negotiable below holds. Report the draft as done.
- **loopback** — one or more reviewers return `request_changes`, or a
  non-negotiable below still fails; run another round within this step
  (the gate below re-runs this step, with the judge's feedback, up to
  `max_review_rounds` times — keep the two numbers in sync if you change
  one).
- **kill** — any reviewer returns `block` for fabricated claims, unsafe
  technical content, wrong pillar fit, derivative writing, or no original
  angle, or a non-negotiable reveals the draft needs restructuring rather
  than editing. Report this rather than silently looping — if the gate's
  loop budget is then exhausted (or immediately, for a `kill`), the step
  fails and a human decides whether the article needs a fresh
  `akm workflow start` from `draft`.

Re-check the final draft against every one of these non-negotiables on
every round, even once the review board says `ship` — this is the last
guardrail before publishing:

1. Topic fits at least one pillar in `brand.yaml`.
2. No banned phrase from `voice.banned_phrases` is present.
3. Every performance / adoption / version claim has a cited source in the
   brief or an authoritative link in the body.
4. Every fenced code block has a language tag and would run as written
   (versions pinned, imports present, no orphan placeholders).
5. `canonical_url` is set and points to `{product.blog_url}/<slug>` —
   never to `dev.to`.
6. Internal link count ≥ `seo.min_internal_links_per_1000_words`, computed
   against the actual word count.
7. TL;DR present and 80–120 words.
8. Title ≤ 65 chars and includes the primary keyword.
9. Meta description 105–160 chars and includes the primary keyword.
10. Frontmatter has `published: false`.
11. Every reviewer approved in the final round.
12. If `literary_voice` was provided, the final draft uses the approved
    stylistic guidance without drifting into imitation or gimmickry.

### gate

- Review-board decision is `ship` (every reviewer approved in the same
  final round).
- All twelve non-negotiables above pass.
- Edited draft saved at `<slug>.md`.
- Review logs and per-round fix lists exist.
- Changelog produced citing the rule each change enforces (e.g.
  `[voice.banned_phrases]`, `[seo.min_internal_links_per_1000_words]`).
- Final word count, internal link count, and primary-keyword placements
  recorded for the report.

## publish-draft

Run the dev.to CLI from the blog-writing skill to create the article with
`published: false` and `canonical_url` pointed at the product blog, once
`edit` has shipped the draft (attached to this unit as input):

```bash
bun skills/blog-writing/scripts/devto-cli.ts draft \
  --file <slug>.md \
  --brand <brand_config_path>
```

The CLI:

- Reads frontmatter (`title`, `description`, `tags`, `cover_image`) from the
  markdown.
- Builds `canonical_url` as `{product.blog_url}/<slug>` from the brand
  config (or honors the value already in frontmatter).
- Defaults tags to `seo.devto_default_tags` if frontmatter omits them.
- POSTs to `https://dev.to/api/articles` with header
  `api-key: $DEVTO_API_KEY`.
- Prints the draft URL (e.g. `https://dev.to/<user>/<slug>-temp-slug`) and
  the dev.to article ID.

To update an existing draft instead of creating a new one:

```bash
bun skills/blog-writing/scripts/devto-cli.ts update \
  --id <article_id> \
  --file <slug>.md
```

To list current drafts for sanity-checking:

```bash
bun skills/blog-writing/scripts/devto-cli.ts list-drafts
```

### gate

- CLI exits 0.
- `devto_article_id` and `devto_draft_url` captured.
- A spot-check of the draft URL shows the article exists with
  `published: false` and the expected canonical URL.

## notify

Call the existing `notify` skill (apprise transport) with the channel from
`publishing.approval.notify_channel` (or the `notify_channel` parameter if
overridden), using the draft published by `publish-draft`, attached to this
unit as input:

```bash
bash skills/notify/scripts/notify.sh \
  --channel <notify_channel> \
  --subject "Blog draft ready for review: <title>" \
  --body "$(cat <<EOF
<approver_mention> — a new draft is ready.

Title: <title>
Topic: <topic>
Pillar: <pillar_primary>
Word count: <word_count>
Dev.to draft: <devto_draft_url>
Canonical (on publish): <canonical_url>

Summary:
<one-paragraph TL;DR from the article>

Reply in-thread to approve or request changes.
EOF
)"
```

`<approver_mention>` comes from `publishing.approval.approver_mention` in
the brand config. The `--channel` value must match a tag in the apprise
config that routes to the reviewer's webhook.

### gate

- Notify command exits 0.
- The notification appears in the reviewer channel with the draft URL,
  TL;DR, and approver mention.
- `notified_channel` recorded for the report.

## report

Print (or persist) a JSON summary of the run so the caller — or downstream
tooling — can pick the article up after approval, drawing on the
notification sent by `notify`, attached to this unit as input. Use this
exact shape:

```json
{
  "topic": "<topic>",
  "pillar": "<pillar_primary>",
  "brief_path": "<workspace_dir>/<slug>-brief.md",
  "draft_path": "<workspace_dir>/<slug>.md",
  "devto_article_id": 123456,
  "devto_draft_url": "https://dev.to/<user>/<slug>-temp-slug",
  "canonical_url": "https://<domain>/blog/<slug>",
  "notified_channel": "<notify_channel>",
  "word_count": 1847,
  "internal_link_count": 6,
  "review_rounds": 3,
  "reviewers_approved": [
    "research",
    "seo",
    "literary-voice",
    "technical",
    "managing-editor"
  ],
  "status": "awaiting-approval"
}
```

Status is always `awaiting-approval` on a successful run. The article stays
at `published: false` until a human flips it.

### gate

- Report JSON emitted with every field populated.
- `status` is `awaiting-approval`.
- Workflow run is marked complete.
