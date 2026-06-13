---
name: karpathy-coder
description: Use when writing, reviewing, or simplifying code with disciplined assumptions, minimal scope, surgical edits, and verifiable success criteria. Trigger for code quality concerns, over-engineering checks, "am I overcomplicating this", focused implementation, or review before completion.
version: 2.0.0
tags: [code-quality, simplicity, surgical-changes, review]
---

# Karpathy Coder

This skill applies four practical coding disciplines:

1. Surface assumptions before coding.
2. Keep the implementation simple.
3. Make surgical changes.
4. Define verifiable success criteria and check them.

## Think Before Coding

- State assumptions explicitly.
- If multiple interpretations exist, choose the safest small path or ask when the risk is real.
- Push back on speculative features, unclear scope, or unnecessary abstractions.
- Prefer reading the existing code before proposing structure.

## Simplicity First

- Solve the requested problem, not adjacent imagined problems.
- Avoid abstractions until they remove real duplication or complexity.
- Prefer clear boring code over clever generic systems.
- Delete only dead code created by your change unless the user asks for cleanup.

## Surgical Changes

- Touch only files needed for the task.
- Preserve local style and ownership boundaries.
- Avoid formatting churn and unrelated refactors.
- Every changed line should trace to the user request or required verification.

## Goal-Driven Execution

For nontrivial work, define:

```text
Goal:
Success criteria:
Files likely involved:
Verification:
Known risks:
```

Then implement, run the available checks, and report the result honestly.

## Review Checklist

- Hidden assumption: Did the code assume behavior not proven by the repo?
- Scope creep: Did it add features not requested?
- Over-abstraction: Is there a new framework/object layer for one use case?
- Diff noise: Are there style-only or unrelated changes?
- Verification gap: Was success checked with tests/build/manual inspection?
- User-change risk: Did it overwrite or revert unrelated work?

## Output

When this skill is active, be direct:

- Explain the chosen small approach.
- Mention tradeoffs only when they affect the decision.
- List checks run.
- State remaining risk if verification is incomplete.
