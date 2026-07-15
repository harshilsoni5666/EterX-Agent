# EterX-Agent

<p align="center">
  <a href="./README.md">README</a> &nbsp;•&nbsp;
  <a href="./INSTALL.md">Install</a> &nbsp;•&nbsp;
  <b>Security</b> &nbsp;•&nbsp;
  <a href="./LICENSE">License</a>
</p>

---

## Security Policy

We take the security of EterX-Agent seriously. As a locally-running autonomous agent with system execution capabilities, maintaining safe default configurations and a secure operating environment is our highest priority.

### Supported Versions

Only the latest version of EterX-Agent on the `main` branch is actively supported with security updates and bug fixes.

| Version | Supported |
| ------- | --------- |
| Current (main) | 🟢 Yes |
| All older versions | 🔴 No |

---

## Safety & Execution Guidelines

EterX-Agent features a capability-based architecture designed to protect your host system. However, because it can run commands and automate browser/OS tasks, please observe the following security guidelines:

### 1. External Inputs as Untrusted
When EterX is integrated with communication channels (like Telegram, Slack, or WhatsApp), treat inbound messages as **untrusted inputs**. 
* **DM Pairing:** By default, EterX operates under a pairing policy (`dmPolicy="pairing"`). Unknown senders cannot execute commands or query the agent without explicit authorization.
* **Avoid Open Access:** Do not set your default DM policy to `"open"` or add wildcard (`"*"`) permissions to public channels unless the agent is running in a fully isolated sandbox.

### 2. Sandbox Configurations
If you deploy EterX to handle requests in group chats or allow multi-user access:
* Configure non-main sessions to run inside isolated sandboxes (such as Docker or safe virtual environments).
* Keep sandbox policies restrictive. By default, restrict access to host file editing, local credential access, and high-privilege commands.

### 3. API Key Management
* API keys are stored locally on your machine in `.env.local` or under `%LOCALAPPDATA%\EterX` (on Windows). 
* Never commit `.env.local` or memory directories (`.workspaces`) to git. A default `.gitignore` is provided to prevent accidental exposure.

---

## Reporting a Vulnerability

If you discover a security vulnerability in EterX-Agent, please **do not open a public issue**. Instead, report it privately to the maintainers:

* **Email:** Send a detailed report to **harshilsoni5666@gmail.com**.
* **Content:** Please include a detailed description of the vulnerability, steps to reproduce, and any potential impact or proof of concept.

We will acknowledge receipt of your vulnerability report within 48 hours and work to provide a patch or mitigation guidelines as quickly as possible.
