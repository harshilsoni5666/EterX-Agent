---
name: Batch Operations
id: batch
description: Apply the same transformation across multiple files efficiently. Batch edits, renames, refactors, and code modifications.
icon: Layers
category: coding
---

# Batch Operations Skill

Apply the same transformation across multiple files.

## Instructions

1. Identify all target files using workspace_search_text or workspace_list_directory
2. Plan the transformation (what changes in each file)
3. Apply changes file by file using workspace_edit_file
4. Verify each change was applied correctly
5. Run tests/lints after all changes

## Workflow

1. **Discover**: Find all files matching the pattern (e.g., all .tsx files importing a specific module)
2. **Preview**: Show the user what will change before applying
3. **Execute**: Apply the same edit pattern to each file
4. **Validate**: Run the project's test suite or type checker
5. **Report**: Summarize what was changed

## Use Cases
- Rename a function/variable across the entire codebase
- Update import paths after moving a module
- Add/remove a prop from all component usages
- Apply a code style change across files
- Update API endpoint references
