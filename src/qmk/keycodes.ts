import { KEYCODE_TABLE } from "./keycodes.generated";

/** Legacy names still widely used in keymaps (QMK renamed mouse keys to MS_*). */
const LEGACY_ALIASES: Record<string, string> = {
  KC_BTN1: "MS_BTN1", KC_BTN2: "MS_BTN2", KC_BTN3: "MS_BTN3", KC_BTN4: "MS_BTN4",
  KC_BTN5: "MS_BTN5", KC_BTN6: "MS_BTN6", KC_BTN7: "MS_BTN7", KC_BTN8: "MS_BTN8",
  KC_MS_U: "MS_UP", KC_MS_D: "MS_DOWN", KC_MS_L: "MS_LEFT", KC_MS_R: "MS_RGHT",
  KC_WH_U: "MS_WHLU", KC_WH_D: "MS_WHLD", KC_WH_L: "MS_WHLL", KC_WH_R: "MS_WHLR",
  KC_ACL0: "MS_ACL0", KC_ACL1: "MS_ACL1", KC_ACL2: "MS_ACL2",
};

export const QK = {
  BASIC_MAX: 0x00ff,
  MODS: 0x0100,
  MODS_MAX: 0x1fff,
  MOD_TAP: 0x2000,
  MOD_TAP_MAX: 0x3fff,
  LAYER_TAP: 0x4000,
  LAYER_TAP_MAX: 0x4fff,
  LAYER_MOD: 0x5000,
  LAYER_MOD_MAX: 0x51ff,
  TO: 0x5200,
  MOMENTARY: 0x5220,
  DEF_LAYER: 0x5240,
  TOGGLE_LAYER: 0x5260,
  ONE_SHOT_LAYER: 0x5280,
  ONE_SHOT_MOD: 0x52a0,
  LAYER_TAP_TOGGLE: 0x52c0,
  USER: 0x7e40,
  USER_MAX: 0x7fff,
} as const;

const byName = new Map<string, number>();
const byValue = new Map<number, string[]>();
for (const [name, value] of KEYCODE_TABLE) {
  byName.set(name, value);
  const list = byValue.get(value) ?? [];
  list.push(name);
  byValue.set(value, list);
}
for (const [legacy, modern] of Object.entries(LEGACY_ALIASES)) {
  const v = byName.get(modern);
  if (v !== undefined) byName.set(legacy, v);
}

/** Prefer the short, familiar alias: KC_TRNS over KC_TRANSPARENT, KC_MUTE over KC_AUDIO_MUTE. */
function rankName(n: string): number {
  if (!/[A-Z]/.test(n)) return 1000; // _______ / XXXXXXX
  let score = n.length;
  if (n.startsWith("KC_")) score -= 4;
  if (n.startsWith("QK_")) score += 20;
  return score;
}

/** QK_KB_0: Keychron's own keys start here (VIA's customKeycodes, entry i = QK_KB_0 + i). */
export const QK_KB = byName.get("QK_KB_0") ?? 0x7e00;
/** The shown keyboard's own keys, by value: their short label (VIA's shortName). */
const customLabels = new Map<number, string>();
let customNames: Array<{ name: string; label: string; title: string }> = [];

/**
 * The keyboard's own keys (Keychron's list differs per board: wireless hosts, battery, OS switch…).
 * Replaces the names in QK_KB_0… with the board's.
 */
export function setCustomKeycodes(list: Array<{ name: string; label: string; title: string }>) {
  for (let v = QK_KB; v < QK_KB + 32; v++) {
    for (const n of byValue.get(v) ?? []) byName.delete(n);
    byValue.delete(v);
  }
  customLabels.clear();
  list.forEach((c, i) => {
    byName.set(c.name, QK_KB + i);
    byValue.set(QK_KB + i, [c.name]);
    customLabels.set(QK_KB + i, c.label);
  });
  customNames = list;
}

/** The board's own key at `value` (its short label), if it has one. */
export const customLabel = (value: number) => customLabels.get(value);
/** The board's own keys, in order (for the key picker). */
export const customKeycodes = () => customNames;

export function basicName(value: number): string | undefined {
  const names = byValue.get(value);
  if (!names) return undefined;
  return [...names].sort((a, b) => rankName(a) - rankName(b))[0];
}

export function valueOf(name: string): number | undefined {
  return byName.get(name.toUpperCase());
}


export const MOD_NAMES: Record<number, string> = {
  0x01: "MOD_LCTL", 0x02: "MOD_LSFT", 0x04: "MOD_LALT", 0x08: "MOD_LGUI",
  0x11: "MOD_RCTL", 0x12: "MOD_RSFT", 0x14: "MOD_RALT", 0x18: "MOD_RGUI",
};

/** 5-bit QMK mod value (bit 4 = right-hand) → "MOD_LCTL | MOD_LSFT". */
export function modsToString(mods: number): string {
  const right = mods & 0x10 ? 0x10 : 0;
  const parts: string[] = [];
  for (const bit of [0x01, 0x02, 0x04, 0x08]) {
    if (mods & bit) parts.push(MOD_NAMES[bit | right]);
  }
  return parts.join(" | ") || "0";
}

const WRAPPERS: Array<[number, string]> = [
  [0x01, "LCTL"], [0x02, "LSFT"], [0x04, "LALT"], [0x08, "LGUI"],
  [0x11, "RCTL"], [0x12, "RSFT"], [0x14, "RALT"], [0x18, "RGUI"],
];

/** Canonical QMK source text for any 16-bit keycode. */
export function keycodeToString(kc: number): string {
  const direct = basicName(kc);
  if (direct) return direct;
  if (kc >= QK.MODS && kc <= QK.MODS_MAX) {
    const mods = (kc >> 8) & 0x1f;
    let inner = basicName(kc & 0xff) ?? hex(kc & 0xff);
    const right = mods & 0x10;
    for (const [bit, name] of [...WRAPPERS].reverse()) {
      if ((bit & 0x10) !== right) continue;
      if (mods & bit & 0x0f) inner = `${name}(${inner})`;
    }
    return inner;
  }
  if (kc >= QK.MOD_TAP && kc <= QK.MOD_TAP_MAX) {
    return `MT(${modsToString((kc >> 8) & 0x1f)}, ${basicName(kc & 0xff) ?? hex(kc & 0xff)})`;
  }
  if (kc >= QK.LAYER_TAP && kc <= QK.LAYER_TAP_MAX) {
    return `LT(${(kc >> 8) & 0xf}, ${basicName(kc & 0xff) ?? hex(kc & 0xff)})`;
  }
  if (kc >= QK.LAYER_MOD && kc <= QK.LAYER_MOD_MAX) {
    return `LM(${(kc >> 5) & 0xf}, ${modsToString(kc & 0x1f)})`;
  }
  const layerFns: Array<[number, string]> = [
    [QK.TO, "TO"], [QK.MOMENTARY, "MO"], [QK.DEF_LAYER, "DF"], [QK.TOGGLE_LAYER, "TG"],
    [QK.ONE_SHOT_LAYER, "OSL"], [QK.LAYER_TAP_TOGGLE, "TT"],
  ];
  for (const [base, name] of layerFns) {
    if (kc >= base && kc <= base + 0x1f) return `${name}(${kc - base})`;
  }
  if (kc >= QK.ONE_SHOT_MOD && kc <= QK.ONE_SHOT_MOD + 0x1f) {
    return `OSM(${modsToString(kc & 0x1f)})`;
  }
  return hex(kc);
}

export function hex(v: number): string {
  return `0x${v.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Keycodes a RAM macro can press: basic keys, optionally wrapped in modifiers. */
export function isMacroSafe(kc: number): boolean {
  return (kc > 0x0001 && kc <= QK.BASIC_MAX) || (kc >= QK.MODS && kc <= QK.MODS_MAX);
}
