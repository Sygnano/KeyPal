import { effectiveAnims, effectiveKeys, MIX_RGB } from "../layers";
import type { Anim, Hsv, KeyId, Lighting, MixLighting } from "../types";
import { EFFECTS, heatmapHit, type Frame, type Hit, type Led } from "./effects";
import { LED_EFFECTS } from "./ledEffects";
import { hsvToRgb } from "./qmkMath";

/** The keyboard renders a frame about every 16 ms (RGB_MATRIX_LED_FLUSH_LIMIT). */
export const FRAME_MS = 16;
/** Keychron fades between a Mix RGB region's effects over this long. */
const TRANSITION_MS = 1000;
/** QMK remembers this many keypresses for the reactive effects (LED_HITS_TO_REMEMBER). */
const HITS = 8;

export interface LedInfo {
  key: KeyId;
  x: number;
  y: number;
  flags?: number;
}

/** A white backlight: its effects by id (each board numbers the ones it enables), drawn in grey. */
export interface WhiteBoard {
  effects: ReadonlyArray<readonly [string, number]>;
}

interface Overlay {
  h: number;
  s: number;
  v: number;
  anim: Anim;
  speed: number;
}

/** A region's place in its Mix RGB effect list (Keychron's layer_effect_index / _timer). */
interface MixTurn {
  index: number;
  since: number;
  lastEffect: number;
}

/**
 * The keyboard's lighting, drawn in the app: what the keyboard shows for a profile's lighting, frame
 * by frame. Same maths as the firmware (QMK's effects, Keychron's Mix RGB rotation, then the
 * profile switcher module's colour layers on top, scaled by the brightness), same frame rate; only
 * randomness differs. `frame()` returns r, g, b per LED, in LED order.
 */
export class RgbSimulator {
  readonly leds: Led[];
  private readonly ledOfKey = new Map<KeyId, number>();
  /** The LEDs' colours: kept between frames, like the LED driver's buffer (some effects rely on it). */
  private readonly buffer: Uint8Array;
  private readonly regionOf: Uint8Array;
  private lighting: Lighting | null = null;
  private overlay: Array<Overlay | null> = [];
  private blankOthers = false;
  /** The simulated g_rgb_timer, advanced in FRAME_MS steps. */
  private timer = 0;
  private clock: number | null = null;
  private presses: Array<{ led: number; at: number }> = [];
  /** When each LED was last pressed, for the module's "light up when pressed". */
  private readonly pressedAt: Float64Array;
  private effectState: Array<Record<string, unknown>> = [];
  private lastEffect = -1;
  private mixKey = "";
  private turns: MixTurn[] = [];

  private readonly geometry: { center: { x: number; y: number }; rows: number; cols: number };
  /** The effects by id: QMK's RGB matrix ones, or a white backlight's LED matrix ones. */
  private readonly effects: Record<number, ((f: Frame) => void) | undefined>;
  private readonly white: boolean;

  /** `center`: k_rgb_matrix_center; `rows`, `cols`: the matrix size; `white`: a white backlight. */
  constructor(leds: readonly LedInfo[], board: { center?: readonly [number, number]; rows: number; cols: number; white?: WhiteBoard }) {
    const [cx, cy] = board.center ?? [112, 32];
    this.geometry = { center: { x: cx, y: cy }, rows: board.rows, cols: board.cols };
    this.white = !!board.white;
    this.effects = board.white ? Object.fromEntries(board.white.effects.map(([name, id]) => [id, LED_EFFECTS[name]])) : EFFECTS;
    this.leds = leds.map((l) => {
      const [row, col] = l.key.split(",").map(Number);
      return { x: l.x, y: l.y, row, col, flags: l.flags };
    });
    leds.forEach((l, i) => this.ledOfKey.set(l.key, i));
    this.buffer = new Uint8Array(leds.length * 3);
    this.regionOf = new Uint8Array(leds.length);
    this.pressedAt = new Float64Array(leds.length).fill(-Infinity);
  }

  ledOf(key: KeyId): number | undefined {
    return this.ledOfKey.get(key);
  }

  /** The lighting to show (null: the keyboard's own, unknown: dark). */
  setLighting(l: Lighting | null) {
    this.lighting = l;
    const keys = effectiveKeys(l);
    const anims = effectiveAnims(l);
    this.overlay = this.leds.map((led) => {
      const key = `${led.row},${led.col}`;
      const c: Hsv | undefined = keys[key];
      if (!c) return null;
      return { ...c, anim: anims[key]?.anim ?? "static", speed: anims[key]?.speed ?? 128 };
    });
    this.blankOthers = !!l && l.effect === 0 && this.overlay.some(Boolean);
    const mix = l?.effect === MIX_RGB ? l.mix : undefined;
    this.regionOf.fill(0);
    mix?.regions.forEach((r, i) => {
      if (i === 0) return;
      for (const k of r.keys) {
        const led = this.ledOfKey.get(k);
        if (led !== undefined) this.regionOf[led] = i;
      }
    });
    // A new list of effects starts the rotation again (like Keychron's update_mixed_rgb_effect_count).
    const mixKey = mix ? JSON.stringify(mix.regions.map((r) => r.effects)) : "";
    if (mixKey !== this.mixKey) {
      this.mixKey = mixKey;
      this.turns = [];
    }
  }

  /** A key pressed on the keyboard. */
  press(key: KeyId) {
    const led = this.ledOfKey.get(key);
    if (led === undefined) return;
    this.presses.push({ led, at: this.timer });
    if (this.presses.length > HITS) this.presses.shift();
    this.pressedAt[led] = this.timer;
    // The typing heatmap counts presses as they come (base effect, or any Mix RGB region playing it).
    if (!this.white) {
      this.effectState.forEach((state, region) => {
        if (this.effectIn(region) === 16) heatmapHit(this.leds, state, led);
      });
    }
  }

  /** Advances to `now` (ms, any clock) and returns r, g, b per LED. */
  frame(now: number): Uint8Array {
    if (this.clock === null) this.clock = now;
    // Catch up in keyboard-sized steps (but not forever after the window was hidden).
    let steps = Math.floor((now - this.clock) / FRAME_MS);
    if (steps > 20) {
      this.timer += (steps - 20) * FRAME_MS;
      steps = 20;
    }
    this.clock += Math.floor((now - this.clock) / FRAME_MS) * FRAME_MS;
    for (let i = 0; i < steps; i++) {
      this.timer += FRAME_MS;
      this.step();
    }
    if (this.lastEffect === -1) this.step();
    return this.withOverlay();
  }

  /** The average colour, for the glow around the board. */
  average(rgb: Uint8Array): [number, number, number] {
    const n = rgb.length / 3 || 1;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      r += rgb[i];
      g += rgb[i + 1];
      b += rgb[i + 2];
    }
    return [r / n, g / n, b / n];
  }

  // ------------------------------------------------------------------ one keyboard frame

  private step() {
    const l = this.lighting;
    const effect = l?.effect ?? 0;
    const started = effect !== this.lastEffect;
    this.lastEffect = effect;
    if (started) this.effectState = [];
    if (!l || effect === 0) {
      this.buffer.fill(0);
      return;
    }
    if (effect === MIX_RGB && !this.white) {
      if (!l.mix) {
        // Regions saved in the keyboard: the app doesn't know them. Shown dark, like "unknown".
        this.buffer.fill(0);
        return;
      }
      this.stepMix(l, l.mix, started);
      return;
    }
    // The module clears the board when Pixel Rain starts (it only paints one key at a time).
    if (started && effect === 15 && !this.white) this.buffer.fill(0);
    this.draw(this.effects[effect], 0, { h: l.hue, s: l.sat, v: l.brightness }, l.speed, started, false);
  }

  /** Keychron's mixed_rgb: each region plays its effects in turn, fading between them. */
  private stepMix(l: Lighting, mix: MixLighting, started: boolean) {
    if (started) this.turns = [];
    for (let region = mix.regions.length - 1; region >= 0; region--) {
      const effects = mix.regions[region].effects.filter((e) => e.effect > 0 && e.effect < MIX_RGB - 1);
      if (!effects.length) continue;
      const turn = (this.turns[region] ??= { index: 0, since: this.timer, lastEffect: -1 });
      let v = l.brightness;
      if (effects.length > 1) {
        const elapsed = this.timer - turn.since;
        const current = effects[turn.index % effects.length];
        if (elapsed > current.time) {
          turn.since = this.timer;
          turn.index = (turn.index + 1) % effects.length;
        } else if (elapsed > current.time - TRANSITION_MS) {
          v = Math.floor((l.brightness * Math.max(0, current.time - elapsed)) / TRANSITION_MS);
        }
        const now = this.timer - turn.since;
        if (now < TRANSITION_MS) v = Math.floor((l.brightness * now) / TRANSITION_MS);
      }
      const fx = effects[turn.index % effects.length];
      const init = turn.lastEffect !== fx.effect;
      turn.lastEffect = fx.effect;
      if (init) this.effectState[region] = {};
      this.draw(EFFECTS[fx.effect], region, { h: fx.hue, s: fx.sat, v }, fx.speed, init, true);
    }
  }

  private effectIn(region: number): number | undefined {
    const l = this.lighting;
    if (!l) return undefined;
    if (l.effect !== MIX_RGB) return region === 0 ? l.effect : undefined;
    const effects = l.mix?.regions[region]?.effects.filter((e) => e.effect > 0 && e.effect < MIX_RGB - 1) ?? [];
    const turn = this.turns[region];
    return effects[(turn?.index ?? 0) % Math.max(1, effects.length)]?.effect;
  }

  private draw(fn: ((f: Frame) => void) | undefined, region: number, hsv: Frame["hsv"], speed: number, init: boolean, regional: boolean) {
    if (!fn) return;
    const buffer = this.buffer;
    const regionOf = this.regionOf;
    const state = (this.effectState[region] ??= {});
    fn({
      leds: this.leds,
      ...this.geometry,
      timer: this.timer,
      hsv,
      speed,
      init,
      region,
      hits: this.hits(),
      state,
      set(i, r, g, b) {
        if (regional && regionOf[i] !== region) return;
        buffer[i * 3] = r;
        buffer[i * 3 + 1] = g;
        buffer[i * 3 + 2] = b;
      },
    });
  }

  private hits(): Hit[] {
    this.presses = this.presses.filter((p) => this.timer - p.at <= 65535);
    return this.presses.map((p) => ({ led: p.led, x: this.leds[p.led].x, y: this.leds[p.led].y, tick: this.timer - p.at }));
  }

  // ------------------------------------------------------------------ the module's colour layers

  /** rgb_matrix_indicators_advanced_kb: the colour layers over the effect, scaled by the brightness. */
  private withOverlay(): Uint8Array {
    const out = this.buffer.slice();
    const brightness = this.lighting?.brightness ?? 255;
    this.overlay.forEach((o, i) => {
      const hsv = o ? this.animate(o, i) : null;
      if (hsv) hsvToRgb(hsv.h, hsv.s, Math.floor((hsv.v * brightness) / 255), out, i * 3);
      else if (this.blankOthers) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = 0;
    });
    return out;
  }

  /** ps_animate: the colour a key shows now, or null (a "light up when pressed" key at rest). */
  private animate(o: Overlay, led: number): Hsv | null {
    const now = this.timer;
    switch (o.anim) {
      case "breathe": {
        let w = triangle(now, 6000 - o.speed * 20);
        w = Math.floor((w * w) / 255);
        return { h: o.h, s: o.s, v: Math.floor((o.v * (40 + Math.floor((w * 215) / 255))) / 255) };
      }
      case "cycle": {
        const period = 12000 - o.speed * 40;
        return { h: (o.h + Math.floor(((now % period) * 256) / period)) & 255, s: o.s, v: o.v };
      }
      case "reactive": {
        const fade = 2000 - o.speed * 7;
        const age = now - this.pressedAt[led];
        if (age >= fade) return null;
        return { h: o.h, s: o.s, v: Math.floor((o.v * (fade - age)) / fade) };
      }
      default:
        return { h: o.h, s: o.s, v: o.v };
    }
  }
}

/** 0 → 255 → 0 over `period` ms (the module's ps_triangle). */
function triangle(now: number, period: number): number {
  const t = Math.floor(((now % period) * 510) / period);
  return t < 256 ? t : 510 - t;
}
