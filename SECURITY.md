# Security Policy

## Overview

EterX-Agent is a locally-running autonomous agent that has direct access to your system — it can execute commands, read and write files, control browsers, and interact with APIs on your behalf. Because of that level of access, security is something I take seriously.

This document explains what versions are supported, how to safely configure the agent, and how to privately report any vulnerabilities you find.

---

## Supported Versions

I actively maintain only the latest code on the `main` branch. Older snapshots and previous branches are not patched.

| Version | Supported |
|---------|-----------|
| Latest (main branch) | Yes |
| All previous versions | No |

If you are running an older version, update to the latest before reporting a bug or vulnerability.

---

## Safe Usage Guidelines

EterX has a lot of system-level access by design. That makes it powerful, but it also means you should be deliberate about how you set it up.

### External Inputs

If you connect EterX to a messaging platform like Telegram, treat every incoming message as untrusted input by default. The agent supports a pairing policy (`dmPolicy="pairing"`) that blocks unknown senders from issuing commands. Do not change this to an open policy unless you are running in a fully isolated environment and understand the risk.

Do not add wildcard (`*`) permissions to public channels or group chats under normal use.

### Multi-User or Remote Deployments

If more than one person is sending requests to the agent, or if the agent is exposed over a network, run it inside an isolated environment such as a Docker container. Keep the sandbox configuration restrictive — in particular, avoid giving sandboxed sessions access to your host credentials, local file system, or high-privilege shell commands.

### API Keys and Credentials

API keys are stored locally in `.env.local` or under `%LOCALAPPDATA%\EterX` on Windows. These files are already excluded from git via the default `.gitignore`, but double-check before committing if you have made any local changes to the ignore rules.

Never share or publish your `.env.local` file.

---

## Reporting a Vulnerability

If you find a security issue in EterX-Agent, please do not open a public GitHub issue. Public issues expose the vulnerability before a fix is ready, which puts other users at risk.

Instead, send me a private email at **harshilsoni5666@gmail.com** with the following information:

- A clear description of the vulnerability
- Steps to reproduce it
- The potential impact or what an attacker could do with it
- Any proof-of-concept code or screenshots if relevant

I will respond within 48 hours to acknowledge the report. Depending on severity, I will either push a patch directly or provide interim mitigation guidance while a proper fix is prepared.

I do not currently have a formal bug bounty program, but I will credit you in the release notes if you want to be acknowledged.

---

Harshil Soni  
Developer, EterX-Agent  
harshilsoni5666@gmail.com
