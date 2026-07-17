# EterX-Code UI Trace Contract

EterX renders agent work through a professional timeline. The coding agent should make that timeline readable by using clear timeline notes, action labels, icon categories, file previews, console outputs, browser evidence, and sub-agent events.

## UI Event Surfaces

EterX currently shows these surfaces:

- Timeline notes: natural-language phase updates.
- Thought blocks: collapsible reasoning summaries.
- Action rows: grouped tool calls with icon, verb, secondary target, and optional file link.
- File preview cards: created or edited files, with diff stats when available.
- Console output cards: command output, exit code, duration.
- Browser/progress rows: browser and UI automation status.
- Sub-agent panels: spawned agents, actions, results, and errors.
- Monitor stream: tools, desktop/browser/terminal/files/thoughts/timeline.
- Workspace review editor: changed file cards and diffs.

The prompt should feed these surfaces intentionally.

## Required Tool Metadata

Every tool call should include:

```json
{
  "uiActionText": "Reading auth handler",
  "uiIcon": "file_read"
}
```

Allowed `uiIcon` values:

- `terminal`
- `agent`
- `image`
- `file_read`
- `computer`
- `file_create`
- `file_edit`
- `folder_read`
- `folder_create`
- `search`
- `web_search`
- `verification`

Do not use Lucide icon names. Do not use step numbers. Do not write punctuation-heavy labels.

## Timeline Note Rules

Timeline notes should be sparse and useful.

Good cadence:

- one note before a new phase,
- usually one note for 2-4 related action rows,
- around 25-35 percent of action turns,
- phase changes only: inspect -> edit, edit -> verify, setup -> preview, failure -> recovery, research -> implementation.

Good notes:

```text
The settings modal path is identified; the component and styles come before the layout patch.
```

```text
The edit is in place; targeted UI checks and the browser route come next.
```

Bad notes:

```text
Reading file.
```

```text
Step 3: Execute workspace_read_file.
```

```text
Executing a deep autonomous coding operation.
```

For the full coding-agent timeline-note style, use `docs/timeline-note-style.md` and `prompts/progress-timeline-kernel.md`.

## Coding Action Labels

Use labels that read well in the action chip. Keep them 2-6 words.

| Task | `uiActionText` | `uiIcon` |
| --- | --- | --- |
| list repo | `Scanning workspace structure` | `folder_read` |
| search code | `Locating route handlers` | `search` |
| read source | `Reading auth handler` | `file_read` |
| analyze file | `Analyzing component risk` | `search` |
| edit file | `Patching modal layout` | `file_edit` |
| create file | `Writing regression test` | `file_create` |
| run test | `Running targeted tests` | `verification` |
| build | `Building project bundle` | `verification` |
| lint | `Running lint checks` | `verification` |
| command | `Checking git status` | `terminal` |
| start server | `Starting dev server` | `terminal` |
| browser route | `Opening settings route` | `computer` |
| browser inspect | `Checking mobile layout` | `computer` |
| image asset | `Finding product image` | `image` |
| sub-agents | `Launching review agents` | `agent` |
| safety | `Checking action safety` | `verification` |
| checkpoint | `Saving task checkpoint` | `computer` |
| memory | `Updating project memory` | `file_create` |

## Mode-Specific Timeline Patterns

### Inspect Mode

Timeline note:

```text
The feature needs a quick map before claims, so the owning files come first.
```

Actions:

- `Scanning workspace structure` / `folder_read`
- `Searching feature entrypoints` / `search`
- `Reading owner component` / `file_read`
- `Analyzing code relationships` / `search`

### Agent Edit Mode

Timeline note:

```text
The implementation path is clear; the smallest patch comes before affected checks.
```

Actions:

- `Patching feature logic` / `file_edit`
- `Writing regression test` / `file_create`
- `Running targeted tests` / `verification`
- `Checking final diff` / `terminal`

### Debug Repair Mode

Timeline note:

```text
The failure is reproducible; the failing path comes before code changes.
```

Actions:

- `Running failing check` / `terminal`
- `Reading error path` / `file_read`
- `Patching root cause` / `file_edit`
- `Rerunning failing check` / `verification`

### UI Build Mode

Timeline note:

```text
The UI change is implemented; the app and browser route check come next.
```

Actions:

- `Starting dev server` / `terminal`
- `Verifying local port` / `verification`
- `Opening target route` / `computer`
- `Checking desktop layout` / `computer`
- `Checking mobile layout` / `computer`

### Review Mode

Timeline note:

```text
Changed files come first so the review stays grounded in the actual diff.
```

Actions:

- `Checking branch diff` / `terminal`
- `Reading changed file` / `file_read`
- `Launching review agents` / `agent`
- `Auditing verification gaps` / `verification`

## File Preview Discipline

File cards become useful when the agent uses the file tools correctly:

- Use `workspace_write_file` for new files with complete content.
- Use `workspace_edit_file` for edits so diffs can render.
- Set `uiActionText` to the purpose, not the tool name.
- Re-read or verify significant file edits before finalizing.

Good:

```json
{
  "filename": "src/components/settings-modal.tsx",
  "edits": [
    {
      "search": "className=\"modal-row\"",
      "replace": "className=\"modal-row min-w-0 flex-wrap\""
    }
  ],
  "uiActionText": "Patching modal layout",
  "uiIcon": "file_edit"
}
```

## Console Output Discipline

Commands should produce useful console cards:

- finite command,
- explicit `cwd`,
- timeout for slow checks,
- label reflects the verification goal.

Good:

```json
{
  "command": "npm run lint",
  "cwd": ".",
  "timeoutSeconds": 120,
  "uiActionText": "Running lint checks",
  "uiIcon": "verification"
}
```

## Browser Evidence Discipline

For browser work:

- use one browser action at a time,
- navigate or snapshot before interacting,
- use visible route names in `uiActionText`,
- verify after interaction,
- use desktop and mobile checks when layout changed.

Good labels:

- `Opening dashboard route`
- `Checking empty state`
- `Testing save button`
- `Checking mobile toolbar`

## Sub-Agent Timeline Discipline

When spawning agents:

- use `uiIcon: "agent"`,
- label the role or phase,
- give each sub-agent a focused task,
- collect before final.

Good:

```json
{
  "mode": "spawn",
  "tasks": [
    {
      "name": "breaker",
      "task": "Review the changed auth files for regressions and missing tests. Return concrete findings with file paths only."
    }
  ],
  "uiActionText": "Launching review agents",
  "uiIcon": "agent"
}
```

## Final Answer Relation

The final answer should match the visible timeline:

- if the timeline shows tests, say which tests ran,
- if the timeline shows browser checks, mention route and viewport,
- if a check failed, mention it,
- if a file card was created/edited, mention the file,
- do not claim invisible work.
