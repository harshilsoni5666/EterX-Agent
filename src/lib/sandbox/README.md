# EterX Optional Sandbox

This folder is a standalone server-side sandbox subsystem. It is not imported by
the current agent runtime or UI. Later, the app can enable it only when a user
selects a sandbox mode.

## What It Provides

- Per-tenant, per-user, per-project, per-session sandbox roots under
  `.workspaces/sandboxes/`.
- Cross-platform command execution for Windows, macOS, and Linux.
- Path policy checks for read, write, and execute operations.
- Modes:
  - `read-only`: reads are allowed, writes are blocked.
  - `workspace-write`: reads and writes stay inside allowed workspace roots.
  - `ephemeral`: writes and execution stay inside the session sandbox root.
- Network policy:
  - `deny`: blocks common network commands and package install commands.
  - `allow`: permits network-looking commands.
- Secret-stripped environment variables for child processes.
- JSONL audit log per sandbox session.
- Command timeout, output caps, and process-tree termination.

## Example Server Usage

```ts
import {
  createSandboxSession,
  runSandboxCommand,
  writeSandboxFile,
} from '@/lib/sandbox';

const sandbox = createSandboxSession({
  tenantId: 'acme',
  userId: 'user_123',
  projectId: 'project_456',
  mode: 'ephemeral',
  network: 'deny',
  workspaceRoot: 'C:/path/to/user/project',
});

await writeSandboxFile(sandbox, 'scratch.js', 'console.log("ok")');
const result = await runSandboxCommand(sandbox, {
  command: 'node scratch.js',
  cwd: sandbox.root,
});
```

## Integration Contract

When the UI is ready, connect the sandbox as an explicit option:

1. User selects sandbox mode.
2. Server creates a `SandboxSession`.
3. Agent file and terminal tools call the sandbox functions instead of the
   existing direct workspace functions.
4. UI reads the session audit log for visibility.

Do not import this module into the current agent runtime until the UI has a
clear sandbox selection state.
