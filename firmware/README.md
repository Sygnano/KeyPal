# Firmware module

`profile_switcher.c` lets the app change key remaps (on every layer of the keymap), macros and per-key colours
(still or animated) on the keyboard, in RAM only. It also keeps each profile's lighting colour and
speed when the effect changes or the lighting wakes from sleep: Keychron's firmware reloads the
saved ones then, which turned a static colour red. Without the module the effects still change,
less reliably, and Keychron's Mix RGB regions still work (they use Keychron's own commands).

Current version: **protocol 1**, the protocol of the app's 1.0 (remaps on every layer, animated colours,
restart into the bootloader from the app, per-key brightness on white backlights, a build id so the app can
name the firmware on the keyboard, a gap between macro keys, and key reports for the app's keyboard tester).
The app talks only to this version: a module from a development build before 1.0 (they reported 2 to 9) is
treated as missing, and Settings → Keyboard says to install the profile switcher again. The app shows no
version number.

A firmware the app builds is stamped with `OPT_DEFS += -DPS_BUILD_ID=0x…`, which STATUS reports back: that is
how the Firmware tab knows which of your firmware projects is on the keyboard. Building by hand leaves it 0,
and nothing else changes.

The simplest way to get it: the app's **Install the profile switcher** (status line, Settings → Keyboard) writes a
ready-made firmware for your keyboard (Keychron's own keymap plus this module, built with each release), with
no build tools. The steps below are for adding it to your own keymap (the app's Firmware tab does them too).

## Add it to your keymap

1. Copy `profile_switcher.c` into your keymap folder, next to `keymap.c`
   (`keyboards/keychron/v6_8k/iso_encoder/keymaps/<yours>/` in Keychron's `qmk_firmware`, branch `2025q3`).
2. Add to that folder's `rules.mk`:

   ```make
   VIA_ENABLE = yes
   DEFERRED_EXEC_ENABLE = yes
   SRC += profile_switcher.c
   ```

3. Build and flash as usual. On Windows, from the **QMK MSYS** terminal:

   ```sh
   cd /c/qmk_firmware
   make keychron/v6_8k/iso_encoder:<yours>
   # then put the keyboard in bootloader mode (hold Esc while plugging it in) and:
   make keychron/v6_8k/iso_encoder:<yours>:flash
   ```

Nothing in `keymap.c` needs to change. The module only defines hooks your keymap can't be using
(`via_custom_value_command_kb`, `keymap_key_to_keycode`, `pre_process_record_kb`, and
`rgb_matrix_indicators_advanced_kb` or, on a white backlight, `led_matrix_indicators_advanced_kb`), and it passes
everything on to the `_user` versions. Features like key overrides, and your own lighting indicators, keep working.

A few Keychron boards define the indicators `_kb` hook in their own code (C1 Pro, Q1 v1, Q9, Q9 Plus, Q11, S1 in
`2025q3`). For them add `OPT_DEFS += -DPS_INDICATORS_USER` to `rules.mk`: the module then takes the `_user` hook,
which their `_kb` one calls first (so your keymap must not define it). The app's Firmware tab and
`scripts/build_module.sh` add that line by themselves when the keyboard needs it.

The build fails with a clear message if `VIA_ENABLE` or `DEFERRED_EXEC_ENABLE` is missing.
If it complains that `pre_process_record_kb` or `keymap_key_to_keycode` is defined twice, your
keymap defines one of them too; send it over and we'll merge them.

If you change `keymap.c` and rebuild **on the same day**, VIA keeps its saved copy of the old
keymap (its "is this a new build?" check only looks at the build date). Clear it with Bootmagic
(hold Esc while plugging the keyboard in) and the new `keymap.c` is loaded. Builds on a new day
reload it on their own.

Macro taps hold the key for 10 ms so games notice them. To change that, add
`#define PS_TAP_HOLD_MS 15` (for example) to your keymap's `config.h`.

After flashing, the app's status line names the active profile instead of saying "the firmware has no
profile switcher", and Settings → Keyboard shows "✓ Profile switcher installed".

## Updating from an earlier version

Replace `profile_switcher.c` in your keymap folder with this one, then build and flash as above.
Nothing else changes. Checked against Keychron `2025q3` with the V6 8K ISO `keychron` keymap: about 74 KB of
flash, about 8 KB of RAM for the module (5.6 KB in version 3: an overlay for each of the 4 layers,
and the animation state). `#define PS_LAYERS 2` in `config.h` covers fewer layers and saves RAM.

## Tests

`test/run.sh` compiles the module for the PC against stand-ins for QMK and replays packets that
the app's Rust code generated (`test/fixture.h`, from `cargo test`). It checks the overlay (every
layer, layer packets, remaps staying on their layer when the Mac/Win switch flips), the knob, macro
playback and timing (also from another layer), the wait-until-idle swap, per-key colours (staging,
brightness, blanking, keys without
an LED), the animations (breathe, hue cycle, light on keypress), Keychron's lighting reload, and bad
input. `test/white_test.c` runs the per-key part on a white backlight (LED matrix), once on the `_kb` hook and once
with `PS_INDICATORS_USER`; its stand-ins bring in `HSV` only with the RGB matrix, like QMK, so a missing include
shows up here rather than on a white board's build.

On Windows run it from the QMK MSYS terminal (or with its `mingw64/bin` on the `PATH`): its gcc has
no sanitizers, so the script runs without them. On Linux or macOS it uses AddressSanitizer and
UBSan.
