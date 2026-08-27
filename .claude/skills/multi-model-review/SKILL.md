---
name: multi-model-review
description: Get independent second opinions on code, a diff, or a design decision from a panel of non-Claude models (OpenAI, DeepSeek, Kimi, Nemotron, MiniMax via NVIDIA NIM, or any OpenAI-compatible endpoint), each reviewing through a distinct role, then synthesize consensus and disagreement. Use when the user says "ask the council", "second opinion", "multi-vendor review", "multi-model review", "what do other models think", or before merging high-stakes changes (payments, auth, tenant isolation, trading logic, migrations). Also handles council setup and reconfiguration.
---

# Multi-Model Review

Cross-vendor review. The point is **bias-breaking**: every Claude subagent shares Claude's
priors, so a Claude-only review cannot catch what Claude systematically misses. Models trained
by different organizations on different data can.

Runner: `bun .claude/skills/multi-model-review/scripts/council.ts` (zero dependencies; Node.js
>= 24 works too: `node .claude/skills/multi-model-review/scripts/council.ts`).
Config: `$COUNCIL_HOME/config.json`, default `~/.config/akm-council/` (user data, outside the
repo — an upgrade never touches it). Role library: `$COUNCIL_HOME/roles.json` overrides the
bundled `roles.json` next to this file.

## When to use

Worth the latency and tokens for payments, billing, auth, tenant isolation, trading logic,
schema migrations, and design decisions that are expensive to reverse.

Not worth it for typo fixes, formatting, or exploratory scripts. For a Claude-only review use
the ordinary review flow — faster and free.

## Setup (first run, or when the user wants to change models)

**1. Keys are environment variables only.** Each provider in `config.json` names an
`api_key_env`; the runner reads that variable at request time. Keys are never stored in config,
never passed as argv, never printed. Two ways to supply them:

```bash
export NVIDIA_API_KEY=...        # plain environment
# or, akm-native — inject a stored secret for one command without exporting it:
akm secret run secrets/nvidia-api-key NVIDIA_API_KEY -- bun .claude/skills/multi-model-review/scripts/council.ts --check
```

NVIDIA issues keys only through the web UI — send the user to <https://build.nvidia.com>, any
model page, "Get API Key". One `nvapi-...` key is account-level and works for every model in
the catalog; the free tier is enough for a panel. Never ask for or handle their password.

**2. Discover real models.** Always do this — providers retire models constantly and a stale
ID fails with a confusing 404/410:

```bash
bun .claude/skills/multi-model-review/scripts/council.ts --list-models --provider nvidia
```

**3. Pick up to 5 and assign roles.** Present the candidates and let the user choose. Two
rules: prefer **five different vendors** over five strong models from two (correlated
panelists waste money), and keep the roles distinct.

```bash
bun .claude/skills/multi-model-review/scripts/council.ts --list-roles
```

Write the panel by piping a spec to `--configure` (it validates providers, roles, and
duplicate names before writing anything):

```bash
echo '{"panelists":[
  {"name":"kimi","provider":"nvidia","model":"moonshotai/kimi-k3","role":"security","enabled":true}
]}' | bun .claude/skills/multi-model-review/scripts/council.ts --configure
```

**4. Verify.** `--check` spends ~8 tokens per panelist:

```bash
bun .claude/skills/multi-model-review/scripts/council.ts --check
```

Read the failures precisely — they distinguish the two failure modes:
`403`/`401` = the model ID is fine, the key is wrong.
`404` or `410 Gone` = the key is fine, the **model ID** is wrong or retired.

## Running a review

**1. Build the prompt as a file.** Never inline a diff — quoting will bite you.

```bash
mkdir -p /tmp/council && git diff main...HEAD > /tmp/council/diff.txt
{
  echo "Review this diff. Context: <what the change does, what the system is>."
  echo "Report only real defects. For each: file:line, concrete failure scenario, fix."
  echo; echo '```diff'; cat /tmp/council/diff.txt; echo '```'
} > /tmp/council/prompt.txt
```

**2. Fan out.** All panelists run in parallel; one dead endpoint does not kill the run.

```bash
bun .claude/skills/multi-model-review/scripts/council.ts --prompt-file /tmp/council/prompt.txt
```

Subset: `--only kimi,deepseek` · Structured output for tooling: `--json`

**3. Synthesize — do not dump raw panelist output at the user.** Produce:

- **Consensus** — flagged by 2+ panelists. Highest confidence. Lead with it.
- **Divergence** — one panelist only. Say who, and why it may be a false positive.
- **Contradiction** — panelists disagree. State it explicitly; do not paper over it.
- **Your read** — where you agree and where you don't, with reasoning. You are not a vote
  counter.

**Then verify every claim against the actual file before relaying it.** Panelists hallucinate
line numbers and invent APIs. A confidently-wrong finding from a second vendor is still
confidently wrong. Majority agreement is evidence, not proof — models trained on similar data
share blind spots and can be wrong together.

## Roles

Nine predefined in `roles.json`: correctness, architecture, security, regression, performance,
simplicity, data-integrity, product, generalist. A panelist picks one via `"role"`, or
overrides with an inline `"lens"` for a one-off.

**Distinct roles are the whole design.** Five models given the same generic "review this"
prompt converge on the same shallow findings. Five models given five different questions find
five classes of defect. Preserve that when editing.

To change a role's wording for every panelist using it, copy the bundled `roles.json` to
`$COUNCIL_HOME/roles.json` and edit there — not the panelists.

## Reference

```bash
council.ts --show           # current panel and which keys resolve
council.ts --list-roles     # available roles
council.ts --list-models    # authoritative model IDs per provider
council.ts --check          # liveness probe (add --json for structured results)
```

Per-panelist tuning in `config.json`: `temperature`, `top_p`, `max_tokens`, `timeout`
(seconds), and `extra_body` (passed through verbatim — this is how provider-specific knobs
like `reasoning_effort` or `chat_template_kwargs` are set). Responses that arrive only in the
`reasoning`/`reasoning_content` channel are handled. Providers that reject `max_tokens` in
favour of `max_completion_tokens` (or reject a non-default `temperature`) are adapted to
automatically, once, from the provider's own structured 400 error.

Any OpenAI-compatible endpoint works — NVIDIA NIM, OpenAI, OpenRouter, Together, Zhipu, a
local vLLM or Ollama: add an entry under `providers` with a `base_url` and an `api_key_env`.

Design adapted from [swingsystems/claude-council](https://github.com/swingsystems/claude-council) (MIT).
