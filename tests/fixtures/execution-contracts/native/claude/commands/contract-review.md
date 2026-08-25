---
description: Review one exact target through the Claude command format
argument-hint: <target>
allowed-tools: Read, Grep
model: fixture-balanced
akm:
  engine: fixture-agent
  timeout: 45s
---
# Contract review

Review `$ARGUMENTS` once. Unsupported portable marker: $1.
