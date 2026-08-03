# Slack Manager Autonomous Agent (`eterxagent-1999-slac`) — Setup & Operational Guide

## Overview
The Advanced Slack Manager Autonomous Agent (`eterxagent-1999-slac`) has been successfully architected, configured, and stored in the EterX agent registry.

## Configuration Files
- **Agent Profile JSON:** `.workspaces/agent-builder/agents/eterxagent-1999-slac.json`
- **Agent Profile Summary:** `.workspaces/agent-builder/agents/eterxagent-1999-slac.profile.json`

## Attached Capabilities & Tools
1. **`slack_controller`**: Full integration for reading channels, searching messages, posting updates, and managing threads.
2. **`workspace_read_file` / `workspace_write_file`**: For reading configuration templates and saving audit reports.
3. **`web_search`**: For referencing Slack API updates and integration guides.

## How to Initialize and Use
1. **In EterX Chat:** Select the **Slack Manager** agent from the agent selector or activate it with ID `eterxagent-1999-slac`.
2. **Environment Variables / Slack Credentials:** Ensure your Slack Bot Token (`SLACK_BOT_TOKEN` or `xoxb-...`) is configured in your environment or Slack integration settings.
3. **Example Prompts to Run:**
   - *"Summarize the last 50 messages in `#engineering` and generate an executive report."*
   - *"Audit active Slack channels and save a summary report to `slack_audit.md`."*
   - *"Send a status notification to `#general` regarding scheduled system maintenance."*
