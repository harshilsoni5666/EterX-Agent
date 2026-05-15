---
name: Simplify Code
id: simplify_code
description: Review code for unnecessary complexity. Remove dead code, simplify abstractions, reduce indirection while maintaining behavior.
icon: Minimize2
category: coding
---

# Simplify Code Skill

Review and simplify complex code.

## Instructions

1. Read the target code thoroughly
2. Identify unnecessary complexity:
   - Dead code and unused imports
   - Over-engineered abstractions
   - Unnecessary indirection layers
   - Duplicated logic
   - Overly defensive error handling
3. Suggest simplifications that maintain behavior
4. Apply changes incrementally
5. Verify behavior is preserved after each change

## What to Look For
- Functions that are only called once (inline them)
- Abstractions with only one implementation (remove the interface)
- Try/catch blocks that swallow errors silently
- Configuration for things that never change
- Comments that just restate the code
- Variables used only once after assignment

## Rules
- Never change behavior - only simplify implementation
- Run tests after each simplification
- Keep changes small and reviewable
- If unsure whether something is used, search the codebase first
