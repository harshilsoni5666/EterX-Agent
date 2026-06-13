---
name: tech-debt-tracker
description: Use to identify, classify, prioritize, and plan remediation for technical debt, legacy code, missing tests, risky dependencies, brittle architecture, documentation gaps, and maintenance cost.
---

# Tech Debt Tracker

Technical debt is only useful to track when it leads to better prioritization. Tie every item to user risk, delivery drag, operational cost, or security exposure.

## Workflow

1. Inspect the repo and recent pain points.
2. Collect debt signals: TODO/FIXME/HACK, duplicated code, flaky tests, missing tests, large files, dependency drift, risky config, complex modules, stale docs.
3. Classify each item by type and affected area.
4. Score impact, urgency, effort, confidence, and owner.
5. Group related items into practical remediation slices.
6. Produce a prioritized plan with verification.

## Debt Categories

- Correctness risk.
- Security risk.
- Performance/cost risk.
- Test gap or flaky verification.
- Architecture coupling.
- Dependency/runtime drift.
- Documentation/onboarding gap.
- Operational/runbook gap.
- Developer-experience friction.

## Prioritization

Use a simple score:

```text
priority = impact + urgency + confidence - effort
```

Explain the reasoning instead of pretending the score is mathematically exact.

## Output

For each item:

- Title.
- Evidence with file/path reference when available.
- Impact.
- Suggested fix.
- Effort size.
- Owner or owning area.
- Verification.

End with the top 3-5 recommended actions.
