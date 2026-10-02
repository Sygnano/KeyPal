import type { Hsv, Lighting } from "./types";

/** QMK HSV (0–255 each) → CSS rgb(), for drawing on screen. */
export function hsvToCss({ h, s, v }: Hsv, alpha = 1): string {
  const hh = (h / 255) * 6;
  const ss = s / 255;
  const vv = v / 255;
  const i = Math.floor(hh) % 6;
  const f = hh - Math.floor(hh);
  const p = vv * (1 - ss);
  const q = vv * (1 - f * ss);
  const t = vv * (1 - (1 - f) * ss);
  const [r, g, b] = [
    [vv, t, p],
    [q, vv, p],
    [p, vv, t],
    [p, q, vv],
    [t, p, vv],
    [vv, p, q],
  ][i];
  const c = (x: number) => Math.round(x * 255);
  return alpha === 1 ? `rgb(${c(r)} ${c(g)} ${c(b)})` : `rgb(${c(r)} ${c(g)} ${c(b)} / ${alpha})`;
}

/** react-colorful's HSV (h 0–360, s/v 0–100) ↔ QMK's 0–255. */
export interface PickerHsv {
  h: number;
  s: number;
  v: number;
}
export const toPicker = ({ h, s, v }: Hsv): PickerHsv => ({ h: (h / 255) * 360, s: (s / 255) * 100, v: (v / 255) * 100 });
export const fromPicker = ({ h, s, v }: PickerHsv): Hsv => ({
  h: Math.round((h / 360) * 255) % 256,
  s: Math.round((s / 100) * 255),
  v: Math.round((v / 100) * 255),
});

export const sameHsv = (a: Hsv | undefined, b: Hsv | undefined) =>
  !!a && !!b && a.h === b.h && a.s === b.s && a.v === b.v;

export const PRESETS: Array<[string, Hsv]> = [
  ["Red", { h: 0, s: 255, v: 255 }],
  ["Orange", { h: 21, s: 255, v: 255 }],
  ["Yellow", { h: 43, s: 255, v: 255 }],
  ["Green", { h: 85, s: 255, v: 255 }],
  ["Cyan", { h: 128, s: 255, v: 255 }],
  ["Blue", { h: 170, s: 255, v: 255 }],
  ["Purple", { h: 191, s: 255, v: 255 }],
  ["Pink", { h: 234, s: 200, v: 255 }],
  ["White", { h: 0, s: 0, v: 255 }],
];

/** White backlights: a layer is a brightness (hue and saturation stay 0). */
export const WHITE_LEVELS: Array<[string, Hsv]> = [
  ["Full", { h: 0, s: 0, v: 255 }],
  ["75%", { h: 0, s: 0, v: 191 }],
  ["50%", { h: 0, s: 0, v: 128 }],
  ["25%", { h: 0, s: 0, v: 64 }],
  ["Off", { h: 0, s: 0, v: 0 }],
];

/** "50%" for a brightness, "Off" at 0. */
export const brightnessLabel = (v: number) => (v === 0 ? "Off" : `${Math.round((v / 255) * 100)}%`);

/** The effect's base colour as a CSS colour, for the glow around the board. */
export function effectCss(l: Lighting): string {
  return hsvToCss({ h: l.hue, s: l.sat, v: 110 + (l.brightness / 255) * 145 });
}
