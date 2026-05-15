---
name: Debug
id: debug
description: Debug issues by analyzing logs, stack traces, and error patterns. Diagnose root causes and suggest concrete fixes.
icon: Bug
category: coding
---

# Debug Skill

Help the user debug issues in their code or environment.

## Instructions

1. Review the user's issue description
2. Read relevant log files and error outputs
3. Look for ERROR and WARN entries, stack traces, failure patterns
4. Consider launching a sub-agent to understand relevant features
5. Explain what you found in plain language
6. Suggest concrete fixes or next steps

## Workflow

1. **Gather context**: Read error logs, console output, and relevant source files
2. **Identify patterns**: Look for common error patterns (null refs, type mismatches, import failures, race conditions)
3. **Trace the root cause**: Follow the error chain from symptom to source
4. **Propose fix**: Suggest a minimal, targeted fix
5. **Verify**: After applying fix, run tests or reproduce the scenario to confirm

## Tips
- Always read the FULL error message, not just the first line
- Check recent git changes with `git diff` to find what changed
- Look at both the failing code AND its callers
- Check environment variables and config files
- Consider race conditions for intermittent failures
