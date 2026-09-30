# Workspace and execution behavior

The runtime supplies capabilities and current context. It does not prescribe a
language, a domain, or a mandatory sequence of discovery and setup steps.

## Folder selection and shared work

- A selected folder is the default for relative file paths and commands.
- Multiple chats and agents can select the same folder. Selection is not an
  exclusive lease; chat identifiers route history, panels and process results.
- A chat without a selected folder uses its durable EterX working directory.
  Its scratch files and optional managed environments have stable chat paths.
- Explicit destinations remain explicit. Missing mounts or selected folders
  produce an actionable error rather than a fallback to Desktop or app source.
- File edit transactions coordinate only their target files. Other files and
  other chats remain independent; current file contents govern conflict handling.

## Execution and environment

- Native `program` and `args` are passed as an argument array. Human-readable
  command labels are never executed or used as shell escaping.
- Shell commands use the selected shell's dialect. Windows, macOS and Linux
  paths stay in their host namespace; WSL receives an explicit working directory.
- Startup settings from Electron and unrelated activated Python environments
  do not automatically become a chat's command environment.
- Project-local command directories are available without activation scripts.
  Python aliases select an explicit EterX configuration, the project's existing
  environment, an existing EterX chat environment, or a discoverable base Python.
  An explicitly supplied executable and invocation overrides are honored.
- `ETERX_PYTHON_PATH` is an optional interpreter override, including a versioned
  executable. An invalid override produces a specific error instead of silently
  substituting a different runtime.
- Discovery uses filesystem metadata. It does not import packages, run version
  probes, install dependencies or create environments when a chat opens.
- An optional environment creation recipe is provided when useful; it is not an
  installed runtime or a required step for unrelated tasks. A missing dependency
  is resolved only for the approach the task actually needs.

## Process results and continuity

- Running processes keep their task identity and output cursor across turns.
  A check-in or empty output does not establish completion or justify relaunch.
- Live output, actual executable/arguments, working directory and exit status
  remain available in terminal details. Compact labels omit long executable
  prefixes while expanded details preserve the real path.
- Millisecond and second inputs retain their declared units. Timer cancellation
  returns cancellation, rather than an expired or successful result.
- Saved output remains readable after restart. If the original execution handle
  and final result are unavailable, the outcome is unknown. A saved PID alone is
  not sufficient to attach to or stop a process, since operating systems reuse PIDs.

These are implementation contracts, not cross-platform validation results.
No builds, tests or validation commands were run for these changes, as requested.
