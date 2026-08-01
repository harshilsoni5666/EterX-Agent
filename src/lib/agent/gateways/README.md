# EterX Gateway Router

The gateway is a desktop-owned, always-on messaging ingress and MCP control plane. Platform-specific webhook, polling, WebSocket, and bridge payloads are normalized into `GatewayAgentInput` before authorization, durable storage, session routing, or agent dispatch.

## Endpoints

- `GET /health`
- `POST /mcp` (authenticated MCP Streamable HTTP requests)
- `POST /control/call` (authenticated native EterX bridge)
- `POST /webhooks/telegram`
- `GET|POST /webhooks/whatsapp`
- `POST /webhooks/discord`
- `POST /webhooks/signal`
- `POST /webhooks/generic`

The listener binds to `127.0.0.1` by default. Use a TLS reverse proxy or tunnel for public webhooks. Never expose a route without its platform signature or webhook secret.

Events use deterministic agent session keys and an append-only JSONL journal. Deduplication keys, event cursors, pairing identities, acknowledgements, conversation summaries, and outbound delivery attempts survive restarts.

## Adding another channel

Register an adapter with the daemon registry:

```js
daemon.registry.register({
  id: 'my-platform',
  normalize(payload) {
    return [/* GatewayAgentInput */];
  },
  async send(target, text, config) {
    // Optional outbound transport implementation.
  },
});
```

Transport code owns authentication and delivery. The adapter produces the standard input contract. This keeps authorization, agent routing, deduplication, persistence, MCP access, and UI behavior platform-independent.
