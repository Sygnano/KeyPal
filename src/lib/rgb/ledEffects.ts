import { abs8, atan2_8, cos8, i8, qadd8, scale16by8, scale8, sin8, sqrt16, u16, u8 } from "./qmkMath";
import type { Frame } from "./effects";

/**
 * QMK's LED matrix effects (`quantum/led_matrix/animations`): white backlights, one brightness per
 * LED. A board numbers only the effects it enables, so they're looked up by name (the generator's
 * names, e.g. "Breathing"). `f.hsv.v` is the brightness, `f.speed` the speed; LEDs are drawn grey.
 */

const MODIFIER = 0x01; // LED_FLAG_MODIFIER

function set(f: Frame, i: number, v: number) {
  f.set(i, v, v, v);
}

function runnerI(f: Frame, fn: (val: number, i: number, time: number) => number) {
  const time = u8(scale16by8(f.timer, f.speed >> 2));
  f.leds.forEach((_, i) => set(f, i, u8(fn(f.hsv.v, i, time))));
}

function runnerDxDy(f: Frame, fn: (val: number, dx: number, dy: number, time: number) => number) {
  const time = u8(scale16by8(f.timer, f.speed >> 1));
  f.leds.forEach((led, i) => set(f, i, u8(fn(f.hsv.v, led.x - f.center.x, led.y - f.center.y, time))));
}

function runnerDist(f: Frame, fn: (val: number, dx: number, dy: number, dist: number, time: number) => number) {
  const time = u8(scale16by8(f.timer, f.speed >> 1));
  f.leds.forEach((led, i) => {
    const dx = led.x - f.center.x;
    const dy = led.y - f.center.y;
    set(f, i, u8(fn(f.hsv.v, dx, dy, sqrt16(dx * dx + dy * dy), time)));
  });
}

function runnerSinCos(f: Frame, fn: (val: number, sin: number, cos: number, i: number) => number) {
  const time = scale16by8(f.timer, f.speed >> 2);
  const cosValue = i8(cos8(time) - 128);
  const sinValue = i8(sin8(time) - 128);
  f.leds.forEach((_, i) => set(f, i, u8(fn(f.hsv.v, cosValue, sinValue, i))));
}

/** LED matrix reactive effects divide by the speed itself (not speed + 1): 0 would divide by zero. */
const speedOf = (f: Frame) => Math.max(1, f.speed);

function runnerReactive(f: Frame, fn: (val: number, offset: number) => number) {
  const maxTick = Math.floor(65535 / speedOf(f));
  f.leds.forEach((_, i) => {
    let tick = maxTick;
    for (let j = f.hits.length - 1; j >= 0; j--) {
      if (f.hits[j].led === i && f.hits[j].tick < tick) {
        tick = f.hits[j].tick;
        break;
      }
    }
    set(f, i, fn(f.hsv.v, scale16by8(tick, f.speed)));
  });
}

function runnerSplash(f: Frame, fn: (val: number, dx: number, dy: number, dist: number, tick: number) => number, all: boolean) {
  const start = all ? 0 : Math.max(0, f.hits.length - 1);
  f.leds.forEach((led, i) => {
    let val = 0;
    for (let j = start; j < f.hits.length; j++) {
      const hit = f.hits[j];
      const dx = led.x - hit.x;
      const dy = led.y - hit.y;
      val = fn(val, dx, dy, sqrt16(dx * dx + dy * dy), scale16by8(hit.tick, f.speed));
    }
    set(f, i, scale8(val, f.hsv.v));
  });
}

const wide = (val: number, _dx: number, _dy: number, dist: number, tick: number) => qadd8(val, 255 - Math.min(255, tick + dist * 5));
const cross = (val: number, dx: number, dy: number, dist: number, tick: number) => {
  let effect = tick + dist;
  const ax = Math.min(255, Math.abs(dx) * 16);
  const ay = Math.min(255, Math.abs(dy) * 16);
  effect += ax > ay ? ay : ax;
  return qadd8(val, 255 - Math.min(255, effect));
};
const nexus = (val: number, dx: number, dy: number, dist: number, tick: number) => {
  let effect = Math.min(255, u16(tick - dist));
  if (dist > 72) effect = 255;
  if ((dx > 8 || dx < -8) && (dy > 8 || dy < -8)) effect = 255;
  return qadd8(val, 255 - effect);
};
const splash = (val: number, _dx: number, _dy: number, dist: number, tick: number) => qadd8(val, 255 - Math.min(255, u16(tick - dist)));

/** By the generator's effect name. */
export const LED_EFFECTS: Record<string, (f: Frame) => void> = {
  Solid: (f) => f.leds.forEach((_, i) => set(f, i, f.hsv.v)),
  "Alphas & mods": (f) => {
    const [alphas, mods] = [f.hsv.v, u8(f.hsv.v + f.speed)];
    f.leds.forEach((led, i) => set(f, i, (led.flags ?? 4) & MODIFIER ? mods : alphas));
  },
  Breathing: (f) => runnerI(f, (val, _i, time) => scale8(u8(abs8(sin8(time >> 1) - 128) * 2), val)),
  Band: (f) =>
    runnerI(f, (val, i, time) => {
      const v = val - Math.abs(scale8(f.leds[i].x, 228) + 28 - time) * 8;
      return scale8(v < 0 ? 0 : v, val);
    }),
  "Band pinwheel": (f) => runnerDxDy(f, (val, dx, dy, time) => scale8(u8(val - time - atan2_8(dy, dx) * 3), val)),
  "Band spiral": (f) => runnerDist(f, (val, dx, dy, dist, time) => scale8(u8(val + dist - time - atan2_8(dy, dx)), val)),
  "Cycle left right": (f) => runnerI(f, (val, i, time) => scale8(u8(f.leds[i].x - time), val)),
  "Cycle up down": (f) => runnerI(f, (val, i, time) => scale8(u8(f.leds[i].y - time), val)),
  "Cycle out in": (f) => runnerDist(f, (val, _dx, _dy, dist, time) => scale8(u8(Math.trunc((3 * dist) / 2) + time), val)),
  "Dual beacon": (f) =>
    runnerSinCos(f, (val, sin, cos, i) =>
      scale8(u8(Math.trunc(((f.leds[i].y - f.center.y) * cos + (f.leds[i].x - f.center.x) * sin) / 128)), val),
    ),
  "Reactive simple": (f) => runnerReactive(f, (val, offset) => scale8(255 - Math.min(255, offset), val)),
  "Reactive wide": (f) => runnerSplash(f, wide, false),
  "Reactive multiwide": (f) => runnerSplash(f, wide, true),
  "Reactive cross": (f) => runnerSplash(f, cross, false),
  "Reactive multicross": (f) => runnerSplash(f, cross, true),
  "Reactive nexus": (f) => runnerSplash(f, nexus, false),
  "Reactive multinexus": (f) => runnerSplash(f, nexus, true),
  Splash: (f) => runnerSplash(f, splash, false),
  Multisplash: (f) => runnerSplash(f, splash, true),
  "Wave left right": (f) => runnerI(f, (val, i, time) => scale8(sin8(u8(f.leds[i].x - time)), val)),
  "Wave up down": (f) => runnerI(f, (val, i, time) => scale8(sin8(u8(f.leds[i].y - time)), val)),
};

/** White-backlight effects that react to keypresses. */
export const REACTIVE_LED_EFFECTS = new Set(Object.keys(LED_EFFECTS).filter((n) => n.startsWith("Reactive") || n.endsWith("splash") || n === "Splash"));
