---
name: slack
description: Use this skill when the user wants to do anything with Slack — send messages, read channels, search conversations, post reports, react to messages, create channels, invite users, manage threads, upload files, or check workspace info. Activate whenever the user mentions Slack, a channel name (#general etc.), team messaging, or workspace communication.
license: Proprietary
---


You have **full Slack connectivity** via the `slack_controller` tool. Use this skill whenever the user asks about Slack, wants to send messages, check channels, search conversations, or manage their workspace.

---

## 🔌 Connection Check

Before any Slack action, verify you are connected:
```
slack_controller({ action: "status" })
```
If not connected → tell user to click the **Slack button** in the input bar and connect their workspace.

---

## 📋 Available Actions (17 total)

### 1. `status` — Check connection
```json
{ "action": "status" }
```
Returns: workspace name, team ID, bot user.

### 2. `list_channels` — List all channels
```json
{ "action": "list_channels" }
```
Returns: id, name, member count, topic, purpose.

### 3. `read` — Read channel messages
```json
{ "action": "read", "channel": "#general", "limit": 20 }
```
Returns: messages with user, text, timestamp, reactions, reply count.

### 4. `send` — Send a message
```json
{ "action": "send", "channel": "#general", "message": "Hello team! 👋" }
```
Use **#channel-name** or a channel ID. Always confirm with ✅ after sending.

### 5. `send_rich` — Send Block Kit rich message
```json
{
  "action": "send_rich",
  "channel": "#general",
  "message": "Fallback text",
  "blocks": "[{\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"*Hello!*\"}}]"
}
```
Use for structured reports, tables, buttons.

### 6. `reply` — Reply in a thread
```json
{ "action": "reply", "channel": "#general", "thread_ts": "1714000000.000100", "message": "Done!" }
```
`thread_ts` is the `ts` from the original message.

### 7. `react` — Add emoji reaction
```json
{ "action": "react", "channel": "#general", "thread_ts": "1714000000.000100", "emoji": "white_check_mark" }
```
Common emojis: `thumbsup`, `white_check_mark`, `eyes`, `tada`, `rocket`, `warning`.

### 8. `search` — Search messages
```json
{ "action": "search", "query": "deploy production", "limit": 10 }
```
Returns: matching messages with channel, user, text, permalink.

### 9. `upload` — Upload file/snippet
```json
{
  "action": "upload",
  "channel": "#general",
  "content": "Report content here...",
  "filename": "daily_report.txt"
}
```
Use to share agent-generated reports, code, or data directly in Slack.

### 10. `list_users` — List workspace members
```json
{ "action": "list_users" }
```
Returns: id, name, real_name, email, is_admin.

### 11. `user_info` — Get user profile
```json
{ "action": "user_info", "userId": "U12345678" }
```

### 12. `create_channel` — Create new channel
```json
{ "action": "create_channel", "channel_name": "project-launch", "is_private": false }
```

### 13. `invite_user` — Invite user to channel
```json
{ "action": "invite_user", "channel": "#project-launch", "userId": "U12345678" }
```

### 14. `pin` — Pin a message
```json
{ "action": "pin", "channel": "#general", "thread_ts": "1714000000.000100" }
```

### 15. `delete_message` — Delete a message
```json
{ "action": "delete_message", "channel": "#general", "thread_ts": "1714000000.000100" }
```
Only works for messages posted by the bot.

### 16. `set_topic` — Set channel topic
```json
{ "action": "set_topic", "channel": "#general", "topic": "Sprint 12 — Deadline: May 1st" }
```

### 17. `get_thread` — Read all replies in a thread
```json
{ "action": "get_thread", "channel": "#general", "thread_ts": "1714000000.000100" }
```

---

## 🧠 Agent Behaviour Rules

1. **Always check status first** on the first Slack action of a session.
2. **Resolve channels by name** — the tool auto-resolves `#channel-name` → ID.
3. **Use `search` before asking the user** for context — search first, then answer.
4. **Rich messages** (`send_rich`) should be used for reports, summaries, and structured outputs.
5. **Upload** agent outputs (code, reports, CSV) as snippets using `upload`.
6. **Thread replies** keep conversations clean — prefer `reply` over `send` for follow-ups.
7. **Confirm actions** — after sending/reacting/uploading, confirm to the user what was done.

---

## 💡 Example Agent Workflows

### "Summarise #product channel and post to #team"
```
1. slack_controller({ action: "read", channel: "#product", limit: 50 })
2. Summarise the messages
3. slack_controller({ action: "send", channel: "#team", message: "📋 *Product Update Summary*\n..." })
```

### "Search for production issues and report"
```
1. slack_controller({ action: "search", query: "production error" })
2. Format findings
3. slack_controller({ action: "upload", channel: "#engineering", content: report, filename: "issues.md" })
```

### "Create a project channel and invite the team"
```
1. slack_controller({ action: "create_channel", channel_name: "project-x" })
2. slack_controller({ action: "list_users" })  ← find user IDs
3. slack_controller({ action: "invite_user", channel: "#project-x", userId: "UXXX" })
```

### "Monitor #general and react to messages"
```
1. slack_controller({ action: "read", channel: "#general", limit: 5 })
2. slack_controller({ action: "react", channel: "#general", thread_ts: "...", emoji: "eyes" })
```
