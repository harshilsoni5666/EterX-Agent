# EterX-Agent Architecture Notes

This file describes how EterX-Code should fit into the main EterX agent system.

## Runtime Prompt Stack

EterX-Code should be assembled from layered context:

1. System/developer rules.
2. Current request guard.
3. EterX-Code professional prompt.
4. Tool registry and tool guidance.
5. Always-on `AGENTS.md`.
6. Mode-specific routing.
7. Relevant skills only.
8. Workspace intelligence.
9. Memory overlays.
10. Task ledger and verification evidence.

Later layers can add detail, but they cannot override the latest user request or safety rules.

## Control Plane

The agent has three internal planes:

- Decision plane: classify, plan, choose tools, decide when to ask.
- Execution plane: file edits, commands, browser actions, research.
- Evidence plane: task ledger, command results, test output, screenshots, diff summary.

The final answer is produced from the evidence plane, not from optimism.

## Tool Registry

EterX tools are registered centrally and exposed by exact name. Prompt text should never invent tool parameters. If a tool schema is unknown, inspect the tool definition or use documented examples from `docs/eterx-tool-calling.md`.

## Memory

Memory must be deliberate:

- Session memory tracks what happened in the current work.
- Project memory stores durable repo facts.
- Procedural memory stores reusable workflows.
- Failure memory stores short postmortems and rule candidates.

Do not store secrets or raw logs.

## Artifact System

Complex work should create internal artifacts:

- task ledger,
- implementation plan,
- evidence graph,
- verification report,
- review report,
- learning postmortem.

These artifacts can live in memory, task checkpoints, or reference files depending on the workflow.

## Sub-Agent Topology

Sub-agents are specialists:

- Cartographer maps code.
- Breaker tests and reviews.
- Browser Pilot verifies UI.
- Security Sentinel audits risky surfaces.
- Archivist proposes durable lessons.

The main agent coordinates and decides. Do not run competing writers on the same file.

## Verification Loop

1. Form a claim.
2. Find the evidence needed for that claim.
3. Run the evidence-producing tool.
4. If evidence fails, fix or downgrade the claim.
5. Only final-answer claims that survive verification.

## Safety Loop

Before risky actions:

1. Identify target.
2. Resolve path or external destination.
3. Classify risk.
4. Rely on the runtime sandbox and capability policy for high-risk actions.
5. Ask user only for red actions or missing credentials.

## Evolution Loop

EterX-Code should improve through evals, not prompt inflation:

1. Failure.
2. Postmortem.
3. Rule candidate.
4. Eval.
5. Promotion or discard.
