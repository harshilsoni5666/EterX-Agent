<p align="center">
  <img src="./banner.png" width="100%">
</p>

<h1 align="center">EterX-Agent </h1>

<p align="center">
 The seamless self-improving ,   Al agent built by Harshil Soni. It has built-in learning loop it can create skills , or use diffrent skills, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and understands who and what are you patterns and likings , And how do you work? or How do you expect the work!  Run it on a custom EterX-App made for it with proffesional ui and all connection .It  costs nearly nothing except your api. It's not tied to your laptop talk to it from Telegram while it works on a anything.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DOCS-ETERX--AGENT-black?style=for-the-badge">
  <img src="https://img.shields.io/badge/LICENSE-MIT-green?style=for-the-badge">
  <img src="https://img.shields.io/badge/STATUS-ACTIVE-blueviolet?style=for-the-badge">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/BUILT%20BY-HARSHIL%20SONI-purple?style=for-the-badge">

</p>

---

## 🚀 About EterX Agent

EterX-Agent is a  AI agent system focused on intelligent task execution, memory persistence, autonomous workflows, and scalable AI infrastructure.

It is designed to operate as a AI assistant capable of learning, adapting, and improving continuously.

---

##  Usage

- Just when after installation , add you api's in api box of app .
- Test check/skip (API)
- Ask anything ...
- Share anything...
- Hand over tasks...
- And get better results day by day...

---

## 🛠 Installation

### One-Command Install

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.ps1 | iex
```

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/harshilsoni5666/EterX-agent-/main/install.sh | bash
```

The installer automatically handles everything — Node.js, Git, dependencies, API key configuration, local storage, desktop shortcuts, and launches EterX when done.

### Manual Install

```bash
git clone https://github.com/harshilsoni5666/EterX-agent-.git
cd EterX-agent-
node setup.js
```

The interactive setup wizard will walk you through:

1. **System detection** — checks Node.js, Git, OS, disk space
2. **Dependency installation** — runs `npm install` automatically
3. **Model provider selection** — choose from 19 supported providers
4. **API key entry** — masked input, multi-key load-balancing for Gemini
5. **Service integrations** — Tavily search, Telegram bot, Slack
6. **Environment generation** — writes `.env.local` with all your keys
7. **Local storage setup** — creates memory, config, and tool directories
8. **System integration** — desktop shortcut, Start Menu, global `eterx` CLI command
9. **Health check** — validates every API key actually works
10. **Launch** — choose Web App, Desktop (Electron), or Telegram Bot

---

## 🧠 Supported Model Providers

| Provider | Models | Key |
|----------|--------|-----|
| **Google Gemini** | gemini-2.5-flash, gemini-2.5-pro | `GEMINI_API_KEY` (supports 30-key load balancing) |
| **OpenAI** | gpt-4.1, o3, o4-mini, codex-mini | `OPENAI_API_KEY` |
| **Anthropic** | claude-sonnet-4, claude-opus-4 | `ANTHROPIC_API_KEY` |
| **OpenRouter** | 200+ models via one key | `OPENROUTER_API_KEY` |
| **Groq** | llama-3.3-70b, mixtral-8x7b | `GROQ_API_KEY` |
| **DeepSeek** | deepseek-chat, deepseek-reasoner | `DEEPSEEK_API_KEY` |
| **Hugging Face** | Llama, Mistral, open-source | `HF_TOKEN` |
| **Alibaba (DashScope)** | qwen-max, qwen-plus | `DASHSCOPE_API_KEY` |
| **Kimi / Moonshot** | moonshot-v1-128k | `KIMI_API_KEY` |
| **z.ai / GLM (Zhipu)** | glm-4-plus, glm-4-flash | `GLM_API_KEY` |
| **MiniMax** | abab6.5s-chat | `MINIMAX_API_KEY` |
| **Arcee AI** | arcee-agent | `ARCEEAI_API_KEY` |
| **GMI Cloud** | gmi-default | `GMI_API_KEY` |
| **Tencent TokenHub** | hunyuan-large | `TOKENHUB_API_KEY` |
| **Xiaomi MiMo** | mimo-default | `XIAOMI_API_KEY` |
| **Kilo Code** | kilo-default | `KILOCODE_API_KEY` |
| **LM Studio** | Any local model | No key needed |
| **Ollama** | llama3.3, codellama, mistral | No key needed |
| **Custom Endpoint** | Any OpenAI-compatible API | Your URL + key |

---

## ⚡ Running EterX

```bash
eterx start          # Web app at localhost:3000
eterx desktop        # Desktop app (Electron)
eterx telegram       # Telegram bot
```

Or with npm:
```bash
npm run eterx:start
npm run eterx:desktop
npm run eterx:telegram
```

---

## 🔧 CLI Commands

```bash
# Setup & Configuration
eterx setup            # Full setup wizard
eterx config           # Change API keys
eterx add-key          # Quick-add a single key

# Diagnostics
eterx doctor           # Deep system diagnosis (30+ checks)
eterx health           # Test all API keys live
eterx benchmark        # Speed-test all providers
eterx providers        # List all providers & status

# Management
eterx status           # View config & update status
eterx upgrade          # Pull latest + reinstall
eterx backup           # Backup config & memory
eterx restore          # Restore from backup
eterx repair           # Fix broken install
eterx logs             # View setup & runtime logs
eterx env              # Show environment variables (masked)
eterx clean            # Clear caches & temp files
eterx uninstall        # Remove EterX
```

---

## 📁 Local Storage

All data is stored locally on your machine — nothing is sent to any cloud.

```
.workspaces/
├── memory/                  # MemoryV2 persistent storage
│   ├── user_memory.json     # Long-term user facts & preferences
│   ├── project_memory/      # Per-project context
│   ├── session_memory/      # Session continuation data
│   ├── credential_refs.json # Safe vault references (no raw keys)
│   └── overlays/            # Self-improvement patches
├── dynamic_tools/           # Agent-created tools (persist across restarts)
├── config/
│   ├── eterx.config.json    # App settings
│   └── setup-meta.json      # Installation metadata
└── backups/                 # Timestamped config backups
```

---

## 🔌 Integrations

| Platform | Description |
|----------|-------------|
| **Telegram** | Full bot integration — talk to EterX from anywhere |
| **Slack** | Workspace connector |
| **Tavily** | Web search for agent research (free tier: 1000/month) |
| **Electron** | Native desktop app with custom titlebar |
| **Browser** | Web interface at localhost:3000 |

---

## 📌 Status

🚧 Currently Under Development

---

## 👨‍💻 Developer

Built by Harshil Soni
