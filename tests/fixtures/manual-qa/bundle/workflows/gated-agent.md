---
type: workflow
description: Deterministic agent workflow with one fail-closed completion gate
updated: 2026-08-05
steps:
  - id: review
---

# Gated Agent

## review

Return the literal marker `qa-agent-success`.

### gate

- The result contains `qa-agent-success`.
