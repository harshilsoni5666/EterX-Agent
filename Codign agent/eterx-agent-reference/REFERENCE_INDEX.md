# EterX-Code Reference Index

## Recommended Load Order

1. `AGENTS.md`
   - Always-on compact rules for any EterX coding run.

2. `agent.md`
   - Main professional prompt for the EterX-Code agent.

3. `docs/trigger-routing.md`
   - Selects mode, tools, skills, verification, and sub-agents from the user's request.

4. `docs/eterx-tool-calling.md`
   - Exact EterX tools and argument shapes.

5. `docs/verification-artifacts.md`
   - Completion proof contract.

6. `Skill.md`
   - Skill-format version for reusable loading.

7. `profiles/eterx-code-agent.profile.md`
   - Agent Builder blueprint.

8. `profiles/eterx-code-agent.profile.json`
   - Machine-readable profile blueprint using the EterX Agent Builder shape.

9. `docs/next-gen-agent-architecture.md`
   - Evidence graph, memory planes, specialist swarm, safety, evals.

10. `docs/adaptive-learning-loop.md`
    - How failures become tested rule candidates.

11. `docs/eval-playground.md`
    - How to evaluate and improve the agent.

12. `docs/safety-model.md`
    - Trust boundaries and action risk levels.

13. `docs/implementation-roadmap.md`
    - Phased path to turn this reference into runtime behavior.

14. `docs/original-design-principles.md`
    - EterX-specific principles that go beyond imitation.

15. `docs/ui-trace-contract.md`
    - Work notes, action rows, icons, file previews, console cards, browser evidence, and sub-agent timeline behavior.

16. `docs/work-note-style.md`
    - Main-agent-style work note rules adapted for professional coding tasks.

## Prompt Blocks

- `prompts/current-request-guard.md`
  - Prevents old memory or prior tasks from hijacking the current request.

- `prompts/tool-routing-contract.md`
  - Compact tool usage policy for runtime injection.

- `prompts/review-and-verification-gates.md`
  - Done criteria and failure recovery.

- `prompts/eterx-code-professional-prompt.md`
  - A single injection-ready prompt assembled from the main design.

- `prompts/frontier-autonomy-kernel.md`
  - Safe autonomy, risk levels, and long-task continuation behavior.

- `prompts/evidence-graph-kernel.md`
  - Proof-backed final-answer discipline.

- `prompts/specialist-swarm-kernel.md`
  - Sub-agent role routing and collection rules.

- `prompts/ui-trace-kernel.md`
  - Runtime block for clean EterX action timeline rendering.

- `prompts/work-note-kernel.md`
  - Runtime block for sparse, professional coding work notes.

## Eval Files

- `evals/sample-evals.json`
  - Starter scenarios for stale-name cleanup, UI browser proof, and unsafe-command traps.

## Design Position

This pack should make EterX-Code behave like an autonomous engineering teammate:

- fast on small tasks,
- careful on complex changes,
- evidence-driven before final claims,
- strict about scope,
- strong at UI/browser verification,
- strong at independent review,
- safe around shell, secrets, and untrusted content.
