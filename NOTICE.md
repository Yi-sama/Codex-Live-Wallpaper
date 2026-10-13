# Project lineage and acknowledgements

Codex Live Wallpaper extends [JonathandNidhog/dsh-plugin-wallpaper-engine-codex](https://github.com/JonathandNidhog/dsh-plugin-wallpaper-engine-codex), which began as a Wallpaper Engine integration for DSH (DeepSeek Harness) and was subsequently rewritten as a native Codex plugin. The original MIT copyright and permission notice are retained in `LICENSE`.

The original DSH-oriented implementation is available in the upstream Git history, beginning with commit [`ed0ec55`](https://github.com/JonathandNidhog/dsh-plugin-wallpaper-engine-codex/commit/ed0ec55a4095c4dfe1dfa295ffe4aca4ae00328d). The current version retains the project-discovery concept while replacing the DSH/Cordis runtime, client bundle, routes, and UI integration with:

- a Codex plugin manifest and skill;
- a local MCP server;
- a Codex-only, allowlisted CDP bridge;
- automatic video compression and cache reuse;
- in-Codex skin controls, video selection, loading progress, and inactive-window pausing.

DSH, Codex, Steam, Wallpaper Engine, and Wallpaper Engine project content are trademarks or works of their respective owners. This project does not include third-party wallpaper media and does not modify Wallpaper Engine source projects.

## Bundled Scene renderer

The files under `src/webwallgl/assets/` include the WebWallGL Scene renderer used by the Scene path of the reference DSH integration, [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine). The bundled renderer retains its upstream notices crediting Vanilagy and contributors and identifying the Mozilla Public License, version 2.0 (MPL-2.0). The renderer bundle and module-preload polyfill are vendored without source modification. The loopback renderer response appends a small Codex lifecycle adapter that exposes the pinned bundle's first-frame, error and diagnostic callbacks; `src/scene-player.mjs` hosts it in a separate-origin iframe and communicates with Codex through messages.

The MPL-2.0 text is available at <https://www.mozilla.org/en-US/MPL/2.0/>.

## Bundled icons

The wallpaper sidebar uses Lucide icons from `src/assets/lucide.min.js`.
Their ISC license and attribution are retained in `src/assets/lucide-LICENSE.txt`.

The Windows launcher and installer use the unmodified `icon-chatgpt.ico`
resource from the locally installed Codex desktop app. The ChatGPT mark belongs
to OpenAI and is not covered by this project's MIT license. It identifies the
app launched by the wallpaper shortcut; this remains an independent community
project, not an official OpenAI installer. Icon provenance is recorded in
`packaging/windows/assets/README.md`.
