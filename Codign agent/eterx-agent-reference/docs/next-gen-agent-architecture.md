# EterX-Code Next-Generation Architecture

This is the target architecture for an advanced EterX coding agent. It goes beyond a prompt by defining control loops, memory, verification, safety, and improvement mechanics.

## 1. Core Loop

EterX-Code runs an evidence-driven loop:

```text
Request -> classify -> inspect -> plan if needed -> act -> verify -> review -> learn -> report
```

The loop is not fixed-depth. It adapts:

- tiny edit: inspect, edit, verify, report.
- complex feature: map, plan, implement, test, browser verify, review, report.
- unknown bug: reproduce, localize, patch, rerun, regress-check, report.
- high-risk change: plan, risk review, ask if needed, execute, verify.

## 2. Layers

### Always-On Layer

Small, stable, loaded every time:

- latest request guard,
- read-before-edit,
- exact tool routing,
- scope boundary,
- verification before success.

### Mode Layer

Loaded based on request:

- answer,
- inspect,
- manual-edit,
- agent-edit,
- debug-repair,
- review,
- ui-build,
- long-task.

### Skill Layer

Loaded only when relevant:

- frontend,
- backend,
- security,
- QA,
- performance,
- documents,
- data,
- agent design.

### Evidence Layer

Built during work:

- files read,
- symbols found,
- edits made,
- commands run,
- tests passed/failed,
- browser observations,
- risks found.

### Memory Layer

Updated only with durable facts:

- project conventions,
- recurring setup commands,
- user preferences,
- repeated failure rules,
- known test commands.

## 3. Evidence Graph

Every final claim should be backed by evidence.

Example:

```text
Requirement: remove stale branding
  -> Search: stale-name scan returned no matches
  -> Files: AGENTS.md, agent.md, Skill.md, docs/*
  -> Verification: rg search, diff check
  -> Claim: stale branding removed from active reference pack
```

If the evidence is weak, the final answer must say so.

## 4. Agent-Computer Interface

The agent should prefer high-signal tools over raw shell when possible.

Good interface actions:

- search text,
- read file,
- edit exact text,
- run finite command,
- verify code,
- inspect browser snapshot,
- record task checkpoint.

Avoid:

- raw shell for everything,
- unreadable huge output,
- repeated commands,
- blind file rewrites,
- hidden side effects.

## 5. Specialist Swarm

Use a role swarm only when useful:

| Role | Job | Output |
| --- | --- | --- |
| Cartographer | Map repo, dependencies, owner files | file map and risk map |
| Surgeon | Propose or apply minimal patch | changed files and rationale |
| Breaker | Find edge cases and failing tests | concrete failures or no findings |
| Browser Pilot | Verify UI behavior | route, viewport, observations |
| Security Sentinel | Check secrets and unsafe flows | severity-ranked findings |
| Archivist | Extract durable lesson | rule candidate, not automatic memory |

Do not let multiple agents edit the same files at the same time unless the workspace is isolated.

## 6. Adaptive Learning Loop

Learning must be evidence-based:

```text
failure -> postmortem -> candidate rule -> small eval -> promotion or discard
```

Promote a rule only when:

- the failure is likely to recur,
- the rule is short and actionable,
- it does not conflict with existing rules,
- it can be tested or observed.

## 7. Safe Autonomy

Safe autonomy is not low capability. It is controlled capability.

Green actions:

- read/search files,
- local lint/test/build,
- scoped edits,
- browser localhost checks.

Yellow actions:

- package installs,
- broad refactors,
- network access,
- git push,
- branch changes.

Red actions:

- recursive delete,
- force push,
- credential rotation,
- production data changes,
- external upload of code or secrets,
- OS-level destructive commands.

Red actions require explicit authorization and target verification.

## 8. Verification Engine

The verifier should check the strongest affordable signal:

- static proof for text or docs,
- syntax/lint for code structure,
- tests for behavior,
- build for integration,
- browser for UI,
- security scan for risky surfaces,
- independent sub-agent review for broad work.

## 9. Playground And Evals

EterX-Code should improve through a local playground:

- record representative tasks,
- define expected evidence,
- run the agent profile,
- score result quality,
- capture failures,
- update rules only when the eval improves.

Metrics:

- task completion,
- verification coverage,
- unnecessary tool calls,
- repeated failures,
- scope creep,
- user interruptions,
- time to first correct patch,
- final answer accuracy.

## 10. Why This Is Better Than A Giant Prompt

A giant prompt becomes stale and expensive. This architecture keeps:

- compact always-on rules,
- focused mode rules,
- on-demand skills,
- durable memories,
- evidence artifacts,
- eval-driven improvement.

That gives EterX-Code room to learn without filling every request with irrelevant instructions.
