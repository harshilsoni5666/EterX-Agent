---
name: Iterative Loop
id: iterative_loop
description: Run iterative refinement loops - make a change, test, observe results, refine. Continue until the goal is met.
icon: RefreshCw
category: coding
---

# Iterative Loop Skill

Run iterative refinement loops for coding tasks.

## Instructions

1. Make the initial change
2. Run the test/build/lint
3. Observe the result
4. If not passing, analyze the failure and refine
5. Repeat until the goal is achieved

## Workflow

1. **Initial attempt**: Make the code change
2. **Test**: Run relevant tests or build commands
3. **Analyze**: Read the output carefully
4. **Refine**: Fix any issues found
5. **Repeat**: Loop until all checks pass
6. **Report**: Summarize iterations and final result

## Rules
- Maximum 10 iterations before asking the user for guidance
- Each iteration should make progress - never repeat the same failed approach
- Log what you learned from each iteration
- If stuck after 3 iterations, try a fundamentally different approach
