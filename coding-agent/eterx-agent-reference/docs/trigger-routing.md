# EterX-Code Trigger Routing

This routing file maps user intent to agent mode, tools, skills, sub-agents, and verification.

## Intent Classifier

| User request | Mode | First tools | Edits? | Verification |
| --- | --- | --- | --- | --- |
| "What does this code do?" | inspect | `workspace_search_text`, `workspace_read_file`, `code_intelligence` | No | Source references |
| "Fix this bug" | debug-repair | `workspace_search_text`, `workspace_read_file`, `workspace_run_command` | Yes | Reproduce or targeted test |
| "Build/add feature" | agent-edit | `workspace_list_directory`, `workspace_search_text`, `task_decomposer` | Yes | lint/test/build |
| "Refactor" | agent-edit | `code_intelligence`, `smart_refactor`, `workspace_search_text` | Yes | lint/build/tests |
| "Review" | review | `git_intelligence`, `workspace_read_file`, `spawn_sub_agent` | Usually no | Findings with risk |
| "Make UI/page/app" | ui-build | `workspace_list_directory`, `workspace_search_text`, `browser_control` | Yes | browser evidence |
| "Run tests/check" | inspect | `workspace_verify_code`, `workspace_run_command` | No unless fixing asked | Command result |
| "Commit/push" | git-operation | `workspace_run_command`, `git_intelligence` | No code edits unless asked | branch/status/log |
| "Remember" | memory | `memory_v2` | No | stored fact summary |
| "Long task/full folder/all files" | long-task | `task_decomposer`, `task_checkpoint`, `spawn_sub_agent` | Yes | phased checks |

## Skill Triggers

Use `get_skill_guidelines` for:

- frontend or UI: senior frontend, responsive layout, component architecture, accessibility.
- backend/API: senior backend, API design reviewer, database designer.
- tests/QA: senior QA, code verify.
- security: security auditor or security testing.
- docs/artifacts: docx, xlsx, pptx, pdf, web artifacts.
- agent design: agent designer, skill creator, advanced prompt engineering.

## Sub-Agent Triggers

Spawn sub-agents when:

- The task has 2 or more independent areas.
- The codebase is large and search can be parallelized.
- A review should be blind and independent.
- UI and backend can be inspected separately.
- Security or performance risk is meaningful.

Do not spawn for:

- one-file edits,
- direct answers,
- quick typos,
- sequential tasks where sub-agents would wait on each other.

## Planning Gate

Use Fast Mode when:

- one or two files,
- low-risk edit,
- known target,
- easy verification.

Use Planning Mode when:

- 4 or more steps,
- multiple subsystems,
- risky migration,
- destructive operation,
- unclear architecture,
- user asks for deep dive.

Planning Mode output should be compact:

- target files,
- intended changes,
- verification plan,
- risks.

Do not ask for approval unless the change is irreversible, destructive, or genuinely ambiguous.
