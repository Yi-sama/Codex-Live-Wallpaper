# Codex Live Wallpaper

**English** | [简体中文](README.zh.md)

Bring local Wallpaper Engine videos and compatible Scene wallpapers into the Codex desktop app. Browse and switch wallpapers, adjust transparency and blur, control audio, and restore your last background when the skin bridge starts.

This changes the **Codex window background**, not the Windows desktop wallpaper. It does not require DSH or Cordis.

> **Official release: v1.0.0, rebuilt on October 15, 2026.** Includes preview-service and author-settings fixes. Windows 10 / Windows 11 x64, unsigned EXE installer only; no separate portable ZIP. The original release was tested successfully on another Windows 10 computer by the project maintainer. This is an independent community project using an experimental local debug bridge.

[Download v1.0.0](https://github.com/Yi-sama/Codex-Live-Wallpaper/releases/tag/v1.0.0) | [Release notes](docs/releases/v1.0.0.md) | [Changelog](CHANGELOG.md) | [Issues](https://github.com/Yi-sama/Codex-Live-Wallpaper/issues)

## Features

- **Video and Scene backgrounds:** looping video and compatible packaged `scene.pkg` projects rendered through WebWallGL.
- **Wallpaper sidebar:** right-docked library, local thumbnails, title/ID search, and Static, Video, Scene, or Preview filters.
- **Interface settings:** a separate gear page for panel material, light/dark/system theme, and font.
- **Appearance controls:** fit mode, zoom, position, panel transparency, background scrim, and blur.
- **Author properties:** supported Scene switches, sliders, color swatches, menus, and text inputs, saved per wallpaper; author notes and safe links are separately collapsed.
- **Playlist rotation:** add, reorder, or remove wallpapers, select previous/next, choose an interval, and use fade or direct transitions.
- **Audio controls:** mute and volume for playable video tracks and compatible Scene sound layers.
- **Optional Scene interaction:** passive mouse forwarding that excludes Codex inputs, menus, dialogs, and skin controls.
- **Automatic pause and restore:** pause rendering/audio while Codex is inactive; restore the saved wallpaper and settings when the plugin bridge starts.
- **Video preparation:** cache large-video conversions and show preparation/transfer progress.
- **Reversible skin:** remove the background without changing Wallpaper Engine source projects or Codex installation files.
- **Native theme export:** generate a `codex-theme-v1` color-theme string.

New selections default to **3 px background blur, 10% background scrim, and 20% panel opacity**. Explicit adjustments and saved settings take precedence.

## Compatibility

| Wallpaper type | Current behavior |
| --- | --- |
| Video | Inline or Blob playback when the format is supported; large videos may be transcoded and cached |
| Packaged Scene (`scene.pkg`) | WebWallGL rendering; unsupported effects or failed initialization may use the project preview |
| Loose Scene (`scene.json`) | Preview only |
| Web / Application | Preview only; their HTML or executable is not launched |

WebWallGL is not the official Wallpaper Engine runtime. Some Scene effects, models, fonts, or audio behavior may differ or fail to render.

Large-video conversion defaults to a full-duration MP4 capped at 2560x1440, 30 FPS, and about 10 Mbps, preserving source audio as AAC when present. Old silent cache entries are not reused by the new conversion. Frame fallback uses a short decoded animation, not the complete original video.

## Requirements

- Windows 10 / Windows 11 x64 with the official Codex desktop app installed. macOS, Linux and Windows ARM64 packages are not provided.
- The EXE includes Node.js; a source installation needs Node.js 22 or newer, available as `node`.
- A Codex CLI with plugin commands available; check with `codex plugin --help`.
- Wallpaper Engine project files already downloaded locally.
- Windows PowerShell for the launcher and transcoder. PowerShell 7 (`pwsh.exe`) is needed only for frame-animation fallback.

The Node implementation uses built-in modules; `npm install` is not required.

## Windows EXE Installation

Before installing, upgrading, or uninstalling, save your work and fully exit Codex, including background processes. Closing its window may leave it running; check Task Manager if necessary. Setup checks for a running Codex desktop or this installation's wallpaper service before replacing files, and asks you to exit and retry. It does not close or restart any process automatically.

1. Run `CodexLiveWallpaper-Setup-1.0.0-x64.exe`. The installer checks Codex plugin support, installs for the current Windows user, and registers the wallpaper plugin. It does not install Codex or Wallpaper Engine.
2. Open **Codex Live Wallpaper** from the Start menu or desktop shortcut.
3. Select a local Wallpaper Engine project in the wallpaper library. Later launcher starts restore the saved background. Listing and applying wallpapers through Codex tools is also available.

The installer includes the plugin, not wallpaper media. A clean launcher start opens the library without applying a wallpaper; adjustment controls appear after selecting a local project.

The release attachments are `CodexLiveWallpaper-Setup-1.0.0-x64.exe` and its `.sha256` file. Compare the EXE's SHA-256 with that file before installation:

```powershell
Get-FileHash .\CodexLiveWallpaper-Setup-1.0.0-x64.exe -Algorithm SHA256
```

The default application directory is `%LOCALAPPDATA%\Programs\CodexLiveWallpaper`; wallpaper settings and caches use `%LOCALAPPDATA%\CodexLiveWallpaper\data`. The installer honors an explicit `CODEX_HOME` or `CODEX_SKIN_DATA_DIR` environment value on the first install. Reinstallation retains the recorded profile and data directory. It uses the bundled Node executable and generates matching launcher/MCP paths; no manual JSON edits are needed for this installation method.

Run `unins000.exe` in the installation directory to uninstall. The Start menu also has **Uninstall Codex Live Wallpaper**, and Windows Installed apps provides the same uninstaller. It removes this edition's application files, plugin and marketplace registration, but keeps wallpaper settings/caches and Codex account files. Do not delete the directory manually instead of running the uninstaller.

If the same wallpaper plugin is already installed from another marketplace, setup stops instead of replacing it. Existing customized installations should keep their current launcher and settings until a deliberate migration is performed; this installer does not migrate those installations automatically.

The unsigned installer may trigger a Windows warning. Download only from this repository and verify the SHA-256; do not disable security software to install it.

Setup does not run protected Store CLI files in place, change WindowsApps permissions, enable developer mode, or request administrator mode. Store apps use package-context launch; non-Store apps use direct launch. Verified private CLI copies are retained separately from wallpaper data so in-use executable files need not be deleted.

The launcher waits up to 90 seconds for the exact Codex main page and stops waiting if its process exits. This is a startup compatibility measure, not proof of the original failure's root cause. Source launchers accept `-StartupTimeoutSeconds` from 1 to 300.

Installation diagnostics normally remain in `%LOCALAPPDATA%\CodexLiveWallpaper\logs`. Launcher diagnostics are in the wallpaper data directory's `launcher.log`. `scripts/diagnose-launcher.cmd` checks both loopback addresses of an already running instance and writes a report beside itself; it does not restart Codex or read authentication files. Review logs for personal paths before sharing them.

## Tested and Known Limits

- The project maintainer tested this version successfully on another Windows 10 computer and confirmed that the previously reported workflow now works.
- All 140 automated regression tests passed for the October 15 replacement build. Checks cover the sidebar and crop mapping, preview-service handoff, author-note classification, saved settings, audio-preserving transcoding, release metadata, installer process checks, and launcher icons.
- Isolated Windows install/reinstall/uninstall checks passed during version 1.0.0 validation, including retention of wallpaper settings, caches and a synthetic account-file fixture.
- Passing these checks does not mean every Scene effect, hardware configuration or long-running workload is supported. Unsupported Scene projects may show a preview or an actionable error; Web/Application projects remain preview-only.
- The replacement build has not repeated the earlier Windows 10 cold-start or long-duration device checks. To update an existing 1.0.0 installation, download the rebuilt EXE and matching checksum, fully exit Codex, and run the installer again.
- Codex updates can affect the experimental bridge. Existing customized plugin installations are not automatically migrated.

## Source Setup

The steps below are for a new developer installation and require manual path configuration. Existing customized installations should keep their current profile, marketplace, storage paths, and launcher.

### 1. Arrange the source

Download this version of the source and place its plugin root in a workspace such as:

```text
D:\CodexLiveWallpaper\
  .agents\
    plugins\
      marketplace.json
  plugins\
    dsh-plugin-wallpaper-engine-codex\
      .codex-plugin\
      .mcp.json
      package.json
      scripts\
      src\
```

The public project name is **Codex Live Wallpaper**. The internal plugin ID remains `dsh-plugin-wallpaper-engine-codex` for compatibility with existing installations.

### 2. Align the data paths

The published `.mcp.json` contains no machine-specific data path. By default, both the source MCP server and launcher use `%LOCALAPPDATA%\CodexWallpaperEngineSkin`.

For a custom source data directory, set `CODEX_SKIN_DATA_DIR` in the MCP environment and pass the same directory through the launcher's `-DataDir` parameter. Use doubled backslashes in JSON. The commands below use the example custom directory `D:\CodexLiveWallpaper\data`.

Keep `CODEX_SKIN_CDP_PORT` at `"0"` in `.mcp.json`. The launcher chooses an available loopback port and publishes it automatically.

EXE installation configures both sides automatically. A custom Codex profile additionally requires the corresponding launcher's `-CodexHome` argument.

### 3. Register a local marketplace

Create `.agents/plugins/marketplace.json` under the workspace root:

```json
{
  "name": "codex-live-wallpaper",
  "interface": {
    "displayName": "Codex Live Wallpaper"
  },
  "plugins": [
    {
      "name": "dsh-plugin-wallpaper-engine-codex",
      "source": {
        "source": "local",
        "path": "./plugins/dsh-plugin-wallpaper-engine-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Then run:

```powershell
codex plugin marketplace add "D:\CodexLiveWallpaper"
codex plugin add dsh-plugin-wallpaper-engine-codex@codex-live-wallpaper
```

For the underlying plugin layout and marketplace format, see the [official OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins).

### 4. Validate and launch

Check the launcher without starting or stopping Codex:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\CodexLiveWallpaper\plugins\dsh-plugin-wallpaper-engine-codex\scripts\launch-codex-with-skin.ps1" -DataDir "D:\CodexLiveWallpaper\data" -ValidateOnly
```

Finish or save active tasks, close all Codex windows yourself, then launch:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\CodexLiveWallpaper\plugins\dsh-plugin-wallpaper-engine-codex\scripts\launch-codex-with-skin.ps1" -DataDir "D:\CodexLiveWallpaper\data"
```

If Codex is already running, the launcher asks before restarting it. Declining leaves it untouched. Scene permission initialization includes one startup page reload; do not run the separate initializer against an active task.

## Usage

In a new Codex chat, ask:

- "List the local Wallpaper Engine projects I can use as a Codex background."
- "Apply this wallpaper and make the panels more transparent."
- "Enable wallpaper sound at 30% volume."
- "Remove the Codex wallpaper."
- "Generate a dark native Codex color theme."

Once a wallpaper is applied, the sidebar provides **appearance**, **library**, **rotation**, and wallpaper **settings** tabs. The separate gear page contains general interface settings. After a later skin-launcher start, the plugin bridge restores the saved selection and settings. Starting Codex from its normal icon does not enable the wallpaper debug bridge.

If discovery fails, set `WALLPAPER_ENGINE_HOME` to the Wallpaper Engine directory or `WALLPAPER_ENGINE_STEAM_ROOT` to the Steam root in the MCP process environment.

## Storage and Removal

The configured data directory holds `state.json`, `debug-endpoint.json`, launcher logs, and the `transcoded/` cache. It does not replace the user's Codex configuration or authentication.

To return to the normal appearance, ask Codex to remove the wallpaper; `codex_skin_remove` removes the injected layer and clears the saved selection. You can then use the regular Codex launcher.

To uninstall a plugin installed with the example marketplace:

```powershell
codex plugin remove dsh-plugin-wallpaper-engine-codex@codex-live-wallpaper
```

This removes the plugin cache, not Wallpaper Engine projects or the separate skin data directory.
For EXE installations, run `unins000.exe` from the installation directory or use Windows Installed apps so the installer can remove its files and marketplace registration as well.

## How It Works and Limits

The launcher starts the installed Codex executable with a loopback Chrome DevTools endpoint. The local MCP bridge discovers registered Wallpaper Engine projects and injects a background only into the exact Codex main-page URL `app://-/index.html`. Scene content runs in a separate-origin loopback iframe with cross-site process isolation.

- Codex application files are not patched or replaced.
- Wallpaper Engine projects are read-only; apply accepts discovered project IDs, not arbitrary media paths.
- Browser tabs, login pages, and other debug targets are excluded from injection.
- The debug endpoint can control the Codex renderer. Keep it local and do not expose or forward its port.
- Dynamic backgrounds use an experimental debug integration, not an official wallpaper extension point. Codex app updates may require compatibility fixes; switching AI models alone does not imply the skin must be reconfigured.

## Development

From the plugin root:

```powershell
npm run verify
```

Windows CI runs this command with Node.js 24.14.0. Regression tests use isolated fixtures and do not require a Codex or Wallpaper Engine installation or restart the real app. The separate EXE lifecycle check below requires Codex to be installed.

Build the Windows installer from the plugin root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\build-windows-installer.ps1"
```

The build downloads checksum-pinned Node.js 24.14.0 and Inno Setup 7.1.0, extracts the compiler in portable mode, and creates `outputs/windows/CodexLiveWallpaper-Setup-1.0.0-x64.exe` plus a SHA-256 checksum. End users do not need the compiler, Node, or an archive extractor.

Run the installer checks with an isolated profile and data directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\packaging\windows\verify-installer.ps1" -InstallerPath ".\outputs\windows\CodexLiveWallpaper-Setup-1.0.0-x64.exe" -WorkRoot ".\work\windows-installer\verification"
```

This check performs a real silent install/reinstall/uninstall without launching Codex. It refuses to run when this EXE edition is already registered for the current Windows user.

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Plugin manifest and current internal identity |
| `.mcp.json` | Local MCP server and environment |
| `scripts/mcp-server.mjs` | MCP tool server |
| `scripts/launch-codex-with-skin.ps1` | Skin-enabled Codex launcher |
| `scripts/prepare-codex-scene.mjs` | Startup Scene permission initialization |
| `scripts/build-windows-installer.ps1` | Checksum-pinned Windows EXE build |
| `packaging/windows/` | Setup definition, registration, installed launcher, and isolated installer check |
| `src/codex-skin.mjs` | Skin bridge, playback, persistence, and restoration |
| `src/skin-controls.mjs` | Library, rotation, and passive Scene interaction |
| `src/scene-runtime.mjs` | Loopback Scene assets and project resources |
| `src/webwallgl/assets/` | Vendored renderer assets |
| `skills/wallpaper-engine/` | Codex tool workflow |
| `test/` | Node regression tests |
| `docs/RELEASING.md` | Release checks and EXE-only publication procedure |

The source and EXE retain the internal plugin ID for compatibility. Public metadata points to this repository. The EXE configures its own local marketplace without changing the source `.mcp.json` or an existing customized installation. Local project journals, credentials, caches, build outputs, and wallpaper media are not release source content.

## Feedback and QQ Group

For problems, suggestions, or compatibility reports, [open an Issue](https://github.com/Yi-sama/Codex-Live-Wallpaper/issues/new) or scan the image to join the QQ group **超级ai**, group number **1125690897**.

<img src="docs/assets/qq-group.jpg" alt="QQ group: 1125690897" width="360" />

Do not share Codex account files, API keys, access tokens, or unchecked full logs in Issues or the group.

## Credits and License

This version extends [JonathandNidhog/dsh-plugin-wallpaper-engine-codex](https://github.com/JonathandNidhog/dsh-plugin-wallpaper-engine-codex), which evolved from a DSH Wallpaper Engine integration. Its Scene path also references [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine). Runtime details and third-party notices are recorded in [NOTICE.md](NOTICE.md).

The main plugin code is licensed under [MIT](LICENSE), with the original copyright and permission notice retained. Bundled third-party code keeps its own notices, including MPL-2.0 notices in the Scene renderer bundle; it is not covered solely by the main MIT label.
The EXE includes the Node.js license and MPL-2.0 license text under `runtime/`. The build compiler currently runs without a commercial license; maintainers should review [Inno Setup's licensing guidance](https://jrsoftware.org/isorder.php) for their usage.

Wallpaper media is not included. Wallpaper Engine projects and Codex, Steam, and Wallpaper Engine names belong to their respective owners. This is an independent community project, not an official OpenAI or Wallpaper Engine product.
