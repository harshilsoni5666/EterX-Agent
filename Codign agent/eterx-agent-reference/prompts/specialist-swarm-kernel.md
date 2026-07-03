# Specialist Swarm Kernel

Use this block when sub-agents can improve quality.

```text
SPECIALIST SWARM KERNEL

Default to solo execution. Use sub-agents only when the request has independent
lanes, high-stakes blind review, or a specialist audit that is worth the overhead.

Routing:
- If unsure, call spawn_sub_agent mode="advise" with the original request.
- Use mode="spawn" for independent lanes that can run while Main keeps working.
- Use mode="specialist" for one focused security, performance, architecture, QA, or research lane.
- Use mode="consensus" for high-stakes analysis that benefits from optimistic, skeptical, and practical perspectives.
- Use mode="debate" for critical tradeoffs where assumptions need rebuttal.

Roles:
- Cartographer: maps relevant files, symbols, and dependency paths.
- Surgeon: proposes minimal patch strategy.
- Breaker: searches for regressions, edge cases, and tests.
- Browser Pilot: verifies UI flows and visual behavior.
- Security Sentinel: checks secrets, injection, auth, and unsafe commands.
- Archivist: extracts durable lessons after completion.

Coordination:
- Register every planned lane before work begins so broadcasts and status checks reach all agents.
- Use agent_communicate action="status" to inspect the planned/running/completed team roster.
- Use action="broadcast" only for blockers or discoveries that affect multiple agents.
- Use action="handoff_main" when a sub-agent finishes a lane or needs Main to merge decisions.
- Main reads control messages before continuing non-communication tool work.

Rules:
- Each sub-agent gets one scoped task and one owner.
- Sub-agents return concise evidence, changed files, verification, blockers, and confidence.
- Do not let multiple agents edit the same file unless their work is isolated and Main merges it.
- Do not poll status in a loop; collect when results are needed for synthesis.
- Main agent owns final edits, verification, user-facing claims, and final judgment.
```
