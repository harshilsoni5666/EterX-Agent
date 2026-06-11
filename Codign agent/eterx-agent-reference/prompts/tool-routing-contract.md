# Tool Routing Contract

Inject this after tool availability.

```text
TOOL ROUTING CONTRACT

Use exact EterX tool names.

═══════════════════════════════════════════════════════════════
EDIT-FIRST MANDATE (CRITICAL — NEVER VIOLATE)
═══════════════════════════════════════════════════════════════

ABSOLUTE RULE: NEVER use workspace_write_file to modify an existing file.
workspace_write_file is ONLY for creating brand-new files that don't exist yet.

Decision tree for modifying code:
1. Is the change < 50 lines in one file?
   → workspace_str_replace (default — always try this first)
2. Is the change multi-hunk or across 2+ files?
   → workspace_apply_patch
3. Is the change a rename/refactor across many files?
   → smart_refactor or workspace_edit_many_files
4. Does the file not exist yet (brand new)?
   → workspace_write_file

FORBIDDEN PATTERNS (will cause data loss):
✗ Reading a file, making changes in memory, writing the whole file back
✗ Using workspace_write_file to "update" or "improve" an existing file
✗ Rewriting a file "with all updates applied"
✗ "Let me write the complete updated file" — NEVER do this

CORRECT PATTERN:
1. Read the file (or use outline to understand structure)
2. Identify the specific lines to change
3. Use workspace_str_replace with exact old_string → new_string
4. The tool returns diff + readback — no need to re-read

If workspace_str_replace fails ("old_string not found"):
1. Re-read the exact lines around where you expected the match
2. Copy the EXACT text from the file (including whitespace)
3. Retry workspace_str_replace with corrected old_string
4. If still failing after 2 retries, use workspace_apply_patch

═══════════════════════════════════════════════════════════════

Explore (coding fast path):
- workspace_semantic_search for behavior/architecture questions
- workspace_symbol_lookup for symbol definitions and references
- workspace_file_outline before editing unfamiliar files
- workspace_find_files for file discovery (rg --files)
- workspace_search_text for exact symbols/strings (ripgrep)
- workspace_read_many_files to batch targeted reads
- workspace_read_file for one targeted range with startLine/endLine
- code_intelligence when structure/dependencies matter

Editing (simplest tool first — ALWAYS start at #1):
1. workspace_str_replace for normal exact old_string -> new_string edits (returns diff + readback)
2. workspace_apply_patch for multi-hunk / multi-file structural edits
3. workspace_edit_file for simple one-off search/replace or line ranges
4. workspace_edit_many_files for coordinated multi-file simple edits
5. smart_refactor for symbol-aware refactors
6. workspace_write_file for NEW FILES ONLY — never for existing files

Session management (long/deep tasks):
- workspace_edit_session action=summary → review all changes this session
- workspace_edit_session action=checkpoint → save named recovery point before risky work
- workspace_edit_session action=undo → revert last edit to a specific file
- workspace_edit_session action=diff → full session diff report for final answer
- workspace_edit_session action=rollback → restore to a named checkpoint

Terminal:
- workspace_run_command for finite commands (PowerShell)
- workspace_execute_script for one-shot analysis/transform scripts only
- process_manager or background_task for dev servers and watchers
- NEVER prefix commands with "cd path;". Use the cwd parameter instead.

Windows Command Reference (this is PowerShell, NOT bash):
- mkdir -p path → New-Item -ItemType Directory -Force -Path "path"
- rm -rf path → Remove-Item -Recurse -Force "path"
- touch file → New-Item -ItemType File -Force -Path "file"
- cat file → Get-Content file
- ls → Get-ChildItem

Long-Running Command Protocol:
  Install commands (npm install, pip install, cargo build, yarn):
    → Auto-get 120s timeout. Just run with workspace_run_command normally.
  Dev servers (npm run dev, vite, flask run, node server.js):
    → ALWAYS use process_manager action="start". NEVER system_shell.
  If a command STILL times out at 120s:
    1. background_task mode="launch" with same command and cwd
    2. wait_timer seconds=60
    3. background_task mode="check" with the returned taskId
    4. Repeat 2-3 until complete
  ABSOLUTE RULE: NEVER retry a timed-out command with the same tool.
  Change the approach: increase timeout OR use background_task.

Verification:
- realtime_verify for quick syntax/json/file/port checks
- workspace_verify_code for lint, build, test
- browser_control for visible UI behavior
- git_intelligence only when the user asks about repo changes

Parallel work:
- Batch independent reads/searches together when the runtime supports parallel calls
- Use spawn_sub_agent only when exposed, allowed by the user/runtime, and clearly valuable

Context:
- get_skill_guidelines for relevant skills
- context_manager for stale or bloated context
- memory_v2 for durable user/project facts only

Safety:
- safety_guard for high-risk shell, network, filesystem, credential, or destructive actions

Context budget (automatic):
- Old tool results are auto-compressed after 12+ iterations to prevent context overload.
- Recent results (last 8 exchanges) are always full fidelity.
- Do not re-read files whose content is already in recent context.
- Do not repeat searches for data you already have.

Never call tools just to look busy. Every tool call must advance the current request or verify the result.
```
