# EterX Syn live runtime report

This is the runtime map for following one agent request from entry to final output. The live trace is opt-in and local.

## The complete path

```text
UI / API request
  -> /api/agent/start or /api/chat
  -> AgentRegistry.startAgent()
  -> Orchestrator.run()
  -> Agent.runReActLoop()
  -> SynapseGraph.initialize(projectId, projectId)
  -> SynapseGraph.processTurn(user message)
  -> InjectionPolicyEngine.buildPayload()
  -> renderPayload()
  -> dynamicContextParts
  -> buildDynamicSystemSuffix() / generateSystemPrompt()
  -> Gemini generateContentStream()
  -> tool calls and tool results
  -> final answer trace
  -> task store, session memory, Synapse graph persistence
```

## What Synapse actually does

Synapse is an assistive continuity layer. It does not change model weights, grant tools, or bypass safety.

For each user turn it:

1. Stores the user turn as a structured source/version/state/confidence record.
2. Vectorizes the query and compares it to the active topic centroid.
3. Detects topic transitions or reactivation of an older topic node.
4. Runs five filters: semantic match, freshness, confidence, token budget, and final ranking.
5. Builds an injection payload and renders it into a text context block.
6. Appends that block to `dynamicContextParts`, which becomes part of the model system instruction.
7. Marks selected records as injected and persists the graph under the EterX data directory in `.synapse/<projectId>/graph.json`.

Important source locations:

- `src/lib/agent/memory/synapse-graph.ts`: graph, records, selection, rendered injection.
- `src/lib/agent/memory/injection-policy.ts`: confidence floor, budget, payload rendering.
- `src/lib/agent/Agent.ts`: Synapse call, system prompt construction, model stream, tools, final answer.
- `src/lib/agent/agent-registry.ts`: background execution and trace buffer.
- `src/lib/agent/monitor/emitter.ts`: real-time monitor events.
- `src/app/api/monitor/live/route.ts`: SSE live monitor endpoint.
- `src/components/monitor/ModernMonitorPanel.tsx`: UI subscriber and event display.

## What is captured in the local JSONL trace

With `ETERX_TRACE_FILE` enabled, one JSON object is appended per line:

- `synapse_injection`: query, Synapse state, omega, confidence, decision-surface counts, selected payload, and rendered context.
- `model_request`: model name, full request contents, system instruction, and tool count. API keys/tokens are redacted.
- `agent_trace`: progress, thought/work notes, tool calls/results, console output, and final answer events.
- `monitor_event`: terminal, files, browser, desktop, search, memory, task, heartbeat, and tool events sent to the live monitor.

## Run it on Windows

Open terminal 1 in the project folder:

```powershell
.\scripts\run-live-trace.ps1
```

Open terminal 2 in the same folder:

```powershell
.\scripts\watch-live-trace.ps1
```

Then use the EterX UI normally and submit one test request. Terminal 2 will show Synapse selection, the model request, and every runtime event as it happens. The raw file is:

```text
logs\syn-live.jsonl
```

You can also choose another file:

```powershell
.\scripts\run-live-trace.ps1 -TraceFile 'C:\temp\eterx-syn.jsonl'
.\scripts\watch-live-trace.ps1 -TraceFile 'C:\temp\eterx-syn.jsonl'
```

The trace is disabled when `ETERX_TRACE_FILE` is unset. It is fire-and-forget and failures to write the file do not stop the agent.

## How to read one request

Find the same `projectId` or `chatId` across entries. Read in this order:

1. `synapse_injection` — what Synapse selected and why.
2. `model_request` — what was actually assembled and sent to Gemini.
3. `agent_trace` with tool events — what the model requested and what tools returned.
4. `monitor_event` — user-visible operational activity and outputs.
5. The final `agent_trace` answer event — what EterX returned.

The monitor UI is a separate real-time view of the same execution family. It uses server-sent events and keeps a bounded in-memory replay buffer, while the JSONL file gives you a durable local record for inspection.
