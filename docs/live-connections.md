# Live connection setup

Open **Settings → Live Convo**, enable Live, and choose a provider.

## Use an added model

Choose **Any configured model** to speak to a model from **Settings → Models**, including local and custom endpoints. Select an exact model, or choose **Use selected chat model** to follow the chat's selection when Live starts.

This mode uses the existing model connection, credentials, endpoint, and agent runtime. Desktop speech recognition uses the dictation model and language selected in **Settings → General**. Spoken replies use a voice installed on the device. Browser speech recognition depends on the browser's speech service. The microphone pauses during spoken replies to avoid sending the reply back as another request.

The selected model and endpoint still need to support the capabilities required by the task. Continuous camera and screen streaming are unavailable in this mode; supported agent tools can inspect the screen or files when requested.

## Native voice providers

| Provider | Connection requirements |
| --- | --- |
| Google Gemini Live | A Gemini key with access to the selected Live model. Gemini Live thinking settings follow that model's supported levels. |
| OpenAI Realtime | An OpenAI key with Realtime access and a supported realtime model. Browser audio uses WebRTC. |
| xAI Grok Voice | An xAI key with access to a Grok Voice model. |
| Deepgram Voice Agent | A Deepgram key that can create temporary credentials and access Voice Agent. |
| ElevenLabs Conversational Agent | An ElevenLabs key and a configured conversational agent ID. Selecting a different voice requires voice overrides enabled for that agent. |

Dedicated Live keys are optional. When none are configured, EterX reuses keys saved for the same native provider, including model-specific keys. A key saved for a custom gateway is not sent to a different native service.

Automatic model selection uses the provider's model catalog. If the key can create sessions but cannot list models, enter an exact supported model ID. Native sessions require models that support realtime audio. Use **Any configured model** for ordinary text/reasoning models.

Model and voice discovery is separate from session authorization. A populated dropdown does not confirm account access, quota, or microphone permissions. Startup errors remain visible with a retry action.

## Conversation and task behavior

- Live can start during an existing task. Starting Live does not restart that task.
- Native Live can steer a running task or queue work for the next run. The task remains attached to its model and workspace.
- The chat feed owns saved task messages and action results. Temporary Live transcripts hand over to those entries instead of adding another copy.
- Replayed provider tool calls reuse their recorded results. An action interrupted during reconnect is reported as uncertain so the agent can inspect its state before retrying.
- A local interruption and its later provider acknowledgment belong to one interruption. The acknowledgment preserves a newer typed request while discarding remaining output from the interrupted response.
- Listening alone does not mark an old task as working. The task's Stop button remains available during Live.
- Spoken task updates belong to the Live chat and tasks it has delegated. The notification and response-detail preferences control native Live updates.
- Updates carry the originating run ID. A late result from an earlier run does not replace a newer task's Mission status. Stopping a run removes its queued progress announcements and tells Live to preserve the stop.
- Native Live adapters share guidance for choosing available tools, preserving user constraints, recovering from errors, and reporting completion from actual results. OpenAI, xAI and Deepgram also expose `configure_live_behavior` for spoken changes to detail and notification preferences. ElevenLabs client tools must be configured on its agent.
- Commands that continue in the background return a task ID. Live can use `manage_terminal_task` to list, inspect or stop that exact process and read new output with its cursor. Starting a process is reported as pending work, not a completed outcome.
- In **Any configured model**, the main chat owns worker progress and completion. Quiet progress settings still allow a spoken answer to a request submitted through Live.
- Attachments remain in the composer draft. End Live to send them with a typed message.

The native adapters expose different media capabilities. Capturing a screenshot through a tool does not mean every voice transport received its pixels. Live uses available text observations or delegates image interpretation to a configured worker with vision; continuous camera and screen sharing use Gemini Live.

## Written answers and spoken summaries

Agent guidance encourages comparison tables and focused Mermaid diagrams when they help explain the result. The requested format and depth still take precedence; a simple answer does not need a diagram.

- Tables support spreadsheet copying and CSV downloads, with row/column counts, sticky headers, and expandable height for long tables.
- A completed Mermaid fence can render while the rest of the answer is still streaming. Incomplete or invalid diagrams keep their original source available. Diagram rendering is serialized so concurrent answers do not change each other's Mermaid configuration.
- Native Live's `present_rich_response` displays the written answer during the turn and saves it when the turn ends. Later speech does not replace that written content. Delegated tasks retain their existing worker answer instead of receiving another copy from a status announcement.
- **Any configured model** speaks an excerpt of the authored prose, skipping tables, diagram/code fences, and display equations. The response-detail preference controls its length, and omitted detail remains in the chat. This is a spoken excerpt, not a second model-generated answer.

## Provider contracts

The adapters follow the documented [OpenAI WebRTC flow](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime), [Gemini Live thinking settings](https://ai.google.dev/gemini-api/docs/live-api/thinking), [xAI voice session and resumption API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech), and [xAI ephemeral authentication](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens). Realtime access and model availability are determined by the provider account when a session starts.
