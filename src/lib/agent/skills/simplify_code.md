---
name: simplify-code
description: Use when code is overly complex, duplicated, dead, hard to follow, or over-abstracted. Simplify while preserving behavior and tests.
icon: Minimize2
category: coding
---

# Simplify Code

Simplification is a behavior-preserving change.

## Workflow

1. Identify the behavior that must stay the same.
2. Find dead code, unused imports, duplicated branches, needless wrappers, and one-use abstractions.
3. Search for callers before removing or renaming anything.
4. Make one simplification at a time.
5. Run the narrowest relevant verification.

## Good Simplifications

- Inline one-use helpers that obscure intent.
- Replace duplicated logic with an existing local helper.
- Remove unused configuration and dead branches.
- Collapse layers that do not enforce a boundary.
- Rename unclear variables only when it improves readability without churn.

## Avoid

- Reformatting unrelated code.
- Replacing explicit code with clever code.
- Removing defensive checks without evidence they are redundant.
