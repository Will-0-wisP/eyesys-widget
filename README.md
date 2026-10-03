# 🌀 Eyesys Widget

A floating desktop widget for Windows 11: an eye icon that reacts to live CPU load, and a
glass folder-preview panel that unfolds out of it when you click it.

![platform](https://img.shields.io/badge/platform-Windows%2011-0078D6)
![built with](https://img.shields.io/badge/built%20with-Electron-47848F)
![license](https://img.shields.io/badge/license-MIT-green)

> This is a personal utility project. The eye artwork under `eyes/mangekyou/` was supplied
> during development and may be derived from third-party sources — see
> [License & artwork](#license--artwork) before making the repo public or sharing it further.

---

## Contents

- [What it does](#what-it-does)
- [Getting started](#getting-started)
- [Building a Windows installer](#building-a-windows-installer)
- [Settings](#settings-gear-icon-in-the-panel)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Adding your own eye artwork](#adding-your-own-eye-artwork)
- [Known limitations](#known-limitations)
- [Publishing this repo to GitHub](#publishing-this-repo-to-github)
- [License & artwork](#license--artwork)

## What it does

| CPU load | Eye shown |
|---|---|
| 0–15 % | Simple (1 tomoe) |
| 16–40 % | Double (2 tomoe) |
| 41–70 % | Triple (3 tomoe) |
| 71–100 % | the eye **you selected**, from 15 Mangekyō designs |
| panel open | the same selected eye |

- **Live CPU monitor** drawn as an eye, sampled directly from `os.cpus()` — no extra
  system-monitoring dependency.
- **Eye changes are animated**: spin ramps up fast, a red wave closes in from the edge,
  the eye swaps underneath, the wave opens back out, spin eases back to idle speed.
- The eye **turns slowly all the time** (speed adjustable, 0–60 rpm, 0 = still).
- **Left-click**: the folder panel opens first; the click-spin and eye transition play
  right after, not before.
- **Right-click**: a small menu — **Settings** (jumps straight to the settings section)
  and **Exit**.
- **Direction-aware panel**: opens left, right, up, or down — whichever side of the icon
  has room on your screen — and never runs off-screen.
- **Glass panel** in the Windows 11 Fluent style, with an adjustable blur intensity taken
  from a quick local screenshot of what's behind it (see [How it works](#how-it-works)).
- **Editable panel title** — click it and type.
- **Folder view**: List or Grid, plus **Sort by** (Name / Date modified / Size / Type,
  either direction). Folders always sort first.
- **Drag files out** of the panel onto File Explorer or any other app to copy them there —
  can be switched off entirely in Settings.
- **Overlay or Desktop-only** display mode, with an **eye-opacity** setting that only
  dims the icon while it's actually sitting over another app's window — full strength
  over the bare desktop, always full strength in Desktop-only mode.
- **Custom eyes**: drop your own `.svg` files into a folder opened from Settings and they
  appear in the picker.
- Drag the icon to reposition it; resize it with Ctrl+scroll or the size slider; resize
  the panel by dragging its corner handle. Everything persists between launches.
- Hides dot-files and Office lock files (`~$report.docx`) from the folder listing.

## Getting started

**Prerequisites:** [Node.js LTS](https://nodejs.org) (18+). Check with `node -v`.

```powershell
git clone https://github.com/<your-username>/eyesys-widget.git
cd eyesys-widget
npm install
npm start
```

`npm install` runs `node node_modules/electron/install.js` automatically (the
`postinstall` script) — this repairs the "Electron failed to install correctly" error
that newer npm versions can cause by blocking install scripts. `npm start` runs the same
check first, so it self-heals a broken install too.

## Building a Windows installer

```powershell
npm run dist
```

The installer lands in `dist\`. It's an assisted (not one-click) NSIS installer: it shows
`build\LICENSE.txt` as an agreement page you must accept, lets you choose the install
folder, and creates the shortcuts you ask for. `build\installer.nsh` closes any running
copy of the app before installing or uninstalling, using a standard `taskkill`-based NSIS
hook, so an upgrade or uninstall never gets blocked by a locked file.

> **Note:** the installer customization (`installer.nsh`) was written without access to a
> Windows/NSIS environment to compile-test it. If `npm run dist` errors on it, open an
> issue with the exact message, or drop the `"include": "build/installer.nsh"` line from
> `package.json`'s `nsis` block to build without it.

## Settings (gear icon in the panel)

| Setting | What it does |
|---|---|
| Watched folder | Which folder the panel previews. Native folder picker. |
| View | List or Grid layout for the file list. |
| Sort by | Name / Date modified / Size / Type, ascending or descending. |
| Drag files to copy | Turns outbound drag-and-drop on rows on or off. |
| Show as | *Overlay on apps* (floats above every window) or *Desktop only* (sits behind other windows, comes forward when clicked). |
| Eye opacity | 20–100 %. Overlay mode only, and only while over an app — full strength over the desktop. |
| Spin speed | 0–60 turns/minute idle spin. |
| Glass blur | 0–50 px blur behind the panel. |
| Icon size | 48–160 px (also: Ctrl+scroll over the icon). |
| Selected eye | Which of the 15 Mangekyō designs shows at 71–100% CPU and while the panel is open. |

The panel **title** is edited by clicking it directly, and the **panel size** by dragging
its corner handle — neither lives in the settings list.

All settings persist to `%APPDATA%\eyesys-widget\eyesys-config.json`.

## How it works

- **Two windows, not one.** The eye icon and the glass panel are separate, transparent,
  frameless Electron `BrowserWindow`s. Keeping them separate is what lets the panel open
  in any direction without the icon window resizing or jumping around.
- **The blur is a snapshot, not a live effect.** CSS `backdrop-filter` can't see through
  one transparent window into whatever's behind it in the OS, so just before the panel
  opens the app takes a quick local screenshot of that area, blurs it, and uses it as the
  glass background. It's never saved or sent anywhere, and it doesn't update live — if a
  video is playing behind the panel, the blur won't reflect that until you reopen it.
- **Desktop-only mode and the opacity rule both rely on a tiny helper process.** Electron
  can't put a window at the very bottom of the z-order, or ask what's currently in front,
  on its own. So on Windows, the app spawns one small hidden PowerShell process that (a)
  calls `SetWindowPos(HWND_BOTTOM)` for Desktop-only mode, and (b) reports the foreground
  window's class a few times a second (Overlay mode only) so the widget can tell "over the
  bare desktop" (`Progman`/`WorkerW`) from "over an app" (anything else, including the
  taskbar and File Explorer — a simplification worth knowing about). If PowerShell is
  unavailable, both features fail safe: Desktop-only mode behaves like a normal window,
  and the opacity setting defaults to full strength rather than guessing.
- **Outbound drag-to-copy uses Electron's native drag API** (`webContents.startDrag`), so
  Windows itself performs the actual file copy when you drop an item onto Explorer or
  another app — the widget only starts the OS-level drag.

```

## Adding your own eye artwork

**Without editing code:** open Settings → "Custom eyes folder…", which opens
`%APPDATA%\eyesys-widget\eyes`. Drop any `.svg` file there (square, under
512 KB) and it appears at the end of the eye picker next time you open Settings.

**As a built-in option:** add the `.svg` to `eyes/mangekyou/`, then add a matching entry
to the `EYES` array in `eyes/manifest.js`:

```js
{ id: 'my-eye', name: 'My Eye' }
```

The `id` must match the filename (without `.svg`).

## Known limitations

- **Windows-only features degrade gracefully elsewhere.** Desktop-only mode and the
  opacity-over-apps detection both depend on the PowerShell helper described above; on
  other platforms (or if PowerShell is blocked) they silently fall back to sensible
  defaults rather than breaking.
- **The foreground-window check is a heuristic**, not pixel-precise hit-testing: it treats
  anything that isn't the literal desktop process as "an app," including the taskbar and
  File Explorer.
- **The installer's `installer.nsh` is untested against a real NSIS build** — see the note
  in [Building a Windows installer](#building-a-windows-installer).
- **The glass blur is a point-in-time snapshot**, not a live effect (explained above).


## License & artwork

The **code** in this repository is released under the [MIT License](LICENSE).

The **eye artwork** under `eyes/mangekyou/` is not covered by that license — it was
supplied during development and may be derived from third-party (anime) sources. Before
making this repository public, sharing it, or distributing a built installer:

- Review where that artwork came from and whether you have the right to redistribute it, or
- Replace the contents of `eyes/mangekyou/` and `eyes/basic/` with artwork you have the
  rights to use (see [Adding your own eye artwork](#adding-your-own-eye-artwork)).

`build/icon.ico` and `build/icon-source-2048.png` are original geometric designs created
for this project and are covered by the MIT license along with the rest of the code.
