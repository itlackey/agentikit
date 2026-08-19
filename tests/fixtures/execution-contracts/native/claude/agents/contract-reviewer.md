---
name: contract-reviewer
description: Read-only Claude reviewer for execution contract fixtures
model: fixture-balanced
tools: Read, Grep
akm:
  engine: fixture-agent
  timeout: 45s
---
# Contract reviewer

Review the requested change without modifying files.
