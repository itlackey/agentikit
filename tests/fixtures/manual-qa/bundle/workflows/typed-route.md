---
type: workflow
description: Deterministic route-first workflow for typed parameter checks
updated: 2026-08-05
params:
  include_processes: { type: boolean }
  count: { type: integer, minimum: 1 }
  labels: { type: array, items: { type: string } }
steps:
  - id: choose
    route:
      input: params.include_processes
      when: [{ match: "true", step: finish }]
      default: finish
  - id: finish
---

# Typed Route

## choose

## finish

Return the literal marker `qa-workflow-finish`.
