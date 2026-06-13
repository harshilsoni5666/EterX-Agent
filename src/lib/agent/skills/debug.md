---
name: debug
description: Use when something is broken, failing, throwing errors, behaving unexpectedly, or producing confusing logs. Focuses on evidence-first diagnosis and minimal verified fixes.
icon: Bug
category: coding
---

# Debug

Debug by narrowing uncertainty, not by guessing.

## Workflow

1. Capture the exact symptom, command, request, or user action that fails.
2. Read the full error output, stack trace, log tail, and relevant source.
3. Identify the first failing boundary: input, state, dependency, network, filesystem, build, runtime, or UI.
4. Form two or three hypotheses and test the cheapest one first.
5. Make the smallest fix that explains the evidence.
6. Reproduce the original scenario or run the closest available check.

## Rules

- Do not repeat the same failed command without changing something meaningful.
- Do not swallow errors or hide failing output.
- If the issue is intermittent, look for race conditions, caching, stale state, clocks, retries, and environment differences.
- If verification is impossible, state exactly what remains unverified.
