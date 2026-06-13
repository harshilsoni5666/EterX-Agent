---
name: iterative-loop
description: Use for tasks that require repeated implement-check-refine cycles, such as fixing tests, polishing UI, improving performance, or resolving build errors.
icon: RefreshCw
category: coding
---

# Iterative Loop

Use this skill when one pass is unlikely to be enough.

## Loop

1. Choose one measurable target for the next iteration.
2. Make the smallest change that could move the target.
3. Run the relevant check.
4. Read the output and record what changed.
5. Continue only if the next iteration has a new hypothesis.

## Stop Conditions

- The target passes.
- Three iterations fail for the same underlying reason.
- The next step requires user input, credentials, permissions, or external state.
- Further changes would expand scope beyond the request.
