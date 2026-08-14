# External service routing and agent operating contract

This document describes the runtime contract for the three generation/research
service families exposed through Settings > External service. The TypeScript
provider metadata remains the source of truth for IDs, defaults, models,
capabilities, credentials, and fallback order:

- `src/lib/search/search-config.ts` and `src/lib/search/search-runtime.ts`
- `src/lib/image/image-generation-config.ts` and `src/lib/image/image-generation-runtime.ts`
- `src/lib/video/video-generation-config.ts` and `src/lib/video/video-generation-runtime.ts`

When a provider API changes, update the adapter, metadata, route brief, tests,
and this document in the same change. Do not claim a provider is live because
its name appears in a dropdown.

## Agent workflow

The main agent and every delegated sub-agent receive live route briefs at the
start of a run. The dedicated Gemini custom-agent runner also appends the same
route block to its current-turn runtime context. The brief includes the
selected provider, model, enabled services/capabilities, credential readiness,
and fallback order. The brief is a prompt-time snapshot; the tools reread the
current settings on every call, so a tool result is authoritative after a
mid-run settings change.

1. For current facts, recent changes, citations, documentation, market data, or
   web verification, call `web_search`. It attempts the selected model's native
   search first when the model family is known to support it, then uses the
   configured External service search provider and key-pool failover.
2. When a provider was just selected or a credential/endpoint was just entered,
   call `external_service_check` with `mode="status"`. Use `mode="probe"` when
   the user asks whether the provider works or after a routing change.
3. Use `image_generator` for a real raster image and `video_generator` for a
   real video. Both tools re-read runtime settings on every call, rotate up to
   three configured keys, fail over after real provider errors, and validate the
   returned bytes before saving an artifact.
4. A connection probe proves endpoint/auth/model reachability only. A real
   generation result is the proof that the selected generation route produced a
   valid artifact. Never create a placeholder or report success without a
   validated result.
5. The dedicated `/api/agents/run` runner is Gemini-only; `/api/chat` and
   delegated workers use the shared provider-aware agent loop.
6. Sub-agents must report the exact provider/model used, the tool result, any
   fallback, and verification status to Main. They must not spawn more agents.

## Search providers

| Provider ID | Primary use | Native capabilities | Credential/endpoint | Runtime route |
|---|---|---|---|---|
| `tavily` | Agent research and source retrieval | Search, read, crawl, map, native research | API key | Tavily SDK and REST base `https://api.tavily.com` |
| `brave` | Fast indexed web search | Search | API key | Brave Web Search API |
| `exa` | Semantic search and content retrieval | Search, read | API key | Exa `/search` and `/contents` |
| `firecrawl` | Search plus markdown extraction | Search, read, crawl, map | API key | Firecrawl v2 API |
| `firecrawl_selfhosted` | Private Firecrawl deployment | Search, read, crawl, map | Configured endpoint | Self-hosted Firecrawl endpoint with `/v2` normalization |
| `parallel` | Objective search and excerpts | Search, read | API key | Parallel Search/Extract API |
| `searxng` | Private metasearch | Search | Configured endpoint | SearXNG `/search?format=json` |
| `duckduckgo` | Credential-free fallback search | Search | None | DuckDuckGo HTML search |
| `xai` | xAI Responses web search | Search | xAI API key | xAI Responses API with `web_search` |

Non-native `extract`, `crawl`, `map`, and `research` actions are deliberately
annotated as agent-level fallbacks when a provider does not advertise that
capability. The tool result carries `providerCapabilities`,
`providerActionMode`, and `failedProviders` so the agent can describe what
actually happened.

The native-first behavior is conservative: known Gemini, OpenAI, Grok,
Anthropic, and Perplexity model families are attempted only when the model
name matches the capability map. Unknown or local models go directly to the
configured External service route. A native result without usable citations is
also rejected in favor of a source-backed external result.

Parallel requests use the current v1 `max_chars_total` and nested
`advanced_settings` fields. Exa highlights are normalized alongside text and
Firecrawl crawl records accept URLs nested in result metadata. xAI web search
uses the configured `xaiModel` (default `grok-4.6`) rather than a hard-coded
model. The adapter contract follows the providers' primary API references, including
[Tavily's API introduction](https://docs.tavily.com/documentation/api-reference/introduction),
[Firecrawl's API reference](https://docs.firecrawl.dev/api-reference/introduction),
the [Brave Search API documentation](https://api.search.brave.com/app/documentation),
the [Parallel Search API](https://docs.parallel.ai/api-reference/search/search),
the [Exa Search API](https://exa.ai/docs/reference/search), and
[xAI citations/web-search documentation](https://docs.x.ai/developers/tools/citations).

## Image providers

| Provider ID | Default model | Credential | Main behavior |
|---|---|---|---|
| `deepinfra` | `stabilityai/stable-diffusion-2-1` | DeepInfra token | Direct text-to-image inference |
| `fal` | `fal-ai/flux/schnell` | `FAL_KEY` | Queue-backed generation and result download |
| `krea` | `krea/krea-2/medium` | Krea token | Job creation and polling |
| `openai` | `gpt-image-2` | OpenAI API key | OpenAI Images API |
| `openrouter` | `openai/gpt-image-1` | OpenRouter API key | Unified OpenAI-compatible image route |
| `xai` | `grok-imagine-image-quality` | xAI API key | xAI image generation route |
| `freepik` | `flux-dev` | Freepik API key | Existing asynchronous FLUX route |

The image adapter is currently text-to-image only; it does not edit an existing
reference image. It accepts provider-native base64 or URLs, downloads the
result, rejects SVG/HTML, validates PNG/JPEG/WebP signatures, and writes a file
extension matching the returned bytes. FAL model IDs are intentionally configurable because its model
catalog changes; its official documentation describes queue submission,
status, and result retrieval in the [FAL queue API guide](https://fal.ai/docs/documentation/model-apis/inference/queue).

## Video providers

| Provider ID | Default model | Credential | Input/output notes |
|---|---|---|---|
| `google` | `veo-3.1-fast-generate-preview` | Gemini/Google AI key | Text-to-video, image input, audio where supported |
| `openai` | `sora-2` | OpenAI API key | Sora job polling, image reference, downloadable MP4 |
| `runway` | `gen4.5` | Runway secret | Text/image-to-video task polling |
| `luma` | `ray-2` | Luma key | Ray generation and image keyframes |
| `minimax` | `MiniMax-H3` | MiniMax key | H3 v2 flow; Hailuo uses v1 query and file retrieval |
| `volcengine` | `doubao-seedance-1-0-pro-250528` | Volcengine Ark key | Seedance task API and image-to-video |
| `fal` | `fal-ai/wan-25-preview/text-to-video` | `FAL_KEY` | Current hosted/open model queue routes |
| `replicate` | `minimax/video-01` | Replicate token | Exact `owner/model` prediction IDs |
| `xai` | `grok-imagine-video` | xAI API key | Asynchronous video generation |

The video adapter polls provider jobs, downloads the returned media, validates
MP4/WebM/Ogg signatures, and writes only validated bytes. OpenAI's current
Videos contract is documented in the [OpenAI Videos API reference](https://platform.openai.com/docs/api-reference/videos),
including `sora-2`, `sora-2-pro`, `input_reference`, and the 4/8/12 second job
durations. Provider availability and exact model access remain account-scoped;
the route brief and probe result must be treated as runtime evidence.
Luma creation uses the documented `/dream-machine/v1/generations/video` route;
MiniMax Hailuo uses `/v1/video_generation`, `/v1/query/video_generation`, and
`/v1/files/retrieve`, while the H3 adapter retains its v2 task route. FAL image
and text-to-video model IDs are separate routes, so an image input must be
configured with an image-to-video model when the selected provider requires it.

## Health checks and failure handling

`external_service_check` supports two modes:

- `status`: local, no network call; reports enabled state, credentials visible
  to the current runtime, models, capabilities, and route briefs.
- `probe`: checks every provider in the requested service family, or one exact
  provider. Search performs one small live search. Image and video validate the
  endpoint, credentials, and selected model where the provider exposes a
  non-billing catalog/health route; otherwise the probe fails rather than
  treating an HTTP 404/405 as proof of readiness. No probe starts a paid
  generation.

Missing credentials, missing self-hosted endpoints, disabled services, rejected
credentials, timeouts, and provider errors are distinct results. Fallback is
performed only after a real provider failure; a missing credential is reported
and skipped instead of being retried indefinitely.
