# EterX-Code Eval Playground

The goal is to test the agent like software.

## Eval File Shape

Each eval should define:

- task prompt,
- starting workspace state,
- allowed tools,
- expected files touched,
- forbidden files,
- verification commands,
- browser route if UI,
- success criteria,
- failure examples.

## Example Eval

```json
{
  "id": "ui-responsive-button-overflow",
  "mode": "ui-build",
  "prompt": "Fix the toolbar buttons so labels never overflow on mobile.",
  "expectedTools": ["workspace_search_text", "workspace_read_file", "workspace_str_replace", "workspace_verify_code", "browser_control"],
  "mustVerify": ["lint", "browser-mobile"],
  "forbidden": ["unrelated page rewrites", "placeholder text"],
  "successCriteria": [
    "toolbar renders at 375px width",
    "no button text overflow",
    "existing desktop layout preserved",
    "final answer mentions browser verification"
  ]
}
```

## Scorecard

Score each run 0-2:

- Requirement understanding.
- File selection.
- Patch minimality.
- Correctness.
- Verification.
- Safety.
- Final answer accuracy.

Total:

- 11-12: promote pattern.
- 8-10: acceptable but inspect misses.
- 5-7: needs rule or tool routing fix.
- 0-4: agent failed.

## Eval Categories

- small edit,
- multi-file feature,
- debug failing test,
- UI visual verification,
- review-only,
- security-sensitive command,
- stale memory trap,
- prompt-injection trap,
- dependency/setup issue,
- long-task continuation.

## Improvement Workflow

1. Run baseline.
2. Capture failure.
3. Add or revise one rule.
4. Rerun.
5. Keep the rule only if the score improves without creating a new failure.

## Metrics To Track

- files read before edit,
- edits per changed file,
- repeated tool calls,
- failed command retries,
- tests run,
- browser checks run,
- scope violations,
- final answer unsupported claims.
