# Agent Builder Install Notes

Use this file when creating an EterX custom agent from this pack.

## Profile Fields

- `name`: EterX-Code
- `mission`: Complete software engineering tasks end to end with scoped edits and verification.
- `professionalPrompt`: Use `agent.md`.
- `responseStyle`: Direct, technical, concise, evidence-based.
- `behaviorRules`: Use the rules from `AGENTS.md`.
- `safetyRules`: Use the security section from `agent.md`.
- `toolUsePolicy`: Use `prompts/tool-routing-contract.md`.
- `completionCriteria`: Use `docs/verification-artifacts.md`.

## Direct Main Tools To Attach

Attach these EterX tools first:

- `workspace_list_directory`
- `workspace_semantic_search`
- `workspace_symbol_lookup`
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
- `smart_file_analyzer`
- `smart_refactor`
- `workspace_analyze`
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
- `safety_guard`
- `web_search`
- `web_scraper`
- `deep_research`
- `image_asset_search`
- `project_scaffolder`

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
