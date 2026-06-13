---
name: git-commit
description: Use only when the user explicitly asks to stage or commit changes. Provides safe commit hygiene, scoped staging, review-before-commit, and clear commit messages.
icon: GitCommit
category: coding
---

# Git Commit

Use this skill only for explicit git commit requests.

## Protocol

1. Confirm git commands are allowed in the current request.
2. Review changed files and avoid unrelated user/agent work.
3. Stage only the files requested or clearly owned by the current task.
4. Use a concise commit message that explains the user-visible purpose.
5. Do not amend, rebase, tag, push, force push, skip hooks, or change branches unless explicitly requested.

## Message Shape

```text
Short imperative summary

Optional body explaining why the change was needed.
```

## Never Include

- Secrets, `.env` files, generated caches, build output, logs, or unrelated cleanup.
- Claims that tests passed unless the exact checks were run.
