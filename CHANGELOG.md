# Changelog

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
