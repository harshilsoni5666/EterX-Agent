# Adaptive Cognitive Harness

EterX's main execution runtime uses a provider-neutral adaptive harness around Gemini, Anthropic, OpenAI, and OpenAI-compatible model adapters. It is not a fixed `plan -> act -> observe` state machine. It treats execution as continuous inference over a goal graph, causal evidence, proof obligations, and a portfolio of evaluated strategies.

## Runtime model

The harness keeps four layers separate:

1. **Objective:** immutable user outcome, constraints, quality signals, and explicit evaluation targets.
2. **Session:** append-only semantic events and retry-safe snapshots. A provider or API-key failure cannot erase progress, failure history, verification freshness, or tool budget.
3. **Brain:** the model plus the adaptive context compiler. It receives the smallest current decision surface instead of the entire control history.
4. **Hands:** provider-neutral tools classified by semantic effect: observation, mutation, verification, command, external action, coordination, or artifact production.

This separation follows the durable interface principle: providers and execution environments may change without changing what counts as progress or proof.

## Dynamic topology synthesis

After each material event, the harness recomputes any useful combination of cognitive modes:

- exploration
- construction
- adversarial evaluation
- evolutionary search
- delegation
- evidence reconciliation
- recovery
- convergence

These are capabilities, not stages. A task may use none, one, or several at once, and may return to a prior mode when new evidence invalidates the current tactic. The compiled operator frontier ranks concrete choices such as acquiring evidence, executing a change, running an evaluator, branching strategy, reconciling evidence, or finalizing.

## Causal proof obligations

A successful state-changing tool advances the mutation epoch. Verification proves only the epoch it observed. Any later state change automatically invalidates that proof and emits a new verification obligation.

Other obligations are derived from live state:

- action requested but no observable outcome exists;
- current/external research requested without grounding evidence;
- evaluator failure remains unrepaired;
- repeated failures make a tactic non-credible;
- an external side effect has no tool confirmation;
- an explicit evaluation target has not been reached;
- the latest candidate regressed below a better measured candidate.

The completion gate is enforced in runtime code. Rewriting a final answer cannot discharge an evidence obligation.

## Evolutionary strategy portfolio

For optimization work, every mutation epoch becomes a candidate arm. Evaluator outputs contribute numeric metrics such as score, accuracy, quality, coverage, fitness, benchmark value, or latency. The harness keeps the best measured candidate visible, detects regressions, and can choose refinement or a distinct branch. It never silently treats the most recent candidate as the best candidate.

## Context compilation

The model sees a bounded decision surface containing:

- active topology;
- ranked operator frontier;
- compact goal facets;
- open proof obligations;
- recent causal evidence;
- candidate portfolio when relevant.

The append-only event history remains outside the prompt. This avoids turning better orchestration into context bloat.

## Provider equality

All provider loops receive the same initial decision surface, refreshed topology, tool semantics, evidence ledger, completion audit, and execution-governor policy. Model-native reasoning formats may differ, but the harness's definition of progress, risk, verification, retry continuity, and completion does not.

## Verification

Run the focused checks with:

```text
npm run test:adaptive-harness
npm run test:execution-governor
```

The integration scenarios cover direct answers, causal verification freshness, evaluator failure, evolutionary branching, grounded research, external actions, best-candidate preservation, provider neutrality, and retry restoration.

## Research basis

The design synthesizes current primary work on durable goal contracts and eval-driven improvement loops, evolving context rather than static prompt expansion, event-stream agent runtimes, automated workflow search, independent generator/evaluator roles, and decoupled brain/session/hands interfaces:

- [OpenAI: Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals)
- [OpenAI: Iterate on difficult problems](https://learn.chatgpt.com/use-cases/iterate-on-difficult-problems)
- [Anthropic: Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Anthropic: Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Google DeepMind: AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)
- [AFlow: Automating Agentic Workflow Generation](https://arxiv.org/abs/2410.10762)
- [Agentic Context Engineering](https://arxiv.org/abs/2510.04618)
