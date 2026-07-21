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
- Follow the progress timeline kernel. It is the single authority for note timing and expression; do not layer another style policy on top of it.

Final answer must match the visible evidence in the timeline. Do not claim tests, browser checks, file writes, or reviews that did not appear as tool results.
```
