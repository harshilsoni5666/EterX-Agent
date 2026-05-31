# EterX-Code Implementation Roadmap

This roadmap shows how to turn the reference pack into a working advanced coding agent in EterX.

## Phase 1: Prompt And Profile

Status: reference-ready.

Deliverables:

- `agent.md` professional prompt.
- `AGENTS.md` always-on compact rules.
- `Skill.md` on-demand skill.
- `profiles/eterx-code-agent.profile.json` Agent Builder profile blueprint.

Goal:

Create an EterX-Code custom agent that has the right identity, tools, behavior rules, safety rules, and completion criteria.

## Phase 2: Tool Attachment Quality

Deliverables:

- Attach the core workspace, verification, browser, process, sub-agent, memory, and safety tools.
- Use per-tool prompt guidance from `docs/agent-builder-install.md`.
- Keep tool prompts short and operational.

Goal:

The agent should know exactly when and how to call each EterX tool.

## Phase 3: Evidence Graph Runtime

Deliverables:

- Track requirements, files read, edits, commands, tests, browser observations, and final claims.
- Block unsupported final claims or downgrade them.
- Surface evidence in the UI as compact artifacts.

Goal:

Every "done" claim has proof.

## Phase 4: Mode Router

Deliverables:

- Implement intent classification using `docs/trigger-routing.md`.
- Load only mode-specific guidance.
- Keep answer, inspect, edit, debug, review, UI, and long-task behavior distinct.

Goal:

The agent acts fast on small tasks and deeply on complex work.

## Phase 5: Specialist Swarm

Deliverables:

- Define sub-agent roles: Cartographer, Breaker, Browser Pilot, Security Sentinel, Archivist.
- Prevent multiple agents editing the same file unless isolated.
- Require collect-and-evaluate before final answer.

Goal:

Parallelism improves quality without causing file conflicts or duplicated work.

## Phase 6: Adaptive Learning

Deliverables:

- Capture failed checks and repeated user corrections.
- Produce postmortems.
- Generate candidate rules.
- Test candidates with evals before promotion.

Goal:

EterX-Code improves from real failures without prompt bloat.

## Phase 7: Eval Playground

Deliverables:

- Convert `evals/sample-evals.json` into runnable agent tests.
- Track scorecard metrics.
- Add regression evals for every promoted rule.

Goal:

Agent behavior becomes measurable.

## Phase 8: Safety And Approval Layer

Deliverables:

- Use risk levels from `docs/safety-model.md`.
- Route red actions through explicit user approval.
- Treat untrusted content as data.
- Redact secrets.

Goal:

The agent can be autonomous without becoming careless.

## Phase 9: UI Evidence Artifacts

Deliverables:

- Task list artifact.
- Implementation plan artifact.
- Diff artifact.
- Test report artifact.
- Browser screenshot or snapshot artifact.
- Learning postmortem artifact.

Goal:

The user sees what happened without reading raw tool logs.

## Phase 10: Continuous Improvement

Deliverables:

- Weekly review of failed evals.
- Remove rules that do not help.
- Add focused skills instead of bloating the core prompt.
- Promote stable workflows into macros only after repeated success.

Goal:

The agent becomes sharper over time.
