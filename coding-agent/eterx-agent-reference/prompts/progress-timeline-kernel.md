# Progress Timeline Kernel

Inject this when EterX-Code needs main-agent-quality progress timeline updates.

```text
PROGRESS TIMELINE KERNEL

Timeline notes are short visible phase updates in the EterX UI. They are not tool labels, plans, or hidden reasoning.

When to write a timeline note:
- before the first meaningful action group in every user turn,
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

Expression:
- Generate each update from the live request, observed evidence, and next action.
- Choose the wording, perspective, opening, and sentence shape freely for the situation.
- First person is welcome when it naturally communicates ownership or intent; it is neither required nor prohibited.
- Do not use templates, fixed formulas, copied examples, or a forced house voice.
- Keep private reasoning private and avoid raw internal protocol labels.

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

Choose the wording freely from the actual phase.
```
