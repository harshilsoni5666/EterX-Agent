# Universal provider runtime

**Updated:** 2026-08-22  
**Scope:** chat and agent model selection, live catalogs, request shaping, native attachments, reasoning, streaming, tool continuation, caching, cancellation, and terminal-status handling.

## Required model-selection contract

EterX does not ship or execute a default chat/agent model.

1. The user connects a provider in Settings.
2. Settings retrieves that provider's live catalog.
3. The user explicitly adds a concrete model ID.
4. The user explicitly selects one added model.
5. The request carries that exact provider/model pair unchanged.
6. A missing, stale, `auto`, router-auto, or placeholder model selection is rejected.

The selector does not substitute the first configured model after a selection is removed. Previously successful model IDs are telemetry only and do not participate in routing. Kilo `kilo-auto/*`, OpenRouter `openrouter/auto`, and generic `auto/default/latest/recommended` placeholders are excluded from the model directory.

## Runtime adapters

| Provider family | Request and stream contract | Tool continuation |
|---|---|---|
| Gemini | Native `@google/genai` generate-content streaming | Native function-call/function-response parts; uploaded file references are retained |
| Anthropic | Native Messages stream, with beta Files/Message APIs when file IDs are used | Native `tool_use` and `tool_result` blocks |
| Perplexity | Responses-compatible `/v1/responses` adapter | Responses function-call items and `function_call_output`; completed output items are replayed |
| OpenAI-compatible providers | OpenAI Chat Completions stream | Streamed tool arguments are assembled by call index/ID and replayed with `role: tool` results |

The common stream boundary preserves visible text, structured reasoning text, provider usage, tool calls, and terminal finish state. A stream that closes without a finish reason, ends because of length/filter/error, or contains an incomplete tool call is reported as incomplete instead of becoming a successful answer.

## Provider matrix

No row below names a default model. Every model ID comes from live discovery and explicit user addition.

| Provider | Catalog | Execution adapter | Provider-specific behavior |
|---|---|---|---|
| Gemini | Dedicated, paginated Google models API | Native Gemini | Native thinking config, Files API/inline media, finish reason and prompt feedback |
| OpenAI | Dedicated `/models` | OpenAI chat-compatible | Native Files API; documented keyed prompt-cache fields; reasoning fields only for advertised/inferred reasoning models |
| Anthropic | Dedicated paginated `/v1/models` | Native Anthropic Messages | Adaptive/manual thinking split, ephemeral cache blocks, beta Files API, native stop reasons |
| Mistral | Dedicated `/models` | Compatible stream | Mistral effort mapping and structured thinking/text separation |
| OpenRouter | Dedicated `/models` with text/tool filtering | Compatible stream | `reasoning` object and reasoning-detail replay; native image/PDF gateway parts; usage is not requested through deprecated `stream_options` |
| Groq | Dedicated `/models` | Compatible stream | GPT-OSS reasoning effort; parallel-tool field omitted where not verified |
| DeepSeek | Dedicated `/models` | Compatible stream | `reasoning_content` is retained across tool turns |
| xAI Grok | Dedicated `/models` | Compatible stream | Reasoning effort for verified model families and stable conversation cache affinity |
| Cerebras | Dedicated `/models` | Compatible stream | Capability-gated common request fields |
| Together AI | Dedicated `/models` | Compatible stream | Correct `.ai` API base and GPT-OSS reasoning mapping |
| Fireworks AI | Live compatible catalog | Compatible stream | Account-returned IDs are used unchanged |
| SambaNova | Live compatible catalog | Compatible stream | No shipped model name; catalog is authoritative |
| Perplexity | Live `/models` catalog | Responses adapter | Responses events, function calls, reasoning summaries, terminal status and usage |
| DeepInfra | Live compatible catalog | Compatible stream | Catalog metadata is retained when supplied |
| Hugging Face | Live router catalog | Compatible stream | Router model IDs and suffixes are retained unchanged |
| NVIDIA NIM | Live compatible catalog | Compatible stream | GPT-OSS reasoning mapping and account-specific model IDs |
| Cloudflare Workers AI | Account/base-URL scoped catalog | Compatible stream | Requires a configured account-scoped base URL |
| Ollama | `/v1/models`, then native `/api/tags` discovery for older local servers | Compatible stream | Local `/v1` request normalization; no API key required by the harness |
| LM Studio | OpenAI and native local catalog endpoints | Compatible stream | Local `/v1` request normalization |
| vLLM | Live local `/models` | Compatible stream | Exact served model ID; tool availability depends on the server's chat template |
| llama.cpp | Live local `/models` | Compatible stream | Reasoning configuration uses `chat_template_kwargs` only for recognized reasoning families |
| Novita AI | Live compatible catalog | Compatible stream | Exact gateway model ID |
| Qwen Cloud | Live DashScope-compatible catalog | Compatible stream | `enable_thinking` and `thinking_budget`; no generic reasoning-effort substitution |
| Xiaomi MiMo | Live compatible catalog | Compatible stream | `reasoning_content` replay across tool turns |
| Tencent TokenHub | Live compatible catalog | Compatible stream | Only provider-returned capabilities become controls |
| Z.AI / GLM | Live compatible catalog | Compatible stream | Uses configured Z.AI v4 base and exact model IDs |
| Kimi / Moonshot | Live compatible catalog | Compatible stream | `reasoning_content` replay across tool turns |
| StepFun | Live compatible catalog | Compatible stream | Correct Step Plan base path; exact discovered IDs |
| MiniMax | Live compatible catalog | Compatible stream | Capability-gated common fields |
| Ollama Cloud | Live compatible catalog | Compatible stream | Exact cloud model IDs; no local-tags assumption |
| Arcee AI | Live compatible catalog | Compatible stream | Exact catalog IDs |
| GMI Cloud | Live compatible catalog | Compatible stream | Correct serving base URL |
| Kilo Gateway | Gateway `/models` | Compatible stream | Concrete gateway IDs only; all `kilo-auto/*` tiers are excluded |
| OpenCode Zen | Zen `/models` | Compatible stream | Concrete Zen model IDs only |
| Upstage Solar | Live compatible catalog | Compatible stream | Exact catalog IDs and provider-advertised capabilities |
| Custom endpoint | User-configured `/models` | Compatible stream | Requires an explicit base URL and concrete returned model ID |

## Tools and live capabilities

Agent mode always supplies the real EterX function schemas. Catalog-provided `supported_parameters` and capability fields are persisted per provider/model and sent with the selected model context. If the provider explicitly reports that tools are unavailable, Agent mode rejects that model before making the request. When a catalog omits tool metadata, EterX does not invent a positive capability; the provider remains authoritative and a provider rejection is returned unchanged.

`parallel_tool_calls` and `stream_options.include_usage` are emitted only for providers whose wire contract is known. Unsupported-field recovery does not delete parameters and silently retry with a different request shape.

## Reasoning controls and continuation

Thinking controls are shown only when the live catalog or a verified model-family contract supplies supported levels. The selected level is translated at the provider boundary:

- Gemini: `thinkingLevel` or `thinkingBudget`.
- Anthropic: adaptive effort or native manual thinking budget, depending on model family.
- OpenRouter: `reasoning: { effort, exclude: false }`.
- Qwen: `enable_thinking` plus `thinking_budget`.
- Mistral/OpenAI/Groq/xAI/Together/NVIDIA: their verified effort field for recognized families.
- llama.cpp: `chat_template_kwargs.reasoning_effort` for recognized local reasoning templates.

DeepSeek, MiMo, and Kimi assistant `reasoning_content` is replayed before tool results. OpenRouter reasoning details are replayed. Perplexity replays completed Responses output items. Visible answers and hidden/structured reasoning are kept separate.

## Attachments

Attachments must have a verified native transport. EterX never reports success after sending only a filename.

- Gemini uses inline image/media parts or the Gemini Files API.
- OpenAI uses image URL parts or native Files API IDs.
- Anthropic uses native image/PDF blocks or beta Files API IDs.
- OpenRouter uses image URL parts and its native PDF file-data part; video is limited to verified video-capable routes.
- Other compatible providers receive image parts only when their model/catalog indicates image or vision input.

If the chosen provider/model has no verified native transport for an attachment type, the request fails with `ATTACHMENT_UNSUPPORTED`. Upload/read failures fail with `ATTACHMENT_PREPARATION_FAILED`; attachments are not removed and the request is not retried without them.

## Cache, usage, abort, and completion

- OpenAI uses `prompt_cache_key` and the supported `prompt_cache_retention` values (`in-memory` or `24h`). Invented breakpoint/options fields were removed.
- Anthropic uses ephemeral cache control on stable content.
- Gemini uses its native cached-content path where eligible.
- Grok receives a non-sensitive stable conversation cache affinity.
- Usage is normalized without fabricating absent counters.
- Abort signals are passed in SDK request options/native request config, not inserted into JSON bodies.
- Key rotation may retry the same exact model, but model IDs and attachment sets are never changed.

## Current honest limitations

- Several OpenAI-compatible providers expose sparse `/models` metadata. EterX cannot prove tool, modality, reasoning, or parallel-call support when the provider does not publish it. It therefore avoids inventing controls and returns provider errors directly.
- Custom/local servers can claim OpenAI compatibility while using model-specific chat templates. The selected served model must actually be configured for tool calls if Agent mode is required.
- Agent Builder currently uses its dedicated Gemini-native runner and therefore requires an explicitly selected added Gemini model. Ordinary Chat and Agent modes use the full provider matrix.
- Live provider calls require the user's real credentials/account entitlements; source-level verification cannot guarantee that every account exposes every catalog model.

## Verification completed

- `npx tsc --noEmit --pretty false`
- `npm run test:model-selector`
- `npm run test:provider-runtime`
- `npm run test:agent-cache`

All four checks passed after the implementation changes.
