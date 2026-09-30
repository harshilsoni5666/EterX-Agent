# Installed desktop storage

The native installers install application resources separately from writable
user data. EterX runs its server from the installed application archive; it does
not extract a source checkout or install npm dependencies into the user profile.
Executable native dependencies remain in the companion unpacked resources.

| Platform | Default profile |
| --- | --- |
| Windows | `%LOCALAPPDATA%\EterX` (falls back to the user's `AppData\Local\EterX`) |
| macOS | `~/Library/Application Support/EterX` |
| Linux | `$XDG_DATA_HOME/EterX`, or `~/.local/share/EterX` |

Relative XDG and Windows application-data environment paths are ignored.
The Linux bootstrap uses the same absolute-XDG rule for installation, launcher
registration, logs, and download caches. Unix bootstrap files are private to
the installing user unless explicitly made executable or readable for launchers.
Explicit `ETERX_DATA_DIR` (direct server runs) and `ETERX_WORKSPACE_ROOT`
overrides must be absolute. The desktop app sets the server's data directory
to its active profile's `data` directory. Development desktop profiles remain
separate from installed profiles.

`data/settings` holds desktop settings and credential material; other durable
stores live under `data`. Chat projects default to `data/.workspaces`.
`session` holds Chromium state and `cache` holds disposable caches. Terminals,
file browsing, and the server share the same workspace resolver. User-selected
project folders remain in their selected locations.

Production launches use the bundled server on IPv4 loopback. Development URL
overrides cannot redirect the installed app. Startup has a two-minute default
deadline with the existing failure/retry UI; `ETERX_BOOT_TIMEOUT_MS` can override
the deadline. Inherited Node injection settings and activated Python environments
are removed from the backend launch environment.

The installer payload includes desktop modules, compiled Next output, runtime
assets, and production dependencies. The gateway modules are runtime assets,
not a shipped repository `src` tree. Application source maps, Next build caches,
environment files, and desktop filesystem metadata are excluded. JavaScript
needed to execute the app remains present; ASAR is packaging, not encryption.

Legacy source and runtime folders may contain user projects or conflicting data.
Migration imports missing state and preserves those originals for recovery
instead of deleting unclassified files. Existing source-bootstrap environment
configuration is imported even when the data root has not changed.

These changes require newly built installers. No builds, checks, or tests were
run for this change; installation, updates, native modules, and connections on
each supported OS remain unverified.
