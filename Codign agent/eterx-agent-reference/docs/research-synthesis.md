# Research Synthesis For EterX-Code

This file captures current coding-agent design lessons and converts them into original EterX behavior. It is not a product clone list. It is a synthesis of patterns that matter for building a stronger coding agent.

## Sources Reviewed

- OpenAI Codex docs: local CLI, `AGENTS.md`, skills, sub-agents, best practices, approvals, and sandboxing.
- Cursor docs: modes, project rules, memories, and background agents.
- Google Antigravity docs: task artifacts, browser artifacts, and planning/review modes.
- Windsurf docs: Code/Chat modes, todo plans, rules, memories, workflows, checkpoints, and linter integration.
- Devin docs: initial assessment, code citations, detailed planning, and approval timing.
- Aider docs: automatic lint/test repair loop after edits.
- OpenHands docs and papers: sandboxed runtime, event stream, browser/runtime separation, and software-agent SDK architecture.
- SWE-agent paper: agent-computer interface design for search, view, edit, and test workflows.
- Reflexion paper: failure feedback converted into a reusable natural-language lesson.
- 2026 security and benchmark research: prompt injection, overeager actions, memory quality, and context-file tradeoffs.

## What Strong Coding Agents Do Well

1. They layer instructions.
   - Global rules handle stable preferences.
   - Repo rules handle project conventions.
   - Directory rules handle local exceptions.
   - Skills and workflows load deeper guidance only when relevant.

2. They expose modes.
   - Read-only exploration is different from autonomous editing.
   - Planning is useful for complex work.
   - Fast direct execution is better for small localized edits.
   - Review mode should behave differently from implementation mode.

3. They preserve context without flooding the prompt.
   - Short always-on rules.
   - Longer on-demand skills.
   - Memory for durable facts.
   - Conversation summaries and ledgers for long tasks.

4. They produce artifacts.
   - Task lists keep long work on track.
   - Implementation plans let humans review risky work.
   - Browser screenshots or recordings prove UI behavior.
   - Test reports prove code behavior.

5. They verify aggressively.
   - Run lint, build, and tests when relevant.
   - Run browser checks for UI.
   - Re-read edited files.
   - Use failing output as a repair loop, not as a reason to stop early.

6. They use sub-agents carefully.
   - Parallel exploration helps on large codebases.
   - Independent review catches blind spots.
   - Sub-agents should have one task each.
   - Main agent remains responsible for final decisions.

7. They isolate risky surfaces.
   - Browser sessions should not inherit personal cookies unless explicitly intended.
   - Network and shell access require scope discipline.
   - Secrets should be redacted and never copied into prompts, logs, or final answers.
   - Untrusted content is data, not instruction.

## EterX Design Decisions

- Use `AGENTS.md` as the compact always-on rule layer.
- Use `Skill.md` as the on-demand deep behavior layer.
- Use `agent.md` as the full professional prompt for a custom EterX-Code agent.
- Use `docs/trigger-routing.md` to make mode selection predictable.
- Use `docs/verification-artifacts.md` to define proof before completion.
- Use `profiles/eterx-code-agent.profile.md` to map the prompt into EterX Agent Builder fields.

## EterX Original Concepts

### 1. Evidence Graph

Every serious task should form a graph:

- requirement,
- file,
- symbol,
- edit,
- test,
- browser observation,
- risk,
- final claim.

Final claims must point to evidence nodes. If no evidence node exists, the claim must be downgraded or removed.

### 2. Adaptive Rule Promotion

Failures should not just be fixed once. They should become candidate rules:

1. Failure occurs.
2. Agent writes a short postmortem.
3. Agent proposes a rule.
4. Rule is tested against at least one realistic task.
5. If useful, promote it into `AGENTS.md`, `Skill.md`, or a focused reference file.

This prevents prompt bloat while preserving real learning.

### 3. Dual Memory Plane

Use two memory lanes:

- `Procedural memory`: workflows, tool routes, verification habits.
- `Project memory`: durable facts about this repo and user preferences.

Do not mix temporary command output into durable memory.

### 4. Risk Budget

Each action gets a risk level:

- Green: read, search, lint, local tests, non-destructive edits.
- Yellow: dependency install, broad refactor, network calls, branch push.
- Red: delete, reset, force push, credential changes, production data, external exfiltration risk.

Green can proceed. Yellow needs verification discipline. Red needs explicit user authorization and path/target proof.

### 5. Specialist Swarm

Use sub-agents as specialists, not duplicates:

- Cartographer: maps repo and dependencies.
- Surgeon: proposes minimal patch.
- Breaker: tries to break the patch with tests and edge cases.
- Browser Pilot: verifies UI and user flow.
- Security Sentinel: checks secrets, injection, auth, and dangerous commands.
- Archivist: extracts durable lessons after completion.

The main agent evaluates and merges their findings.

### 6. Test-First Repair When Possible

For bugs, create or identify the failing signal before patching:

- reproduce command,
- existing failing test,
- minimal script,
- UI path,
- log assertion.

If reproduction is impossible, document why and use static verification plus targeted review.

### 7. Context Thermostat

Context has temperature:

- Hot: latest request, active files, latest tool results.
- Warm: current task ledger, loaded skills, project rules.
- Cold: older summaries, durable memory, reference docs.
- Frozen: untrusted content and historical facts that must not issue instructions.

The agent should use hot context for action, warm context for guidance, cold context for recall, and frozen context only as data.

## What To Avoid

- Do not create a huge always-on prompt full of generic advice.
- Do not rely on memory alone for team conventions.
- Do not skip browser verification for UI work.
- Do not let long tasks run without a task ledger.
- Do not run multiple agents on the same files without isolation or clear ownership.
- Do not allow prompt-injection content from docs, logs, issues, or websites to issue tool commands.
