#!/bin/sh
# Builds a Keychron keyboard's firmware with the profile switcher module added to one of its keymaps,
# the way the app's Firmware mode does (a copy as keymap "ps_check", module file + rules.mk lines).
#
#   QMK_DIR=/path/to/keychron/qmk_firmware scripts/build_module.sh keychron/v6_8k/iso_encoder [keymap]
#
# keymap defaults to Keychron's "keychron" (what they ship, with VIA), else "via", else "default".
# Used by CI on a few boards; works in QMK MSYS too. The copy is removed afterwards.
set -e
: "${QMK_DIR:?set QMK_DIR to a Keychron qmk_firmware checkout}"
KB="$1"
TEMPLATES="${2:-keychron via default}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# QMK looks for keymaps in the keyboard's folder, then its parents.
src=""
for TEMPLATE in $TEMPLATES; do
  dir="$QMK_DIR/keyboards/$KB"
  while [ "$dir" != "$QMK_DIR/keyboards" ]; do
    if [ -d "$dir/keymaps/$TEMPLATE" ]; then src="$dir/keymaps/$TEMPLATE"; break; fi
    dir="$(dirname "$dir")"
  done
  [ -n "$src" ] && break
done
[ -n "$src" ] || { echo "$KB has none of the keymaps: $TEMPLATES" >&2; exit 1; }

dest="$QMK_DIR/keyboards/$KB/keymaps/ps_check"
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
cp -r "$src" "$dest"
trap 'rm -rf "$dest"' EXIT
cp "$ROOT/firmware/profile_switcher.c" "$dest/"
rules="$dest/rules.mk"
[ -f "$rules" ] && [ -n "$(tail -c1 "$rules")" ] && echo >> "$rules"
grep -q '^VIA_ENABLE *= *yes' "$rules" 2>/dev/null || echo 'VIA_ENABLE = yes' >> "$rules"
grep -q '^DEFERRED_EXEC_ENABLE *= *yes' "$rules" 2>/dev/null || echo 'DEFERRED_EXEC_ENABLE = yes' >> "$rules"
echo 'SRC += profile_switcher.c' >> "$rules"
# Boards whose own code takes the indicators _kb hook: the module uses _user instead.
dir="$QMK_DIR/keyboards/$KB"
while [ "$dir" != "$QMK_DIR/keyboards" ]; do
  if cat "$dir"/*.c 2>/dev/null | grep -q '_matrix_indicators_advanced_kb *('; then
    echo 'OPT_DEFS += -DPS_INDICATORS_USER' >> "$rules"
    break
  fi
  dir="$(dirname "$dir")"
done

echo "Building $KB with the profile switcher module (from keymap $TEMPLATE)"
make -C "$QMK_DIR" SKIP_GIT=yes "$KB:ps_check"
