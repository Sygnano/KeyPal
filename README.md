# KBoard Companion

**Per-program key remaps, macros and lighting for Keychron keyboards, on Windows.** Focus a game
and your keyboard switches to that game's profile; go back to your desktop and it goes back to
Default. Like Corsair iCUE or Logitech G Hub, for Keychron's QMK keyboards.

> [!WARNING]
> **KBoard Companion replaces your keyboard's firmware.** Remaps and macros need a small module inside the
> keyboard's firmware, so KBoard Companion (or you, by hand) writes a new firmware to the keyboard: Keychron's
> own keymap with that module added. Read this before you flash:
>
> - **Your keyboard's own saved settings are reset** to Keychron's defaults (its keymap, lighting
>   and Mix RGB as saved with Keychron Launcher or VIA). Your KBoard Companion profiles are not affected:
>   they live on your PC.
> - **Don't unplug the keyboard while the firmware is being written** (a few seconds). If a flash
>   is interrupted anyway, the keyboard isn't broken: the bootloader that receives firmware is in
>   the chip's read-only memory. Hold Esc while plugging it in (or press the reset button under the
>   space bar keycap) and flash again.
> - **You can always go back.** Before every flash KBoard Companion reads the firmware that is on
>   the keyboard into a backup (with, on most models, its own saved keymap and lighting), and
>   _Firmware backups_ (Settings → Keyboard, or the Firmware tab) writes one back. Turn
>   off _Back up the keyboard's firmware first_ to skip it. Keychron's own firmware from their
>   website, flashed the same way, also puts the keyboard back as it came.
> - **Only the Keychron V6 8K ISO has been tried so far.** KBoard Companion knows every Keychron model in
>   Keychron's own firmware (271 of them) and treats them all the same way, but none of the others
>   has run on real hardware yet. If you try another model, please
>   [open an issue](https://github.com/Sygnano/kboard-companion/issues) saying how it went.
>
> KBoard Companion is free software, provided as is, without warranty (see the [licence](LICENSE)).

## Features

- **Profiles per program.** Attach programs to a profile by file name, exact path, a whole folder,
  or a window title ("only while the title contains _Figma_"), or pick them from the windows open
  right now. The most specific rule wins; Default is used when nothing matches. As many profiles as
  you like: they live on your PC, and the keyboard only ever holds the active one, in its memory.
- **Remaps on every layer** of the keymap, the knob included: another key, any QMK keycode
  (`LT(2, KC_SPC)`, `LCTL(KC_C)`…), a macro, or nothing.
- **Macros**: recorded from your keyboard (with or without the timing), typed text (KBoard Companion works out
  the keys for your keyboard layout, AZERTY included), delays, and an adjustable gap between keys
  for games that read the keyboard once per frame. Every macro is kept in a **macro bank**, to reuse
  on any key of any profile, linked (edit once, every key follows) or as a copy.
- **Lighting per profile**, like layers in an image editor: a base effect with **colour layers** on
  top, each still, breathing, cycling through colours, or lighting up when pressed. Or Keychron's
  **Mix RGB**: groups of keys each playing their own effects in turn. White-backlight models get
  brightness layers. The keyboard on screen plays the lighting as you edit it.
- **Keyboard tester**: every key going down and up on the drawn keyboard, Fn and the knob included,
  with an optional key sound.
- **Firmware made easy**: one click installs the ready-made firmware for your model, or write and
  compile your own keymap in KBoard Companion's built-in editor.
- **Undo/redo** for every edit, **export and import** of profiles, a **tray** menu to force a
  profile, **start with Windows**, notifications when the profile changes, light and dark themes,
  and automatic updates.

## What you need

- **Windows 10 or 11.**
- **A Keychron keyboard** from their QMK range (Q, Q Max, Q Pro, Q HE, V, V Max, K Pro, K Max, C Pro,
  the 8K models…), **plugged in with its USB cable**. Wireless connections aren't supported.
- **KBoard Companion's firmware on the keyboard** for remaps, macros and per-key lighting. Without it, only the
  lighting effects change. KBoard Companion installs it for you (see below).

## Install

1. Download `KBoard.Companion_x.y.z_x64-setup.exe` from the
   [releases](https://github.com/Sygnano/kboard-companion/releases/latest) and run it.
   Windows may warn that the publisher is unknown, because the installer isn't code-signed: choose
   _More info → Run anyway_.
2. Start KBoard Companion and plug in your keyboard. KBoard Companion recognises the model and draws it. On first start
   it reads the keyboard's keymap and lighting, and Default takes the keyboard's current lighting,
   so switching back from a game lands exactly where you started.
3. **Install the firmware**: the status line says the profile switcher is missing. Click
   _Install it…_ (also in Settings → Keyboard), read what it does, then follow the steps: KBoard Companion
   downloads the firmware made for your model and a few small flashing tools (about 0.5 MB), then
   waits for the keyboard's bootloader. Click _Restart into bootloader_ if it's offered, or unplug
   the keyboard, hold **Esc**, and plug it back in. If Windows has no driver for the bootloader,
   KBoard Companion offers _Install the driver_ (Windows asks for permission). The keyboard restarts with the new firmware.

KBoard Companion updates itself: it checks at start, and Settings → Updates installs a new version (updates
are signed and checked).

**Coming from KeyPal, Keychron Companion App or V6 Profile Switcher** (KBoard Companion's earlier names): install
KBoard Companion and start it once. It moves your profiles, settings, firmware projects, downloads and "Start
with Windows" over. Then uninstall the old app.

## Using KBoard Companion

### Profiles and programs

1. **+ New** makes a profile (a copy of Default). Name it, then **Add program…** under it:
   _From open windows…_ is the easiest (start the game first), or browse for the `.exe` or a folder.
   Click a program to edit its rule (match the name, the exact path, or a folder; add a window
   title).
2. Drag profiles to reorder them: when two match a program equally well, the higher one wins.
3. **Apply** saves your changes and sends them to the keyboard. **Discard** goes back to what was
   applied. Ctrl+Z / Ctrl+Y undo and redo any edit.

The status line at the top says which profile is active. The play button on a profile forces it,
whatever program is in front; the X goes back to automatic switching.

### Keys

- Click a key to remap it: another key, a QMK keycode, a macro, or _Disable_.
- The tabs above the keyboard are its **layers**. The dot marks the one in use (the Mac/Win switch
  picks it), _Fn_ marks layers a key turns on while held. Double-click a tab to rename it. A key with
  nothing of its own on a layer shows, dimmed, what it falls through to.
- Right-click keys, or drag a box around several, for more: reset, disable, colour.

### Macros

Choose _Macro_ on a key, then click the recorder and press keys. _Record timing_ keeps the pauses;
_Add text_ types a text; _Add QMK code_ adds a key Windows would catch (the Windows key, Alt+Tab);
_Add delay_ adds a pause. _Gap between keys_ sets the wait after each key (10 ms by default, set in
Settings): raise it if a game misses letters. Macros you've made are in every key's _Macro_ tab, to reuse
linked or as a copy.

### Lighting

On the **Lighting** tab, pick a mode: the same as Default, an effect with colour layers, or Mix RGB.
**+ Add layer**, pick a colour, then click keys to paint them. A layer can be still, breathe, cycle
colours or light up when pressed. _Live preview_ shows every change on the keyboard as you make it.

### Keyboard tester

_Test keyboard_ (top right) shows each key going down and up and counts the ones you've tried.
_Test keyboard_ again to leave.

### Firmware mode

_Firmware_ at the top of the sidebar. The toggle at the bottom of the sidebar picks one of two ways:

- **Basic mode** installs KBoard Companion's ready-made firmware for your keyboard (the same as _Install it…_).
  Nothing to write or build.
- **Advanced mode** is for writing your own keymap. KBoard Companion gets what's needed (QMK MSYS, the build
  tools, about 5 GB with Keychron's firmware source; Windows asks for permission to install them),
  makes **firmware projects** from Keychron's keymaps or a keymap folder you have, with KBoard Companion's
  module added, and gives you an editor (Ctrl+S saves). **Test build** compiles and points at any
  errors; **Flash…** builds and writes it to the keyboard. When a KBoard Companion update brings a new module,
  the project offers _Update the module_.

[firmware/README.md](firmware/README.md) explains how to add the module to a keymap by hand, if you
build with QMK yourself.

### Settings

The gear at the top right: theme, start with Windows, what closing the window does (KBoard Companion keeps
running in the tray by default), notifications, which keyboard layout the key labels follow
(AZERTY, QWERTZ…), the default gap between macro keys, export and import of all profiles, updates,
and the logs.

## Troubleshooting

The status line says why the keyboard can't be used:

| It says | What to do |
| --- | --- |
| _Keyboard not found_ | Plug it in with its USB cable (not wireless). |
| _…its firmware has no Raw HID interface_ | Its firmware can't talk to programs: _Install it…_ puts KBoard Companion's firmware on it. |
| _…no profile switcher_ | Only the lighting effects change. _Install it…_ adds the module. |
| _…a version this app can't talk to_ | The keyboard has another version of KBoard Companion's module. Install the profile switcher again from KBoard Companion, or update KBoard Companion. |
| _Windows would not open it_ | Close VIA or Keychron Launcher, which can hold the keyboard. |

- **Remaps show the wrong letters** (A instead of Q): Settings → Key labels, pick your keyboard
  layout. The keyboard only knows key positions; what they type is Windows' business.
- **A game misses letters of a macro**: raise the gap between keys (the macro's own, or Settings).
- **Flashing waits for the bootloader forever**: unplug the keyboard, hold Esc, plug it back in
  while holding it. If Windows has no driver for it, KBoard Companion says so: _Install the driver_, then flash again.

To report a problem: turn on Settings → _Detailed logs_, make it happen again, and attach `v6ps.log`
(Settings → _Open logs folder_) to an [issue](https://github.com/Sygnano/kboard-companion/issues).

## Where your data is

| What | Where |
| --- | --- |
| Profiles, settings | `%APPDATA%\fr.sygnano.kboard-companion\` (`profiles.json`, `settings.json`) |
| Firmware projects | `%APPDATA%\fr.sygnano.kboard-companion\firmware\` |
| Logs | `%LOCALAPPDATA%\fr.sygnano.kboard-companion\logs\` |
| Downloaded firmware and tools | `%LOCALAPPDATA%\fr.sygnano.kboard-companion\qmk\` (if that path has a space, its short name or `C:\ProgramData\KBoardCompanion\qmk\`) |

Settings → _Open settings folder_ and _Open logs folder_ open them. A `profiles.json` that can't be
read is set aside as `profiles.json.<time>.bad`, never overwritten. To uninstall, use Windows'
_Installed apps_; these folders stay unless you delete them.

## Building from source

Prerequisites (once): [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/installation)
(`winget install pnpm`), Rust and the MSVC build tools, then a new terminal:

```bat
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```sh
pnpm install
pnpm dev                  # the full app
pnpm dev:ui               # the UI alone in a browser, with a pretend keyboard
pnpm build                # the installer (src-tauri/target/release/bundle/nsis)
pnpm test                 # UI tests; also: pnpm run typecheck, pnpm run lint, pnpm run e2e
cd src-tauri && cargo test          # the Rust core
firmware/test/run.sh                # the firmware module, on the PC
```

[firmware/README.md](firmware/README.md) explains the firmware module and how to add it to a keymap
by hand. How KBoard Companion talks to it is in `src-tauri/src/protocol.rs` (the app's side) and
`firmware/profile_switcher.c` (the keyboard's).

## Licence

[GPL-3.0-or-later](LICENSE): the app, the firmware module (built into QMK, GPL-2.0-or-later,
compatible) and the keyboard data generated from Keychron's GPL firmware.

Keychron is a trademark of Keychron, iCUE of Corsair, and G Hub of Logitech. KBoard Companion is an independent
project, not made or endorsed by any of them.
