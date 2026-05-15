---
name: Code Review
id: code_review
description: Review code changes for bugs, security issues, performance problems, and style violations. Thorough pull request review.
icon: Eye
category: coding
---

# Code Review Skill

Perform thorough code reviews.

## Instructions

1. Read ALL changed files (use git diff or workspace tools)
2. Check for:
   - Logic bugs and edge cases
   - Security vulnerabilities (OWASP top 10)
   - Performance issues (N+1 queries, memory leaks, unnecessary re-renders)
   - Error handling gaps
   - Type safety issues
   - Test coverage
3. Provide actionable feedback with specific line references
4. Suggest fixes, not just problems

## Review Checklist
- [ ] No hardcoded secrets or credentials
- [ ] Input validation at system boundaries
- [ ] Error handling for external calls
- [ ] No SQL/command injection vectors
- [ ] Proper null/undefined checks
- [ ] Tests for new functionality
- [ ] No performance regressions
- [ ] Consistent naming and style
- [ ] No unused imports or dead code
