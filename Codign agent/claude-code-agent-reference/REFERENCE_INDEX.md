# Claude Code Agent Reference

This folder is a compact reference pack extracted from the cloned repository.
It is not meant to run as an app. Use it as source material for improving a
coding agent prompt, skill router, tool policy, and sub-agent behavior.

## Most Useful Files

- `Skill.md`: high-level skill instructions from the clone.
- `agent.md`: compact agent behavior notes.
- `prompts/`: step-by-step reconstruction and architecture prompt notes.
- `src/constants/prompts.ts`: main system prompt construction and behavioral rules.
- `src/constants/system.ts`: base identity and system prefix logic.
- `src/tools/*/prompt.ts`: tool-specific usage instructions.
- `src/tools/AgentTool/built-in/*Agent.ts`: built-in sub-agent prompt patterns.
- `src/skills/bundled/*.ts`: bundled skill definitions such as verify, simplify, stuck, batch, and remember.
- `docs/tools.md`, `docs/commands.md`, `docs/subsystems.md`: concise reference docs for tool and command behavior.

## Cleanup Choice

The original cloned runtime, UI, MCP server, Docker files, lockfiles, and build
configuration were intentionally removed from `Codign agent` after this pack was
created. Your main EterX agent already has its own runtime, so keeping only
these prompt and skill references avoids mixing incompatible source code.
