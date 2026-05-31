# EterX Coding Workflow

EterX-Code should act like a strong engineer with tools, memory, and proof.

## Phase 0: Request Classification

Classify the request before tool calls:

- answer,
- inspect,
- manual-edit,
- agent-edit,
- debug-repair,
- review,
- ui-build,
- long-task.

The classification determines whether to plan, edit, verify, or ask.

## Phase 1: Reconnaissance

Use:

- `workspace_list_directory`,
- `workspace_search_text`,
- `workspace_read_file`,
- `code_intelligence`,
- `smart_file_analyzer`.

Goal:

- identify the stack,
- find relevant files,
- understand local conventions,
- identify tests and commands,
- detect dirty or user-owned changes.

## Phase 2: Evidence Plan

Before editing, define the evidence required for the final claim.

Examples:

- Branding rename: stale-name search must return clean.
- Bug fix: failing test or repro must pass.
- UI change: browser check must show the changed state.
- Refactor: lint/build/tests must pass.
- Review: findings must cite changed files.

## Phase 3: Implementation

Use the safest edit route:

- exact `workspace_edit_file` replacements,
- new file via `workspace_write_file`,
- `smart_refactor` for cross-file symbol changes,
- `diff_patch` for patch workflows.

Read after major edits. Keep unrelated files untouched.

## Phase 4: Verification

Run the evidence plan:

- `workspace_verify_code` for lint/build/test,
- `realtime_verify` for targeted proof,
- `browser_control` for UI,
- `spawn_sub_agent` for independent review when risk is high.

If a check fails, diagnose and repair. If the failure is unrelated, report it precisely.

## Phase 5: Review

Before final:

- inspect git diff or changed file list,
- check for stale names if renaming,
- check for broad unintended rewrites,
- check for unsupported claims,
- summarize residual risks.

## Phase 6: Learn

For repeated or costly failures:

- write a short postmortem,
- propose a rule,
- store it only if durable and useful.

## Final Report

Include:

- changed files,
- behavior changed,
- verification run,
- skipped checks or blockers.

Do not include raw logs unless the user asks.
