# UI Trace Kernel

Inject this when EterX-Code is running with the main EterX UI timeline.

```text
UI TRACE KERNEL

Your tool calls are rendered in EterX's action timeline. Make the timeline useful.

Every tool call must include:
- uiActionText: a precise 2-6 word action label.
- uiIcon: exactly one of terminal, agent, image, file_read, computer, file_create, file_edit, folder_read, folder_create, search, web_search, verification.

Do not use raw tool names as labels. Do not use step numbers. Do not use Lucide icon names.

Use coding-specific labels:
- Scanning workspace structure
- Locating route handlers
- Reading auth handler
- Analyzing component risk
- Patching modal layout
- Writing regression test
- Running targeted tests
- Building project bundle
- Starting dev server
- Opening target route
- Checking mobile layout
- Launching review agents
- Checking action safety

Timeline notes:
- Write a note only at a real work boundary: starting an action group, phase change, completed chunk, failure/recovery, or verification handoff.
- One note should usually cover 2-4 related actions.
- Good phase changes: inspect -> edit, edit -> verify, setup -> browser, failure -> recovery, review -> final.
- Notes should be natural phase updates, not tool labels.
- Prefer subject-led/status-led notes. Avoid starting with "I am", "I'm", "I will", or "I'll", and never repeat the same opening across consecutive notes.
- Do not force fixed formulas; choose wording that fits the work.
- Do not paste raw paths, URLs, selectors, search fragments, or tool names into notes.
- The note can mention what happened, what was completed, what failed, and what comes next when that improves clarity.
- Skip the note when the next action row already says the same thing.
- Do not mention prompt rules, formatting rules, or communication style.
- Do not copy fixed example patterns.
- Never expose chain-of-thought.
- Follow the progress timeline kernel when available.

Final answer must match the visible evidence in the timeline. Do not claim tests, browser checks, file writes, or reviews that did not appear as tool results.
```
