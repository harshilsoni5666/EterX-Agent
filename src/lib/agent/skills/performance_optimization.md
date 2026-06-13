---
name: performance-optimization
description: Use when code is slow, memory-heavy, laggy, expensive, or likely to regress performance. Focuses on measurement, bottleneck isolation, and targeted optimization.
icon: Zap
category: coding
---

# Performance Optimization

Optimize from evidence. Do not make performance changes because they sound fast.

## Workflow

1. Define the metric: latency, throughput, memory, bundle size, render time, query count, or CPU.
2. Establish a baseline with available profiling, logs, benchmarks, or reproducible commands.
3. Identify the bottleneck before editing.
4. Prefer algorithmic improvements over micro-optimizations.
5. Preserve behavior with tests or sample output comparisons.
6. Measure again and report the delta.

## Common Targets

- N+1 queries and repeated network calls.
- Work inside render loops.
- Full-file reads where streaming or sampling is enough.
- Unbounded concurrency or retries.
- Large client bundles and unnecessary imports.
- Repeated parsing, serialization, sorting, or deep cloning.

## Completion

State the baseline, change made, verification run, measured result, and residual risk.
