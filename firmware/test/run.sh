#!/bin/sh
# Compile profile_switcher.c for the PC against QMK stand-ins and run its tests.
# Linux/macOS: any cc. Windows: from the QMK MSYS shell (its gcc has no sanitizers, so they're skipped).
set -e
cd "$(dirname "$0")"
cc="${CC:-$(command -v cc || command -v gcc)}"
out="${TMPDIR:-${TEMP:-/tmp}}/ps_host_test"
san="-fsanitize=address,undefined -fno-sanitize-recover=all"
if ! echo 'int main(void) { return 0; }' | "$cc" $san -x c -o "$out.probe" - 2>/dev/null; then
  echo "(no sanitizers with this compiler: running without them)"
  san=""
fi
rm -f "$out.probe" "$out.probe.exe"
build() {
  "$cc" -std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter $san \
    -Istubs -I. -DQMK_KEYBOARD_H='"qmk_stubs.h"' "$@"
}
# -DPS_BUILD_ID is what the app adds to rules.mk so the keyboard can name its firmware.
build -DPS_BUILD_ID=0xDEADBEEF -o "$out" host_test.c
"$out"
# A Keychron wireless board: key reports go to the USB driver, not the active transport.
build -DPS_BUILD_ID=0xDEADBEEF -DLK_WIRELESS_ENABLE -o "$out.wireless" host_test.c
"$out.wireless"
# A white backlight (LED matrix), with the module on the _kb hook, then on the _user one.
build -DPS_TEST_WHITE -o "$out.white" white_test.c
"$out.white"
build -DPS_TEST_WHITE -DPS_INDICATORS_USER -o "$out.white_user" white_test.c
"$out.white_user"
