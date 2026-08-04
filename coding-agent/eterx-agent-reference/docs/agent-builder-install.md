# Agent Builder Install Notes

Use this file when creating an EterX custom agent from this pack.

## Profile Fields

- `name`: EterX-Code
- `mission`: Complete software engineering tasks end to end with scoped edits and verification.
- `professionalPrompt`: Use `agent.md`.
- `responseStyle`: Direct, technical, concise, evidence-based.
- `behaviorRules`: Use the rules from `AGENTS.md`.
- `safetyRules`: Use the security section from `agent.md`.
- `toolUsePolicy`: Use the runtime tool declarations and the single-editor contract.
- `completionCriteria`: Use `docs/verification-artifacts.md`.

## Direct Main Tools To Attach

Attach these EterX tools first:

- `workspace_list_directory`
- `workspace_semantic_search`
- `workspace_file_outline`
- `workspace_find_files`
- `workspace_search_text`
- `workspace_read_many_files`
- `workspace_read_file`
- `workspace_str_replace`
- `workspace_apply_patch`
- `workspace_edit_file`
- `workspace_edit_many_files`
- `workspace_write_file`
- `workspace_run_command`
- `workspace_verify_code`
- `realtime_verify`
- `code_intelligence`
- `workspace_read_file`
- `smart_refactor`
- `git_intelligence`
- `git_operations`
- `browser_control`
- `process_manager`
- `background_task`
- `task_decomposer`
- `task_checkpoint`
- `spawn_sub_agent`
- `get_skill_guidelines`
- `memory_v2`
- `context_manager`
- `web_search`
- `web_scraper`
- `deep_research`
- `image_asset_search`
- `code_generator`

## Tool Attachment Guidance

For each attached tool, include:

- purpose,
- when to use,
- input policy,
- output policy.

Example:

```text
Tool: workspace_str_replace
Purpose: Apply precise exact-text edits to existing workspace files.
When to use: Default edit path after reading the target range and identifying the exact change.
Input policy: Provide exact old_string and new_string, including whitespace.
Output policy: Use returned diff/readback as evidence; re-read only when the result is ambiguous.
```

## Custom Tools To Consider Later

Do not add custom tools before the base profile is stable. After repeated use, consider:

- `eterx_feature_pipeline`: inspect, plan, edit, verify, review.
- `eterx_ui_smoke`: start app, open browser, verify route, capture evidence.
- `eterx_safe_git_release`: status, diff, lint/test, commit, push.
- `eterx_stale_name_scan`: search forbidden terms in selected scope.
