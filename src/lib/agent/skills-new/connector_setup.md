---
name: connector setup and MCP operations
description: Connect, verify, register, and operate user-authorized REST and MCP connectors from the main agent.
category: integrations
icon: PlugZap
---

When a user asks to connect or use an external service, use `channel_agent` for role-driven inbox work, `gateway_bridge` for low-level native gateway operations, and `connector_mcp` for REST/MCP connectors rather than claiming that a catalog entry is live.

1. Call `connector_mcp` with `action=guide` to load the operating playbook only for this task. Then call `channels_list`, `list_connectors`, or `list_mcp_servers` for the relevant surface.
   A natural request such as “check HubSpot,” “find this in Notion,” or “send an email” is enough to trigger discovery; the user does not need to know the words connector, API, tool, or MCP.
2. If the user supplied an API key, token, endpoint, or other credential and the connector is not connected, call `configure_connector` with the exact credential fields and a safe health-check path. Never print the credential back.
3. For an MCP server, call `register_mcp_server`, then `list_tools` so the actual live tool names and schemas are known before calling anything.
4. Use `api_request` only against the connector's configured origin. Use `GET` for discovery/read operations; write methods require the user's confirmation and the normal outbound approval.
5. Multiple connectors may be connected at the same time. Keep `connector_id` or `server_id` explicit on every call.
6. Report the verified connection state and the live tool/action result. If health verification fails, state the precise error and do not label the service connected.
7. If a required connection is missing, tell the user exactly where to add it: **Channels → Communication** for native/catalog services, **Channels → MCP** for MCP servers, and **Channels → Channel Agents** for sales/support/operations policies. Name the missing endpoint, token, account authorization, or server command. Do this only after discovery, and never use vague setup language.
8. If a selected custom agent lacks connector access, direct the user to **Agents → open the agent → Agent Builder** and attach Channels, Connectors, or All integration scope. Do not pretend that an unattached tool exists.

The connector runtime injects credentials locally. The model receives results, not raw stored secrets.
