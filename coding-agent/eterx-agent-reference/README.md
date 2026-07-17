# EterX-Code Agent Reference Pack

This folder contains a clean, EterX-only design for a next-generation coding agent. It is a prompt, rule, routing, and tool contract pack. It is not copied runtime source from another product.

The design is based on patterns used by strong modern coding agents:

- Layered instructions instead of one vague prompt.
- Short always-on rules plus deeper on-demand references.
- Agent modes for answer, inspect, edit, debug, review, and long-task work.
- Task artifacts: plan, task ledger, implementation notes, verification report, and browser evidence.
- Tool routing that maps each coding action to exact EterX tools.
- Sub-agents for parallel exploration and independent review.
- Verification gates before claiming success.
- Safety boundaries for shell, browser, filesystem, secrets, and prompt injection.

## Main Files

- `agent.md`: Full EterX-Code professional prompt. This is the main one-shot agent identity.
- `AGENTS.md`: Short always-on repository instruction file for coding agents.
- `Skill.md`: EterX skill file version of the coding agent behavior.
- `profiles/eterx-code-agent.profile.md`: Agent Builder profile blueprint and tool attachment list.
- `profiles/eterx-code-agent.profile.json`: Machine-readable EterX Agent Builder profile blueprint.
- `docs/trigger-routing.md`: How user requests map to mode, tools, skills, and sub-agents.
- `docs/eterx-tool-calling.md`: Exact EterX tool names and call shapes.
- `docs/verification-artifacts.md`: What proof the agent should produce before completion.
- `docs/research-synthesis.md`: Design lessons from current coding-agent systems.
- `docs/next-gen-agent-architecture.md`: Original EterX-Code architecture with evidence graph, specialist swarm, and learning loop.
- `docs/adaptive-learning-loop.md`: Failure-to-rule promotion workflow.
- `docs/eval-playground.md`: Local behavior eval design.
- `docs/safety-model.md`: Trust boundaries and risk controls.
- `docs/implementation-roadmap.md`: Phased plan to wire this into the actual EterX runtime.
- `docs/original-design-principles.md`: EterX-specific principles for a better-than-copy agent.
- `docs/ui-trace-contract.md`: Coding-agent timeline notes, action labels, icons, file previews, console cards, browser evidence, and sub-agent timeline rules.
- `docs/timeline-note-style.md`: Main-agent-style timeline-note guidance adapted for coding work.
- `prompts/`: Injection-ready prompt blocks for the main EterX runtime.
- `evals/`: Starter behavioral evals for improving the agent.

## Keep This Pack Small

Do not add vendor runtimes, install scripts, unrelated app source, or copied UI shells here. This pack should remain a high-quality prompt and operating contract for EterX-Code.

## Safety Boundary

Only edit this `coding-agent` reference folder unless the user explicitly asks for app source changes.
