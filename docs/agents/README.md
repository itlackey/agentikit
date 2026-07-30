# Agents

Documentation for wiring AI agents into akm.

Run `akm help agents` for the CLI reference agents should load into a system prompt
(the short form is the default; pass `--full` for the complete guide). It always prints the embedded
corpus at `src/assets/hints/cli-hints-full.md` / `cli-hints-short.md` --
browse those files directly if you want to read the reference without running
the CLI. There used to be a separate `docs/agents/AGENTS.md` /
`AGENTS.full.md` pair here; it fed nothing at runtime after R-006 and kept
re-diverging from the embedded copy with no test to catch it, so it was
deleted and its still-true unique content was merged into the embedded files.

- [Agent Install Guide](agent-install.md) -- Step-by-step automated install for agents
- [Curate Workmap](curate-workmap.md) -- Read before changing `akm curate` ranking or output
