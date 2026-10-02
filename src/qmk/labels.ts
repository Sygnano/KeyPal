import { basicName, customLabel, keycodeToString, QK, valueOf } from "./keycodes";

/** What a key types alone, with Shift and with AltGr, in a keyboard layout. */
export interface Legend {
  base: string;
  shift?: string;
  altgr?: string;
  /** The levels that are dead keys (^ then e gives ê): they type nothing until the next key. */
  dead?: Array<"base" | "shift" | "altgr">;
}

/** French AZERTY (Windows id 0000040C). */
const FRENCH: Record<string, Legend> = {
  KC_GRV: { base: "²" },
  KC_1: { base: "&", shift: "1" },
  KC_2: { base: "é", shift: "2", altgr: "~", dead: ["altgr"] },
  KC_3: { base: '"', shift: "3", altgr: "#" },
  KC_4: { base: "'", shift: "4", altgr: "{" },
  KC_5: { base: "(", shift: "5", altgr: "[" },
  KC_6: { base: "-", shift: "6", altgr: "|" },
  KC_7: { base: "è", shift: "7", altgr: "`", dead: ["altgr"] },
  KC_8: { base: "_", shift: "8", altgr: "\\" },
  KC_9: { base: "ç", shift: "9", altgr: "^" },
  KC_0: { base: "à", shift: "0", altgr: "@" },
  KC_MINS: { base: ")", shift: "°", altgr: "]" },
  KC_EQL: { base: "=", shift: "+", altgr: "}" },
  KC_Q: { base: "A" }, KC_W: { base: "Z" }, KC_E: { base: "E", altgr: "€" },
  KC_R: { base: "R" }, KC_T: { base: "T" }, KC_Y: { base: "Y" }, KC_U: { base: "U" },
  KC_I: { base: "I" }, KC_O: { base: "O" }, KC_P: { base: "P" },
  KC_LBRC: { base: "^", shift: "¨", dead: ["base", "shift"] },
  KC_RBRC: { base: "$", shift: "£", altgr: "¤" },
  KC_A: { base: "Q" }, KC_S: { base: "S" }, KC_D: { base: "D" }, KC_F: { base: "F" },
  KC_G: { base: "G" }, KC_H: { base: "H" }, KC_J: { base: "J" }, KC_K: { base: "K" },
  KC_L: { base: "L" }, KC_SCLN: { base: "M" },
  KC_QUOT: { base: "ù", shift: "%" },
  KC_NUHS: { base: "*", shift: "µ" },
  KC_NUBS: { base: "<", shift: ">" },
  KC_Z: { base: "W" }, KC_X: { base: "X" }, KC_C: { base: "C" }, KC_V: { base: "V" },
  KC_B: { base: "B" }, KC_N: { base: "N" },
  KC_M: { base: ",", shift: "?" },
  KC_COMM: { base: ";", shift: "." },
  KC_DOT: { base: ":", shift: "/" },
  KC_SLSH: { base: "!", shift: "§" },
  KC_BSLS: { base: "*", shift: "µ" },
};

/** US QWERTY (Windows id 00000409). */
const US: Record<string, Legend> = {
  KC_GRV: { base: "`", shift: "~" },
  KC_1: { base: "1", shift: "!" }, KC_2: { base: "2", shift: "@" }, KC_3: { base: "3", shift: "#" },
  KC_4: { base: "4", shift: "$" }, KC_5: { base: "5", shift: "%" }, KC_6: { base: "6", shift: "^" },
  KC_7: { base: "7", shift: "&" }, KC_8: { base: "8", shift: "*" }, KC_9: { base: "9", shift: "(" },
  KC_0: { base: "0", shift: ")" },
  KC_MINS: { base: "-", shift: "_" }, KC_EQL: { base: "=", shift: "+" },
  KC_LBRC: { base: "[", shift: "{" }, KC_RBRC: { base: "]", shift: "}" },
  KC_BSLS: { base: "\\", shift: "|" }, KC_NUHS: { base: "\\", shift: "|" },
  KC_NUBS: { base: "\\", shift: "|" },
  KC_SCLN: { base: ";", shift: ":" }, KC_QUOT: { base: "'", shift: '"' },
  KC_COMM: { base: ",", shift: "<" }, KC_DOT: { base: ".", shift: ">" },
  KC_SLSH: { base: "/", shift: "?" },
};
for (let i = 0; i < 26; i++) {
  const l = String.fromCharCode(65 + i);
  US[`KC_${l}`] = { base: l };
}

/**
 * Tables used when Windows can't be asked (the browser mock, another OS, an error). The app
 * normally gets the legends from Windows itself, for whatever layout the user has.
 */
const BUILTIN: Record<string, Record<string, Legend>> = { "0000040C": FRENCH, "00000409": US };

/** Legends by keycode value; `setLegends` swaps in the user's layout once it is known. */
let current = byValue(US);

function byValue(table: Record<string, Legend>): Map<number, Legend> {
  const m = new Map<number, Legend>();
  for (const [name, lg] of Object.entries(table)) {
    const v = valueOf(name);
    if (v !== undefined) m.set(v, lg);
  }
  return m;
}

/** A built-in layout's legends, keyed like the backend's (keycode value in decimal). */
export function builtinLegends(layoutId: string): Record<string, Legend> | null {
  const table = BUILTIN[layoutId.toUpperCase()];
  if (!table) return null;
  const out: Record<string, Legend> = {};
  for (const [kc, lg] of byValue(table)) out[String(kc)] = lg;
  return out;
}

/** Use these legends (keycode value in decimal → legend) from now on. */
export function setLegends(table: Record<string, Legend>): void {
  const m = new Map<number, Legend>();
  for (const [kc, lg] of Object.entries(table)) {
    const v = Number(kc);
    if (Number.isInteger(v) && lg && typeof lg.base === "string") m.set(v, lg);
  }
  current = m;
}

/** The legends in use (keycode value → legend), for turning text into keys (`typeText.ts`). */
export const currentLegends = (): ReadonlyMap<number, Legend> => current;

/** Keycap-style names for everything that is not a printable character. */
const NAMED: Record<string, string> = {
  KC_NO: "None", KC_TRNS: "▽", KC_ESC: "Esc", KC_TAB: "Tab", KC_CAPS: "Caps",
  KC_LSFT: "Shift", KC_RSFT: "Shift", KC_LCTL: "Ctrl", KC_RCTL: "Ctrl",
  KC_LALT: "Alt", KC_RALT: "Alt Gr", KC_LGUI: "Win", KC_RGUI: "Win",
  KC_SPC: "Space", KC_ENT: "Enter", KC_BSPC: "Bksp", KC_DEL: "Del", KC_INS: "Ins",
  KC_HOME: "Home", KC_END: "End", KC_PGUP: "PgUp", KC_PGDN: "PgDn",
  KC_UP: "↑", KC_DOWN: "↓", KC_LEFT: "←", KC_RGHT: "→",
  KC_PSCR: "PrtSc", KC_SCRL: "ScrLk", KC_PAUS: "Pause", KC_APP: "Menu",
  KC_NUM: "Num", KC_PSLS: "/", KC_PAST: "*", KC_PMNS: "-", KC_PPLS: "+",
  KC_PENT: "Enter", KC_PDOT: ".", KC_P0: "0", KC_P1: "1", KC_P2: "2", KC_P3: "3",
  KC_P4: "4", KC_P5: "5", KC_P6: "6", KC_P7: "7", KC_P8: "8", KC_P9: "9",
  KC_MUTE: "Mute", KC_VOLU: "Vol+", KC_VOLD: "Vol−", KC_MPLY: "Play",
  KC_MNXT: "Next", KC_MPRV: "Prev", KC_MSTP: "Stop", KC_BRIU: "Bri+", KC_BRID: "Bri−",
  KC_CALC: "Calc", KC_MYCM: "My PC", KC_WSCH: "Search", KC_WHOM: "Browser",
  KC_MAIL: "Mail", KC_MSEL: "Media",
  MS_BTN1: "Mouse 1", MS_BTN2: "Mouse 2", MS_BTN3: "Mouse 3", MS_BTN4: "Mouse 4",
  MS_BTN5: "Mouse 5", MS_BTN6: "Mouse 6", MS_BTN7: "Mouse 7", MS_BTN8: "Mouse 8",
  MS_UP: "Ms ↑", MS_DOWN: "Ms ↓", MS_LEFT: "Ms ←", MS_RGHT: "Ms →",
  MS_WHLU: "Wheel ↑", MS_WHLD: "Wheel ↓", MS_WHLL: "Wheel ←", MS_WHLR: "Wheel →",
  KC_TASK: "Task view", KC_FILE: "Explorer", KC_CTANA: "Cortana",
  UG_TOGG: "RGB on/off", UG_NEXT: "RGB mode+", UG_PREV: "RGB mode−",
  UG_VALU: "RGB bri+", UG_VALD: "RGB bri−", UG_HUEU: "Hue+", UG_HUED: "Hue−",
  UG_SATU: "Sat+", UG_SATD: "Sat−", UG_SPDU: "Speed+", UG_SPDD: "Speed−",
  QK_BOOT: "Bootloader", QK_RBT: "Reboot",
};

const MOD_LABEL: Array<[number, string]> = [
  [0x01, "Ctrl"], [0x02, "Shift"], [0x04, "Alt"], [0x08, "Win"],
];

function basicLabel(kc: number): string {
  const name = basicName(kc);
  if (!name) return keycodeToString(kc);
  if (NAMED[name]) return NAMED[name];
  const lg = current.get(kc);
  if (lg) return lg.base;
  const f = /^KC_F(\d+)$/.exec(name);
  if (f) return `F${f[1]}`;
  return name.replace(/^(KC|QK|MS|UG|RM)_/, "");
}

/** Short human label, used on the tape strip and in the bind list. */
export function keycodeLabel(kc: number): string {
  const custom = customLabel(kc);
  if (custom) return custom;
  if (kc <= QK.BASIC_MAX || basicName(kc)) return basicLabel(kc);
  if (kc >= QK.MODS && kc <= QK.MODS_MAX) {
    const mods = (kc >> 8) & 0x1f;
    const parts = MOD_LABEL.filter(([bit]) => mods & bit).map(([bit, l]) =>
      mods & 0x10 && bit === 0x04 ? "Alt Gr" : mods & 0x10 ? `R${l}` : l,
    );
    return [...parts, basicLabel(kc & 0xff)].join("+");
  }
  return keycodeToString(kc);
}

/** Full legend (shift / base / AltGr) for drawing a keycap. */
export function legendFor(kc: number): Legend {
  return current.get(kc) ?? { base: keycodeLabel(kc) };
}

/**
 * Browser KeyboardEvent.code → QMK keycode name. `code` is positional, so this is
 * independent of the OS layout: pressing the AZERTY "A" key yields KeyQ → KC_Q.
 */
export const DOM_CODE_TO_QMK: Record<string, string> = {
  Escape: "KC_ESC", Backquote: "KC_GRV", Minus: "KC_MINS", Equal: "KC_EQL",
  Backspace: "KC_BSPC", Tab: "KC_TAB", BracketLeft: "KC_LBRC", BracketRight: "KC_RBRC",
  Backslash: "KC_NUHS", IntlBackslash: "KC_NUBS", CapsLock: "KC_CAPS", Semicolon: "KC_SCLN",
  Quote: "KC_QUOT", Enter: "KC_ENT", ShiftLeft: "KC_LSFT", ShiftRight: "KC_RSFT",
  Comma: "KC_COMM", Period: "KC_DOT", Slash: "KC_SLSH", ControlLeft: "KC_LCTL",
  ControlRight: "KC_RCTL", AltLeft: "KC_LALT", AltRight: "KC_RALT", MetaLeft: "KC_LGUI",
  MetaRight: "KC_RGUI", ContextMenu: "KC_APP", Space: "KC_SPC", Insert: "KC_INS",
  Delete: "KC_DEL", Home: "KC_HOME", End: "KC_END", PageUp: "KC_PGUP", PageDown: "KC_PGDN",
  ArrowUp: "KC_UP", ArrowDown: "KC_DOWN", ArrowLeft: "KC_LEFT", ArrowRight: "KC_RGHT",
  PrintScreen: "KC_PSCR", ScrollLock: "KC_SCRL", Pause: "KC_PAUS", NumLock: "KC_NUM",
  NumpadDivide: "KC_PSLS", NumpadMultiply: "KC_PAST", NumpadSubtract: "KC_PMNS",
  NumpadAdd: "KC_PPLS", NumpadEnter: "KC_PENT", NumpadDecimal: "KC_PDOT",
  AudioVolumeMute: "KC_MUTE", AudioVolumeUp: "KC_VOLU", AudioVolumeDown: "KC_VOLD",
  MediaPlayPause: "KC_MPLY", MediaTrackNext: "KC_MNXT", MediaTrackPrevious: "KC_MPRV",
  MediaStop: "KC_MSTP",
};
for (let i = 0; i < 26; i++) {
  const l = String.fromCharCode(65 + i);
  DOM_CODE_TO_QMK[`Key${l}`] = `KC_${l}`;
}
for (let i = 0; i < 10; i++) {
  DOM_CODE_TO_QMK[`Digit${i}`] = `KC_${i}`;
  DOM_CODE_TO_QMK[`Numpad${i}`] = `KC_P${i}`;
}
for (let i = 1; i <= 24; i++) DOM_CODE_TO_QMK[`F${i}`] = `KC_F${i}`;
