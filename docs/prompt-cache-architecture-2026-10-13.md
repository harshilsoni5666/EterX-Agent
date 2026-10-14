# Prompt cache reuse and usage accounting

Implementation notes, 2026-10-13. Source changes only: no Git commands, builds, lint, type checks, tests, benchmarks, or live inference requests were run for this work. Existing saved usage receipts informed the changes; the resulting hit rate and runtime behavior remain unmeasured.

## Findings from the saved run

The supplied screenshot shows 67.0% aggregate reuse and 45.4% on the latest request. The saved chat identifies that latest request as worker `Mode-Routing-And-Permissions`, with 14,848 cached input tokens out of 32,707. It followed compaction from approximately 272,000 to 36,000 locally estimated tokens. Those estimates are not provider input measurements. Other saved requests reached approximately 90–99% reuse; they do not establish the performance of these new changes.

The main chat includes worker billing, while its current-context meter describes the active agent. The usage popup now identifies the latest request's agent and model, labels the active context, and explains a matching compaction event when available. Cold and post-compaction requests continue to count in the aggregate.

Concurrent OpenAI requests in the saved traces also shared one routing key. This supports addressing route concentration, but does not prove that routing caused the screenshot's latest miss.

## Request layout

The main provider loops now use this order:

1. Stable agent identity, operating rules, and canonical tool declarations.
2. Session policies, permissions, selected modes, and workspace constraints.
3. The retained native conversation, including tool exchanges and reasoning records.
4. The current user request and appended runtime observations.

Changing working memory, recalled information, host observations, file catalogues, and progress previously changed early system content. That invalidated otherwise reusable history. These observations now travel in named runtime update sections. Identical sections are not appended again; a new section supersedes earlier observations with the same name. Existing transcript blocks are retained. Empty updates explicitly clear a previously populated section.

Continuity, execution guidance, adaptation, plans, memory, other observations, and communication cues now update independently. A changed small cue no longer resends the complete combined snapshot. The existing content-selection budgets remain unchanged. Restored combined snapshots receive a superseding empty update before the separate sections take over.

Agent identity and operating policy retain system authority. Runtime observations are reference data and cannot grant permission or override instructions. Admission bookkeeping excludes the runtime carriers so restoring a checkpoint does not mistake them for additional human turns. Tool declarations retain all schemas and array order; declaration names and object keys are canonicalized for consistent serialization.

The layout follows the stable-prefix and appended-update approach described in [Anthropic's Claude Code caching article](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/). It does not replace the selected model, reduce reasoning settings, remove capabilities, or discard context to inflate a percentage.

## Provider behavior

| Route | Implemented behavior |
| --- | --- |
| OpenAI | Stable cache identity; supported GPT-5.6+ Responses requests combine implicit caching with explicit system, preceding, and latest input boundaries. Earlier models retain automatic caching. Rejected cache hints get a bounded retry without the hints. |
| Anthropic | Request-local cache markers on tools, stable system content, a preceding conversation boundary, and latest eligible input. Markers do not mutate durable history or shared tool schemas. Native Claude gateway requests use the same policy. |
| Gemini | Explicit caching uses the exact system instruction and tool bundle needed by the request. Runtime observations are appended to the conversation. A cached request omits duplicate system/tool overrides. Failed cache repair falls back to the complete ordinary request. |
| Other compatible providers | Stable request content and credential routing are shared. Provider-specific cache controls are kept on supported routes. Native cache measurements, including DeepSeek hit/miss counts, are recognized. Providers control whether caching is available. |

OpenAI documents exact-prefix reuse, model-dependent controls, and optional cache keys in its [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching). The implementation reserves at most three explicit boundaries alongside the implicit boundary on supported Responses models. Retention defaults are left to the model/account unless an applicable explicit setting exists.

Anthropic documents four explicit breakpoints and a limited lookback window in its [prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Keeping the preceding request boundary helps after large tool batches. Restored arrays can also mark an earlier user turn. Thinking blocks are not explicitly marked. Five-minute TTL remains the default; `ANTHROPIC_PROMPT_CACHE_TTL=1h` opts into the longer, differently priced write tier.

On Claude tool continuations, runtime reference updates are nested inside the latest tool result. This avoids an ordinary user text block triggering thinking removal on older Claude and Haiku models. The compatible Messages bridge applies the same representation consistently on replay. Actual human messages retain their original role and content.

Gemini's [Generate Content caching guide](https://ai.google.dev/gemini-api/docs/generate-content/caching) distinguishes automatic prefix reuse from explicit cached-content objects. Explicit objects have storage charges and eligibility requirements. This implementation explicitly caches system instructions and tools, not the entire growing transcript. It does not assume that an explicit system cache guarantees implicit hits for all subsequent history.

## Routing and cache lifecycle

For OpenAI models before GPT-5.6, conversation scopes select a deterministic routing shard. The default is eight, configurable with `OPENAI_PROMPT_CACHE_SHARDS` from 1 to 64; 1 restores a shared routing key. This responds to OpenAI's documented overflow above roughly 15 requests per minute per prefix/key group. It trades some initial cross-conversation sharing for less route concentration. The best value depends on workload and has not been measured here. GPT-5.6+ retains its automatic routing behavior. No warmup calls, artificial delays, or reasoning changes are introduced.

- Compatible main loops, native Anthropic, and direct Chat choose a stable initial credential for a conversation. Credential-list reordering does not change that choice. Retry rotation remains available.
- The Gemini lease pool remembers a healthy conversation route across lease release, within existing concurrency limits. Failed routes can rotate. Remembered entries are bounded and removed when credentials leave Settings.
- Custom-agent lease IDs remain unique per run while their cache affinity uses a stable scope. Successful fallback credentials are recorded accurately.
- Gemini cache creation remains coalesced by credential, model, and content. A failed variant does not suppress an already valid variant. Content-specific failures back off separately from credential/model quota failures.
- Local eviction and early expiry stop cache renewal and let the remote TTL expire. They do not delete a remote cache name another request may already hold. The local variant limit is 32 per credential/model.

Compaction requests also receive appropriate provider cache policies. A stable instruction block is separated from per-part state so repeated chunks and repair attempts have a reusable boundary. Compaction retains its selected model, archival transaction, continuity safeguards, and output requirements. This is not a fork of the full main-agent provider request; a new compacted conversation can still require a cold cache write.

## Measurement

The displayed aggregate is weighted by measured input tokens:

```text
cache hit rate = sum(cache-read input tokens) / sum(input tokens with cache reporting)
cache reporting coverage = input tokens with cache reporting / measured input tokens
```

Cache writes and generated output do not count as hits. Reported zero hits remain zero. Missing cache data stays unknown and is excluded from the cache-rate denominator; coverage makes that exclusion visible. The latest-request rate becomes unknown when the latest receipt has no usable cache measurement, rather than showing an older receipt.

Anthropic input accounting includes ordinary input, cache reads, and cache creation once. OpenAI-style totals already include cached input. Gemini output accounting includes visible and reasoning output once. [DeepSeek's native usage fields](https://api-docs.deepseek.com/api/create-chat-completion/) take precedence over generic cache placeholders, and its hit/miss pair can supply a missing input total.

Stream usage records are merged as cumulative snapshots: omitted fields preserve earlier measurements, actual zero values replace them, and totals are never added across chunks. Replayed usage receipts are reconciled; normalized unmeasured placeholders do not overwrite earlier measured fields.

## Local explanations for prefix changes

`prompt-cache-diagnostics.ts` compares ordinary OpenAI/compatible requests, native Anthropic requests, and native gateway requests with their previous completed request in the same conversation scope. It distinguishes model, endpoint/credential/routing, settings, tools, system, and conversation changes. Usage receipts carry the explanation; runtime traces also carry character counts and provider-reported input/cache counts.

Only hashes, counts, timestamps, and model identity are retained in the bounded comparison map, not prompt text or plaintext credentials. The map holds at most 256 scopes and 50,000 block fingerprints. This adds no inference requests or external diagnostics service. Interrupted streams do not replace the baseline. Local character counts describe structural overlap, not tokens, achievable hit rates, or proof that a provider retained a cache. Provider cache-hint fallback and provider-side transformations may differ from the locally observed request. Ordinary native Gemini loops retain their provider-reported usage without this additional comparison; the Gemini gateway path includes it.

## Interpreting the target

There is no universal 99% guarantee. Fresh input, cold starts, expiry, model/tool/policy changes, compaction, and provider routing can all require uncached processing. Even perfect reuse of a 20,000-token prefix with 500 new tokens gives about 97.6% for that request. Historical cold requests remain part of the aggregate; a better latest-request rate does not instantly replace the chat's earlier average.

The revised prompt layout itself causes an initial cache transition. The practical objective is high reuse on repeated eligible prefixes, correct reporting, and preserved agent behavior. No warmup inference, dummy token padding, or automatic whole-history cache rewriting was added to manufacture a higher number.

Existing controls remain available: `ETERX_DISABLE_CONTEXT_CACHE=1`, `ETERX_ENABLE_EXPLICIT_GEMINI_CACHE=0`, `ANTHROPIC_PROMPT_CACHE_TTL`, and `OPENAI_PROMPT_CACHE_RETENTION`. `OPENAI_PROMPT_CACHE_SHARDS` controls the added routing partition. Disabling application cache controls cannot disable a provider's own automatic caching.

## Main implementation files

- `src/lib/agent/runtime-prompt-context.ts`: appended, deduplicated runtime observations.
- `src/lib/agent/provider-prompt-cache.ts`: provider policy, boundary selection, stable routing, and usage normalization.
- `src/lib/agent/prompt-cache-diagnostics.ts`: bounded local prefix comparison and explanations.
- `src/lib/agent/Agent.ts`, `agent-runner.ts`, and `src/lib/chat/direct-chat.ts`: request assembly and recovery.
- `src/lib/agent/agent-cache.ts` and `api-key-pool.ts`: Gemini lifecycle and affinity.
- `src/lib/agent/provider-native-bridge.ts` and `provider-stream-adapter.ts`: native wire handling and usage preservation.
- `src/lib/agent/resilience/context-compaction.ts`: cache-aware compaction requests.
- `src/lib/model-usage.ts` and `src/components/layout/chat-input.tsx`: aggregate, latest-request, and reporting-coverage metrics.
