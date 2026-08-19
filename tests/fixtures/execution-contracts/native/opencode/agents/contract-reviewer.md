---
description: Read-only OpenCode reviewer for execution contract fixtures
mode: subagent
model: fixture-balanced
temperature: 0
tools:
  read: true
  grep: true
  write: false
akm:
  engine: fixture-agent
  timeout: 45s
---
# Contract reviewer

Review the requested change without modifying files.
