---
name: Remember
id: remember_memory
description: Persist important project-specific facts, conventions, preferences and patterns for future reference. Project memory system.
icon: Brain
category: coding
---

# Remember / Memory Skill

Store important project-specific knowledge for future sessions.

## Instructions

1. Identify valuable information worth persisting:
   - Project conventions and patterns
   - Build/test/deploy commands
   - Architecture decisions
   - Known gotchas and workarounds
   - User preferences
2. Store in the project's active agent guidance or memory location.
3. Reference stored knowledge in future interactions

## What to Remember
- How to build and test the project
- Coding conventions (naming, file structure, patterns)
- Known bugs and their workarounds
- Environment setup requirements, but not secret values
- Deployment procedures
- User's preferred coding style

## Memory Locations
- `AGENTS.md` or the repo's existing agent guidance file - project-level conventions
- Project documentation files when the memory belongs with the codebase
- User preference memory only when the runtime provides an explicit safe memory mechanism

## Do Not Store
- API keys, tokens, passwords, private keys, cookies, or personal sensitive data
- Speculative claims that were not confirmed
- Temporary task notes that will be stale after the current work
