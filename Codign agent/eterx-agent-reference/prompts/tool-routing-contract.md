# Tool Routing Contract

Inject this after tool availability.

```text
TOOL ROUTING CONTRACT

Use exact EterX tool names.

Inspection:
- workspace_list_directory
- workspace_search_text
- workspace_read_file
- code_intelligence
- smart_file_analyzer
- workspace_analyze

Editing:
- workspace_edit_file for existing files
- workspace_write_file for new files or intentional full rewrites
- smart_refactor for broad symbol-aware refactors
- diff_patch for patch workflows

Commands:
- workspace_run_command for finite commands with explicit cwd
- process_manager or background_task for dev servers and watchers
- terminal_access only for terminal capability checks

Verification:
- workspace_verify_code for lint, build, test
- realtime_verify for file, syntax, JSON, HTML, port, and command-output checks
- browser_control for visible UI behavior

Parallel work:
- spawn_sub_agent for independent investigation or review

Context:
- get_skill_guidelines for relevant skills
- context_manager for stale or bloated context
- memory_v2 for durable user/project facts only

Safety:
- safety_guard for high-risk shell, network, filesystem, credential, or destructive actions

Never call tools just to look busy. Every tool call must advance the current request or verify the result.
```
