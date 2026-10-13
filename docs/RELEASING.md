# Releasing

## Version 1.0.0 Approval

The project maintainer confirmed successful testing on another Windows 10
computer and explicitly approved GitHub publication on 2026-10-13.
Publish version `1.0.0` as an official, non-prerelease release. Describe the
confirmed testing accurately rather than retaining the earlier pending status.
Before running any installer or uninstaller, save your work and fully exit
Codex, including background processes. Setup blocks while Codex or this
installation's wallpaper service is running; it does not stop any process.
The directory-local uninstaller is `unins000.exe`; use it rather than deleting
the program directory manually. Uninstall retains settings, caches and account
files.

## Source Checks

1. Run `npm run verify` on Windows with Node.js 22 or newer. CI uses 24.14.0.
   No dependency installation or real Codex/Wallpaper Engine installation is
   needed for regression tests.
2. Confirm package, plugin, MCP and installer version values match the release.
   Keep the internal plugin ID `dsh-plugin-wallpaper-engine-codex`.
3. Inspect the source to publish. Preserve `LICENSE`, `NOTICE.md` and vendored
   notices. Exclude local journals, personal configuration, credentials,
   wallpaper media, dependencies, caches and build outputs.
4. Keep the bilingual README, default appearance and compatibility limits
   consistent with the build.

## Build and Verify

Build into a fresh output directory so an older verified installer remains
available:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-installer.ps1 -Version 1.0.0 -OutputDirectory .\outputs\release-candidate
```

The script uses checksum-pinned Node.js 24.14.0 and Inno Setup 7.1.0. Check the
payload against the tested source and confirm that the EXE and checksum agree:

```powershell
Get-FileHash .\outputs\release-candidate\CodexLiveWallpaper-Setup-1.0.0-x64.exe -Algorithm SHA256
Get-Content .\outputs\release-candidate\CodexLiveWallpaper-Setup-1.0.0-x64.exe.sha256
```

On a machine with Codex installed, fully exited, and its plugin-capable CLI on
PATH, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\windows\verify-installer.ps1 -InstallerPath .\outputs\release-candidate\CodexLiveWallpaper-Setup-1.0.0-x64.exe -WorkRoot .\work\release-verification
```

This performs real isolated install, reinstall and uninstall checks using
temporary profile/data paths. It also starts the bundled MCP, checks its version
and partial-adjustment schema, and validates the launcher without starting
Codex. Source regression tests verify first-selection appearance defaults
separately.
Pass `-VerifyIcons` to create and inspect the desktop/Start menu shortcuts,
extract the installer icon and verify the uninstall display icon. This mode
refuses to overwrite an existing desktop shortcut and removes the test shortcuts
through the native uninstaller.
It refuses to run if this EXE edition is already installed for the current
Windows user. Never remove or bypass that protection.

Separately, manually check first selection, playback, adjustment, restart
restoration and removal on the intended device. Record any untested areas
honestly; a launcher `ValidateOnly` result is not a playback check.

## GitHub Release

Only after explicit publication approval, commit the intended public files, push
`main`, and create a release tagged `v1.0.0` in
`Yi-sama/Codex-Live-Wallpaper`.

Attach only:

- `CodexLiveWallpaper-Setup-1.0.0-x64.exe`
- `CodexLiveWallpaper-Setup-1.0.0-x64.exe.sha256`

Use `docs/releases/v1.0.0.md` for release notes. State the maintainer-confirmed
Windows 10 test result, passed automated checks, the unsigned EXE and compatibility
limits. Do not upload a portable ZIP,
private journals, test profiles, build payloads, debug reports or wallpapers.
GitHub's automatically generated source archives are not a portable edition.
