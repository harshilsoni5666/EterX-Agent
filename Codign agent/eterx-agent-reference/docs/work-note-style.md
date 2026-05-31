# EterX-Code Work Note Style

Work notes are the short visible phase updates that appear between the user's request and the action timeline. They are not logs, plans, or thoughts. They should make the UI feel like a professional engineer is actively moving through the task.

## How The Main EterX Agent Handles Work Notes

The main EterX agent filters and surfaces work notes with these principles:

- Clean text before display.
- Remove code blocks, inline code markers, bullets, and private reasoning labels.
- Reject notes that look like raw tool labels.
- Prefer first-person, action-linked notes.
- Surface a first note only when it explains the next action.
- Surface later notes mainly on real phase changes.
- Avoid a one note per action rhythm.
- Keep notes short and tied to the immediate tool phase.

EterX-Code should follow the same shape, with coding-specific wording.

## Work Note Definition

A work note answers one of these:

- What did I just find?
- What am I checking next?
- What changed?
- What failed?
- What recovery path am I taking?
- What verification phase starts now?

A work note should usually be one sentence. Use two short sentences only for a meaningful phase change, failed command, or verification handoff.

## Cadence

Use work notes for phase changes:

- inspect -> edit,
- edit -> verify,
- setup -> browser,
- failure -> recovery,
- review -> final synthesis,
- long-task phase -> next phase.

Do not write a note before every tool call. A good coding work note usually covers 2-4 action rows.

Aim for roughly:

- simple task: 0-1 notes,
- medium task: 2-4 notes,
- long task: one note per phase or milestone.

## Good Coding Work Notes

Inspect:

```text
I need to see how this is wired, so I am opening the relevant route and component files first.
```

Found target:

```text
I found the owning component and its styles. I am patching the layout where the overflow starts.
```

Edit complete:

```text
The patch is in place. Next I am running the targeted checks so the change is not only cosmetic.
```

Browser handoff:

```text
The app is running now. I am opening the affected route and checking the mobile layout directly.
```

Failure:

```text
That command failed because the test script is missing. I am checking the package scripts and switching to the available verification path.
```

Recovery:

```text
The first selector was stale. I am reading the current DOM snapshot and using the live element reference instead.
```

Review:

```text
I have the changed files now. I am reading the risky paths before writing review findings.
```

Final verification:

```text
The code checks are done. I am doing one final stale-name scan before summarizing.
```

## Bad Work Notes

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
I am synthesizing an enterprise-grade autonomous cognition pathway.
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
I found [specific thing]. I am [next concrete action].
```

```text
[Specific thing] is now in place. Next I am [verification/recovery action].
```

```text
That failed because [specific cause]. I am [changed approach].
```

```text
I need [missing evidence]. I am [tool-backed check].
```

## Coding-Specific Phase Notes

### Repository Discovery

```text
I need the project shape first, so I am scanning the workspace and locating the relevant entrypoints.
```

### Bug Reproduction

```text
I need a failing signal before patching, so I am running the targeted check and reading the error path.
```

### Patch Phase

```text
I found the root cause in the state update path. I am applying the smallest patch there.
```

### Test Phase

```text
The fix is in place. I am rerunning the same check that exposed the failure.
```

### UI Verification

```text
The UI code is updated. I am checking the route in the browser instead of relying on the compile result alone.
```

### Sub-Agent Review

```text
The implementation touches separate areas. I am launching focused reviewers for test risk and regression risk.
```

### Git Phase

```text
The working tree has the expected edits. I am checking branch status before any git operation.
```

## Formatting Rules

- Use ASCII punctuation in prompt files.
- Avoid markdown lists inside a work note.
- Avoid code blocks inside a work note.
- Avoid raw file extensions at the start.
- Mention a concrete file, route, command, or check when useful.
- Do not reveal hidden reasoning.
- Do not say "I will continue" unless the next tool call actually continues work.

## Relationship To Action Rows

The work note explains the phase. Action rows show the tools.

Example:

Work note:

```text
I found the modal layout file. I am patching the flex behavior and then checking it in the browser.
```

Action rows:

- `Reading settings modal` with `file_read`.
- `Patching modal layout` with `file_edit`.
- `Starting dev server` with `terminal`.
- `Checking mobile layout` with `computer`.

## Final Answer Connection

The final answer should not repeat every work note. It should summarize the outcome and verification. Work notes are live progress; final answer is the receipt.
