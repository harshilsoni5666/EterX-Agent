# EterX release operations

EterX is distributed as compiled, per-platform desktop software. End users do
not clone the repository or install Node.js.

## Release contract

The `.github/workflows/release.yml` workflow builds Windows, macOS, and Linux
packages for x64 and ARM64. It publishes:

- Windows NSIS installers and differential-update blockmaps
- macOS ZIP/DMG packages
- Linux AppImage/DEB packages
- electron-updater metadata for each platform
- `SHA256SUMS.txt`, consumed by both public bootstrap scripts

The application version in `package.json` and the release tag must match. Use a
SemVer tag such as `v0.2.0`. A tag is immutable after public release; publish a
new patch version instead of replacing an existing version.

## Publish

1. Set the intended SemVer value in `package.json` and `package-lock.json`.
2. Create and push the matching `v<version>` tag, or run **Native release**
   manually against an existing tag.
3. Wait for all three native build jobs and the publish job to complete.
4. Confirm the release contains `SHA256SUMS.txt`, all native packages, and the
   `latest*.yml` updater metadata before announcing it.

The public installation commands always resolve the latest non-draft,
non-prerelease GitHub release.

## Signing and notarization

Unsigned development builds can be produced without repository secrets. Public
production releases should configure:

- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for Authenticode signing
- `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD` for Apple code signing
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for Apple
  notarization

Keep signing material only in protected GitHub Actions secrets. Never add
certificates, passwords, API keys, or notarization credentials to this
repository.

## Update behavior

The desktop app uses GitHub Releases through `electron-updater`. It downloads in
the background, shows progress in Settings, and applies the package using the
native updater. User data lives outside the installed application and is not an
update target.

Each packaged Next.js runtime is first copied to a versioned staging directory
inside the OS user-data location and then renamed into place. EterX retains one
previous runtime and removes older versions only after the new runtime has
started successfully.

## Recovery

If a release is defective, publish a higher patch version with the correction.
The client intentionally rejects silent downgrades. Existing user data remains
available because it is never stored in the app bundle or versioned runtime.
