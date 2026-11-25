# EterX release operations

EterX is distributed as compiled, per-platform desktop software. End users do
not clone the repository or install Node.js.

## Release contract

The `.github/workflows/release.yml` workflow builds Windows, macOS, and Linux
packages for x64 and ARM64. It publishes:

- Windows NSIS installers and differential-update blockmaps
- macOS ZIP packages and differential-update blockmaps (local builds can also produce DMGs)
- Linux AppImage packages
- electron-updater metadata for each platform and Linux architecture
- `SHA256SUMS.txt`, consumed by both public bootstrap scripts
- `release-notes.json`, shared customer-facing highlights for every desktop platform

The AppImage is the canonical Linux package for both initial installation and
manual in-app updates. Keeping one package format per Linux architecture avoids
publishing a second system-managed installation path with different update
semantics.

The application version in `package.json` and the release tag must match. Use a
SemVer tag such as `v0.2.0`. A tag is immutable after public release; publish a
new patch version instead of replacing an existing version.

## Publish

1. Set the intended SemVer value in `package.json` and `package-lock.json`.
   Run `npm ci --legacy-peer-deps`, `npm run test:ci`, and `npm run build`
   locally, fixing any failures before tagging.
2. Create and push the matching `v<version>` tag, or run **Native release**
   manually against an existing tag.
3. The workflow validates the tag, package versions, and release notes before
   preparing a draft. The complete CI suite and the three native builds run
   in parallel from the same commit. Publishing waits for all of them to pass.
   A failure leaves the draft unpublished for a retry.
4. Confirm the release contains `SHA256SUMS.txt`, all native packages, and the
   complete updater metadata set before announcing it: `latest.yml`,
   `latest-mac.yml`, `latest-linux.yml`, and `latest-linux-arm64.yml`.

The publish job uses GitHub's uploaded asset digests for `SHA256SUMS.txt` and
downloads the assets to calculate checksums if digests are unavailable.

The public installation commands always resolve the latest non-draft,
non-prerelease GitHub release.

## Signing and notarization

The public workflow currently produces unsigned Windows and macOS packages and
protects their integrity with the published SHA-256 manifest. Platform signing
and macOS notarization remain recommended for production distribution and can
be enabled later with protected repository secrets:

- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for Authenticode signing
- `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD` for Apple code signing
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for Apple
  notarization

Keep signing material only in protected GitHub Actions secrets. Never add
certificates, passwords, API keys, or notarization credentials to this
repository. Signing changes publisher trust and operating-system warnings; it
does not change the AppData-preserving update architecture.

## Update behavior

The desktop app uses GitHub Releases through `electron-updater`. Native checks
start about 8 seconds after the window opens, repeat every 30 minutes while
visible, and refresh on return when the last attempt was more than 5 minutes
ago. Show, restore, and renderer-load events share one request. Failures retry
after 1, 2, 5, 10, then 30 minutes; reconnecting schedules a retry with a one-minute
minimum between attempts. Scans pause while hidden, minimized, suspended,
downloading, or awaiting installation. Manual checks bypass the retry delay.

The header keeps its normal **Updates** link when no release is available. A
blue **Update** button opens Settings and starts downloading the known release.
Viewing or dismissing a notice acknowledges that release without removing the
blue button. In-app notices announce availability and readiness. Native notices
are also available when the app is unfocused, and open Updates when clicked.
Restart remains an explicit action. User data lives outside the installed
application and is not an update target.

The provider compares the public stable release tag before fetching metadata;
clients already at that version do not require a `latest*.yml` asset. For newer
versions, it pins downloads to the release tag and selects the installed OS and
architecture. If channel metadata is missing, a matching installer in the
official `SHA256SUMS.txt` permits a full download verified by electron-updater.
Missing packages, checksums, and release-host failures retry quietly during
automatic discovery. Manual checks show the failure in Settings and keep any
previously discovered update available. Diagnostics remain in the desktop log,
and failed checks never count as a successful up-to-date check. This compatibility fallback
does not replace the requirement to publish every metadata file for new releases.

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
| macOS x64/ARM64 | `latest-mac.yml` | matching `.zip` plus its generated `.blockmap` |
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

Windows starts NSIS with `--updated /S --force-run` and waits for the installer
(or elevation helper) to spawn before quitting, so a failed launch leaves the
verified download available for retry. `/S` skips the assisted setup wizard and
allows `--force-run` to reopen EterX even with `runAfterFinish: false`. First-time
installation retains its assisted UI. System-wide installations can still need
Windows administrator approval; silent updates do not bypass elevation.
The NSIS `customInit` hook also selects silent mode for `--updated`, so existing
clients that omit `/S` get this behavior on their next update to a new installer.
Linux stages the new AppImage on the installation filesystem, keeps the old
image until the replacement is ready, and atomically replaces the existing path.
Custom filenames and symlink launchers keep working, and relaunch waits for the
old process to exit before starting the replacement. The previous image remains
in its transaction directory until the new version's server and main window
load successfully. Failed startup leaves that backup available for recovery.

Unsigned macOS updates use a separate helper that refuses to replace a bundle
until the old process exits. Each attempt has its own staging directory; failed
replacement or startup restores the previous bundle, retaining the backup if
restoration itself fails. Signed macOS updates use Squirrel, with late install
callbacks removed after recovery so a timed-out attempt cannot restart the app
unexpectedly.

All platforms reject an install request unless the verified download matches
the version shown and is newer than the running application. After saving user
state, EterX records the target version and installation location outside the
application package. A successful startup at that location records whether the
new version is running or the previous version reopened, and Settings shows the
result independently of update discovery. This receipt never triggers another
installation. A failed or cancelled installation remains an explicit retry.

## Writing What’s New

`release-notes.json` is the source for the in-app notification, the full notes in
Settings → Updates, and the public GitHub release description. Update its
`version` alongside `package.json` for each release. Its editor schema lives in
`docs/release-notes.schema.json`.

Write a short `summary`, then group highlights into `new`, `improved`, `fixed`,
or `security`. Use each group at most once and omit empty groups. Each highlight
has a short `title` and an optional `description`. Describe the benefit or the
problem a customer experienced in plain language. Leave out commit hashes,
internal filenames, dependency bumps, build logs, and developer-only changes.
The app renders these fields as plain text; no Markdown or HTML is needed.
Keep the file below 64 KiB, with at most 100 highlights across all groups.

The release workflow prepares Markdown from the same file, attaches the JSON
to the draft release, and publishes both with the native packages. The version
must match the release tag. The file is also included in the installed app so
Settings can show the current version’s notes without a network connection.

For a newer release, the updater retrieves highlights from that exact release
tag, accepts only notes matching its version, and shares the result with both
views. Notes have a separate short timeout and are optional for older releases;
missing or invalid notes display a neutral empty state and do not block updates.
Raw commit lists are never displayed or automatically turned into product claims.

The notification uses a bounded preview. A matching background fade appears
only when the content overflows, including after a window resize or font load.
Clicking the card or using its keyboard action opens Settings → Updates without
starting a download or restart. Its separate dismiss button only acknowledges
the notice. Settings shows the complete highlights above the existing update
status, download/restart controls, and scheduling information.

## Recovery

If a release is defective, publish a higher patch version with the correction.
The client intentionally rejects silent downgrades. Existing user data remains
available because it is never stored in the app bundle or versioned runtime.
