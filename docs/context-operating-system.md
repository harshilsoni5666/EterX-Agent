# Context Fabric: durable history and bounded working context

EterX does not treat the chat transcript or an AI-generated summary as authoritative state. The transcript is an expensive presentation format. The Context Fabric is the provider-neutral continuity layer used by Gemini, Anthropic, OpenAI-compatible, and Mistral loops.

## Working context across requests

The visible chat transcript contains user messages and settled answers, not the provider's complete tool execution history. Rebuilding every request from those bubbles alone discards tool results without a compaction. `working-context-checkpoint.ts` now persists the operational conversation at safe request boundaries and after completed tool batches, independently of the UI feed.

Checkpoints are chat-scoped, compressed, integrity-sealed, and replaced atomically within a run. Separate run files preserve previous committed state. Restore requires an exact visible-dialogue prefix match; a stale shorter history cannot overwrite newer context. Same-run retries do not append the current request twice. A different model receives historical operational records as reference data instead of foreign tool protocol or private reasoning/signatures. The same model retains its native wire records. Provider calibration is stored with the local estimate of that exact request.

The registry passes the original user request as admission metadata, separately from attachment, routing, pinned-path, and timing envelopes. Each adapter uses that identity for persistence while still sending the full runtime request to the provider. The identity is paired with its exact runtime request so a child cannot accidentally inherit the parent's root. Text equality never removes a prior user turn: repeated requests after failures remain distinct. Gemini retry survivors carry the paired input/local count and model identity as well as the transcript; key rotation preserves calibration, while a model change retires it.

Version-one checkpoints could hash a standalone `[USER REQUEST]` prefix at admission and compare it against unwrapped feed text on the next query. Saved records from the reported September 8 drop show 88,821 provider input tokens before that mismatch, followed by 18,725 on the rebuilt request; no compaction event was recorded. Restore now recognizes that exact legacy root encoding only when every preceding dialogue identity matches. A one-time, size-bounded recovery admits missing public operational records from integrity-verified, same-lineage ancestral checkpoints. It deduplicates stored records, excludes private reasoning/signatures, never replays tools, and does not resurrect a compacted prefix. Original files remain untouched. An unrecognized mismatch stops restoration instead of quietly replacing the working transcript with the shorter feed. Recovery cannot recreate evidence that was never saved.

Cross-model translation preserves public Responses output items, including tool calls/results and citations, instead of dropping the entire output field as reasoning. User text accompanying structured content stays in its original conversation role. Public reference records are not replayed as new tool calls. Plain dialogue text retains its whitespace, and annotated text retains its evidence metadata. Provider-private reasoning/signatures remain excluded from foreign-model replay.

Completed tool observations after the checkpoint's Context Fabric revision can recover an interrupted batch without replaying its actions. Older chats without checkpoints have a conservative migration path: only exact, hash-verified pages with a matching full user lineage are admitted, and already-compacted history stays in the archive. This cannot reconstruct observations that were never durably saved. Checkpoint write failures preserve existing files and the live caller payload and report the durability failure.

## Context budgets and settings

`context-window-policy.ts` resolves the requested preference, per-chat override, and effective model-limited window for Settings and the composer. The expanded meter prints the exact denominator and explains a selected budget exceeding the model limit. Newly saved budget edits carry revisions; active runs adopt them at the next safe request boundary through `live-context-budget.ts`. Older preference writes and failure retry tiers cannot supersede a newer explicit budget edit. An in-flight provider request keeps its admitted payload/window.

Compaction preserves the committed verbatim-tail budget during restoration. New uncovered turns no longer silently consume that tail's allowance; another reduction requires a real compaction transaction. Cancellation closes the visible compaction lifecycle without committing a replacement or escalating its retry tier. Compatible-provider compaction uses the same stream transport as chat, including Responses-based providers, and requires a terminal success signal. Retries are bounded, cancellation-aware, and retain configured credentials on authenticated local endpoints.

Provider discovery and per-key connection checks are request-scoped reads: they do not replace runtime credentials or remove saved model choices. Settings discards discovery responses started before a newer edit, and reveals model controls when a provider is connected without automatically choosing a model.

Discovered per-model windows travel with the runtime policy, including worker and supervisor model switches. The original requested budget is not replaced by a smaller prior model's effective limit. Compactor attempt deadlines are distinct from user cancellation, so timeout recovery can exhaust the bounded retry policy. Journal replacement flushes a temporary file before rename and never removes the previous journal first; checkpoint commits within one run are serialized in call order. Restored Anthropic attachment references select the Files API message transport even when the latest query uploads no new files.

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

## Live context measurements

The context-panel header shows request-scoped cache status beside its close control, without adding a footer or another metrics section. Hits require provider-reported cached input tokens; cache writes, measured misses, absent reports, pending measurements, and disabled application controls are distinct. Model changes retire the prior model's cache display. Successful compaction has no persistent panel card; active attempts and failures remain visible.

Caching uses the provider's supported mechanism, not a universal unsupported parameter: automatic prefix reuse for compatible providers, keyed requests for OpenAI, ephemeral boundaries for Anthropic, and attempted explicit Gemini caches for main/coding/custom/builder agents. Direct OpenAI and Anthropic chat also apply their cache controls. Gemini direct/fast requests retain the automatic prefix path. Explicit Gemini cache creation defaults on, with `ETERX_ENABLE_EXPLICIT_GEMINI_CACHE=0` as its opt-out and `ETERX_DISABLE_CONTEXT_CACHE=1` disabling application cache controls globally. Provider-managed automatic caching cannot necessarily be disabled by that switch. Explicit caches may incur provider storage charges; TTLs are bounded and idle entries stop renewing. Active main/custom loops revisit cache eligibility at safe boundaries; creation is coalesced and failures back off rather than hammering the API. No cache failure is permission to remove context, and no cache policy guarantees a hit or unsupported-provider functionality.

The main composer and worker composer use the same reducer in `src/lib/context-usage-meter.ts`. It starts at the newest payload measurement, orders updates by their measurement occurrence (not their first feed-row position), and adds only subsequent live content and the unsent draft. Provider output usage replaces the streamed response estimate; terminal/preview UI copies are not extra model messages.

Each compaction boundary receives a request identity carried into the corresponding provider usage report. A late report for an earlier request cannot overwrite the current payload. Terminal compaction events carry their resulting usage and breakdown atomically, so a successful commit updates the meter even if its companion snapshot has not arrived. For older events without this payload, the meter retires the old category composition until a fresh snapshot arrives. Failure remeasures the exact preserved caller context and publishes the raised per-chat window, without showing a successful reduction. Live, saved, and restored feeds share a terminal-safe lifecycle merge; a delayed active phase cannot reopen a finished compaction.

Before a provider responds, counts remain estimates. Calibration pairs a prior provider count with the local estimate of that same request, then accounts for the new payload delta. Compaction, restoration, and model changes retire that calibration. The meter is not a monotonic counter: real compaction, changed payloads, and tokenizer corrections can legitimately lower it. It must not invent usage to hide a decrease.

A model selection alone does not measure a new request. Until its first payload sample arrives, the existing meter marks the prior count as awaiting the selected model and uses the selected capacity, without presenting the old count as a new exact measurement. Late provider usage for a different model or run cannot recalibrate the current payload, including legacy reports missing request IDs. Equivalent public conversation state does not imply identical token counts: tokenizer, runtime prompt, tool schema, and provider framing can differ. A lower count is not evidence of compaction unless a compaction transaction actually committed.

Adapters that move a capsule into a system channel must present that installed capsule during reconciliation. In particular, Anthropic reconstructs its trusted system carrier at this boundary so subsequent tool iterations do not masquerade as full-history restores.

OpenAI's [compaction guide](https://developers.openai.com/api/docs/guides/compaction) describes returning a canonical compacted window containing a compaction item and retained items. The analogous invariant here is to measure the installed next payload, not the old request or the summarizer's own token usage. EterX's portable text capsules are distinct from OpenAI's opaque native compaction items.

## Research basis

The design combines lossless page retrieval, bitemporal knowledge graphs, multi-network memory, adaptive retention value, external context-manager actions, and semantic-boundary compaction. Primary references include [OpenAI's Responses API context guidance](https://openai.com/index/equip-responses-api-computer-environment/), [Anthropic's context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [ACON](https://arxiv.org/abs/2510.00615), [AdaCoM](https://arxiv.org/abs/2605.30785), [SelfCompact](https://arxiv.org/abs/2606.23525), [Learning What to Remember](https://arxiv.org/abs/2606.12945), [Graphiti](https://arxiv.org/abs/2501.13956), [Hindsight](https://arxiv.org/abs/2512.12818), and [GAM](https://arxiv.org/abs/2511.18423).
