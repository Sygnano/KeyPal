/**
 * QMK's integer maths (lib8tion, `quantum/color.c`), ported exactly so the on-screen effects
 * move like the keyboard's. Values are uint8 (0–255) unless said; C's wrap-around is `& 255`.
 */

export const u8 = (x: number) => x & 255;
/** C cast to int8_t. */
export const i8 = (x: number) => ((x & 255) ^ 128) - 128;
export const u16 = (x: number) => x & 0xffff;

export const qadd8 = (a: number, b: number) => Math.min(255, a + b);
export const qsub8 = (a: number, b: number) => Math.max(0, a - b);
/** FASTLED_SCALE8_FIXED: i × (1 + scale) / 256. */
export const scale8 = (i: number, scale: number) => (u8(i) * (1 + u8(scale))) >> 8;
export const scale16by8 = (i: number, scale: number) => (u16(i) * (1 + u8(scale))) >> 8;
/** abs8 takes an int8_t and returns one (so abs8(-128) is -128). */
export const abs8 = (x: number) => {
  const v = i8(x);
  return v < 0 ? i8(-v) : v;
};

const B_M16 = [0, 49, 49, 41, 90, 27, 117, 10];
/** sin8: 0–255 in, 0–255 out (128 ± 127), FastLED's piecewise-linear version. */
export function sin8(theta: number): number {
  theta = u8(theta);
  let offset = theta;
  if (theta & 0x40) offset = 255 - offset;
  offset &= 0x3f;
  let secoffset = offset & 0x0f;
  if (theta & 0x40) secoffset++;
  const section = offset >> 4;
  const b = B_M16[section * 2];
  const m16 = B_M16[section * 2 + 1];
  const mx = (m16 * secoffset) >> 4;
  let y = i8(mx + b);
  if (theta & 0x80) y = i8(-y);
  return u8(y + 128);
}
export const cos8 = (theta: number) => sin8(theta + 64);

/** Integer square root of a uint16, as uint8. */
export const sqrt16 = (x: number) => Math.min(255, Math.floor(Math.sqrt(u16(x))));

/** Angle of (dx, dy) as 0–255 (lib8tion's approximation). */
export function atan2_8(dy: number, dx: number): number {
  if (dy === 0) return dx >= 0 ? 0 : 128;
  const absY = dy > 0 ? dy : -dy;
  let a: number;
  if (dx >= 0) a = i8(32 - Math.trunc((32 * (dx - absY)) / (dx + absY)));
  else a = i8(96 - Math.trunc((32 * (dx + absY)) / (absY - dx)));
  return u8(dy < 0 ? -a : a);
}

export interface Hsv8 {
  h: number;
  s: number;
  v: number;
}

/** QMK's hsv_to_rgb (without the CIE curve), writing r, g, b into `out` at `at`. */
export function hsvToRgb(h: number, s: number, v: number, out: Uint8Array, at: number): void {
  h = u8(h);
  s = u8(s);
  v = u8(v);
  if (s === 0) {
    out[at] = out[at + 1] = out[at + 2] = v;
    return;
  }
  const region = Math.floor((h * 6) / 255);
  const remainder = (h * 2 - region * 85) * 3;
  const p = (v * (255 - s)) >> 8;
  const q = (v * (255 - ((s * remainder) >> 8))) >> 8;
  const t = (v * (255 - ((s * (255 - remainder)) >> 8))) >> 8;
  let r: number, g: number, b: number;
  switch (region) {
    case 6:
    case 0:
      [r, g, b] = [v, t, p];
      break;
    case 1:
      [r, g, b] = [q, v, p];
      break;
    case 2:
      [r, g, b] = [p, v, t];
      break;
    case 3:
      [r, g, b] = [p, q, v];
      break;
    case 4:
      [r, g, b] = [t, p, v];
      break;
    default:
      [r, g, b] = [v, p, q];
  }
  out[at] = r;
  out[at + 1] = g;
  out[at + 2] = b;
}

export const random8 = () => Math.floor(Math.random() * 256);
export const random8Max = (max: number) => Math.floor(Math.random() * max);
export const random8MinMax = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
