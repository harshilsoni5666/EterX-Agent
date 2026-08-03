---
name: connector setup and MCP operations
description: Connect, verify, register, and operate user-authorized REST and MCP connectors from the main agent.
category: integrations
icon: PlugZap
---

When a user asks to connect or use an external service, use `gateway_bridge` for native gateway channels and the registered `connector_mcp` tool for REST/MCP connectors rather than claiming that a connector is available from the UI catalog.

1. Call `gateway_bridge` with `channels_list`, then call `list_connectors` and `list_mcp_servers` so native and external state are both known.
2. If the user supplied an API key, token, endpoint, or other credential and the connector is not connected, call `configure_connector` with the exact credential fields and a safe health-check path. Never print the credential back.
3. For an MCP server, call `register_mcp_server`, then `list_tools` so the actual live tool names and schemas are known before calling anything.
4. Use `api_request` only against the connector's configured origin. Use `GET` for discovery/read operations; write methods require the user's confirmation and the normal outbound approval.
5. Multiple connectors may be connected at the same time. Keep `connector_id` or `server_id` explicit on every call.
6. Report the verified connection state and the live tool/action result. If health verification fails, state the precise error and do not label the service connected.

The connector runtime injects credentials locally. The model receives results, not raw stored secrets.
