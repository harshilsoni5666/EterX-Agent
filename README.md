<p align="center">
  <img src="./public/assets/banner.png" width="100%" alt="EterX-Agent Banner">
</p>

<h1 align="center">EterX-Agent</h1>

<p align="center">
  <strong>An autonomous AI agent that works and operates in your computer, plans, and learns — built for real work.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Under%20Development-orange" alt="Status">
  <img src="https://img.shields.io/badge/Developer-Harshil%20Soni-blue" alt="Developer">
  <img src="https://img.shields.io/badge/Tools-80%2B%20Native%20Tools-green" alt="Tools">
</p>

---

## About EterX Agent

EterX is an autonomous agent platform that plans, runs tasks, and operates your computer locally. It takes high-level goals, breaks them down into clear steps, and executes them using specialized tools and helper agents.

*   **Collaborative Swarms**: Spawns parallel background sub-agents that communicate via a built-in mailbox system to tackle complex, independent tasks.
*   **Intelligent Model Routing**: Automatically selects the best model, balances load across API keys, and routes through fallback chains to prevent service interruption.
*   **Custom Agent Builder**: Talk to the builder to create specialized agents with custom rules, missions, and tailored tool chains built specifically for your environment.

### Agent-first app support with themes
A premium, highly integrated interface supporting both custom light and dark themes designed specifically to match your preferred workspace aesthetics. All data runs locally on your machine, ensuring your workspace configurations and memories remain entirely private.

<p align="center">
  <img src="./public/assets/white-theme.png" width="48%" alt="White Theme" />
  <img src="./public/assets/black-theme.png" width="48%" alt="Dark Theme" />
</p>

---

## Architecture

### Sub-Agent System

EterX operates a collaborative multi-agent architecture. For complex or multi-layered projects, the main agent can delegate tasks to parallel sub-agents running independently in the background.

*   **Identifiable Personas**: Sub-agents are loaded as distinct personas named after prominent thinkers and scientists (such as Einstein, Heisenberg, Turing, Ada, and Curie) to make it easy to follow who is performing each task in the workspace logs.
*   **Parallel Non-Blocking Workflows**: When the main agent delegates work, sub-agents start immediately in the background with a staggered delay (such as 500ms intervals) to prevent startup bottlenecks and environment race conditions. The main agent is never blocked and can continue its own tasks in parallel. Results are saved locally and collected once the sub-agents complete their goals.
*   **Key Isolation & Throttling Prevention**: To prevent rate limits, each sub-agent is assigned its own client with a different API key leased from the local pool. This prevents parallel agents from conflicting, hitting limits, or getting blocked during high-concurrency tasks.
*   **Inter-Agent Mailbox (Agent-to-Agent Communication)**: A real-time mailbox system lets agents coordinate. Sub-agents check their mailboxes between tasks to read coordination requests, send questions to the main agent, hand off partial results, or broadcast warnings to the entire swarm. Messages include priorities (low, normal, high, critical) and delivery modes:
    *   *Interrupt*: Pauses the recipient at their next safe boundary to force a response to critical questions or alerts.
    *   *Defer*: Delivers the message silently to be processed when the agent is free.
    *   *Silent*: Logs the data directly to history without disrupting the agent's active execution flow.
*   **Interactive Control Loops**: You have complete command over the background swarm. Sub-agents can be individually paused (suspending their loops safely using promise resolvers), resumed when needed, or closed (terminated) immediately. A global emergency stop flag can also be triggered to halt all active background agents across all chats instantly.
*   **Specialized Domain Experts**: EterX can spawn highly focused specialist profiles depending on the requirements:
    *   **Mira (Security Auditor)**: Audits code security, reviews authorization flows, checks for exposed credentials, evaluates header policies (CORS, CSRF), and assesses unsafe data-handling paths.
    *   **Leo (Performance Analyst)**: Profiles latency issues, identifies memory leaks (such as unclosed streams or listener buildup), analyzes database query efficiency (like N+1 loops), and implements CPU optimizations.
    *   **Kai (Architect)**: Analyzes module design, checks for circular dependencies, reviews state management flows, and maps out system boundaries using visual flow diagrams.
    *   **Zara (QA Tester)**: Tracks bugs, verifies edge cases, identifies untested code paths, and automatically writes test suites (using Jest or Vitest) to check for regressions.
    *   **Sage (Researcher)**: Conducts deep multi-source research using date-aware search limits and source-credibility filtering to verify claims and resolve conflicting evidence.
*   **Consensus Panels**: Spawns a three-agent panel composed of an Optimist (Dave) to identify upsides, a Skeptic (Nova) to challenge assumptions and find risks, and a Realist (Sam) to ground suggestions in practical constraints. Together, they debate and synthesize a balanced recommendation.
*   **Adversarial Debate Panels**: Runs multi-round debate swarms where agents critique each other's work:
    *   *Round 1*: Agents analyze the task independently.
    *   *Round 2*: Agents review the opposing analysis, write cross-rebuttals, and revise their initial positions.
    *   *Round 3*: A confidence score is calculated based on concessions and agreement patterns, and a final synthesis is compiled by the realist or main agent.

---

## End-to-End Workflow

EterX is organized around a seamless, end-to-end workflow that connects model configuration, customized personas, and multi-agent execution:

*   **Configure Providers and Models**: Select your preferred AI provider (Google Gemini, OpenAI, Anthropic, OpenRouter, etc.) and pick the specific models you want to use. EterX manages these connections, handles load balancing across multiple API keys, and automatically routes tasks to stable fallback models if a primary model is down.
*   **Create Tailored Custom Agents**: Use the interactive Agent Builder to design custom agents. You can talk to the builder to establish their mission and behavior rules, and the system will automatically configure a custom chain of tools and helpers specifically for that agent's work environment.
*   **Delegate Tasks to Collaborative Sub-Agents**: Initiate your workflow and let the main agent break down complex tasks. It can spawn specialized sub-agents in the background that work in parallel and communicate via an inter-agent mailbox system to coordinate and assemble the final output.
*   **Execute Local Workspace Actions**: Let your agents interact directly with your workspace. They can safely read and edit files, execute commands in isolated local sandboxes, conduct deep multi-angle web research, and use the computer cursor naturally to complete your instructions.
*   **Retain Memory and Relational Context**: When a workflow finishes, EterX persists the learnings, facts, and project details locally. This feeds into a continuous learning loop, making all future tasks faster and context-aware.

---

## The Tools: What EterX Can Actually Do

EterX ships with **80+ native tools** organized into categories. These are not wrappers — each tool is a purpose-built capability.

### Computer & Screen Control
The `screen_agent` tool gives EterX full, real human-like control of your computer:
- Takes screenshots and **sees** the screen
- Clicks with natural bezier cursor movement (not robotic straight lines)
- Types with human-like timing and per-character delays
- Reads text from the screen using Windows OCR + UI Automation
- Finds any UI element by name or text, even if coordinates are unknown
- Waits for visual changes or text to appear before continuing
- Streams the live screen in real time to the monitor panel

### Code Intelligence & File Operations
- `workspace_read_file`, `workspace_write_file`, `workspace_edit_file` — file read/write with patch-level precision
- `smart_refactor` — AI-assisted code restructuring
- `code_intel`, `workspace_symbol_lookup`, `workspace_file_outline` — understand any codebase structure
- `workspace_apply_patch` — apply git-style unified diffs to files
- `workspace_run_command`, `workspace_execute_script`, `workspace_verify_code` — run and verify code in your project
- `git`, `git_intel` — full git operations and intelligence

### Deep Research
- `deep_research` — multi-angle parallel research engine: runs several search queries simultaneously, scrapes top results, synthesizes into a structured report with sources
- `web_search`, `web_scraper`, `pdf_parser`, `youtube_transcript`, `rss_feed` — pull information from any source

### Communication & Messaging
- `telegram` — send messages, control conversations, interact with the Telegram Bot interface
- `slack` — post to channels, react to messages, manage Slack workflows
- `whatsapp` — control WhatsApp via the controller tool
- `email` — send emails programmatically

### Data & Documents
- `chart_generator` — generate data visualizations and charts
- `csv_analyzer` — parse and analyze spreadsheet data
- `docx_generator` — create Word documents
- `office_artifact_builder` — build professional Excel spreadsheets, PowerPoint presentations, and office documents
- `markdown`, `compression`, `diff` — markdown processing, file compression, and comparison

### System & Automation
- `shell`, `terminal_access`, `background_task`, `terminal_background` — run any terminal command, including long-running background processes with scheduled check-ins
- `process_manager`, `file_watcher`, `http_server` — manage system processes, watch files for changes, spin up local HTTP servers
- `sys_automation`, `desktop_control` — OS-level automation
- `system_monitor` — monitor CPU, memory, disk, and process health

### Intelligence & Self-Improvement
- `self_improve` — the agent can write and apply improvement patches to its own skill system
- `memory_v2` — store and recall facts, project context, and session state
- `task_decomposer` — break large goals into organized, independent subtasks
- `realtime_verify` — verify information from live web sources before accepting it as fact

### AI Infrastructure
- `image_gen` — generate images via AI
- `tts` — text-to-speech output
- `calculator`, `js_runner`, `regex`, `json_transform` — built-in compute utilities
- `crypto` — cryptographic operations
- `database` — interact with databases
- `network` — make HTTP requests and inspect network responses
- `api_caller`, `api_hub` — call any external API
- `api_key_vault` — secure, masked storage for API credentials

---

## Agent Builder

EterX includes a built-in **Agent Builder** system that lets you create and deploy your own custom AI agents.

When operating in Agent Builder mode, the agent can:

1. **Define a mission and professional system prompt** for a custom agent
2. **Attach existing tools** by reference (e.g., give a custom agent access to `web_search`)
3. **Define agent-scoped custom tools** — prompt macros, tool chains, or scoped code
4. **Set behavior rules, safety rules, tool use policies, and completion criteria**
5. **Finalize and validate** the agent when all requirements are satisfied

The finalized custom agent is saved as a structured profile with a `SYSTEM_PROMPT.md` file, ready to be loaded into any EterX session.

---

## Model System

EterX does not hardcode any model names. Every model reference is resolved through a **Universal Model Registry** that reads from environment variables and maintains proven-model caching.

**Supported providers and their fallback chains:**

| Provider | Default Model | Fallback Chain |
|----------|--------------|----------------|
| **Gemini (Think)** | gemini-3.5-flash | gemini-3-flash-preview → gemini-2.5-pro → ... |
| **Gemini (Fast)** | gemini-3.5-flash | gemini-3-flash-preview → gemini-2.5-flash → ... |
| **OpenAI** | gpt-5.5 | gpt-5.4 → gpt-5.4-mini → gpt-5.4-nano |
| **Anthropic** | claude-opus-4-8 | claude-sonnet-4-6 → claude-haiku-4-5 → ... |
| **OpenRouter** | openai/gpt-5.5 | anthropic/claude-opus → google/gemini → ... |
| **Mistral** | mistral-medium-3-5 | mistral-small → ministral-14b → ... |
| **Groq** | openai/gpt-oss-120b | llama-3.3-70b → compound → compound-mini |

If a model is deprecated or unavailable, the agent automatically walks the fallback chain without any code changes. You only need to update your `.env.local` file to override.

**Multi-key load balancing:** You can configure multiple API keys per provider. EterX shuffles and rotates them automatically to distribute load and avoid rate limits.

---

## Memory Architecture

EterX uses a **multi-tier, locally stored memory system**. Nothing is sent to a cloud memory service.

```text
.workspaces/
├── memory/
│   ├── user_memory.json         # Long-term facts about you and your preferences
│   ├── project_memory/          # Per-project context — what has been done, decisions made
│   ├── session_memory/          # Active session state for continuation
│   ├── credential_refs.json     # API key references (no raw keys stored)
│   └── overlays/                # Self-improvement patches applied over time
├── dynamic_tools/               # Custom tools the agent created during sessions
├── temp/screen-agent/           # Temporary files from screen capture and OCR
├── config/
│   ├── eterx.config.json        # App settings
│   └── setup-meta.json          # Installation metadata
└── backups/                     # Timestamped configuration snapshots
```

The `synapse-graph` memory system additionally builds a relational graph of concepts — connecting facts, files, and context together so the agent can recall relevant information even when it is not explicitly referenced.

---

## Interfaces

| Interface | How to start | Description |
|-----------|-------------|-------------|
| **Web App** | `eterx start` | Next.js UI at `localhost:3000`. Full chat, file panel, monitor panel, agent controls. |
| **Desktop App** | `eterx desktop` | Electron wrapper that runs the web app as a native desktop window with deeper OS integration. |
| **Telegram Bot** | `eterx telegram` | Remote agent access from anywhere. Supports fast-path responses for quick questions and full task execution for complex work. |

---

## Installation

### One-Command Install (Recommended)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.ps1 | iex
```

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.sh | bash
```

> The installer handles Node.js, Git, dependencies, API key configuration, local storage setup, desktop shortcuts, and launch.

### Manual Install

```bash
git clone https://github.com/harshilsoni5666/EterX-agent-.git
cd EterX-agent-
node setup.js
```

### API Key Setup

After installing, add or update your API keys at any time:
```bash
eterx api
```

---

## CLI Reference

### Launch
```bash
eterx start           # Web app at localhost:3000
eterx desktop         # Desktop app (Electron)
eterx telegram        # Telegram bot
eterx open            # Open web app in browser
```

### Setup & Keys
```bash
eterx setup           # Full setup wizard
eterx api             # Quick API key setup
eterx config          # Reconfigure all keys
eterx add-key         # Add a single new key
```

### Diagnostics
```bash
eterx doctor          # 30+ system checks
eterx health          # Live API key test
eterx benchmark       # Speed-test all providers
eterx providers       # List all providers and their status
```

### Management
```bash
eterx status          # View config and update status
eterx upgrade         # Pull latest and reinstall
eterx backup          # Backup config and memory
eterx restore         # Restore from backup
eterx repair          # Fix broken installation
eterx logs            # View last 60 lines of setup logs
eterx env             # Show masked environment variables
eterx clean           # Clear Next.js cache, TypeScript build info, stale locks
eterx uninstall       # Remove EterX
```

---

## Project Structure

```text
EterX-Agent/
├── src/
│   ├── app/                      # Next.js pages and API routes
│   ├── components/               # React UI components (chat, monitor, file panel)
│   ├── contexts/                 # React state providers
│   └── lib/
│       ├── agent/                # Core agent engine
│       │   ├── Agent.ts          # Main GeminiAgentClient — model routing, tool execution loop
│       │   ├── tools/            # All 80+ native tools
│       │   │   ├── core/         # Core tools (shell, search, screen, memory, sub-agents...)
│       │   │   ├── workspace/    # File and code tools
│       │   │   ├── research/     # Web scraping, PDF, YouTube, RSS
│       │   │   ├── automation/   # Agent Builder, process manager, file watcher
│       │   │   └── communication/# Telegram, Slack, WhatsApp
│       │   ├── memory/           # MemoryV2, conversation ledger, synapse graph
│       │   ├── reasoning/        # Cognitive engine, context intelligence, verification
│       │   ├── resilience/       # Auto-context compression, error recovery
│       │   ├── roles/            # Sub-agent orchestration, inter-agent communication
│       │   ├── hooks/            # Cognitive hooks, velocity monitor
│       │   └── model-routing.ts  # Universal model registry and fallback chains
│       ├── code/                 # Code generation runtime
│       ├── live/                 # Real-time WebSocket communication
│       └── sandbox/              # Sandboxed command execution
├── electron/                     # Desktop app wrapper
├── fastapi_blog/                 # Python FastAPI backend for structured data
├── setup/                        # Installation and diagnostic scripts
└── eterx.js                      # CLI entry point (400+ line command router)
```

---

## Developer

Currently under development.

Built by **Harshil Soni**.
