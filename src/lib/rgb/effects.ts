import {
  abs8,
  atan2_8,
  cos8,
  hsvToRgb,
  i8,
  qadd8,
  qsub8,
  random8,
  random8Max,
  random8MinMax,
  scale16by8,
  scale8,
  sin8,
  sqrt16,
  u16,
  u8,
  type Hsv8,
} from "./qmkMath";

/**
 * QMK's RGB matrix effects (`quantum/rgb_matrix/animations`) as Keychron's boards have them, one function
 * each, fed the same inputs as on the keyboard. Keychron draws them per Mix RGB region: `set`
 * only paints the LEDs of the region being drawn (`rgb_matrix_region_set_color`).
 */

export interface Led {
  x: number;
  y: number;
  /** The key over it, "row,col". */
  row: number;
  col: number;
  /** g_led_config flags (0x01 modifier, 0x04 key…), when known. */
  flags?: number;
}

/** A keypress, for the reactive effects (QMK's g_last_hit_tracker). */
export interface Hit {
  led: number;
  x: number;
  y: number;
  /** Milliseconds since the press (capped at 65535). */
  tick: number;
}

/** What an effect draws with: the frame's inputs, and the LED buffer. */
export interface Frame {
  leds: readonly Led[];
  /** k_rgb_matrix_center (112, 32 unless the board says otherwise). */
  center: { x: number; y: number };
  /** The matrix size (Digital Rain falls down its columns). */
  rows: number;
  cols: number;
  /** g_rgb_timer: milliseconds since start. */
  timer: number;
  hsv: Hsv8;
  speed: number;
  /** The first frame since this effect started (in this region). */
  init: boolean;
  region: number;
  hits: readonly Hit[];
  /** State an effect keeps between frames, per region. */
  state: Record<string, unknown>;
  set(i: number, r: number, g: number, b: number): void;
}

const scratch = new Uint8Array(3);

function setHsv(f: Frame, i: number, h: number, s: number, v: number) {
  hsvToRgb(h, s, v, scratch, 0);
  f.set(i, scratch[0], scratch[1], scratch[2]);
}

// ------------------------------------------------------------------ runners

type IFn = (hsv: Hsv8, led: Led, time: number) => Hsv8;
function runnerI(f: Frame, fn: IFn) {
  const time = u8(scale16by8(f.timer, qadd8(f.speed >> 2, 1)));
  f.leds.forEach((led, i) => {
    const hsv = fn({ ...f.hsv }, led, time);
    setHsv(f, i, hsv.h, hsv.s, hsv.v);
  });
}

type DxDyFn = (hsv: Hsv8, dx: number, dy: number, time: number) => Hsv8;
function runnerDxDy(f: Frame, fn: DxDyFn) {
  const time = u8(scale16by8(f.timer, f.speed >> 1));
  f.leds.forEach((led, i) => {
    const hsv = fn({ ...f.hsv }, led.x - f.center.x, led.y - f.center.y, time);
    setHsv(f, i, hsv.h, hsv.s, hsv.v);
  });
}

type DistFn = (hsv: Hsv8, dx: number, dy: number, dist: number, time: number) => Hsv8;
function runnerDist(f: Frame, fn: DistFn) {
  const time = u8(scale16by8(f.timer, f.speed >> 1));
  f.leds.forEach((led, i) => {
    const dx = led.x - f.center.x;
    const dy = led.y - f.center.y;
    const hsv = fn({ ...f.hsv }, dx, dy, sqrt16(dx * dx + dy * dy), time);
    setHsv(f, i, hsv.h, hsv.s, hsv.v);
  });
}

/** The runner hands (cos, sin) to parameters named (sin, cos): kept as QMK has it. */
type SinCosFn = (hsv: Hsv8, sin: number, cos: number, led: Led) => Hsv8;
function runnerSinCos(f: Frame, fn: SinCosFn) {
  const time = scale16by8(f.timer, f.speed >> 2);
  const cosValue = i8(cos8(time) - 128);
  const sinValue = i8(sin8(time) - 128);
  f.leds.forEach((led, i) => {
    const hsv = fn({ ...f.hsv }, cosValue, sinValue, led);
    setHsv(f, i, hsv.h, hsv.s, hsv.v);
  });
}

type ReactiveFn = (hsv: Hsv8, offset: number) => Hsv8;
function runnerReactive(f: Frame, fn: ReactiveFn) {
  const maxTick = Math.floor(65535 / qadd8(f.speed, 1));
  f.leds.forEach((_, i) => {
    let tick = maxTick;
    for (let j = f.hits.length - 1; j >= 0; j--) {
      if (f.hits[j].led === i && f.hits[j].tick < tick) {
        tick = f.hits[j].tick;
        break;
      }
    }
    const hsv = fn({ ...f.hsv }, scale16by8(tick, qadd8(f.speed, 1)));
    setHsv(f, i, hsv.h, hsv.s, hsv.v);
  });
}

type SplashFn = (hsv: Hsv8, dx: number, dy: number, dist: number, tick: number) => Hsv8;
/** `start`: 0 for every remembered press, the last one only otherwise. */
function runnerSplash(f: Frame, fn: SplashFn, allHits: boolean) {
  const start = allHits ? 0 : Math.max(0, f.hits.length - 1);
  f.leds.forEach((led, i) => {
    let hsv: Hsv8 = { ...f.hsv, v: 0 };
    for (let j = start; j < f.hits.length; j++) {
      const hit = f.hits[j];
      const dx = led.x - hit.x;
      const dy = led.y - hit.y;
      hsv = fn(hsv, dx, dy, sqrt16(dx * dx + dy * dy), scale16by8(hit.tick, qadd8(f.speed, 1)));
    }
    setHsv(f, i, hsv.h, hsv.s, scale8(hsv.v, f.hsv.v));
  });
}

// ------------------------------------------------------------------ effects

function jellybean(f: Frame) {
  const colour = (i: number) => setHsv(f, i, random8(), random8MinMax(127, 255), f.hsv.v);
  if (scale16by8(f.timer, qadd8(f.speed, 16)) % 5 === 0) f.state.index = random8Max(f.leds.length);
  if (f.init) f.leds.forEach((_, i) => colour(i));
  else if (typeof f.state.index === "number" && f.state.index < f.leds.length) {
    colour(f.state.index);
    f.state.index = undefined;
  }
}

function pixelRain(f: Frame) {
  const last = (f.state.timer as number | undefined) ?? f.timer;
  if (f.init) f.state.timer = f.timer;
  if (f.timer - last > 320 - f.speed) {
    f.state.timer = f.timer;
    const i = random8Max(f.leds.length);
    if (random8() & 2) f.set(i, 0, 0, 0);
    else setHsv(f, i, random8(), random8MinMax(127, 255), f.hsv.v);
  }
}

/** The heat of each LED (g_rgb_frame_buffer), raised by keypresses (see `heatmapHit`). */
function typingHeatmap(f: Frame) {
  const heat = heatOf(f);
  if (f.init) heat.fill(0);
  const last = (f.state.decreasedAt as number | undefined) ?? f.timer;
  const decrease = f.timer - last >= 25;
  if (decrease || f.init) f.state.decreasedAt = f.timer;
  f.leds.forEach((_, i) => {
    const val = heat[i];
    setHsv(f, i, 170 - qsub8(val, 85), f.hsv.s, scale8((qadd8(170, val) - 170) * 3, f.hsv.v));
    if (decrease) heat[i] = qsub8(val, 1);
  });
}

function heatOf(f: { leds: readonly Led[]; state: Record<string, unknown> }): Uint8Array {
  if (!(f.state.heat instanceof Uint8Array)) f.state.heat = new Uint8Array(f.leds.length);
  return f.state.heat as Uint8Array;
}

/** A keypress under the typing heatmap: +32 on the key, a little on its neighbours. */
export function heatmapHit(leds: readonly Led[], state: Record<string, unknown>, led: number) {
  const heat = heatOf({ leds, state });
  const p = leds[led];
  leds.forEach((q, i) => {
    if (i === led) heat[i] = qadd8(heat[i], 32);
    else {
      const d = sqrt16((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
      if (d <= 40) heat[i] = qadd8(heat[i], Math.min(16, qsub8(40, d)));
    }
  });
}

/** Green drops falling down the matrix columns (ported from Kaleidoscope's DigitalRain). */
function digitalRain(f: Frame) {
  const ROWS = f.rows;
  const COLS = f.cols;
  const max = f.hsv.v;
  const pureGreen = (max * 3) >> 2;
  const boostMax = (max * 3) >> 2;
  const decayTicks = max ? Math.floor(255 / max) : 255;
  if (!(f.state.rain instanceof Uint8Array) || f.init) {
    f.state.rain = new Uint8Array(ROWS * COLS);
    f.state.drop = 0;
    f.state.decay = 0;
    f.leds.forEach((_, i) => f.set(i, 0, 0, 0));
  }
  const rain = f.state.rain as Uint8Array;
  let drop = f.state.drop as number;
  let decay = ((f.state.decay as number) + 1) & 255;
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const k = row * COLS + col;
      if (row === 0 && drop === 0 && Math.random() < 1 / 24) rain[k] = max;
      else if (rain[k] > 0 && rain[k] < max && decay === decayTicks) rain[k]--;
    }
  }
  f.leds.forEach((led, i) => {
    const v = rain[led.row * COLS + led.col];
    if (v > pureGreen) {
      const boost = Math.floor((boostMax * (v - pureGreen)) / Math.max(1, max - pureGreen));
      f.set(i, boost, max, boost);
    } else {
      f.set(i, 0, pureGreen ? Math.floor((max * v) / pureGreen) : 0, 0);
    }
  });
  if (decay === decayTicks) decay = 0;
  if (++drop > 28) {
    drop = 0;
    for (let row = ROWS - 1; row > 0; row--) {
      for (let col = 0; col < COLS; col++) {
        const k = row * COLS + col;
        if (row === ROWS - 1 && rain[k] === max) rain[k]--;
        if (rain[k - COLS] >= max) {
          rain[k - COLS] = max - 1;
          rain[k] = max;
        }
      }
    }
  }
  f.state.drop = drop;
  f.state.decay = decay;
}

/** Effect id (Keychron's VIA list) → how it draws. 0 (off) and 24 (Mix RGB) are the simulator's. */
export const EFFECTS: Record<number, (f: Frame) => void> = {
  1: (f) => f.leds.forEach((_, i) => setHsv(f, i, f.hsv.h, f.hsv.s, f.hsv.v)),
  2: (f) => runnerI(f, (hsv, _, time) => ({ ...hsv, v: scale8(u8(abs8(sin8(time >> 1) - 128) * 2), hsv.v) })),
  3: (f) => runnerDist(f, (hsv, dx, dy, dist, time) => ({ ...hsv, v: scale8(u8(hsv.v + dist - time - atan2_8(dy, dx)), hsv.v) })),
  4: (f) => runnerI(f, (hsv, _, time) => ({ ...hsv, h: time })),
  5: (f) => runnerI(f, (hsv, led, time) => ({ ...hsv, h: u8(led.x - time) })),
  6: (f) => runnerI(f, (hsv, led, time) => ({ ...hsv, h: u8(led.y - time) })),
  7: (f) => runnerI(f, (hsv, led, time) => ({ ...hsv, h: u8(hsv.h + abs8(led.y - f.center.y) + (led.x - time)) })),
  8: (f) => runnerDist(f, (hsv, _dx, _dy, dist, time) => ({ ...hsv, h: u8(Math.trunc((3 * dist) / 2) + time) })),
  9: (f) =>
    runnerDxDy(f, (hsv, dx, dy, time) => {
      const x = (f.center.x >> 1) - abs8(dx);
      return { ...hsv, h: u8(3 * sqrt16(x * x + dy * dy) + time) };
    }),
  10: (f) => runnerDxDy(f, (hsv, dx, dy, time) => ({ ...hsv, h: u8(atan2_8(dy, dx) + time) })),
  11: (f) => runnerDist(f, (hsv, dx, dy, dist, time) => ({ ...hsv, h: u8(dist - time - atan2_8(dy, dx)) })),
  12: (f) =>
    runnerSinCos(f, (hsv, sin, cos, led) => ({
      ...hsv,
      h: u8(hsv.h + Math.trunc(((led.y - f.center.y) * cos + (led.x - f.center.x) * sin) / 128)),
    })),
  13: (f) =>
    runnerSinCos(f, (hsv, sin, cos, led) => ({
      ...hsv,
      h: u8(hsv.h + Math.trunc(((led.y - f.center.y) * 2 * cos + (led.x - f.center.x) * 2 * sin) / 128)),
    })),
  14: jellybean,
  15: pixelRain,
  16: typingHeatmap,
  17: digitalRain,
  18: (f) => runnerReactive(f, (hsv, offset) => ({ ...hsv, v: scale8(255 - Math.min(255, offset), hsv.v) })),
  19: (f) =>
    runnerSplash(
      f,
      (hsv, _dx, _dy, dist, tick) => ({ ...hsv, v: qadd8(hsv.v, 255 - Math.min(255, tick + dist * 5)) }),
      true,
    ),
  20: (f) =>
    runnerSplash(
      f,
      (hsv, dx, dy, dist, tick) => {
        let effect = Math.min(255, u16(tick - dist));
        if (dist > 72) effect = 255;
        if ((dx > 8 || dx < -8) && (dy > 8 || dy < -8)) effect = 255;
        return { ...hsv, h: u8(f.hsv.h + Math.trunc(dy / 4)), v: qadd8(hsv.v, 255 - effect) };
      },
      true,
    ),
  21: (f) =>
    runnerSplash(
      f,
      (hsv, _dx, _dy, dist, tick) => {
        const effect = Math.min(255, u16(tick - dist));
        return { ...hsv, h: u8(hsv.h + effect), v: qadd8(hsv.v, 255 - effect) };
      },
      false,
    ),
  22: (f) =>
    runnerSplash(
      f,
      (hsv, _dx, _dy, dist, tick) => ({ ...hsv, v: qadd8(hsv.v, 255 - Math.min(255, u16(tick - dist))) }),
      false,
    ),
  // Per Key RGB plays a table saved in the keyboard (Keychron Launcher) the app can't read: shown as
  // the effect's colour.
  23: (f) => f.leds.forEach((_, i) => setHsv(f, i, f.hsv.h, f.hsv.s, f.hsv.v)),
};

/** Effects that react to keypresses (the preview says to type). */
export const REACTIVE_EFFECTS = new Set([16, 18, 19, 20, 21, 22]);
