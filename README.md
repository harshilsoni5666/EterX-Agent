<p align="center">
  <img src="./banner.png" width="100%" alt="EterX-Agent Banner">
</p>

<h1 align="center">EterX-Agent</h1>

<p align="center">
  <strong>A self-improving AI agent platform built for intelligent task execution, persistent memory, autonomous workflows, skill creation, and multi-provider AI infrastructure.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Under%20Development-orange" alt="Status">
  <img src="https://img.shields.io/badge/Developer-Harshil%20Soni-blue" alt="Developer">
</p>

---

## Table of Contents

- [About](#-about-eterx-agent)
- [Key Features](#-key-features)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Supported Providers](#-supported-model-providers)
- [CLI Commands](#-cli-commands)
- [Project Structure](#-project-structure)
- [Local Storage Architecture](#-local-storage-architecture)

---

## About EterX Agent

EterX-Agent is designed to operate as an **adaptive AI assistant** that can:
- Learn from use and improve skills over time.
- Persist useful knowledge.
- Search prior conversations.
- Understand user work patterns and preferences.

It runs with a custom EterX app interface and supports practical integrations, allowing tasks to continue beyond a single local laptop session (e.g., executing workflows through Telegram).

---

## Key Features

- **Advanced Reasoning & Planning**: Dynamically breaks down complex tasks, spawns specialized sub-agents (e.g., critics and planners), and utilizes neural plasticity for self-improvement.
- **Multi-Provider AI**: Seamlessly switch between Google Gemini, OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, local models via Ollama, and more—with automatic load balancing and error fallbacks.
- **Multi-Tier Persistent Memory**: Retains user facts, project context, and session data locally through a sophisticated graph-based memory system.
- **Sandboxed Execution**: Safely compiles, runs, and manipulates code in a strictly isolated local environment with strict capability boundaries.
- **Cross-Platform Interfaces**: Access your agent seamlessly via the Next.js Web App, native Desktop Electron App, or on-the-go with the Telegram Bot integration.
- **Dynamic Skill Creation**: The agent can autonomously write and integrate new tools for itself on the fly to solve novel problems.
- **Local First & Private**: All memories, workspace configurations, and logs are stored strictly on your local disk.

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
> **Note:** The installer automatically handles Node.js, Git, dependencies, API key configuration, local storage, desktop shortcuts, and application launch. For existing installs, it repairs setup and dependencies without altering source files (unless `ETERX_UPDATE=1` is set).

### Manual Install

If you prefer to set up everything manually:
```bash
git clone https://github.com/harshilsoni5666/EterX-agent-.git
cd EterX-agent-
node setup.js
```
The interactive wizard will guide you through system detection, dependency installation, key setup, and environment generation.

---

## Configuration

After installation, you can add or manage API keys at any time using:

```bash
eterx api
```
The quick wizard prioritizes Google Gemini, followed by optional setups for Tavily, OpenAI, Groq, Telegram, and Slack. Your existing keys will be preserved unless explicitly updated.

---

## Usage

Run EterX via the global CLI command or npm scripts:

| Environment | CLI Command | npm Command |
|-------------|-------------|-------------|
| **Web App** (localhost:3000) | `eterx start` | `npm run eterx:start` |
| **Desktop App** (Electron) | `eterx desktop` | `npm run eterx:desktop` |
| **Telegram Bot** | `eterx telegram` | `npm run eterx:telegram` |

---

## Supported Model Providers

EterX-Agent supports a vast array of top-tier AI models:

<details>
<summary><strong>Click to expand the full list of providers</strong></summary>

| Provider | Models | Key Configuration |
|----------|--------|-------------------|
| **Google Gemini** | gemini-2.5-flash, gemini-2.5-pro | `GEMINI_API_KEY` |
| **OpenAI** | gpt-4.1, o3, o4-mini | `OPENAI_API_KEY` |
| **Anthropic** | claude-sonnet-4, claude-opus-4 | `ANTHROPIC_API_KEY` |
| **OpenRouter** | 200+ models via one key | `OPENROUTER_API_KEY` |
| **Groq** | GPT-OSS, Llama 3.3/3.1, Compound | `GROQ_API_KEY` |
| **DeepSeek** | deepseek-chat, deepseek-reasoner | `DEEPSEEK_API_KEY` |
| **Hugging Face** | Llama, Mistral, open-source | `HF_TOKEN` |
| **Alibaba DashScope**| qwen-max, qwen-plus | `DASHSCOPE_API_KEY` |
| **Kimi / Moonshot** | moonshot-v1-128k | `KIMI_API_KEY` |
| **z.ai / GLM** | glm-4-plus, glm-4-flash | `GLM_API_KEY` |
| **MiniMax** | abab6.5s-chat | `MINIMAX_API_KEY` |
| **Arcee AI** | arcee-agent | `ARCEEAI_API_KEY` |
| **GMI Cloud** | gmi-default | `GMI_API_KEY` |
| **Tencent TokenHub** | hunyuan-large | `TOKENHUB_API_KEY` |
| **Xiaomi MiMo** | mimo-default | `XIAOMI_API_KEY` |
| **Kilo Code** | kilo-default | `KILOCODE_API_KEY` |
| **LM Studio** | Any local model | *No key required* |
| **Ollama** | llama3.3, codellama, mistral | *No key required* |
| **Custom Endpoint** | Any OpenAI-compatible API | Custom URL and key |

</details>

---

## CLI Commands

EterX comes with a powerful CLI tool for easy management:

### Setup & Configuration
```bash
eterx setup            # Full setup wizard
eterx api              # Quick API key setup
eterx config           # Change API keys
eterx add-key          # Add a single key
```

### Diagnostics
```bash
eterx doctor           # System diagnosis
eterx health           # Test configured API keys
eterx benchmark        # Speed-test providers
eterx providers        # List providers and status
```

### Management
```bash
eterx status           # View config and update status
eterx upgrade          # Pull latest and reinstall
eterx backup           # Backup config and memory
eterx restore          # Restore from backup
eterx repair           # Fix broken install
eterx logs             # View setup and runtime logs
eterx env              # Show masked environment variables
eterx clean            # Clear caches and temp files
eterx uninstall        # Remove EterX
```

---

## Project Structure

The codebase is organized into several key components, spanning both frontend interfaces and backend agent logic:

```text
EterX-Agent/
├── electron/                # Desktop application wrapper using Electron
├── fastapi_blog/            # Python backend (FastAPI) for API integrations
├── src/
│   ├── app/                 # Next.js web application routing and pages
│   ├── components/          # Reusable React UI components
│   ├── contexts/            # React context providers for state management
│   └── lib/                 # Core AI agent engine
│       ├── agent/           # Adaptive logic, reasoning, roles, memory
│       ├── code/            # Code generation and editing tools
│       ├── live/            # Real-time WebSocket/communication
│       └── sandbox/         # Isolated execution environments
├── scripts/                 # Utility scripts for theme generation and testing
├── setup/                   # Setup wizards and installation scripts
└── eterx.js                 # Global CLI entry point
```

---

## Local Storage Architecture

All data remains strictly local on your machine under the `.workspaces/` directory:

```text
.workspaces/
├── memory/                  # Persistent storage (MemoryV2)
│   ├── user_memory.json     # Long-term user facts and preferences
│   ├── project_memory/      # Per-project context
│   ├── session_memory/      # Session continuation data
│   ├── credential_refs.json # Safe vault references (no raw keys)
│   └── overlays/            # Self-improvement patches
├── dynamic_tools/           # Agent-created tools persisting across restarts
├── config/
│   ├── eterx.config.json    # Application settings
│   └── setup-meta.json      # Installation metadata
└── backups/                 # Timestamped configuration backups
```

---

## Developer

**EterX-Agent** is proudly built and maintained by **Harshil Soni**.
