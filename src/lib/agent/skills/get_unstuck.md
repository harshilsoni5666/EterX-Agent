---
name: Get Unstuck
id: get_unstuck
description: When blocked on an issue - re-read errors, check assumptions, try focused fixes. Systematic approach to getting unblocked.
icon: Unlock
category: coding
---

# Get Unstuck Skill

Systematic approach to getting unblocked when stuck on a coding problem.

## Instructions

1. Re-read the error message carefully - the answer is usually in the error
2. Check your assumptions about what the code does
3. Try a focused fix based on the error
4. If that fails, try a different approach
5. Escalate to the user only when genuinely stuck after investigation

## Workflow

1. **Read the error**: Parse the full error message, stack trace, and context
2. **Check assumptions**: Did a file change? Is a dependency missing? Wrong version?
3. **Isolate**: Create a minimal reproduction of the issue
4. **Research**: Search for the error message or pattern
5. **Fix**: Apply the most likely fix
6. **Verify**: Confirm the fix resolves the issue
7. **Document**: Note what the issue was for future reference

## Common Causes
- Missing dependencies (npm install)
- Wrong Node/Python version
- Stale cache (.next, node_modules/.cache)
- Environment variables not set
- Import path case sensitivity
- Circular dependencies
- Race conditions in async code
