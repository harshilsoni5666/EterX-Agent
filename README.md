<p align="center">
  <img src="./banner.png" width="100%">
</p>

<h1 align="center">EterX-Agent</h1>

<p align="center">
EterX-Agent is a self-improving AI agent platform built by Harshil Soni for intelligent task execution, persistent memory, autonomous workflows, skill creation, and multi-provider AI infrastructure.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DOCS-ETERX--AGENT-black?style=for-the-badge">
  <img src="https://img.shields.io/badge/LICENSE-MIT-green?style=for-the-badge">
  <img src="https://img.shields.io/badge/STATUS-ACTIVE-blueviolet?style=for-the-badge">
  <img src="https://img.shields.io/badge/BUILT%20BY-HARSHIL%20SONI-purple?style=for-the-badge">
</p>

---

## About EterX Agent

EterX-Agent is designed to operate as an adaptive AI assistant that can learn from use, improve skills over time, persist useful knowledge, search prior conversations, and understand user work patterns and preferences.

It runs with a custom EterX app interface and supports practical integrations so tasks can continue beyond a single local laptop session, including workflows through Telegram.

---

## Usage

- Install and launch the application.
- Add API keys in the app API settings.
- Run the API test or skip check when appropriate.
- Ask questions, share files, and delegate tasks.
- Continue improving results over repeated use.

---

## Installation

### One-Command Install

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.ps1 | iex
```

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.sh | bash
```

The installer handles Node.js, Git, dependencies, API key configuration, local storage, desktop shortcuts, and application launch.

### Manual Install

```bash
git clone https://github.com/harshilsoni5666/EterX-agent-.git
cd EterX-agent-
node setup.js
```

The interactive setup wizard walks through:

1. System detection - checks Node.js, Git, operating system, and disk space
2. Dependency installation - runs `npm install`
3. Model provider selection - choose from supported providers
4. API key entry - masked input and multi-key load balancing for Gemini
5. Service integrations - Tavily search, Telegram bot, and Slack
6. Environment generation - writes `.env.local` with configured keys
7. Local storage setup - creates memory, config, and tool directories
8. System integration - desktop shortcut, Start Menu entry, and global `eterx` CLI command
9. Health check - validates configured API keys
10. Launch - choose Web App, Desktop, or Telegram Bot

---

## Supported Model Providers

| Provider | Models | Key |
|----------|--------|-----|
| **Google Gemini** | gemini-2.5-flash, gemini-2.5-pro | `GEMINI_API_KEY` with multi-key load balancing |
| **OpenAI** | gpt-4.1, o3, o4-mini, codex-mini | `OPENAI_API_KEY` |
| **Anthropic** | claude-sonnet-4, claude-opus-4 | `ANTHROPIC_API_KEY` |
| **OpenRouter** | 200+ models via one key | `OPENROUTER_API_KEY` |
| **Groq** | llama-3.3-70b, mixtral-8x7b | `GROQ_API_KEY` |
| **DeepSeek** | deepseek-chat, deepseek-reasoner | `DEEPSEEK_API_KEY` |
| **Hugging Face** | Llama, Mistral, open-source models | `HF_TOKEN` |
| **Alibaba DashScope** | qwen-max, qwen-plus | `DASHSCOPE_API_KEY` |
| **Kimi / Moonshot** | moonshot-v1-128k | `KIMI_API_KEY` |
| **z.ai / GLM (Zhipu)** | glm-4-plus, glm-4-flash | `GLM_API_KEY` |
| **MiniMax** | abab6.5s-chat | `MINIMAX_API_KEY` |
| **Arcee AI** | arcee-agent | `ARCEEAI_API_KEY` |
| **GMI Cloud** | gmi-default | `GMI_API_KEY` |
| **Tencent TokenHub** | hunyuan-large | `TOKENHUB_API_KEY` |
| **Xiaomi MiMo** | mimo-default | `XIAOMI_API_KEY` |
| **Kilo Code** | kilo-default | `KILOCODE_API_KEY` |
| **LM Studio** | Any local model | No key required |
| **Ollama** | llama3.3, codellama, mistral | No key required |
| **Custom Endpoint** | Any OpenAI-compatible API | Custom URL and key |

---

## Running EterX

```bash
eterx start          # Web app at localhost:3000
eterx desktop        # Desktop app with Electron
eterx telegram       # Telegram bot
```

Or with npm:
```bash
npm run eterx:start
npm run eterx:desktop
npm run eterx:telegram
```

---

## CLI Commands

```bash
# Setup and configuration
eterx setup            # Full setup wizard
eterx config           # Change API keys
eterx add-key          # Add a single key

# Diagnostics
eterx doctor           # System diagnosis
eterx health           # Test configured API keys
eterx benchmark        # Speed-test providers
eterx providers        # List providers and status

# Management
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

## Local Storage

All data is stored locally on your machine.

```text
.workspaces/
├── memory/                  # MemoryV2 persistent storage
│   ├── user_memory.json     # Long-term user facts and preferences
│   ├── project_memory/      # Per-project context
│   ├── session_memory/      # Session continuation data
│   ├── credential_refs.json # Safe vault references without raw keys
│   └── overlays/            # Self-improvement patches
├── dynamic_tools/           # Agent-created tools that persist across restarts
├── config/
│   ├── eterx.config.json    # App settings
│   └── setup-meta.json      # Installation metadata
└── backups/                 # Timestamped config backups
```

---

## Status

Currently under development.

---

## Developer

Built by Harshil Soni.