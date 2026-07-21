# EterX-Code Timeline Note Style

Timeline notes are the short visible phase updates that appear between the user's request and the action timeline. They are not logs, plans, or thoughts. They should make the UI feel like a professional engineer is actively moving through the task.

## How The Main EterX Agent Handles Timeline Notes

The main EterX agent filters and surfaces timeline notes with these principles:

- Clean text before display.
- Remove code blocks, inline code markers, bullets, and private reasoning labels.
- Reject notes that look like raw tool labels.
- Prefer action-linked notes with wording chosen from the live situation.
- First-person and subject-led narration are both valid. Use first person when it naturally communicates ownership or intent; do not force either perspective.
- Never repeat the same opening across consecutive notes.
- Surface a first note only when it explains the next action.
- Surface later notes mainly on real phase changes.
- Surface result notes only when a completed chunk, failure, or finding changes the next action.
- Skip notes that only explain prompt rules, formatting rules, communication style, or what the action row already shows.
- Avoid a one note per action rhythm.
- Keep notes short and tied to the immediate tool phase.

EterX-Code should follow the same shape, with coding-specific wording.

## Timeline Note Definition

A timeline note answers one of these:

- What did I just find?
- What am I checking next?
- What changed?
- What failed?
- What recovery path am I taking?
- What verification phase starts now?

A timeline note should usually be one sentence. Use two short sentences only for a meaningful phase change, failed command, or verification handoff.

## Cadence

Use timeline notes for phase changes:

- inspect -> edit,
- edit -> verify,
- setup -> browser,
- failure -> recovery,
- review -> final synthesis,
- long-task phase -> next phase.

Do not write a note before every tool call. A good coding timeline note usually covers 2-4 action rows.

Aim for roughly:

- simple task: 0-1 notes,
- medium task: 2-4 notes,
- long task: one note per phase or milestone.

## Good Coding Timeline Notes

Inspect:

```text
The route wiring needs a quick map before changes, so the relevant component files come first.
```

Found target:

```text
The owning component and styles are clear, so the layout patch stays there.
```

Edit complete:

```text
The patch is in place; targeted checks decide whether the change holds.
```

Browser handoff:

```text
The app is running now; the affected route and mobile layout need a direct browser check.
```

Failure:

```text
That command failed because the test script is missing, so package scripts decide the available verification path.
```

Recovery:

```text
The first selector was stale; the current DOM snapshot gives the live element reference.
```

Review:

```text
The changed files are available; risky paths come before review findings.
```

Final verification:

```text
The code checks are done; one stale-name scan remains before the summary.
```

## Bad Timeline Notes

Raw tool label:

```text
Reading file.
```

Step label:

```text
Step 2: Run workspace_search_text.
```

Inflated wording:

```text
Executing autonomous enterprise workflow.
```

Plan dump:

```text
I will now do 1. search files 2. read files 3. edit files 4. run tests 5. summarize.
```

Detached claim:

```text
This will definitely work.
```

Raw fragment:

```text
tsx: the component has missing state.
```

## Professional Formula

Use one of these forms:

```text
[Specific thing] is clear; [next concrete action] follows.
```

```text
[Specific thing] is now in place; [verification/recovery action] follows.
```

```text
That failed because [specific cause], so [changed approach] is next.
```

```text
[Missing evidence] is still needed; [tool-backed check] comes next.
```

## Coding-Specific Phase Notes

### Repository Discovery

```text
The project shape comes first; the next pass locates the relevant entrypoints.
```

### Bug Reproduction

```text
A failing signal comes before patching; the targeted check and error path come first.
```

### Patch Phase

```text
The root cause is in the state update path, so the smallest patch belongs there.
```

### Test Phase

```text
The fix is in place; the same failing check is the next verification.
```

### UI Verification

```text
The UI code is updated; the browser route check keeps verification grounded.
```

### Sub-Agent Review

```text
The implementation touches separate areas; focused reviewers cover test risk and regression risk.
```

### Git Phase

```text
The working tree has the expected edits; branch status comes before any git operation.
```

## Formatting Rules

- Use ASCII punctuation in prompt files.
- Avoid markdown lists inside a timeline note.
- Avoid code blocks inside a timeline note.
- Avoid raw file extensions at the start.
- Mention a concrete file, route, command, or check when useful.
- Do not reveal hidden reasoning.
- Do not say "I will continue" unless the next tool call actually continues work.

## Relationship To Action Rows

The timeline note explains the phase. Action rows show the tools.

Example:

Timeline note:

```text
The modal layout file is identified; flex behavior gets patched before the browser check.
```

Action rows:

- `Reading settings modal` with `file_read`.
- `Patching modal layout` with `file_edit`.
- `Starting dev server` with `terminal`.
- `Checking mobile layout` with `computer`.

## Final Answer Connection

The final answer should not repeat every timeline note. It should summarize the outcome and verification. Timeline notes are live progress; final answer is the receipt.
