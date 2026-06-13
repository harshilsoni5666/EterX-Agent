---
name: self-healing-code
description: Use for resilient error handling, recovery paths, and autonomous diagnosis after test/runtime failures. Emphasizes observable recovery over magical retries.
icon: ShieldAlert
category: coding
---

# Self-Healing Code

Self-healing means clear failure detection, bounded recovery, and useful diagnostics.

## Principles

- Detect failures at system boundaries.
- Retry only transient operations, with caps and backoff.
- Keep recovery paths explicit and tested.
- Preserve the original error cause in logs or returned diagnostics.
- Avoid silent fallbacks that hide data loss or security failures.

## Debug Loop

1. Isolate the failing boundary.
2. Reproduce with the smallest input.
3. Add targeted instrumentation if needed.
4. Implement the recovery path.
5. Verify both success and failure scenarios.

## Anti-Patterns

- Infinite retries.
- Empty catch blocks.
- Returning fake success when an operation failed.
- Resetting user state without confirmation.
- Broad changes that mask the original defect.
