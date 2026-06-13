---
name: batch-operations
description: Use when the same safe transformation must be applied across multiple files, imports, identifiers, configs, tests, or docs. Emphasizes discovery, preview, scoped editing, and verification.
icon: Layers
category: coding
---

# Batch Operations

Use this skill for repeated changes where consistency matters more than cleverness.

## Workflow

1. Define the transformation in one sentence.
2. Discover all candidate files with search tools.
3. Split candidates into in-scope, maybe, and out-of-scope.
4. Inspect representative files before editing.
5. Apply edits in a repeatable pattern.
6. Re-scan for old and new patterns.
7. Run the narrowest relevant checks.

## Safety Rules

- Never run broad rewrites over generated, vendored, lock, binary, or build-output files.
- Do not infer semantic equivalence from text matches alone; inspect callers and imports.
- Prefer structured codemods or formatters when the repository already has them.
- Keep unrelated style churn out of batch edits.

## Completion

Report the pattern changed, files touched, checks run, and any skipped ambiguous matches.
