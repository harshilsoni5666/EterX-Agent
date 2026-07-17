# Verification Artifacts

EterX-Code should prove work with the right artifact, not with confidence language.

## Artifact Types

| Artifact | When to create | Evidence |
| --- | --- | --- |
| Task ledger | long or multi-stage work | pending/done steps |
| Implementation note | broad changes | target files and rationale |
| Diff summary | any code change | changed files and behavior |
| Test report | code behavior | command, exit code, key output |
| Build report | compile/bundle changes | command, exit code, failures |
| Browser evidence | UI changes | URL, viewport, screenshot/read result |
| Review report | reviews/security/performance | findings by severity |
| Blocker report | incomplete work | tried paths, blocker, needed input |

## Verification Ladder

Use the lowest rung that actually proves the task:

1. File content check.
2. Syntax check.
3. Lint.
4. Targeted test.
5. Full test suite.
6. Build/package.
7. Runtime smoke test.
8. Browser interaction.
9. Independent sub-agent review.

## UI Verification

For UI changes:

1. Start the app with `process_manager` or another background tool.
2. Use `realtime_verify` to confirm the port is open.
3. Use `browser_control` to navigate.
4. Capture structure with `snapshot` or page read.
5. Interact with key controls.
6. Check at least one desktop and one mobile viewport when layout changed.
7. Report any visual risk if browser verification cannot run.

## Final Claim Rules

- "Done" requires evidence.
- "Build passes" requires a successful build result.
- "Tests pass" requires a successful test result.
- "UI works" requires browser or runtime evidence.
- "No stale names remain" requires a search result.

If a check was skipped, say why.
