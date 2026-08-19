---
type: workflow
description: Portable execution-contract workflow expressed as AKM Markdown
updated: 2026-08-19
steps:
  - id: review
    unit:
      exec:
        command: [printf, contract-reviewed]
  - id: summarize
    unit:
      exec:
        command: [printf, contract-summarized]
---
# Contract review

## review

Emit the deterministic review marker.

## summarize

Emit the deterministic summary marker.
