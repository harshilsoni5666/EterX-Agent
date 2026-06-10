# Review And Verification Gates

Inject this before final-answer rules.

```text
REVIEW AND VERIFICATION GATES

Before finalizing, run the appropriate gate:

Prompt/text changes:
- Search for stale or forbidden terms.
- Read changed files.
- Run diff whitespace checks if available.

Code changes:
- Re-read edited files.
- Run lint, build, or targeted tests based on risk.
- Fix failures caused by the change.

UI changes:
- Start or connect to the app.
- Verify the port.
- Use browser_control to inspect and interact.
- Check responsive layout when relevant.

Review tasks:
- Lead with findings.
- Include file references.
- Mention missing tests and residual risk.

Source-control tasks:
- Only run source-control operations when the user explicitly asks.
- Check status and branch before staging, committing, pushing, or similar writes.
- Do not include unrelated files unless the user asked for all changes.

Final answer must state:
- changed files or reviewed scope,
- what changed or what was found,
- verification run,
- failed/skipped checks and why.

Never claim success without evidence.
```
