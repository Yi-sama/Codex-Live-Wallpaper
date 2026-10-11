# Releasing

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-installer.ps1 -Version 0.3.6 -OutputDirectory .\outputs\release-candidate
```

The script uses checksum-pinned Node.js 24.14.0 and Inno Setup 7.1.0. Check the
payload against the tested source and confirm that the EXE and checksum agree:

```powershell
Get-FileHash .\outputs\release-candidate\CodexLiveWallpaper-Setup-0.3.6-x64.exe -Algorithm SHA256
Get-Content .\outputs\release-candidate\CodexLiveWallpaper-Setup-0.3.6-x64.exe.sha256
```

On a machine with Codex installed and its plugin-capable CLI on PATH, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\windows\verify-installer.ps1 -InstallerPath .\outputs\release-candidate\CodexLiveWallpaper-Setup-0.3.6-x64.exe -WorkRoot .\work\release-verification
```

This performs real isolated install, reinstall and uninstall checks using
temporary profile/data paths. It also starts the bundled MCP, checks its
appearance defaults and validates the launcher without starting Codex.
It refuses to run if this EXE edition is already installed for the current
Windows user. Never remove or bypass that protection.

Separately, manually check first selection, playback, adjustment, restart
restoration and removal on the intended device. Record any untested areas
honestly; a launcher `ValidateOnly` result is not a playback check.

## GitHub Release

After source and installer checks, commit the intended public files, push
`main`, and create a **regular release** tagged `v0.3.6`, titled
`v0.3.6 - 首个正式版`, in
`Yi-sama/Codex-Live-Wallpaper`.

The maintainer explicitly approved publication on 2026-10-11 without further
real-device acceptance. Do not describe the package as fully tested or free of
known issues. State Windows 10 / Windows 11 x64 as the current supported scope.

Attach only:

- `CodexLiveWallpaper-Setup-0.3.6-x64.exe`
- `CodexLiveWallpaper-Setup-0.3.6-x64.exe.sha256`

Use `docs/releases/v0.3.6.md` for this release's notes. Include the original QQ
contact image from `docs/assets/qq-group.jpg` through its tagged raw GitHub URL,
plus the Issues link and group number 1125690897. State that the EXE is unsigned
and include remaining compatibility/validation limits. Do not upload a portable ZIP,
private journals, test profiles, build payloads, debug reports or wallpapers.
GitHub's automatically generated source archives are not a portable edition.
