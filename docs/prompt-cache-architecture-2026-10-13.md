# Prompt cache reuse and usage accounting

Implementation notes, 2026-10-13. Source changes only: no Git commands, builds, lint, type checks, tests, benchmarks, or live inference requests were run for this work. The achieved hit rate and runtime behavior remain unmeasured.

## Request layout

The main provider loops now use this order:

1. Stable agent identity, operating rules, and canonical tool declarations.
2. Session policies, permissions, selected modes, and workspace constraints.
3. The retained native conversation, including tool exchanges and reasoning records.
4. The current user request and appended runtime observations.

Changing working memory, recalled information, host observations, file catalogues, and progress previously changed early system content. That invalidated otherwise reusable history. These observations now travel in named runtime update sections. Identical sections are not appended again; a new section supersedes earlier observations with the same name. Existing transcript blocks are retained. Empty updates explicitly clear a previously populated section.

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

Gemini's [Generate Content caching guide](https://ai.google.dev/gemini-api/docs/generate-content/caching) distinguishes automatic prefix reuse from explicit cached-content objects. Explicit objects have storage charges and eligibility requirements. This implementation explicitly caches system instructions and tools, not the entire growing transcript. It does not assume that an explicit system cache guarantees implicit hits for all subsequent history.

## Routing and cache lifecycle

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

## Interpreting the target

There is no universal 99% guarantee. Fresh input, cold starts, expiry, model/tool/policy changes, compaction, and provider routing can all require uncached processing. Even perfect reuse of a 20,000-token prefix with 500 new tokens gives about 97.6% for that request. Historical cold requests remain part of the aggregate; a better latest-request rate does not instantly replace the chat's earlier average.

The revised prompt layout itself causes an initial cache transition. The practical objective is high reuse on repeated eligible prefixes, correct reporting, and preserved agent behavior. No warmup inference, dummy token padding, or automatic whole-history cache rewriting was added to manufacture a higher number.

Existing controls remain available: `ETERX_DISABLE_CONTEXT_CACHE=1`, `ETERX_ENABLE_EXPLICIT_GEMINI_CACHE=0`, `ANTHROPIC_PROMPT_CACHE_TTL`, and `OPENAI_PROMPT_CACHE_RETENTION`. Disabling application cache controls cannot disable a provider's own automatic caching.

## Main implementation files

- `src/lib/agent/runtime-prompt-context.ts`: appended, deduplicated runtime observations.
- `src/lib/agent/provider-prompt-cache.ts`: provider policy, boundary selection, stable routing, and usage normalization.
- `src/lib/agent/Agent.ts`, `agent-runner.ts`, and `src/lib/chat/direct-chat.ts`: request assembly and recovery.
- `src/lib/agent/agent-cache.ts` and `api-key-pool.ts`: Gemini lifecycle and affinity.
- `src/lib/agent/provider-native-bridge.ts` and `provider-stream-adapter.ts`: native wire handling and usage preservation.
- `src/lib/agent/resilience/context-compaction.ts`: cache-aware compaction requests.
- `src/lib/model-usage.ts` and `src/components/layout/chat-input.tsx`: aggregate, latest-request, and reporting-coverage metrics.
