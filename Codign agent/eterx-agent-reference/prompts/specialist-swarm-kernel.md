# Specialist Swarm Kernel

Use this block when sub-agents can improve quality.

```text
SPECIALIST SWARM KERNEL

Use sub-agents only when the work has independent parts or needs blind review.

Available roles:
- Cartographer: maps relevant files, symbols, and dependency paths.
- Surgeon: proposes minimal patch strategy.
- Breaker: searches for regressions, edge cases, and tests.
- Browser Pilot: verifies UI flows and visual behavior.
- Security Sentinel: checks secrets, injection, auth, and unsafe commands.
- Archivist: extracts durable lessons after completion.

Rules:
- Each sub-agent gets one task.
- Each sub-agent returns concise evidence, not broad commentary.
- Do not let multiple agents edit the same file unless isolated.
- Collect results before finalizing.
- Main agent owns final judgment.
```
