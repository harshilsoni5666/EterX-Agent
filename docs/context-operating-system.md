# Context Fabric: a temporal, lossless context operating system

EterX does not treat the chat transcript or an AI-generated summary as authoritative state. The transcript is an expensive presentation format. The Context Fabric is the provider-neutral continuity layer used by Gemini, Anthropic, OpenAI-compatible, and Mistral loops.

## Storage model

Each observation is represented at two levels:

1. An immutable gzip page stores the exact user request, steering update, tool arguments, and raw pre-compaction tool result. Large observations are byte-chunked behind an integrity-checked page manifest.
2. A lightweight temporal-epistemic graph stores decision-relevant facts and pointers back to those pages.

The graph separates four memory networks:

| Network | What belongs there |
| --- | --- |
| World | objectives, binding constraints, entities, references, preferences |
| Experience | attempted strategies, failures, recoveries, milestones, negative knowledge |
| Observation | tool evidence, artifacts, exact values, mutation and verification state |
| Belief | decisions, hypotheses, inferred state, and next-action commitments |

Facts carry valid time, recorded time, epistemic status, provenance, targets, entities, and learned value factors. A contradictory update closes the older fact's valid interval and creates a contradiction edge; it never rewrites history.

## What is retained

Retention is driven by seven independent value signals rather than one fixed importance score: affective intensity, goal relevance, value alignment, user relevance, task utility, reliability, and usage history. The runtime learns small bounded weight updates from successful completions and continuity failures.

The following information is always continuity-critical while active:

- current objective and every user constraint or prohibition;
- exact identifiers, paths, URLs, commands, values, and page hashes;
- action-to-observation and tool-call-to-result causality;
- current mutation epoch and fresh verification evidence;
- decisions, preconditions, unresolved failures, rejected strategies, and negative knowledge;
- pending external actions, irreversible boundaries, and next-action commitments;
- supersession and valid-time history when a fact changes.

Large raw data is not repeatedly injected into prompts. It remains in the page store and is opened just in time when an exact decision depends on it.

## Retrieval

Retrieval fuses five rankings with reciprocal-rank fusion:

- lexical overlap;
- local TF-IDF semantic similarity;
- temporal relevance;
- learned memory value;
- bounded graph expansion from query-grounded seeds.

Active objectives and constraints are mandatory. Other facts and exact-page pointers compete for the remaining token budget. This makes the working set a query-dependent projection, not a permanent lossy summary.

## Compaction

Compaction is a transaction:

1. Persist the Context Fabric and build an authoritative continuity manifest.
2. Archive the complete compaction source with a SHA-256 hash.
3. Ask the configured model to transfer executable world state, not narrate the conversation.
4. Audit every manifest record and exact anchor.
5. Deterministically restore omissions before committing the capsule.
6. Record omissions as policy failures so later compaction instructions become stricter.

Soft compaction is deferred during unresolved derivations, failed-strategy recovery, best-candidate preservation, or a mutation awaiting verification. A hard context boundary may force recovery. Message count never decides semantic safety.

## Provider equality

Provider adapters are serialization boundaries only. Every main loop uses the same Context Fabric, raw-result archive, retrieval policy, continuity manifest, semantic-boundary decision, deterministic repair, adaptive harness, evidence ledger, and execution governor. Provider-specific message formats cannot weaken these guarantees.

## Research basis

The design combines lossless page retrieval, bitemporal knowledge graphs, multi-network memory, adaptive retention value, external context-manager actions, and semantic-boundary compaction. Primary references include [OpenAI's Responses API context guidance](https://openai.com/index/equip-responses-api-computer-environment/), [Anthropic's context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [ACON](https://arxiv.org/abs/2510.00615), [AdaCoM](https://arxiv.org/abs/2605.30785), [SelfCompact](https://arxiv.org/abs/2606.23525), [Learning What to Remember](https://arxiv.org/abs/2606.12945), [Graphiti](https://arxiv.org/abs/2501.13956), [Hindsight](https://arxiv.org/abs/2512.12818), and [GAM](https://arxiv.org/abs/2511.18423).
