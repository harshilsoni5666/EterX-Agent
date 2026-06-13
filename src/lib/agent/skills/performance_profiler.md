---
name: "performance-profiler"
description: Use when an app, API, query, bundle, page, job, or workflow is slow, memory-heavy, expensive, or at risk of performance regression. Focuses on measurement, bottleneck isolation, targeted fixes, and before/after verification.
---

# Performance Profiler

Measure before optimizing. A performance fix without a baseline is a guess.

## Workflow

1. Define the symptom and success metric: latency, throughput, memory, CPU, bundle size, query time, frame rate, or cost.
2. Establish a baseline with a repeatable command or scenario.
3. Isolate the bottleneck: CPU, memory, I/O, network, database, rendering, bundle, or external dependency.
4. Make the smallest targeted change.
5. Re-measure with the same scenario.
6. Report before/after numbers and remaining risk.

## Useful Commands

Use what fits the stack:

```bash
# Node/API smoke and load checks
npx autocannon http://localhost:3000
npx clinic doctor -- node server.js

# Browser/app bundle checks
npm run build
npx next build
npx vite build

# Python profiling
python -m cProfile -o profile.out script.py
py-spy top --pid <pid>

# Go profiling
go test -bench=. -benchmem ./...
go tool pprof

# Database
psql -c "EXPLAIN (ANALYZE, BUFFERS) <query>"
```

Do not load-test production or third-party systems without explicit authorization.

## Report Format

```markdown
## Performance Finding

Symptom:
Baseline:
Bottleneck evidence:
Change made:
After:
Tradeoffs:
Verification:
```

## Common Pitfalls

- Optimizing without a baseline.
- Comparing different environments or datasets.
- Fixing average latency while P95/P99 regresses.
- Ignoring memory growth after a short successful run.
- Treating bundle size, query count, or CPU time as separate from user-visible performance.
