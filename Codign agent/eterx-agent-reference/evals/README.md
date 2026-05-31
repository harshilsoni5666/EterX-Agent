# EterX-Code Eval Suite

This folder defines lightweight scenarios for testing whether EterX-Code behavior improves.

Use these evals before promoting new rules into `AGENTS.md`, `Skill.md`, or `agent.md`.

## Run Method

1. Pick one eval JSON.
2. Start from the described workspace state.
3. Run EterX-Code with the eval prompt.
4. Score the output using the scorecard.
5. Promote a rule only if it improves the score without hurting another eval.

## Scorecard

Each dimension scores 0-2:

- request understanding,
- file selection,
- patch minimality,
- correctness,
- verification,
- safety,
- final answer accuracy.

Maximum score: 14.
