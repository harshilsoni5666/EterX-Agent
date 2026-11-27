# What EterX collects

EterX telemetry records product activity as event metadata and numeric usage measurements. Fields are included only when the app can observe them.

| Event | Information collected |
| --- | --- |
| `client.connected` | App connection or runtime start; coarse client type, operating system, platform, architecture, app version and release channel when available. |
| `client.thread.started` | A conversation was created or copied; creation source and whether it was created by a user, agent or system. |
| `client.turn.requested` | A Chat, Agent or Builder run was admitted; origin, interaction mode, request type and known provider/model. |
| `provider.turn.sent` | A provider dispatch occurred for a run; provider and known model. |
| `provider.turn.completed` | Run outcome and duration; provider request and turn counts; reported token usage, with primary and child activity kept separate. |
| `provider.request.completed` | Provider request outcome, type, duration, known public provider/model, and reported token usage. Failed attempts and native Live usage receipts are included. |
| `provider.session.started` | A managed provider session or native Live session started; session type and known provider/model. |
| `provider.session.stopped` | A managed or native Live session ended, was cancelled or was recovered after interruption; status and duration when available. |
| `provider.sessions.stopped_all` | A bulk stop was requested and the number of running sessions affected. |
| `provider.runtime_mode.changed` | The previous and new runtime permission modes. |
| `provider.request.responded` | A tool approval decision: approve once, approve for the session, or reject. |
| `mcp.tool.invoked` | A configured connector or desktop MCP tool category, outcome, duration and error category when available. |
| `mcp.delegated_task.finished` | A delegated worker task's completion status, task category, mode and duration when available. |
| `feature.used` | Use and outcome of measured features such as search, title generation, image or video generation, compaction, Builder, connectors, delegation and Live. |
| `install.owner_observed` | A pseudonymous installation/profile identifier and observed counts of saved conversations and referenced workspaces. |
| `server.boot.heartbeat` | Runtime start and periodic presence, with runtime type and app version when available. |

## Shared measurements

Events can include their event name, a unique event ID and occurrence time; app version, release channel, operating system, platform, architecture and surface; and a pseudonymous installation identifier. Provider and model labels are included only when recognized as public catalog entries.

When reported, usage measurements include request duration and count; input, output, total, cached, cache-write and reasoning tokens; audio and image tokens; generated image count; generated video or audio duration; and separate main, child and auxiliary activity counts. Missing provider usage is left unreported rather than estimated.

Other recorded values are bounded categories or counts, such as request origin and type, interaction or permission mode, feature or tool category, outcome, error category, attachment count, active session count, conversation count and workspace count.
