# Import conversations and setup

Open **Settings → Import** to bring supported Codex, Claude, or Cursor content into EterX. The page follows the current light or dark theme. A scan produces a selectable preview before anything is installed.

## Choose content and a destination

1. Choose a detected source, use **Source options** to enter or browse a local data folder, or upload exported files.
2. Search and select individual conversations, multiple conversations, or whole projects. Select instructions, skills, agents, and MCP definitions separately; individual setup items can be excluded.
3. Choose **Recents**, an existing import folder, or **New folder**. These are sidebar groups; a chat's original workspace path remains attached.
4. Import, then open the conversation from the sidebar and continue with an EterX provider. Configure that provider normally in EterX.

The preview and import report disclose skipped or unsupported content. A running operation continues if Settings closes. A completed scan can be reopened for 30 minutes while the server remains running. Starting a new scan replaces the previous preview. After a server restart, scan again; committed chats and preferences remain stored.

## Source coverage

| Source | Conversations | Setup |
| --- | --- | --- |
| Codex | Local session and archived-session JSONL, including `.jsonl.zst` archives; session-index titles; compatible JSON exports | User/project AGENTS files, configuration instructions, local skills including `.agents/skills`, plugin skill files, Markdown agents and agent TOML definitions, MCP definitions |
| Claude | Claude Code project JSONL, including readable subagent histories; Claude JSON exports | CLAUDE files, rules, project memory, skills, commands, custom-agent Markdown, compatible local plugin skills/agents, MCP definitions |
| Cursor | Local text/JSONL transcripts; supported `composerData` and bubble records from the local SQLite store; JSON/Markdown exports | Rules, AGENTS files, skills, custom agents, MCP definitions |

Detected roots are `CODEX_HOME` or `~/.codex`, `CLAUDE_CONFIG_DIR` or `~/.claude`, `~/.cursor`, and the platform's Cursor `User` data directory. Project setup discovery follows workspace paths recorded in local history. Source SQLite databases are opened read-only, using Node SQLite when available or the OS SQLite library through the existing Koffi dependency in desktop runtimes.

Uploads accept JSON, JSONL, Markdown, text, TOML, and ZIP. A skill ZIP preserves supported scripts, references, templates, images, fonts, documents, and media under its skill directory. Imports never run these files. Uploads without an original workspace path are personal setup; a local scan preserves project scope. Uploading an export does not replace an existing local sync connection for the same provider.

Cloud-only conversations require an export. Locally available attachments, embedded images, and cited output files are retained in EterX's normal per-chat media store. They use the normal attachment previews, file controls, and later-turn media context. Missing originals retain an unavailable attachment card; reattach those files to restore access. Remote-only media is not downloaded. Private reasoning, source-system prompts, auth sessions, permission grants, plugin hooks, executable plugin binaries, and source-app model configuration are not installed. Unknown Cursor database formats and unsupported TOML values produce import notes rather than fabricated content. Text exports without native conversation IDs use their filename as identity; retain the filename when updating the same export.

## Runtime integration

- Chats enter the regular durable chat store with normal user, answer, commentary, and historical-tool events. They are available to the sidebar, normal chat continuation, and provider-neutral context history. Historical tool records are stored as evidence; they are never replayed as tool calls.
- Source actions pass through a presentation adapter before entering Thought Sequence. Recorded shell invocations and process output use the native terminal row; patches and string replacements use file-change rows and recorded diffs; file reads use recorded previews; searches, browser actions, skills, plans, agent activity, and other tools use the existing action and result views. Unknown tools retain expandable results. Historical process IDs never create or reconnect to live terminals.
- Inline diffs, turn Changes, and comparison views share the same line coordinates. Unified hunk offsets are preserved, and offset-free patches recover positions from recorded file reads, creations, and intervening edits. Codex patches retain their ordered section anchors; supported literal PowerShell replacements update the recorded file history without executing scripts. Reconstructed before/after content uses the same diff generator as native edits. If the source has insufficient evidence, the gutter remains blank; excerpt counters are never presented as file line numbers. Historical positions never come from the current disk file. Literal single-file shell reads use native file previews with the recorded starting line.
- Available source project folders automatically become the chat's normal workspace, including on repair or a later sync. The same root drives file browsing, code views, terminals and agent context. Explicit folder selections and disconnections are retained across sync and stale saves. Missing folders produce an import note and can be reconnected with the chat's normal folder picker.
- Codex orchestration scripts are parsed without execution to recover literal nested tool arguments. When a sequence does not record separate results, its combined output is retained separately instead of assigning it to the wrong action. Dynamic expressions and unproven conditional calls remain in the source activity record. Missing exit codes or file contents are not fabricated.
- A supported generated-patch pattern (literal file list, line filter, literal replacement, and `apply_patch`) reconstructs changes against recorded file versions. Dynamic assignments invalidate stale literal bindings, preventing partial patch headers from becoming nameless file rows. Short file previews fit their content; large previews retain the native scroll limit.
- Generated attachment manifests and environment/context envelopes are removed from visible user messages. Progress commentary appears inside Worked; Codex output-file directives become normal local-file cards. File previews show the recorded content or diff, rather than silently fetching a newer file from disk.
- Skills are copied to EterX's real workspace skill directory under `skills/imports/<provider>/<id>/SKILL.md`. Stable unique catalog IDs avoid collisions. Relative support paths resolve from the copied skill's directory. The runtime refreshes its skill catalog at run/tool boundaries, and project skills are limited to their original workspace and descendants.
- Skills that reference known source-only app APIs are saved paused with a compatibility note. Adapt those files to available EterX tools before enabling them. This detection is conservative, not a guarantee that every dependency of every skill is available.
- Imported custom agents use the normal agent profile store and picker, with EterX's baseline tools and skill loader. Their source instructions are preserved; their model accounts and tool permissions are not transferred.
- Enabled instruction and memory files join the next run's reference context. Project instructions match their workspace. Large and conditional rules include file references for reading when relevant. Imported instructions cannot override the current request or grant new permissions.
- MCP definitions enter the encrypted connector store disconnected. **Connect** in Imported setup performs the actual initialization and tool-list request before enabling a server. Stdio working directories and supported environment substitutions are retained. Missing environment variables, unavailable programs, unsupported transports, or authentication failures are reported. Source OAuth sessions are not reused. A connected server becomes available to EterX; its source workspace is informational.

The **Imported setup** list has per-item switches and copyable destination paths. Turning off an item preserves its files. Pausing automatic sync preserves imported content; it does not disable already imported setup.

## Sync and preservation

Automatic sync is opt-in. While EterX is open, the coordinator polls for background operations every 10 seconds and schedules eligible sources at least 30 seconds apart per source, one scan/import at a time. Actual latency depends on source size. A staged selection pauses automatic source scans until it is imported, dismissed, or expires.

Selecting all conversations includes future conversations; selecting whole projects includes future conversations in those projects. An individual selection follows only those IDs. Source switches and **Sync now** control each local source. Uploaded files are refreshed by uploading them again.

Stable provider/source identities and receipts make repeat imports idempotent. Chat imports share the durable chat write queue with normal sends and deletions. Source updates preserve EterX continuations, manually renamed chats, locally edited imported messages and setup files, and removed chats/messages. Existing source history is retained if the source is compacted or truncated. Explicit re-import can move selected chats to another sidebar folder. Connected or locally edited MCP definitions are not silently replaced.

Completed imports publish updates to the current window and other EterX windows. Restored active chats merge the incoming history with ongoing local activity. Context hydration also considers the import revision, so updated source text is available on the next continuation.

When a presentation adapter changes, existing imported chats are repaired in the background while EterX is open, even with automatic source sync paused. The repair revisits only conversations already imported, preserves local continuations and edited text, and uses the original local source when available. Corrected import revisions take precedence over stale raw envelopes in cached windows. Missing source media cannot be reconstructed without its original file or embedded bytes.

## Storage and boundaries

Import preferences, source selections, per-item receipts, and reports live under the EterX data directory in `imports/state.json`, with an atomic backup. Instructions live in `imports/instructions`. Chats use the existing chat store; skills and agents use their existing workspace stores. Paused setup controls also have a backup recovery path.

Scanning reads known source paths, skips symbolic links and credential stores, and does not modify source apps. Local import routes are restricted to localhost with same-origin request protection. Preview responses contain metadata rather than conversation bodies or MCP credentials. Continued conversations send relevant context to the provider configured in EterX, just as normal chats do.

Scans are bounded to 20,000 files and 512 MB, with 64 MB per file, up to eight roots and 500 workspaces for project setup. Cursor database reads have separate bounded record/byte budgets. Uploads are limited to 64 MB total expanded content and 2,000 entries; ZIP paths are checked before any resource is copied. Large or unsupported records are reported so users can export smaller selections.

Local Zstandard archives are decoded incrementally with [fzstd](https://github.com/101arrowz/fzstd). Frame windows and expanded bytes obey the file and scan limits; corrupt, oversized, or unsupported archives produce an import note. Repairs prioritize already-imported session IDs, and general scans visit newer dated folders first. Archive compression does not change a conversation's source date. Source files remain untouched.

Explicitly referenced chat media is limited to 64 MB per file and 512 MB per conversation. Missing, oversized, or inaccessible files remain represented by an unavailable card and an import note.

## Format references

Source settings and setup conventions are based on the official [Codex configuration documentation](https://developers.openai.com/codex/config-basic/), [Claude Code local-session documentation](https://code.claude.com/docs/en/how-claude-code-works), [Claude settings reference](https://code.claude.com/docs/en/settings), [Cursor rules documentation](https://cursor.com/docs/rules), and [Cursor MCP setup documentation](https://cursor.com/help/customization/mcp). Cursor's private SQLite layout is handled as a compatibility adapter, not a guaranteed public API.

No tests, builds, type checks, or lint commands were run, as requested. Existing imports were repaired through the normal import service; the affected saved diff now contains line 288 and context lines 285–291. Visual UI inspection remains outstanding.
