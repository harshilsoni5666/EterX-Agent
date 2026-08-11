# EterX release operations

EterX is distributed as compiled, per-platform desktop software. End users do
not clone the repository or install Node.js.

## Release contract

The `.github/workflows/release.yml` workflow builds Windows, macOS, and Linux
packages for x64 and ARM64. It publishes:

- Windows NSIS installers and differential-update blockmaps
- macOS ZIP/DMG packages
- Linux AppImage/DEB packages
- electron-updater metadata for each platform and Linux architecture
- `SHA256SUMS.txt`, consumed by both public bootstrap scripts

The AppImage is the Linux package used by the in-app updater. A `.deb` is
published for package-manager installations and is updated by downloading and
installing the next `.deb`; the app never replaces a system-managed package
behind the package manager's back.

The application version in `package.json` and the release tag must match. Use a
SemVer tag such as `v0.2.0`. A tag is immutable after public release; publish a
new patch version instead of replacing an existing version.

## Publish

1. Set the intended SemVer value in `package.json` and `package-lock.json`.
2. Create and push the matching `v<version>` tag, or run **Native release**
   manually against an existing tag.
3. Wait for all three native build jobs and the publish job to complete.
4. Confirm the release contains `SHA256SUMS.txt`, all native packages, and the
   complete updater metadata set before announcing it: `latest.yml`,
   `latest-mac.yml`, `latest-linux.yml`, and `latest-linux-arm64.yml`.

The public installation commands always resolve the latest non-draft,
non-prerelease GitHub release.

## Signing and notarization

Unsigned development builds can be produced locally without repository
secrets. The native release workflow refuses to publish unsigned Windows or
macOS production updates because native update verification depends on the
installed app and replacement package having a valid publisher identity:

- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for Authenticode signing
- `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD` for Apple code signing
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for Apple
  notarization

Keep signing material only in protected GitHub Actions secrets. Never add
certificates, passwords, API keys, or notarization credentials to this
repository.

## Update behavior

The desktop app uses GitHub Releases through `electron-updater`, but checks are
manual. The user opens the Updates section in Settings, chooses **Check for
updates**, then explicitly downloads and installs a release. User data lives
outside the installed application and is not an update target.

The packaged `app-update.yml` points at the `harshilsoni5666/EterX-Agent`
GitHub repository. Installed clients access that feed without a GitHub token,
so the repository and its published release assets must be publicly readable.
Do not embed a private-repository token in the application. If releases must
remain private, move the updater to an authenticated distribution service and
change the package `publish` provider as a separate release migration.

The metadata requested by each installed package is:

| Installed package | Hosted metadata | Hosted application artifact |
|---|---|---|
| Windows x64/ARM64 | `latest.yml` | matching NSIS `.exe` plus `.blockmap` |
| macOS x64/ARM64 | `latest-mac.yml` | matching `.zip` (DMG remains available for manual install) |
| Linux x64 AppImage | `latest-linux.yml` | matching `.AppImage` |
| Linux ARM64 AppImage | `latest-linux-arm64.yml` | matching `.AppImage` |

Checking, availability, byte progress, verification, save-gating, and native
installer startup are streamed from Electron's main process to the Updates UI.
Transfer reaching 100% is not considered installable until `electron-updater`
emits its verified `update-downloaded` event.

The install gate flushes chats, preferences, scheduled tasks, and runtime
settings before handing control to the native installer. A transient local
write or a still-hydrating startup state is retried; if it still cannot be
confirmed, the downloaded package remains ready and the user gets **Retry
restart and install** instead of losing AppData.

Each release contains a compiled Next.js standalone runtime inside the native
application package. The updater replaces that immutable package while the
canonical per-user EterX data directory remains untouched.

## Recovery

If a release is defective, publish a higher patch version with the correction.
The client intentionally rejects silent downgrades. Existing user data remains
available because it is never stored in the app bundle or versioned runtime.
