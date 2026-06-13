---
name: "codebase-onboarding"
description: Use to inspect a repository and create onboarding documentation for engineers, contractors, tech leads, or maintainers. Covers architecture, setup, common workflows, ownership, risks, and contribution guidance from actual repo evidence.
---

# Codebase Onboarding

Create onboarding docs from the real codebase, not from a canned template.

## Workflow

1. Inspect the repo structure, manifests, configs, entry points, tests, docs, scripts, and deployment files.
2. Identify the audience: junior developer, senior engineer, contractor, tech lead, on-call, or product-adjacent reader.
3. Verify setup/build/test commands from package files or existing docs before recommending them.
4. Document how the system is actually organized and where a newcomer should start.
5. Include troubleshooting, ownership boundaries, and safe contribution guidance.

## Useful Local Commands

```bash
rg --files
Get-ChildItem -Force
rg -n "TODO|FIXME|HACK|deprecated|owner|runbook|deploy|test|build"
```

Use the repo's native commands from `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, Gradle/Maven files, or existing docs.

## Output Shape

Adapt sections to the audience:

- Project purpose and mental model.
- Tech stack and runtime.
- Local setup and verification commands.
- Directory map with important files.
- Main workflows: develop, test, build, deploy, debug.
- Architecture boundaries and data flow.
- Common gotchas and troubleshooting.
- Contribution expectations and review checklist.
- Pointers for deeper reading.

Keep it practical. A contractor handoff can be short and scoped; a platform onboarding guide can be deeper.
