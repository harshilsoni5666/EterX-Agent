---
name: "runbook-generator"
description: Use to create or improve operational runbooks for services, deployments, incidents, maintenance, rollbacks, alerts, and on-call procedures.
---

# Runbook Generator

Runbooks must be executable under pressure. Generate them from real service behavior, not generic placeholders.

## Workflow

1. Identify service name, owner, environment, dependencies, dashboards, alerts, deploy path, and rollback path.
2. Inspect existing docs, scripts, CI/CD workflows, health endpoints, config, and infrastructure files.
3. Write copy-pasteable commands with expected outputs and verification steps.
4. Include escalation contacts or placeholders only when real ownership is unavailable.
5. Add a test/dry-run note so the runbook does not rot.

## Runbook Sections

Use the sections that fit the service:

- Purpose and scope.
- Ownership and escalation.
- Dependencies and dashboards.
- Health checks.
- Deploy procedure.
- Rollback procedure.
- Common incidents and diagnosis.
- Maintenance tasks.
- Data safety and backup/restore notes.
- Post-incident update checklist.

## Quality Bar

- Every action has an expected result.
- Every risky action has rollback or stop criteria.
- Commands are scoped to environment.
- Secrets are referenced by name/location, never written out.
- The runbook says how to verify recovery.
