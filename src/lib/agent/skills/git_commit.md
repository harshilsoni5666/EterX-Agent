---
name: Git Commit
id: git_commit
description: Create proper git commits with staged changes. Follows git safety protocol - never skip hooks, never amend without permission.
icon: GitCommit
category: coding
---

# Git Commit Skill

Create well-formatted git commits following safety protocol.

## Instructions

1. Run git status to see all changes
2. Run git diff to review staged and unstaged changes
3. Run git log -5 to match existing commit message style
4. Draft a concise commit message (1-2 sentences) focusing on WHY not WHAT
5. Stage specific files (never use git add -A)
6. Create the commit using HEREDOC format

## Git Safety Protocol
- NEVER skip hooks (--no-verify) unless explicitly asked
- NEVER amend existing commits unless explicitly asked
- NEVER force push unless explicitly asked
- NEVER commit .env files or credentials
- Always create NEW commits, not amend
- Stage files by name, not with -A or .

## Commit Message Format
```bash
git commit -m "$(cat <<'EOF'
Brief description of what changed and why

EOF
)"
```
