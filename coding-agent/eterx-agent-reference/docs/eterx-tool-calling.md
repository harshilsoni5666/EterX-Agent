# EterX Tool Calling

This file records the practical tool calls EterX-Code should use. The names and argument shapes match the EterX tool registry.

## Workspace Tools

### List Directory

Use this before assuming project structure.

```json
{
  "tool": "workspace_list_directory",
  "arguments": {
    "directory": "."
  }
}
```

`directory` is optional. Use a relative workspace path when possible.

### Read File

```json
{
  "tool": "workspace_read_file",
  "arguments": {
    "filename": "src/app/page.tsx"
  }
}
```

Use `filename` for workspace-relative or absolute paths.

### Search Text

```json
{
  "tool": "workspace_search_text",
  "arguments": {
    "pattern": "function login",
    "directory": "src"
  }
}
```

Use this to find symbols, routes, component names, config keys, tool names, and error strings.

### Edit File

Use exact search text when possible.

```json
{
  "tool": "workspace_edit_file",
  "arguments": {
    "filename": "src/app/page.tsx",
    "edits": [
      {
        "search": "const title = \"Old\";",
        "replace": "const title = \"EterX\";"
      }
    ]
  }
}
```

Use line ranges only when exact search text is not stable enough.

```json
{
  "tool": "workspace_edit_file",
  "arguments": {
    "filename": "src/app/page.tsx",
    "edits": [
      {
        "startLine": 20,
        "endLine": 24,
        "replace": "const enabled = true;"
      }
    ]
  }
}
```

### Write File

Use for new files only. Do not use this tool to update an existing source file; use `workspace_str_replace` or `workspace_apply_patch` instead.

```json
{
  "tool": "workspace_write_file",
  "arguments": {
    "filename": "docs/notes.md",
    "content": "# Notes\n\nEterX reference notes.\n",
    "append": false
  }
}
```

`append` is optional and defaults to false.

### Run Command

Use finite commands with clear working directory.

```json
{
  "tool": "workspace_run_command",
  "arguments": {
    "command": "npm run lint",
    "cwd": ".",
    "timeoutSeconds": 60
  }
}
```

Default timeout is short. Use `process_manager` or `background_task` for long-running servers.

### Verify Code

```json
{
  "tool": "workspace_verify_code",
  "arguments": {
    "checkType": "test",
    "cwd": ".",
    "timeoutSeconds": 120
  }
}
```

Allowed `checkType` values:

- `lint`
- `build`
- `test`

## Verification Tool

Use `realtime_verify` for targeted checks.

```json
{
  "tool": "realtime_verify",
  "arguments": {
    "mode": "file_exists",
    "target": "src/app/page.tsx"
  }
}
```

Useful modes:

- `file_exists`
- `file_content`
- `file_size`
- `command_output`
- `code_syntax`
- `compare_files`
- `port_check`
- `json_valid`
- `html_valid`

Example syntax check:

```json
{
  "tool": "realtime_verify",
  "arguments": {
    "mode": "code_syntax",
    "target": "src/lib/agent/tools/index.ts"
  }
}
```

## Code Intelligence

Use these when the task needs project-level understanding:

- `code_intelligence`: symbol and code relationship analysis.
- `smart_refactor`: structured refactor support.

Example:

```json
{
  "tool": "workspace_file_outline",
  "arguments": {
    "filename": "src/lib/agent/tools/workspaceTool.ts"
  }
}
```

## Skills

When a task maps to a skill, ask for guidelines first.

```json
{
  "tool": "get_skill_guidelines",
  "arguments": {
    "skill_name": "eterx-code-agent"
  }
}
```

## Sub-Agents

Use `spawn_sub_agent` for parallel investigation, review, or independent verification.

```json
{
  "tool": "spawn_sub_agent",
  "arguments": {
    "mode": "spawn",
    "tasks": [
      {
        "name": "api-review",
        "task": "Inspect src/lib/api for likely regressions from the requested change. Return findings with file paths."
      },
      {
        "name": "ui-review",
        "task": "Inspect affected UI components for layout or state bugs. Return findings with file paths."
      }
    ]
  }
}
```

Collect results:

```json
{
  "tool": "spawn_sub_agent",
  "arguments": {
    "mode": "collect"
  }
}
```

The main agent owns the final decision. Sub-agent output is evidence, not automatic truth.

## Browser

Use `browser_control` for UI checks.

Recommended flow:

1. Start or connect to a browser session.
2. Navigate to the local URL.
3. Observe or snapshot the page.
4. Use refs from `observe` or `snapshot` for clicks and typing.
5. Verify visible behavior.

```json
{
  "tool": "browser_control",
  "arguments": {
    "action": "goto",
    "url": "http://localhost:3000"
  }
}
```

```json
{
  "tool": "browser_control",
  "arguments": {
    "action": "snapshot"
  }
}
```

## Git

Use `git_intelligence` for repository reasoning and status summaries. Use `git_operations` for simple repository operations when its workspace mapping fits the task.

For exact current-repo commands, prefer `workspace_run_command` with a clear `cwd`:

```json
{
  "tool": "workspace_run_command",
  "arguments": {
    "command": "git status --short --branch",
    "cwd": ".",
    "timeoutSeconds": 30
  }
}
```

## Common Mapping

| Need | EterX Tool |
| --- | --- |
| Inspect folder | `workspace_list_directory` |
| Read file | `workspace_read_file` |
| Search code | `workspace_search_text` |
| Edit existing file | `workspace_edit_file` |
| Create file | `workspace_write_file` |
| Run shell command | `workspace_run_command` |
| Lint, build, test | `workspace_verify_code` |
| Targeted proof | `realtime_verify` |
| UI check | `browser_control` |
| Skill rules | `get_skill_guidelines` |
| Parallel investigation | `spawn_sub_agent` |
| Memory | `memory_v2` |
| Context pruning | `context_manager` |
