# External service routing and agent operating contract

This document describes the runtime contract for the three generation/research
service families exposed through Settings > External service. The TypeScript
provider metadata remains the source of truth for IDs, defaults, models,
capabilities, credentials, and fallback order:

- `src/lib/search/search-config.ts` and `src/lib/search/search-runtime.ts`
- `src/lib/image/image-generation-config.ts` and `src/lib/image/image-generation-runtime.ts`
- `src/lib/video/video-generation-config.ts` and `src/lib/video/video-generation-runtime.ts`

When a provider API changes, update the adapter, metadata, route brief,
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
   search first when the preference is enabled and a provider adapter is
   available, then uses the configured external primary and fallbacks in order.
2. The route briefs report configuration, not verified account access. The
   settings panel offers optional connection probes; never run a probe when
   the user has prohibited checks or tests.
3. Use `image_generator` for a real raster image and `video_generator` for a
   real video. Both tools re-read runtime settings on every call, rotate up to
   three configured keys, fail over after real provider errors, and validate the
   returned bytes before saving an artifact.
4. A connection probe reports only the evidence returned by a read-only
   endpoint or catalog. It does not prove generation access. Media results
   require downloaded bytes with a supported file signature and a successful
   local save. This is not a full image decode or video playback check.
5. The dedicated `/api/agents/run` runner is Gemini-only; `/api/chat` and
   delegated workers use the shared provider-aware agent loop.
6. Sub-agents must report the exact provider/model used, the tool result, any
   fallback, and verification status to Main. They must not spawn more agents.

## Search providers

| Provider ID | Primary use | Native capabilities | Credential/endpoint | Runtime route |
|---|---|---|---|---|
| `tavily` | Agent research and source retrieval | Search, read, crawl, map, native research | API key | Tavily REST API with cancellation and request deadlines |
| `brave` | Fast indexed web search | Search | API key | Brave Web, News, and Image Search APIs |
| `exa` | Semantic search and content retrieval | Search, read | API key | Exa `/search` and `/contents` |
| `firecrawl` | Search plus markdown extraction | Search, read, crawl, map | API key | Firecrawl v2 API |
| `firecrawl_selfhosted` | Private Firecrawl deployment | Search, read, crawl, map | Endpoint and optional API key | Self-hosted Firecrawl endpoint with `/v2` normalization |
| `parallel` | Objective search and excerpts | Search, read | API key | Parallel Search/Extract API |
| `searxng` | Private metasearch | Search | Configured endpoint | SearXNG `/search?format=json` |
| `duckduckgo` | Credential-free fallback search | Search | None | DuckDuckGo HTML search |
| `xai` | xAI Responses web search | Search | xAI API key | xAI Responses API with `web_search` |

Non-native `extract`, `crawl`, `map`, and `research` actions are deliberately
annotated as agent-level fallbacks when a provider does not advertise that
capability. The tool result carries `providerCapabilities`,
`providerActionMode`, and `failedProviders` so the agent can describe what
actually happened.

Native adapters cover Gemini grounding, OpenAI Responses and search-specific
Chat Completions models, xAI Responses, Anthropic server search, Perplexity,
OpenRouter native search, Mistral Conversations, Qwen, and Z.AI. Unfamiliar model
IDs on these providers can be attempted; API errors and missing source URLs
fall through to external services. Other providers, including local models,
use the external chain. Provider/model availability remains account-dependent.

Qwen uses Responses for newer models and the same host's DashScope endpoint
for older models that need source-returning search. OpenRouter requests the
native engine so that its own automatic third-party search does not bypass
the configured external fallback order. Relevant contracts are documented by
[OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search),
[OpenRouter](https://openrouter.ai/docs/guides/features/server-tools/web-search),
[Mistral](https://docs.mistral.ai/studio/agents/agent-tools/websearch),
[Qwen](https://www.alibabacloud.com/help/en/model-studio/web-search), and
[Z.AI](https://docs.z.ai/guides/tools/web-search).

`web_search` accepts `route="auto"` (default), `route="model"` (the same
native-first policy), or `route="external"`. Optional `provider` reorders the
enabled external choices for one call. Neither option bypasses the master
switch, native-search preference, or provider service switches. The result
includes `modelSearch` with enabled/attempted/error state, `attemptedProviders`,
and `failedProviders`. Each failed route is visible even when a later route
succeeds. Explicit empty fallback lists remain empty.

Requests for image assets or readable page content use external services.
`image_asset_search` shares this route and current credentials instead of
maintaining a separate Tavily-only client. Brave, Firecrawl, SearXNG, Tavily,
and returned Exa image metadata can supply image URLs. Providers returning no
requested images fail over. Direct read/crawl/map fallbacks enforce URL safety,
retain successful pages when other pages fail, and support cancellation.

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

Image and video tools accept an enabled `provider` and optional exact `model`.
FAL, Krea, and Freepik image jobs, and all video job adapters, retain the returned
job ID. A polling or download failure returns `providerActionMode="pending"`
with `{ provider, model, id }` in `job`. Resume by passing those exact values as
`provider`, `model`, and `jobId`; a resume call stays on that provider. Confirmed
terminal job failures can fall through to the next enabled route during an
initial generation call. Once a job exists, key retries poll that job without
creating another. Downloads and filesystem saves also avoid resubmitting
generation.

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
route briefs describe configuration, and probes report only the endpoint evidence
they obtained. The saved video's MIME type and session history use its actual
output format and path.
Luma creation uses the documented `/dream-machine/v1/generations/video` route;
MiniMax Hailuo uses `/v1/video_generation`, `/v1/query/video_generation`, and
`/v1/files/retrieve`, while the H3 adapter retains its v2 task route. FAL image
and text-to-video model IDs are separate routes, so an image input must be
configured with an image-to-video model when the selected provider requires it.

## Settings and failure handling

Connection buttons call the corresponding `/api/settings/search`,
`/api/settings/image`, or `/api/settings/video` route. Search probes perform
one live search on the requested provider without mutating shared settings or
silently succeeding through a different provider. Media probes use read-only
endpoints and report whether the catalog advertised the selected model or only
an endpoint responded. No connection probe starts a generation.

Krea uses the documented [job-list endpoint](https://www.krea.ai/docs/api-reference/general/list-jobs),
and Runway uses the [organization endpoint](https://github.com/runwayml/sdk-python/blob/main/src/runwayml/resources/organization.py).
FAL uses its [Platform model catalog](https://fal.ai/docs/platform-apis/v1/models),
separate from the inference queue; a custom FAL endpoint without a catalog probe
reports that access remains unverified. FAL and DeepInfra public catalog results
do not establish credential validity or permission to generate.

The Freepik route also accepts `https://api.magnific.com` as a custom endpoint
and selects the [Magnific authentication header](https://docs.magnific.com/authentication)
for it. Its provider ID and saved legacy endpoint remain compatible with existing
Freepik settings.

Dedicated service credentials take precedence over compatible model-provider
keys, followed by environment credentials. OpenAI, xAI/Grok, OpenRouter,
DeepInfra, Google/Gemini, and MiniMax reuse matching model keys where applicable.
Every service respects its master switch. Provider settings are snapshotted
for a call, and new calls read the latest settings. Custom endpoints are editable
for every service family; a primary-provider change keeps the previous primary
in the fallback list, where it can be disabled or reordered.

External requests have deadlines covering response bodies as well as headers.
Stop interrupts requests and polling; it does not delete an already submitted
remote job. Native model requests retain the application's model timeout policy.
Retry rounds honor the runtime retry setting and preserve HTTP errors so key
rotation can distinguish authentication/rate/transport failures from malformed
requests. Media jobs preserve their IDs when follow-up is needed. An error
while saving a completed artifact never starts another paid generation.

Missing credentials, missing self-hosted endpoints, disabled services, rejected
credentials, timeouts, and provider errors are distinct results. Fallback is
performed only after a real provider failure; a missing credential is reported
and skipped instead of being retried indefinitely.
