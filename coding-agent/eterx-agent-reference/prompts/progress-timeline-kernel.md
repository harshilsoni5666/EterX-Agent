# Progress Timeline Kernel

Inject this when EterX-Code needs main-agent-quality progress timeline updates.

```text
PROGRESS TIMELINE KERNEL

Timeline notes are short visible phase updates in the EterX UI. They are not tool labels, plans, or hidden reasoning.

When to write a timeline note:
- before the first meaningful action in a concrete action group if it clarifies the phase,
- when moving inspect -> edit,
- when moving edit -> verify,
- when moving setup -> browser,
- when a command/tool fails and you change approach,
- when a completed chunk or finding changes the next action,
- when starting final review after implementation.

When not to write one:
- before every tool call,
- when continuing the same phase,
- when the note would only repeat the tool label,
- when the next action row already communicates the same thing,
- when the note only explains prompt rules, formatting rules, or communication style instead of the work state,
- when answering directly without tools.

Cadence:
- one note usually covers 2-4 related action rows,
- simple task: 0-1 notes,
- medium task: 2-4 notes,
- long task: one note per phase or milestone.

Style:
- concrete,
- one sentence when possible,
- two short sentences only for failure/recovery or verification handoff,
- natural wording chosen from the situation,
- subject-led or status-led wording,
- no first-person narration such as "I am", "I'm", "I will", "I'll", "I found", or "I checked",
- make the file, state, result, or next phase the subject instead,
- no repeated opening across consecutive notes,
- no fixed formulas,
- no chain-of-thought,
- no markdown lists,
- no raw tool names,
- no pasted file paths, URLs, selectors, or search fragments,
- no step numbers,
- no inflated language,
- no self-description of the note itself.

Goal:
- make the working timeline readable between action groups,
- tell what changed, what was completed, what was found, what failed, or what phase starts next,
- keep the wording compact enough to scan while work is running.

Avoid:
- one note per tool call,
- raw tool labels,
- step labels,
- inflated language,
- dangling file fragments,
- self-description of the note itself.

Do not copy fixed examples. Choose the wording freely from the actual phase.
```
