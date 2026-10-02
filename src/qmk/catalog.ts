import { BOARD } from "../lib/layout";
import { customKeycodes, valueOf } from "./keycodes";

export interface CatalogGroup {
  id: string;
  label: string;
  names: string[];
}

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** Ordered like an AZERTY board so the picker reads the way the keycaps do. */
const RAW: CatalogGroup[] = [
  {
    id: "letters",
    label: "Letters",
    names: ["KC_Q", "KC_W", "KC_E", "KC_R", "KC_T", "KC_Y", "KC_U", "KC_I", "KC_O", "KC_P",
      "KC_A", "KC_S", "KC_D", "KC_F", "KC_G", "KC_H", "KC_J", "KC_K", "KC_L", "KC_SCLN",
      "KC_Z", "KC_X", "KC_C", "KC_V", "KC_B", "KC_N"],
  },
  {
    id: "symbols",
    label: "Digits & symbols",
    names: ["KC_GRV", ...range("KC_", 1, 9), "KC_0", "KC_MINS", "KC_EQL", "KC_LBRC", "KC_RBRC",
      "KC_QUOT", "KC_NUHS", "KC_NUBS", "KC_M", "KC_COMM", "KC_DOT", "KC_SLSH"],
  },
  { id: "fkeys", label: "Function", names: range("KC_F", 1, 24) },
  {
    id: "edit",
    label: "Editing & navigation",
    names: ["KC_ESC", "KC_TAB", "KC_CAPS", "KC_ENT", "KC_SPC", "KC_BSPC", "KC_DEL", "KC_INS",
      "KC_HOME", "KC_END", "KC_PGUP", "KC_PGDN", "KC_UP", "KC_DOWN", "KC_LEFT", "KC_RGHT",
      "KC_PSCR", "KC_SCRL", "KC_PAUS", "KC_APP"],
  },
  {
    id: "mods",
    label: "Modifiers",
    names: ["KC_LCTL", "KC_LSFT", "KC_LALT", "KC_LGUI", "KC_RCTL", "KC_RSFT", "KC_RALT", "KC_RGUI"],
  },
  {
    id: "numpad",
    label: "Numpad",
    names: ["KC_NUM", "KC_PSLS", "KC_PAST", "KC_PMNS", "KC_PPLS", "KC_PENT", "KC_PDOT",
      ...range("KC_P", 0, 9)],
  },
  {
    id: "media",
    label: "Media & system",
    names: ["KC_MUTE", "KC_VOLD", "KC_VOLU", "KC_MPLY", "KC_MPRV", "KC_MNXT", "KC_MSTP",
      "KC_BRID", "KC_BRIU", "KC_CALC", "KC_MYCM", "KC_WSCH", "KC_MAIL"],
  },
  {
    id: "mouse",
    label: "Mouse",
    names: [...range("MS_BTN", 1, 8), "MS_UP", "MS_DOWN", "MS_LEFT", "MS_RGHT",
      "MS_WHLU", "MS_WHLD", "MS_WHLL", "MS_WHLR"],
  },
  {
    id: "lighting",
    label: "Lighting",
    names: ["UG_TOGG", "UG_NEXT", "UG_PREV", "UG_VALU", "UG_VALD", "UG_HUEU", "UG_HUED",
      "UG_SATU", "UG_SATD", "UG_SPDU", "UG_SPDD"],
  },
  { id: "special", label: "Special", names: ["KC_NO", "KC_TRNS", "QK_BOOT"] },
];

/** The picker's groups for the keyboard shown: its own keys (Keychron's: Mac keys, Bluetooth hosts,
 * battery…) after the media ones, and lighting keys only when it has RGB. */
export function catalog(): CatalogGroup[] {
  const own = customKeycodes().map((c) => c.name);
  const groups = RAW.filter((g) => g.id !== "lighting" || BOARD.lighting === "rgb");
  const at = groups.findIndex((g) => g.id === "media") + 1;
  if (own.length) groups.splice(at, 0, { id: "keyboard", label: "This keyboard", names: own });
  return groups.map((g) => ({ ...g, names: g.names.filter((n) => valueOf(n) !== undefined) }));
}
