---
name: slack
description: Use when the user wants to work with Slack: read or summarize channels, search conversations, draft or send messages, reply in threads, react, upload files, create or manage channels, inspect workspace context, or prepare Slack-ready reports.
license: Proprietary
---

# Slack

Use Slack capabilities only when a Slack connector, MCP tool, API credential, or approved project integration is actually available in the current runtime. Do not assume a specific tool name.

## Operating Rules

1. Verify connection and workspace identity before the first Slack action.
2. Respect the user's requested scope: channel, thread, time range, people, and whether the task is read-only or may post.
3. Ask for confirmation before sending, deleting, inviting, creating channels, changing topics, or posting externally visible updates unless the user explicitly authorized the exact action.
4. Prefer thread replies for follow-ups when the work started from a thread.
5. Preserve privacy: summarize only the requested channels/messages and avoid exposing sensitive personal or credential-like data.
6. When a Slack capability is unavailable, prepare the message/report locally and explain what connection or permission is missing.

## Common Workflows

| Request | Approach |
|---|---|
| Summarize a channel | Read the scoped messages, group by topic/decision/action, include time window and gaps |
| Search Slack | Use the available search capability, quote only short necessary snippets, include channel/thread references |
| Draft a message | Produce a ready-to-send draft; confirm before posting unless already authorized |
| Post a report | Convert findings to concise Slack formatting, attach files only when the connector supports uploads |
| Reply in a thread | Use the original channel and thread timestamp; keep context in-thread |
| React to a message | Confirm target message and emoji when not obvious |
| Create/manage channels | Confirm name, visibility, members, topic, and retention/compliance implications |

## Message Quality

- Keep Slack output concise and action-oriented.
- Use bullets for status, blockers, decisions, and owners.
- Use code blocks for logs, commands, or structured data.
- Avoid large pasted reports when an uploaded file or linked artifact is more appropriate.

## Failure Handling

If a send/upload/update fails, report the failure plainly, keep the prepared content available, and do not retry repeatedly without evidence the failure is transient.
