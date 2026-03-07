Here are the best ideas and final architectural decisions from the thread, condensed into a clear system design you can actually implement.


---

Agentikit Capability Discovery — Key Ideas

1. Capability Discovery Instead of File Search

The goal is not searching files, it is discovering capabilities (agents, tools, commands, skills).

Agents should be able to ask:

"find tools for summarizing git commits"

And receive a ranked list of capabilities.

So the system indexes metadata, not source code.


---

2. .stash.json Sidecar Metadata System

Each extension directory can contain:

.stash.json

This file describes one or more capabilities.

Example:

{
  "entries": [
    {
      "name": "git-diff-summarizer",
      "type": "tool",
      "description": "summarize git commit changes",
      "tags": ["git","diff","commit"],
      "examples": [
        "summarize git commits",
        "explain git diff"
      ],
      "entry": "run.ts"
    }
  ]
}

Why this works

• Supports multiple tools per directory
• Easy to edit
• Compatible with existing repos
• Persistent metadata improves search over time


---

3. Automatic Metadata Generation

Users should not have to create metadata manually.

When indexing runs:

scan directories
→ detect extensions
→ generate metadata
→ write .stash.json

Generation sources (priority order):

1 existing .stash.json
2 legacy metadata files
3 package.json
4 code comments
5 filename heuristics

Example generated metadata:

{
  "entries": [
    {
      "name": "docker-compose",
      "type": "tool",
      "description": "generate docker compose stacks",
      "tags": ["docker","compose","container"],
      "entry": "compose.ts",
      "generated": true
    }
  ]
}

This ensures zero configuration onboarding.


---

4. Hybrid Search Architecture (Best Design)

The most important design decision:

Use ripgrep + semantic ranking.

Stage 1 — ripgrep candidate filtering

rg query tokens across .stash.json

Example:

rg "git|commit|diff" ~/.agentikit

This quickly finds relevant metadata files.


---

Stage 2 — semantic ranking

Embedding similarity ranks the candidate entries.

query embedding
vs
entry embedding

Rank by cosine similarity.


---

Why this architecture is ideal

Method	Problem

ripgrep only	no semantic understanding
semantic only	slower


Hybrid approach gives:

speed + intelligence


---

5. Embedding Model

Use a local CPU model.

Recommended:

Xenova/all-MiniLM-L6-v2

via:

@xenova/transformers

Benefits:

• runs in Bun
• no GPU
• no external API
• small model


---

6. Metadata Embedding Cache

Embeddings should be stored in metadata.

Example:

{
  "entries": [
    {
      "name": "git-diff",
      "embedding": [0.132, -0.442, ...]
    }
  ]
}

Benefits:

index once
search instantly

No recomputation.


---

7. Index Storage

Index file:

~/.cache/agentikit/index.json

Stores:

entries
embeddings
paths

This enables fast search.


---

8. CLI Interface

Two commands are needed.

Build index

akm index

Output example:

Indexed: 47 extensions
Generated metadata: 12
Index updated


---

Search

akm search "summarize git commits"

Output:

1 git-diff-summarizer
2 commit-message-ai
3 repo-insights


---

9. Directory Structure

Recommended layout:

~/.agentikit

agents/
tools/
commands/
skills/

Example:

tools/git/
  summarize.ts
  .stash.json


---

10. Metadata Schema

Fields supported:

Field	Purpose

name	capability name
type	tool / agent / command / skill
description	short summary
tags	keywords
examples	example tasks
entry	entry script
embedding	cached vector
generated	metadata auto-generated flag



---

11. Progressive Repository Improvement

Each indexing run:

improves repository metadata

Generated metadata persists and can be edited manually.

Over time the repo becomes fully structured.


---

12. Performance Targets

Expected performance:

Operation	Target

directory scan	<50ms
metadata generation	<200ms
index build	<500ms
query search	<10ms



---

Final Architecture

Directory Scan
     ↓
Metadata Resolution
     ↓
Metadata Generation
     ↓
.stash.json written
     ↓
Embedding Index
     ↓
ripgrep candidate filtering
     ↓
semantic ranking
     ↓
ranked capability list


---

The Three Most Important Decisions

If you remember nothing else, these are the three key ideas:

1. .stash.json sidecar metadata

Flexible, multi-entry capability description.

2. Hybrid search

ripgrep + semantic ranking

3. Automatic metadata generation

Users never have to create metadata by hand.

The missing piece is intent phrases (sometimes called capability intents or task phrases).

Right now your metadata mostly describes what the tool is:

"description": "summarize git commit changes"

But agents usually search using tasks, not descriptions.

Example agent query:

"explain what changed in this repo"

That might not match:

"summarize git diff"

Even semantic search sometimes struggles here because the phrasing is far apart.


---

The Key Improvement: intents

Add a field in .stash.json called:

"intents"

These are natural language tasks the capability solves.

Example:

{
  "entries": [
    {
      "name": "git-diff-summarizer",
      "type": "tool",
      "description": "summarize git commit changes",
      "tags": ["git","diff","commit"],

      "intents": [
        "summarize git commits",
        "explain what changed in a repository",
        "show a summary of code changes",
        "describe changes in a pull request"
      ],

      "entry": "run.ts"
    }
  ]
}


---

Why This Works Extremely Well

Agents tend to think in task language, not capability language.

Example query:

"what changed in this repo"

Without intents the model compares to:

"summarize git commit changes"

With intents it compares to:

"explain what changed in a repository"

Which is a near perfect semantic match.


---

How It Improves Search

Instead of embedding:

description + tags

You embed:

description
+ tags
+ intents

Example text used for embedding:

git-diff-summarizer
summarize git commit changes
git diff commit
summarize git commits
explain what changed in a repository
describe pull request changes

This dramatically improves ranking.


---

Even Better: Auto-Generate Intents

During indexing you can generate some intents automatically.

Example rules:

From description

summarize git commit changes

Generate:

summarize git commits
explain git diff
show commit summary


---

From tags

Tags:

git
diff
commit

Generate:

show git changes
summarize git repo changes
describe git commits


---

Why Most Tool Systems Fail

Most systems only store:

name
description
tags

But AI agents think in tasks.

So discovery often fails.

Your design becomes much stronger if you model tasks explicitly.


---

Final .stash.json Structure

Recommended schema:

{
  "entries": [
    {
      "name": "git-diff-summarizer",
      "type": "tool",

      "description": "summarize git commit changes",

      "tags": [
        "git",
        "diff",
        "commit"
      ],

      "intents": [
        "summarize git commits",
        "explain what changed in a repository",
        "show commit summary",
        "describe pull request changes"
      ],

      "examples": [
        "summarize git commits in this repo",
        "explain what changed in the last commit"
      ],

      "entry": "run.ts"
    }
  ]
}


---

How This Fits the Search Pipeline

Final search pipeline:

agent task
     ↓
ripgrep candidate filtering
     ↓
load stash entries
     ↓
embed:
   description
   tags
   intents
   examples
     ↓
semantic similarity
     ↓
rank results


---

Why This Matters for Agentikit

This design makes Agentikit behave much closer to how Claude Code / Cursor / OpenAI tools internally discover tools.

They don’t rely only on descriptions — they rely on task language.


---

My Strong Recommendation

Your final schema should include:

name
type
description
tags
intents   ← most important field
examples
entry
embedding
generated


---

