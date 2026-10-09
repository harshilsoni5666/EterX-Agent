# Provider cache and stream audit — 2026-10-09

Scope: shared Chat, Agent, and custom Gemini-agent request paths. These changes
apply across provider model selections, rather than replacing the selected model.
No Git commands, credential changes, or installed-app modifications were performed.

## OpenAI

- Removed the invalid `in-memory` default. Caching stays automatic with a stable
  cache key; the model/account selects retention when no override is configured.
- Normalize the legacy environment spelling to `in_memory`; omit legacy retention
  overrides for GPT-5.6+ and in-memory overrides for GPT-5.5.
- If an HTTP 400 specifically rejects a cache key/retention hint, retry once using
  implicit caching, without changing tools, reasoning, or the selected model.
- Invalid request errors no longer rotate through every configured credential.
- Include documented extra-high reasoning choices for the GPT-5.2–5.4 family;
  newer GPT families use the reasoning request/token-limit path.

References: [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[GPT-5.4 mini capabilities](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

## Gemini

- A cached system instruction cannot be overridden by a dynamic system instruction.
  Agent requests with dynamic instructions use automatic prefix caching while
  preserving the complete system prompt and tool declarations. Eligible fixed
  prompts can still use the existing explicit-cache manager.
- Custom-agent requests similarly omit the explicit cache when supplying a new
  runtime system instruction. Cache telemetry reflects the actual request.
- Expired-cache repair gets one real retry, instead of exhausting the one-attempt
  connection loop before sending the repaired request.
- Normalize reasoning levels before serialization, including models rejecting
  `minimal` and older Pro models accepting only low/high.
- Recover once from the SDK's `Incomplete JSON segment at the end` error, retaining
  completed agent work and discarding incomplete text/function arguments. Retract
  partial Chat answers before retrying. Persistent truncation fails rather than loops.
- Custom-agent usage-only chunks no longer duplicate the preceding content, and
  tool calls require a successful response finish boundary.

References: [context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching),
[thinking controls](https://ai.google.dev/gemini-api/docs/generate-content/thinking).
The truncation error was reproduced with the installed Google SDK against a mocked
HTTP stream, not inferred from the screenshot alone.

## Anthropic

- One shared cache policy for Chat and Agent requests marks tools, the stable system
  block, and the latest eligible conversation block (at most three breakpoints).
- Clear stale breakpoints; never mark thinking blocks or empty text as cache targets.
- Cache the growing conversation in Chat mode as well as the system prompt.
- Recognize additional documented adaptive/extra-high Claude families.
- Missing or interrupted stream boundaries receive bounded recovery; incomplete
  responses are not accepted as successful tool turns.

References: [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort).

## Grok and other compatible providers

- Grok Chat requests now send a stable, hashed conversation affinity header, as
  Agent requests already did, without exposing chat identifiers.
- Do not infer adjustable reasoning for every Grok 3/4 ID. Use verified family
  controls or explicit provider capability metadata.
- Provider-managed prefix caching remains available for all compatible endpoints;
  OpenAI/Claude-specific fields are not broadcast to other vendors.
- User cache opt-outs remain respected. Enabling caching does not guarantee a hit,
  remote-model support, or savings below a provider's token thresholds.

References: [Grok caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works),
[Grok reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning).

## Validation and installed application

Regression tests cover cache defaults/overrides, bounded cache fallback, invalid
request handling, Claude breakpoint eligibility, Gemini reasoning normalization,
Grok parameter isolation, and truncated Gemini streams through the real SDK.
Provider runtime/catalog, local compatible endpoint, cache, model selector,
retry, agent lifecycle, thought lifecycle, chat lifecycle, and TypeScript checks pass.

These are local contract/integration tests with mock responses, not paid live tests
against every vendor/model/account. They cannot establish that every model has
working account access or that a provider will produce cache hits.

The running installation loads its server from the packaged application archive
under `C:\Program Files\EterX`. It does not hot-reload this source checkout. The
source fixes require an updated application build/install to reach that copy.
The existing executable, chats, settings, and credentials were left intact.
