# EterX always-on gateway

EterX owns messaging connections in the Electron main process instead of a visible chat tab. With **Keep running on close** enabled, closing the main window hides EterX to the system tray while the gateway, agent renderer, and scheduled-task poller remain alive. Choosing **Quit EterX** from the tray performs a full shutdown.

## Architecture

1. A platform adapter receives a webhook, Telegram polling update, Discord Gateway dispatch, compatible `signal-cli` bridge event, or an IMAP email.
2. The adapter produces a `GatewayAgentInput` with stable platform, conversation, actor, message, attachment, and reply-target fields.
3. The authorization layer applies open, allowlist, or pairing policy before a message enters the agent. Pairing is the secure default for built-in messaging transports.
4. The durable store rejects duplicate platform event IDs, appends accepted events to JSONL, and assigns a monotonic cursor.
5. A deterministic session key routes each conversation through a serial session lane, preventing concurrent messages from corrupting chat state.
6. The hidden renderer claims unacknowledged events and turns them into normal EterX chats using the same memory, policy, tools, and persistence as desktop chats.
7. Events are acknowledged only after the agent server accepts the run. Outbound replies use a durable delivery ledger with exponential retry.

Runtime state is stored under Electron's platform-specific user-data directory, never in the source checkout. Platform credentials are encrypted with Electron `safeStorage` and are not returned to the Channels UI after saving.

## Gateway control plane and MCP

The listener exposes an authenticated local MCP endpoint at `POST /mcp`. The Channels gateway screen can copy a ready-to-use Streamable HTTP client configuration. A random 256-bit control token is written with restricted permissions beneath the gateway data directory and is required as a bearer token.

Available tools:

- `conversations_list`, `conversation_get`, and `messages_read`
- `attachments_fetch`
- `events_poll` and `events_wait`
- `messages_send`
- `channels_list`
- `permissions_list_open` and `permissions_respond`

The EterX agent also registers a native `gateway_bridge` tool that calls the same control plane. This gives agent workflows one consistent interface whether a conversation came from Telegram, Messenger, WhatsApp, Discord, Signal, email, or a custom webhook.

## Platform notes

- **Telegram:** polling is suitable for an always-on desktop and avoids requiring a public URL. Webhook normalization is also supported. Telegram update IDs provide deduplication.
- **WhatsApp Cloud:** expose `/webhooks/whatsapp` through a TLS reverse proxy or tunnel. Configure the callback verification token, Meta app secret, access token, and phone-number ID. POST bodies are verified using `X-Hub-Signature-256`.
- **Messenger:** expose `/webhooks/messenger` through a TLS reverse proxy or tunnel. Configure the Page access token, Page ID, verify token, and Meta app secret. Webhook bodies are verified using `X-Hub-Signature-256`; outbound replies use the Page Graph API.
- **Email:** use a dedicated mailbox with an app password. The adapter polls IMAP for new messages, ignores self/automated mail, caches safe attachments locally, applies allowlist or pairing policy, and replies through SMTP with `In-Reply-To` and `References` headers. Existing unread mail is marked seen at first startup so enabling the channel does not trigger a historical reply storm.
- **Discord:** the daemon implements Gateway v10 Hello, jittered heartbeat, sequence tracking, reconnect, and session resume. Enable the Message Content privileged intent when the bot requires guild message bodies. Interaction webhooks verify Ed25519 signatures when a public key is configured.
- **Signal:** Signal has no official bot API. This integration targets an optional loopback bridge that exposes `signal-cli` JSON-RPC and an SSE event stream. Keep `signal-cli` current and do not expose the bridge publicly.
- **Custom:** POST normalized or near-normalized JSON to `/webhooks/generic` with either `Authorization: Bearer <secret>` or an HMAC SHA-256 digest in `X-EterX-Signature`.

## Cross-platform background startup

- Windows and macOS use Electron login-item registration with `--background`.
- Linux writes a per-user XDG autostart entry at `~/.config/autostart/eterx-background.desktop`.
- All platforms use `app.getPath('userData')` for durable state and `process.execPath` for startup, avoiding installation-path assumptions.

The listener defaults to `127.0.0.1:47821`. Loopback is the safe default. Public webhook providers require a TLS reverse proxy or tunnel that forwards only the required route. The Channels gateway also includes a searchable connector catalog for additional setup pathways; catalog entries are explicitly marked as native, MCP, or pathway so an unimplemented adapter cannot be enabled accidentally.

## Main files

- `src/lib/agent/gateways/registry.cjs` - pluggable adapter registry
- `src/lib/agent/gateways/normalizers.cjs` - built-in platform normalizers
- `src/lib/agent/gateways/session.cjs` - deterministic session keys and serialized lanes
- `src/lib/agent/gateways/hooks.cjs` - gateway lifecycle hooks
- `src/lib/agent/gateways/store.cjs` - dedupe, event journal, identity approvals, conversations, acknowledgements, and delivery ledger
- `src/lib/agent/gateways/daemon.cjs` - HTTP/MCP server, polling, WebSocket lifecycle, verification, routing, and outbound delivery
- `src/lib/agent/tools/communication/gateway_bridge.ts` - agent-native gateway control tool
- `src/components/channels/agent-channels-view.tsx` - original Channels landing and compact EterX-native gateway setup UI
