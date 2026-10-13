# Changelog

## 1.0.0 - Official Release (2026-10-13)

> Tested successfully by the project maintainer on another Windows 10 computer.
> Before installing, upgrading or uninstalling, save your work and fully exit Codex,
> including background processes. Setup does not close Codex automatically.

- Right-docked wallpaper sidebar, Static filter, nine rotation intervals up to
  12 hours, and a separate gear page for material, theme and font.
- Source-proportional preview with a window-shaped crop frame, Complete/Cover
  modes, and decoded video-frame preview without a second player.
- Refined mascot entry, outside-click dismissal, library refresh on opening,
  and author properties grouped under wallpaper Settings.
- Scene failure explanations and explicitly copyable AI diagnostics.
  This does not fix all Scene allocation, graphics or compatibility failures.
- Keep slow Scene preview requests valid, report snapshot failures, and read
  registered thumbnails through the existing local bridge when HTTP loading
  fails (6 MiB per-image transfer limit).
- Keep thumbnail replies valid across library redraws and reuse the bounded
  image cache instead of discarding successful replies to retired tiles.
- Send ready Scene preview requests without waiting for parent animation frames,
  use unique IDs across sidebar updates, and retain successful snapshots for
  paused playback without asking the renderer for more frames.
- Use the original ChatGPT multi-size icon for the installer, desktop/Start
  menu wallpaper launchers and uninstall display; retain the distinct
  Codex Live Wallpaper shortcut name.
- Check for a running Codex desktop or this installation's wallpaper service
  before installation or uninstall, and show a bilingual exit-and-retry message
  without stopping user processes or skipping locked files.
- Launcher-owned first-use library and saved selection restoration, actual
  Scene render diagnostics, and AAC-preserving large-video conversion.
- Installation-directory `unins000.exe`, Start menu uninstall entry, and
  isolated install/reinstall/uninstall verification with retained-data checks.

All 136 automated regressions and scoped Windows installer checks passed during release
validation. The EXE is unsigned and contains no wallpapers. Scene compatibility
still depends on the project and hardware; customized installations are not
automatically migrated.

## 0.3.6 - First Official Release (2026-10-11)

- Codex window backgrounds from local Wallpaper Engine videos and compatible
  packaged Scenes, with a searchable library and playlist rotation.
- Adjustment controls for fit, position, transparency, blur, author properties,
  optional Scene interaction, and supported audio.
- Saved wallpaper restoration and inactive-window playback pausing.
- Default appearance: background blur 3 px, scrim 10%, panel opacity 20%.
  Existing saved preferences are preserved.
- Per-user Windows 10 / Windows 11 x64 EXE with bundled Node.js, its own launcher, plugin
  registration, diagnostics, and data-preserving uninstall.
- Startup compatibility wait of up to 90 seconds, exact main-page targeting,
  and loopback diagnostics. The original slow-start failure's root cause
  remains unconfirmed.
- Public metadata and configuration no longer refer to a developer data path;
  the internal plugin ID and upstream copyright notices are retained.
- Bilingual installation notes, known-issue disclosures, Issues feedback,
  and the QQ community contact image (group 1125690897).

This first official release still has known compatibility issues. It is unsigned
and does not include wallpaper media or a separate
portable ZIP. Web/Application and unpackaged Scenes use previews; unsupported
Scene effects may differ or fail. Large-video transcoding currently removes
audio. Clean-machine and long-running playback coverage remains limited;
real-device acceptance of this package was waived for this publication.
