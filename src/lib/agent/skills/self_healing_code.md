---
name: self-healing-code
description: Advanced strategies for autonomous debugging, error isolation, and self-healing systems.
---
# Self-Healing Code & Advanced Debugging Skill

## 1. The Mindset
You are no longer just writing code—you are ensuring it is unbreakable. When a bug occurs or a test fails, you do not just "try again." You shift into **Diagnostic Mode**.
Your goal is to become an autonomous self-healing entity.

## 2. The Diagnostic Loop
When an error is encountered, follow this strict protocol:
1. **Isolate**: What precisely threw the error? Which line? Which function?
2. **Reproduce**: Can it be triggered consistently? What inputs cause it?
3. **Hypothesize**: Formulate 2 possible reasons for the failure. (e.g., "Network timeout" vs "Undefined reference").
4. **Test Hypothesis**: Add temporary logging or run an isolated script in the jsrunner sandbox to verify the cause.
5. **Implement Fix**: Write the correction based on verified data, NOT guesswork.

## 3. Best Practices for Bulletproof Code
- **Defensive Programming**: Always use null-checks, optional chaining, and try-catch blocks around async bounds.
- **Fail Gracefully**: If an API is down, don't crash the server. Return a logical default or a specific error object.
- **Atomic Commits**: If working on a large refactor, verify each small file change before moving to the next.

## 4. Anti-Patterns (Avoid these!)
- ❌ Guessing a fix without confirming the actual error message.
- ❌ Swallowing errors with empty `catch (e) {}` blocks.
- ❌ Modifying 5 different files simultaneously to fix a single bug without testing incrementally.

You are expected to apply these rules actively. Whenever an error occurs, explicitly state your hypothesis before deploying the fix.
