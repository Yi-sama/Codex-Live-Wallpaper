---
name: wallpaper-engine
description: Use installed Wallpaper Engine projects as a reversible background skin inside the Codex app. Use when the user asks to skin, theme, decorate, or set a Wallpaper Engine background in Codex, list compatible local projects, remove the Codex skin, or generate a native Codex color theme.
---

# Wallpaper Engine Skin for Codex

Use the plugin's `codex_skin` MCP tools. This plugin changes the Codex window, never the Windows desktop wallpaper.

## Workflow

1. Call `codex_skin_status` first.
2. If `bridge.debug.available` is false, call `codex_skin_launch_instructions`. Explain that the user must close Codex and relaunch it with the bundled script, then continue in a new task.
3. Call `codex_skin_list_sources` before applying a skin. Resolve the request to an exact returned `id`; ask the user only if multiple plausible matches remain.
4. Call `codex_skin_apply` with that exact id. Keep video and Scene audio muted unless the user explicitly asks for sound. For requested sound, use `muted: false` and start at `volume: 0.3` unless the user chooses another level.
   Omit appearance parameters unless the user requests adjustments: defaults are `blurPx: 3`, `scrimOpacity: 0.1`, and `panelOpacity: 0.2`. Preserve explicit user choices and saved settings.
5. Call `codex_skin_remove` when the user wants the normal Codex appearance restored.
6. Use `codex_skin_generate_native_theme` when the user wants a supported color/font theme or cannot use the dynamic bridge.

## Rendering expectations

- Small video files render inline. Videos over the compression threshold are automatically transcoded into a full-duration, hardware-friendly cached MP4 before Blob playback. Files still over the Blob limit use a decoded animation sequence, with the project preview as the final fallback.
- Scene projects with a valid `scene.pkg` use the bundled WebWallGL renderer in a separate-origin loopback iframe. The skin launcher enables cross-site process isolation so scene work cannot block the Codex chat thread. Loading completes only after a rendered first frame; initialization/render failures report their cause and use the preview as a fallback. Web and Application projects still use their preview image.
- The launcher initializes Scene frame permission before publishing its ready endpoint: it performs one startup page reload with the permission enabled before document initialization. A late debug injection cannot change the already-initialized frame-src policy. Wallpaper/chat selection never triggers this reload. A blocked frame reports the actual policy failure instead of remaining in loading; do not describe its preview as a successful Scene.
- Do not run scripts/prepare-codex-scene.mjs against an active window without explicit reload consent. It reloads only exact app://-/index.html targets, does not close Codex processes, and is automatically invoked by the skin launcher before the endpoint becomes ready.
- The dynamic skin is experimental because Codex does not expose a public background-image plugin API. The launcher enables a loopback-only Chrome DevTools endpoint and does not modify installed Codex files.
- Scene rendering uses a vendored WebWallGL bundle and does not start the official Wallpaper Engine desktop runtime. Projects that depend on unsupported runtime features may fall back to the preview.
- The selected skin and adjustment settings persist under LocalAppData. When Codex is launched with the bundled loopback debug launcher, the MCP bridge automatically restores the last enabled skin; ending a task must not remove it.
- A normal Codex launch without the debug flag cannot accept a dynamic skin. If status reports the bridge unavailable, give the bundled launcher steps; after relaunch, wait for automatic restoration before asking the user to select the wallpaper again.
- The launcher defaults to `--remote-debugging-port=0`, so the system assigns the port. It captures the native listening address, verifies the exact Codex page, then publishes `debug-endpoint.json` under the skin data directory. The plugin reads the actual port automatically; do not ask the user to pick a fixed port. A null status port means the launcher has not published a ready endpoint yet.
- Report `renderMode`, `fallbackKind`, and `usedPreviewFallback` honestly after apply. Describe `scene` as WebWallGL runtime rendering and `frames` as a decoded animation sequence, not direct video playback.
- Keep `showControls` enabled by default. Tell the user that “皮肤调整” selects a local video or Scene and controls fit mode, zoom, position, panel opacity, background scrim, and blur. Video and Scene modes also provide a “声音” checkbox and “音量 %” slider.
- The panel has adjustment, library and rotation tabs. The library shows registered local thumbnails and supports title/ID search and video/Scene/preview filters; Web and Application projects remain preview-only. Playlist controls add, reorder and remove projects, select previous/next, start/pause rotation, set an interval and choose fade or direct switching. Rotation waits while hidden, unfocused or loading and is owned by the single active renderer, not every chat bridge.
- Scene author controls support bool, slider, color, combo and text values. List metadata includes the full property keys; apply accepts optional `userPropertyValues`. Values are stored per wallpaper in the existing state file and restored when returning to a project or reloading the main document. Unknown and unsupported properties are ignored; source project files are never rewritten.
- Scene mouse interaction is opt-in (`mouseEnabled`). Passive pointer/wheel forwarding excludes controls, editors, menus and dialogs, checks readiness/focus and uses the transformed Scene bounds. It never prevents Codex input or scrolling.
- Scene music comes from the package's own sound layers through the existing WebWallGL audio mixer. Sound and volume settings persist across wallpaper selection and chat controller handoff; muting does not erase the selected volume. A Scene starts silently during initialization and applies audio settings only after its first frame.
- The controls panel stays open across a video switch. It shows indeterminate progress while preparing/transcoding, measured 0–100% progress while transferring, green on completion, and red on failure.
- Video, Scene rendering/music, and frame playback pause automatically while the Codex window is unfocused, minimized, or hidden, and resume when it becomes active.
- Pause is a playback state, not a loading failure. Hidden Scene initialization waits for a visible first frame and identifies that waiting state; video transfer and source preparation keep their own status instead of being overwritten by blur. Inspect actual loading/readiness before treating a paused label as the cause.
- Restoration removes retired CDP targets, resumes a new main document's empty Blob player, and commits a video with its final data chunk. Normal chat restoration still reuses a healthy player. Disconnect unregisters that controller's document-restoration script without removing the live wallpaper.
- An incomplete Blob transfer is not proof that its sender is still running. A reused player lets the current bridge claim the existing byte offset under a new token and send only the remainder; old-token chunks and failures cannot overwrite the new transfer. Version-4 players support this transfer handoff; loaded videos retain normal zero-transfer reuse.
- The elected document-restoration controller reads the shared saved state before accepting captured settings or wallpaper IDs; retained controllers' old injection snapshots must not override newer persisted choices.
- Wallpaper selection is a request claimed atomically by one live bridge, not a command addressed only to the last remembered chat controller. An abruptly lost controller cannot strand selection while another bridge is connected. Superseded requests cannot replace the wallpaper or register a stale document-restoration script. Existing players receive this control update once, then resume normal reuse.
- Scene player, renderer and polyfill bytes are retained when the MCP module starts, so a later plugin-cache cleanup cannot remove a running bridge's Scene resources. The Scene entry page reports player-module import failures to the parent instead of leaving indeterminate loading. Wallpaper Engine packages remain read-only disk sources.
- After upgrading from a bridge without retained Scene assets, check the actual live tool launcher path and runtime protocol, not only the installed manifest. Old chats can keep old or failed bridge processes. A new chat picks up new imports but does not prove all old processes are gone; a full user-controlled close and relaunch through the skin shortcut is required to clear an already mixed/broken runtime. Never restart active Codex tasks automatically.
- Transcoding writes only to the plugin cache under local application data and never changes a Wallpaper Engine source project. Report compression size and resolution when available.

## Safety

- Listing and status calls are read-only.
- Apply and remove affect only the current Codex renderer and are reversible.
- Never call Wallpaper Engine playback or desktop-control commands.
- Never delete or modify Wallpaper Engine projects.
- Never accept an arbitrary filesystem path for injection; apply only ids returned by `codex_skin_list_sources`.
- Connect only to CDP targets whose URL is exactly `app://-/index.html`. Never inspect or inject WebViews, browser tabs, HTTPS pages, login pages, or any non-Codex target.
