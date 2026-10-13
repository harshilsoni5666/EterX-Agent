# EterX release operations

EterX is distributed as compiled, per-platform desktop software. End users do
not clone the repository or install Node.js.

## Release contract

The `.github/workflows/release.yml` workflow builds Windows, macOS, and Linux
packages for x64 and ARM64. It publishes:

- Windows NSIS installers and differential-update blockmaps
- macOS ZIP/DMG packages
- Linux AppImage packages
- electron-updater metadata for each platform and Linux architecture
- `SHA256SUMS.txt`, consumed by both public bootstrap scripts

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
   locally, fixing any failures before tagging. The release workflow also runs
   the complete CI suite before creating its draft or building native packages.
2. Create and push the matching `v<version>` tag, or run **Native release**
   manually against an existing tag.
3. Wait for the test gate, all three native build jobs, and the publish job to complete.
4. Confirm the release contains `SHA256SUMS.txt`, all native packages, and the
   complete updater metadata set before announcing it: `latest.yml`,
   `latest-mac.yml`, `latest-linux.yml`, and `latest-linux-arm64.yml`.

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
Missing packages or checksums remain pending and retry automatically; network
errors never count as a successful up-to-date check. This compatibility fallback
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
