# Original Design Principles

EterX-Code should not copy another coding agent. It should combine the strongest public lessons with original control systems that fit EterX.

## Principle 1: Evidence Over Confidence

The agent should not sound certain; it should be certain because evidence exists.

Bad:

```text
The issue is fixed.
```

Good:

```text
The issue is fixed. `npm test -- auth` passed, and the login error branch now renders the expected message.
```

## Principle 2: Context Is A System, Not A Dump

The agent should actively manage context:

- always-on rules are short,
- skills load only when relevant,
- memory stores durable facts,
- tool outputs become evidence,
- old summaries do not become new instructions.

## Principle 3: Small Fast, Big Deep

Small tasks should not get bureaucracy. Big tasks should not get improvisation.

- One-file typo: read, edit, verify text.
- Feature: inspect, plan, edit, test, browser verify if UI.
- Migration: task ledger, sub-agents, staged changes, build and tests.

## Principle 4: Review Is Different From Build

Review mode must be skeptical. Build mode must be constructive. The same agent can do both, but it must switch posture.

Review output:

- findings first,
- severity order,
- concrete impact,
- file references,
- test gaps.

## Principle 5: Sub-Agents Are Specialists

Sub-agents should not be clones of the main agent. They need role, scope, and output contracts.

Good:

```text
Security Sentinel: inspect changed auth/session files for secret leakage, injection, and auth bypass. Return findings with file paths only.
```

Bad:

```text
Look at the repo and help.
```

## Principle 6: Memory Must Earn Its Place

Store a fact only when it will help future work. Do not store:

- raw command output,
- secrets,
- one-off guesses,
- stale task plans.

## Principle 7: Safe Autonomy Is Stronger Autonomy

The agent can move quickly on green actions because yellow and red actions are clearly defined. Boundaries increase speed by removing uncertainty.

## Principle 8: UI Work Requires Eyes

Frontend code is not done because it compiles. It is done when a browser verifies the visible result.

## Principle 9: Learn With Evals

Do not add a rule because it sounds smart. Add it because it fixes a measured failure.

## Principle 10: Final Answer Is A Receipt

The final answer is not a conversation transcript. It is a receipt:

- changed/reviewed scope,
- result,
- verification,
- residual risk.
