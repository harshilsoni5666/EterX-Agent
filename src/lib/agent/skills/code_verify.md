---
name: Code Verify
id: code_verify
description: Verify code correctness by running tests, type checking, linting, and build validation. Ensure code works before reporting done.
icon: CheckCircle
category: coding
---

# Code Verification Skill

Verify that code changes are correct and complete.

## Instructions

1. Run the project's test suite
2. Run the type checker (tsc --noEmit)
3. Run the linter (eslint, biome, etc.)
4. Run the build to check for compilation errors
5. Report results faithfully - never claim success when tests fail

## Verification Steps

1. **Type check**: `npx tsc --noEmit` or equivalent
2. **Lint**: `npx eslint .` or project's lint command
3. **Test**: `npm test` or project's test command
4. **Build**: `npm run build` to verify production compilation
5. **Manual check**: Read the changed files to visually verify correctness

## Rules
- NEVER claim "all tests pass" when output shows failures
- Report actual error messages and counts
- If you cannot run verification, explicitly say so
- Always run verification BEFORE reporting task complete
