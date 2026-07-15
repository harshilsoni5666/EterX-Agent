# Security Policy

## Overview

EterX-Agent runs locally on your machine and has direct access to your system — it can execute commands, read and write files, control browsers, and call external APIs on your behalf. That level of access is what makes it useful, and it is also why I want to be clear about how to handle security concerns and general issues responsibly.

This document is for anyone who finds a bug, experiences unexpected behavior, or discovers a security vulnerability. Whatever you are dealing with, there is a right place to report it, and I will take it seriously.

## An Honest Note

I will be straightforward: I am a solo developer, and dedicated security hardening has not been a primary focus of this project so far. The guidelines in this document reflect reasonable practices I am aware of, but I have not conducted formal security audits or penetration testing on EterX-Agent.

If you have a security background and you see something I have missed — whether it is a design decision, an unsafe default, or a pattern that could be improved — I genuinely want to hear it. This is not false modesty. If you have recommendations, please reach out. I will read them carefully and take them seriously.

The goal is to build something that people can trust to run on their machines. Getting there requires input from people who know more than I do in certain areas, and I am open to that.

---

## Supported Versions

I maintain only the latest code on the `main` branch. Older versions are not patched or updated.

| Version | Supported |
|---------|-----------|
| Latest (main branch) | Yes |
| All previous versions | No |

If you are on an older version, please update before reporting an issue — it may already be resolved.

---

## Reporting a Bug or General Issue

If something is not working the way you expect, or you have run into a crash, unexpected behavior, or any other problem that is not a security concern, please open a GitHub Issue.

When you open an issue, it helps a lot if you include:

- A description of what happened and what you expected to happen
- The steps that led to the problem
- Your operating system and Node.js version
- Any relevant error messages or logs from the terminal

There is no strict format required. Write it however feels natural — I will follow up if I need more information.

I genuinely appreciate every report. Finding and fixing bugs is a shared effort, and the people who take the time to report them make the project meaningfully better for everyone.

---

## Safe Usage Guidelines

Because EterX operates with elevated system access, how you configure it matters.

### External Inputs

If you connect EterX to a messaging platform like Telegram, treat all incoming messages as untrusted by default. The agent supports a pairing policy (`dmPolicy="pairing"`) that blocks unrecognized senders from issuing commands. I recommend keeping this setting unless you are running in a fully isolated environment.

Avoid setting your policy to open or adding wildcard permissions to public channels unless you fully understand what that grants.

### Multi-User or Remote Deployments

If the agent is accessible by more than one person, or exposed over a network, run it inside an isolated container such as Docker. Keep the environment restrictive — sandboxed sessions should not have access to your host credentials, local file system, or high-privilege commands.

### API Keys and Credentials

API keys are stored locally in `.env.local` or under `%LOCALAPPDATA%\EterX` on Windows. The default `.gitignore` excludes these files, but please verify this before pushing any changes to a public repository.

Never share your `.env.local` file or commit it anywhere.

---

## Reporting a Security Vulnerability

If you believe you have found a security vulnerability — something that could expose user data, allow unauthorized command execution, or be exploited by an attacker — please do not open a public GitHub Issue. Disclosing a vulnerability publicly before a fix exists puts everyone using the project at risk.

Instead, please email me directly at **harshilsoni5666@gmail.com**. I will treat your report with complete confidentiality.

Please include:

- A clear description of the vulnerability
- The steps needed to reproduce it
- What impact it could have — what an attacker could do with it
- Any supporting code, logs, or screenshots if you have them

You do not need to have a full proof of concept or a perfect write-up. If you have found something that looks wrong, reach out and we can figure it out together.

I will acknowledge your email within 48 hours. Depending on the severity, I will either ship a patch directly or share interim guidance while a fix is being prepared. If you would like to be credited in the release notes, just let me know — I am happy to do that.

---

Thank you for helping make EterX-Agent better and safer. Whether it is a bug report or a vulnerability disclosure, I appreciate you taking the time.

Harshil Soni  
Developer, EterX-Agent  
harshilsoni5666@gmail.com
