# Git workspace

Open the workspace **+** menu and choose **Git**, or choose **Open Git workspace** from the branch menu below the composer. When the workspace is open, **Ctrl/⌘ + Alt + G** opens its Git tab.

Git is available by default. Opening a chat does not automatically open the Git panel. The panel follows the selected project; projectless chats can choose a folder using the folder control. The full repository path is shown above the branch controls, including when the selected project is a subfolder of a repository.

## Everyday workflow

1. Select a file in **Changes** to inspect its patch. Conflicts, staged files, and unstaged files have separate groups. A partially staged file appears in both applicable groups. Each text file shows green additions and red deletions (for example, `+80 −12`) for its group. Binary files and conflicts have explicit labels; new text files up to 2 MB show their line counts.
2. Use **+** to stage a file or **−** to unstage it. **All** operates on the displayed group; when filtering, **Matching** operates on the matching files. Group actions accept up to 500 files at a time.
3. Enter a message and choose **Commit staged**. **Ctrl/⌘ + Enter** also submits a valid commit. Commit drafts are saved in the existing AppData preferences store, separately for each chat and repository.
4. Use **Fetch** to update remote references, **Pull** to fast-forward a clean working tree, and **Push** or **Publish** to send the current branch. Ahead/behind counts reflect the most recent fetch.

Commits include the index only. Discarding a tracked file restores its unstaged text changes from the index, retaining staged changes. Discard requires a current diff and confirmation. New, renamed, conflicted, and binary files are not discarded by this control.

## Branches, history, and stashes

- **Branches:** create a branch, switch local or remote branches, compare another branch with the current branch, merge or squash into the current branch, and delete merged local branches. Branches checked out in another worktree are identified. Switching and merging require a clean working tree.
- **History:** browse the current branch's commits, filter loaded commits, load earlier history, inspect patches, and copy commit IDs.
- **Stashes:** save tracked changes, optionally include untracked files, inspect a stash, apply it while retaining the saved copy, or explicitly drop it. Applying a stash requires a clean working tree. Ignored files are excluded when saving.

**Compare with current branch** and **Review working tree** open the existing Review panel. **Open file** opens Files, and the terminal button creates a terminal for the repository. The Git panel's staged preview and Review's complete working-tree view have separate labels because they may contain different changes.

## Repository setup

A folder without a repository offers **Initialize repository**, using `main` as the initial branch. No files are automatically staged. **Add remote** accepts an HTTPS or SSH repository URL. Adding a remote does not fetch or push.

The author button in the Git toolbar loads the effective commit name and email. Saving changes writes repository-local identity settings. It does not change the global Git identity.

Git uses the machine's installed executable, credentials, hooks, and signing configuration. If authentication needs an interactive login, complete that setup in the system terminal, then retry the action. Missing Git, repository access failures, conflicts, and command failures appear as explicit states or inline messages.

## Settings → Git

| Setting | Default | Behavior |
| --- | --- | --- |
| Git integration | On | Enables the composer branch controls and Git workspace. |
| Git workspace tab | On | Includes Git in the workspace launcher and + menu without opening it automatically. |
| Auto-refresh local status | On | Refreshes visible Git surfaces and on focus; does not fetch from remotes. |
| Branch prefix | `eterx/` | Prefills new branch names; the complete name remains editable. |
| Branch merge method | Merge | Chooses regular merging or squash staging. |
| Confirm before pushing | On | Shows the repository, branch, and remote destination before publishing. |

Disabling integration stops these surfaces from issuing Git requests. Existing Review behavior and agent tool permissions are separate features. Native browser workspace menus pick up the new Git entry after the desktop process restarts.

## Implementation

The renderer uses `/api/git` for named read and mutation operations. The service invokes Git with argument arrays and literal pathspecs, never shell command interpolation. File groups travel over standard input with NUL separators to support unusual names and Windows command-line limits.

Actions are serialized per common Git directory, including linked worktrees. Mutations compare the observed HEAD, branch, status, operation, and index fingerprint with a fresh snapshot. A stale view is rejected for refresh. Destructive discard additionally compares the inspected patch, and stash actions validate both the stash reference and object ID. External Git clients can still operate independently; normal Git locking and conflict errors remain authoritative.

The UI never automatically retries writes. After an interrupted connection or timeout, refresh before retrying because the operation may already have completed. Force-push, hard reset, untracked-file cleanup, and automatic conflict resolution are not exposed.
