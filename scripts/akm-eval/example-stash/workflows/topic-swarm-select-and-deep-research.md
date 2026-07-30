---
type: workflow
description: Swarm across many candidate topics, recursively map and score their branches, select the strongest topic for the user's goal, then transition into deep research and wiki publication using the same artifact model as the deep-research workflow.
tags: [example, research, topic-swarm, deep-research, wiki, agents]
params:
  goal: { type: string, description: "The higher-level objective to optimize for, such as finding the best article topic, market angle, research direction, or product opportunity." }
  audience: { type: string, description: "Who the final recommendation and deep-research report are for." }
  scope: { type: string, description: "Constraints, exclusions, domain boundaries, geography, time horizon, and quality bar." }
  candidate_pool: { type: array, description: "Optional list of starting topics, hypotheses, niches, or search seeds." }
  workspace_dir: { type: string, description: "Directory for run artifacts. Defaults to a per-run directory such as `.akm-run/<run-id>/`." }
  deliverable_path: { type: string, description: "Output report path for the final deep-research report. Defaults to a per-run path such as `.akm-run/<run-id>/report.md`." }
  wiki_name: { type: string, description: "Optional AKM wiki name to publish the selected topic research into. Defaults to `research`." }
  max_swarm_topics: { type: number, description: "Maximum number of top-level topics to explore in the swarm. Defaults to 12." }
  max_topic_depth: { type: number, description: "Maximum recursive depth for swarm branch expansion or deep-research frontier expansion. Defaults to 3." }
  max_topic_branches: { type: number, description: "Maximum child topics to spawn from one node before forcing prioritization. Defaults to 5." }
  max_iterations: { type: number, description: "Maximum iterative rounds for the deep-research phase. Defaults to 8." }
  min_primary_sources: { type: number, description: "Minimum count of primary or official sources required in the deep-research phase. Defaults to 5." }
  trusted_domains: { type: array, description: "Optional list of domains to prioritize or restrict to." }
  seed_urls: { type: array, description: "Optional list of URLs to ingest before broad web search." }
steps:
  - id: frame-objective
  - id: seed-swarm
    inputs: [steps.frame-objective.output]
  - id: recursive-swarm-exploration
    inputs: [steps.seed-swarm.output]
  - id: score-and-select
    inputs: [steps.recursive-swarm-exploration.output]
  - id: build-deep-research-handoff
    inputs: [steps.score-and-select.output]
  - id: run-deep-research
    inputs: [steps.build-deep-research-handoff.output]
  - id: challenge-selected-topic
    inputs: [steps.run-deep-research.output]
  - id: write-final-report
    inputs: [steps.challenge-selected-topic.output]
  - id: publish-into-wiki
    inputs: [steps.write-final-report.output]
  - id: audit-combined-run
    inputs: [steps.publish-into-wiki.output]
---

# Topic Swarm Select And Deep Research

This workflow combines two modes of research that should reinforce each
other:

- **Topic swarm** explores a broad space of possibilities, recursively
  mapping branches and scoring them against the user's goal.
- **Deep research** takes the highest-value topic from that swarm and
  executes a rigorous evidence loop with citations, contradiction checks,
  and wiki publication.

The key design rule is continuity of artifacts. The swarm does not throw
work away. It leaves behind a scored topic graph and evidence trail that
become the starting context for the deep-research phase. Paths below are
relative to the directory named by the `workspace_dir` parameter unless
stated otherwise.

## frame-objective

Turn the user's request into a selection problem before exploring topics.

Create `brief.md` with:

1. `Goal` - the real objective behind the request, from the `goal`
   parameter.
2. `Audience` - who the answer is for and what decision they need to make,
   from the `audience` parameter.
3. `Scope` - boundaries, exclusions, geography, time horizon, and quality
   bar, from the `scope` parameter.
4. `Selection criteria` - 4 to 8 criteria that define what makes one topic
   better than another.
5. `Disqualifiers` - what should immediately eliminate a topic.
6. `Deliverable` - what the final recommendation and deep-research report
   must contain.

Resolve defaults for parameters left unset:

- `workspace_dir` -> a per-run directory when omitted.
- `deliverable_path` -> `report.md` under `workspace_dir` when omitted.
- `wiki_name` -> `research` when omitted.
- `max_swarm_topics` -> `12` when omitted.
- `max_topic_depth` -> `3` when omitted.
- `max_topic_branches` -> `5` when omitted.
- `max_iterations` -> `8` when omitted.
- `min_primary_sources` -> `5` when omitted.

If the prompt is too vague to score topics, stop and ask clarifying
questions before the swarm begins.

### gate

- `brief.md` exists with goal, audience, scope, selection criteria,
  disqualifiers, and deliverable.
- Defaults are resolved and recorded.
- The selection problem is concrete enough to rank topics against it.

## seed-swarm

Create the initial topic universe to explore, guided by the brief from
`frame-objective`, attached to this unit as input.

Create `swarm-seeds.md` containing:

- the `candidate_pool` parameter's contents, if any
- topics derived from the goal and scope
- adjacent approaches, competing framings, and contrarian angles
- underserved or less obvious niches that still satisfy the objective

Then create `topic-graph.md` with one entry per seed topic:

- `topic`
- `parent_topic` (`root` at this stage)
- `depth`
- `hypothesis`
- `why_it_might_win`
- `status` (`open`, `exploring`, `scored`, `selected`, `deferred`,
  `rejected`)
- `priority`
- `entry_queries`
- `spawn_budget_remaining`

Cap the initial top-level candidate set at `max_swarm_topics` by ranking and
pruning weak seeds before broad exploration begins.

### gate

- `swarm-seeds.md` exists with the candidate universe.
- `topic-graph.md` exists with the first ranked set of topics.
- The number of top-level topics is bounded by `max_swarm_topics`.

## recursive-swarm-exploration

Explore the topic space recursively, but only as far as it improves topic
selection quality, continuing from the seeded graph built by `seed-swarm`,
attached to this unit as input.

Create or append to `swarm-iterations.md` for each round. For every
explored topic, record:

1. `Topic explored`
2. `Why chosen now`
3. `Searches and sources consulted`
4. `Signals found` - evidence of audience demand, novelty, source
   richness, competitive landscape, strategic fit, difficulty, or
   monetizable relevance
5. `Child branches spawned`
6. `Topics rejected or deprioritized`
7. `Score updates`

Recursive swarm rules:

- Select the highest-priority `open` topic from `topic-graph.md`.
- Mark it `exploring` while active.
- Recursively branch into child topics only when the child would
  materially sharpen selection among candidates.
- Do not exceed `max_topic_depth`.
- Do not exceed `max_topic_branches` child topics per parent without first
  ranking and pruning.
- Reject branches that are interesting but fail the goal or selection
  criteria.

This is a discovery swarm, not the final deep-research loop. It should
answer:

- Which topics are best aligned to the user's goal?
- Which have enough source depth to justify deep research?
- Which are differentiated enough to warrant a final report or article?

### gate

- `swarm-iterations.md` records at least one full exploration round.
- `topic-graph.md` shows recursive branching, pruning, and status changes.
- Weak or non-material branches are explicitly rejected or deferred.
- The swarm has enough evidence to compare the surviving topics.

## score-and-select

Convert exploration into a decision, using the topic graph built by
`recursive-swarm-exploration`, attached to this unit as input.

Create `topic-scorecard.md` with one row per surviving topic. Score each
topic against the criteria from `brief.md`, for example:

- relevance to the goal
- audience fit
- evidence availability
- novelty or differentiation
- practical usefulness
- strategic upside
- risk of weak or stale sources

Then choose exactly one selected topic unless the evidence is too weak to
make any recommendation. Record:

- why it won
- why the nearest alternatives lost
- what specific questions still need deep research
- the initial subquestions that the deep-research phase should inherit

Mark the winning topic as `selected` in `topic-graph.md`.

### gate

- `topic-scorecard.md` exists and compares the surviving topics.
- Exactly one topic is selected, or the workflow blocks with a justified
  reason.
- The selected topic has inherited deep-research questions and rationale.

## build-deep-research-handoff

Translate the winning topic into the artifact model used by the
deep-research workflow so the next phase can start without rethinking the
problem, using the selection produced by `score-and-select`, attached to
this unit as input.

Create these files from the selection output:

- `plan.md`
- `frontier.md`
- `sources.md`

`plan.md` must include:

- the selected topic as the main question
- the inherited subquestions from `score-and-select`
- evidence needs
- trusted-domain or seed-URL policy if provided
- stop conditions for deep research

`frontier.md` must include:

- the selected topic at depth `0`
- first-wave deep-research subtopics at depth `1`
- status, priority, entry queries, and exit conditions

`sources.md` must include:

- the best sources already discovered during the swarm
- trust notes and freshness notes
- why each source matters to the selected topic

This step is the synergy bridge: the swarm's outputs become the
deep-research inputs directly.

### gate

- `plan.md`, `frontier.md`, and `sources.md` exist.
- The selected topic and inherited subquestions are encoded for deep
  research.
- The deep-research phase can start from swarm findings instead of from
  zero.

## run-deep-research

Now execute the same rigorous loop used in the standalone deep-research
workflow, but scoped to the selected topic and seeded from the artifacts
`build-deep-research-handoff` produced, attached to this unit as input.

Create or append to `iterations.md` and maintain `findings.md`.

For each round:

- select the highest-priority `open` topic from `frontier.md`
- gather evidence, inspect primary sources, and update the source map
- recursively spawn child topics only when they materially reduce
  uncertainty or improve the answer
- promote only validated claims into `findings.md`
- reject weak, stale, or contradictory claims explicitly
- mark topics `saturated`, `deferred`, or `rejected` with reasons

Promote a claim only when all of the following hold:

- it materially matters to the selected topic
- it has at least one citation to a primary or otherwise authoritative
  source
- it is specific enough to verify later
- it is recent enough for the domain, or clearly marked historical

This is the ratchet rule: only validated progress accumulates.

Stop when the plan's stop conditions are met, all material topics are
`saturated`, or the `max_iterations` parameter is reached.

### gate

- `iterations.md` records the deep-research rounds.
- `frontier.md` reflects recursive deep-research topic handling.
- `findings.md` contains only promoted, traceable claims.
- The selected topic now has evidence depth beyond the swarm phase.

## challenge-selected-topic

Run a deliberate disconfirmation pass on the winning topic before writing
the final report, against the findings produced by `run-deep-research`,
attached to this unit as input.

Create `contradictions.md` with:

1. `Direct contradictions`
2. `Hidden assumptions`
3. `Missing evidence`

For each important finding, attempt to locate corroboration,
disconfirmation, or an explicit reason no independent source exists.
Downgrade or qualify findings that do not survive this pass.

### gate

- `contradictions.md` exists for the selected topic.
- Major findings have corroboration, disconfirmation, or an explicit gap
  note.
- Any downgraded claims are reflected back into `findings.md`.

## write-final-report

Write the final report to the path named by the `deliverable_path`
parameter, drawing on the disconfirmation pass from
`challenge-selected-topic`, attached to this unit as input.

Required sections:

1. `Recommendation` - the chosen topic and why it won.
2. `Why not the alternatives` - the strongest rejected candidates and why
   they lost.
3. `Method` - how the swarm and deep-research phases were run.
4. `Deep findings` - the validated findings for the selected topic.
5. `Disconfirming evidence and caveats`
6. `Decision implications`
7. `Sources`

Every non-trivial factual claim must be traceable to the evidence
artifacts.

### gate

- The report exists at `deliverable_path`.
- It explains both topic selection and deep-research findings.
- Major claims are traceable to sources and artifacts.

## publish-into-wiki

Write the selected topic and its supporting concepts into the target wiki
so the swarm and deep-research outputs become reusable knowledge, using
the final report from `write-final-report`, attached to this unit as
input. A wiki is a plain directory (`schema.md` + `pages/` + `raw/`)
recognized by the `llm-wiki` adapter on `akm index` — there is no
`akm wiki` command family (`create`, `ingest`, `lint`, `search` are all
unknown commands, exit 2); every write below uses the agent's normal file
tools.

Resolve the target wiki:

- If the `wiki_name` parameter is provided, use it.
- Otherwise default to `research`.
- If the wiki does not exist yet, create it by hand at
  `wikis/<wiki_name>/`: a `schema.md` rulebook plus empty `pages/` and
  `raw/` directories is enough, then register it as its own bundle:

  ```sh
  akm bundle add wikis/<wiki_name> --name <wiki_name>
  ```

  Point `akm bundle add` at the wiki's own directory, not a path nested
  inside the primary AKM stash — a nested path gets claimed by the primary
  stash's own adapter instead of `llm-wiki` and loses wiki recognition.
- If it already exists, find its registered path with
  `akm bundle list --format json` (the matching source's `path` field) if
  you do not already have it.

There is no ingest command — copy or write the raw material straight into
the wiki's `raw/` directory yourself.

Write at least:

1. one main article for the selected topic
2. one page summarizing the swarm comparison and why this topic won
3. additional pages for major related concepts, entities, or frameworks
   that emerged during the run

Stash durable artifacts under `wikis/<wiki_name>/raw/`, such as:

- the final report
- the topic scorecard
- the source map
- high-value extracted notes

Then:

- update `log.md`
- run `akm index`
- there is no `akm wiki lint`, and `akm lint` does not currently reach
  bundle-adapter content such as wiki pages (verified: `akm lint --dir
  <wiki-root>` returns zero findings even against a deliberately broken
  xref) — check `xrefs:`/`sources:` by hand against `schema.md`
- run `akm search "<selected topic>"` to confirm retrieval

### gate

- The wiki contains the new or updated pages.
- Relevant raw artifacts are stashed under `raw/`.
- `akm index` completes cleanly; new pages were checked by hand against
  `schema.md` since there is no automated wiki lint yet.
- The selected topic research is now reusable through `akm search`.

## audit-combined-run

Create `audit.md` that verifies, drawing on the wiki publication performed
by `publish-into-wiki`, attached to this unit as input:

- the swarm explored enough breadth before selection
- recursive branching stayed bounded and decision-relevant
- the selected topic was chosen by explicit criteria rather than
  convenience
- deep research added evidence depth beyond the swarm phase
- citation coverage, freshness coverage, and source balance are acceptable
- wiki publication succeeded and is searchable
- remaining gaps are recorded with recommended next actions

### gate

- `audit.md` exists and checks breadth, selection quality, recursive
  coverage, deep-research quality, citations, freshness, source balance,
  wiki publication, and remaining gaps.
- The workspace contains `brief.md`, `swarm-seeds.md`, `topic-graph.md`,
  `swarm-iterations.md`, `topic-scorecard.md`, `plan.md`, `frontier.md`,
  `sources.md`, `iterations.md`, `findings.md`, `contradictions.md`, the
  final report, and `audit.md`.
- Another agent can resume or review either the swarm phase or the
  deep-research phase without replaying the conversation.
