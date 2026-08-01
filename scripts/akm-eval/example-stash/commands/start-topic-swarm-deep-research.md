---
description: "Scaffold and start the combined topic-swarm plus deep-research workflow with a clean parameter template."
---
# Start Topic Swarm Deep Research

Start the combined swarm-plus-deep-research workflow for this goal:

`$ARGUMENTS`

Use this procedure:

1. Ensure the workflow asset exists in the stash. If `workflows/research/topic-swarm-select-and-deep-research` does not exist yet, create it from `scripts/akm-eval/example-stash/workflows/topic-swarm-select-and-deep-research.md`:

```sh
akm workflow create research/topic-swarm-select-and-deep-research --from scripts/akm-eval/example-stash/workflows/topic-swarm-select-and-deep-research.md
```

2. Run the workflow with exact declared parameter flags. Fill in unknowns
conservatively instead of inventing specifics:

```sh
akm workflow run workflows/research/topic-swarm-select-and-deep-research \
  --goal "$ARGUMENTS" \
  --audience "Specify the intended reader and decision-maker" \
  --scope "Specify boundaries, exclusions, geography, time horizon, and quality bar" \
  --workspace_dir ".akm-run/topic-swarm-deep-research" \
  --deliverable_path ".akm-run/topic-swarm-deep-research/report.md" \
  --wiki_name research \
  --max_swarm_topics 12 \
  --max_topic_depth 3 \
  --max_topic_branches 5 \
  --max_iterations 8 \
  --min_primary_sources 5 \
  --trusted_domains '[]' \
  --seed_urls '[]'
```

3. Record the returned run id and terminal result. If the goal is already
narrow and topic selection is unnecessary, prefer the standalone workflow in
`scripts/akm-eval/example-stash/workflows/deep-research-auto-research.md`
instead.
