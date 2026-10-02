import "./v6board";
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEDS } from "../src/lib/layout";
import { atan2_8, cos8, hsvToRgb, scale8, scale16by8, sin8, sqrt16 } from "../src/lib/rgb/qmkMath";
import { RgbSimulator } from "../src/lib/rgb/simulator";
import type { Lighting } from "../src/lib/types";

const rgbOf = (h: number, s: number, v: number) => {
  const out = new Uint8Array(3);
  hsvToRgb(h, s, v, out, 0);
  return [...out];
};
const at = (frame: Uint8Array, led: number) => [...frame.slice(led * 3, led * 3 + 3)];

test("QMK's integer maths", () => {
  assert.deepEqual([sin8(0), sin8(64), sin8(128), sin8(192)], [128, 255, 128, 1]);
  assert.equal(cos8(0), 255);
  assert.deepEqual([atan2_8(0, 5), atan2_8(0, -5), atan2_8(5, 0), atan2_8(-5, 0)], [0, 128, 64, 192]);
  assert.equal(sqrt16(112 * 112 + 32 * 32), 116);
  assert.equal(scale8(255, 255), 255);
  assert.equal(scale8(200, 127), 100);
  assert.equal(scale16by8(70000, 255), 70000 - 65536, "the timer wraps at 16 bits");
  assert.deepEqual(rgbOf(0, 255, 255), [255, 0, 0]);
  assert.deepEqual(rgbOf(85, 255, 255), [0, 255, 0]);
  assert.deepEqual(rgbOf(170, 255, 255), [0, 0, 255]);
  assert.deepEqual(rgbOf(0, 0, 200), [200, 200, 200]);
});

test("the LED map: every LED under a key, on QMK's 224 × 64 grid", () => {
  assert.equal(LEDS.length, 109);
  assert.equal(new Set(LEDS.map((l) => l.key)).size, 109);
  assert.ok(LEDS.every((l) => l.x >= 0 && l.x <= 224 && l.y >= 0 && l.y <= 64));
  assert.deepEqual(LEDS[0], { key: "0,0", x: 0, y: 0, flags: 1 });
});

const base: Lighting = { effect: 1, hue: 170, sat: 255, brightness: 255, speed: 128 };

test("solid colour, cycling effects, and effect None", () => {
  const sim = new RgbSimulator(LEDS, { rows: 6, cols: 21 });
  sim.setLighting(base);
  const f = sim.frame(0);
  for (let i = 0; i < LEDS.length; i++) assert.deepEqual(at(f, i), [0, 0, 255]);

  sim.setLighting({ ...base, effect: 5 }); // Cycle Left Right
  const a = sim.frame(1000);
  const esc = sim.ledOf("0,0")!;
  const f16 = sim.ledOf("0,20")!;
  assert.notDeepEqual(at(a, esc), at(a, f16), "hue follows the position");
  const b = sim.frame(3000);
  assert.notDeepEqual(at(a, esc), at(b, esc), "and moves with time");

  sim.setLighting({ ...base, effect: 0 });
  assert.ok(sim.frame(4000).every((c) => c === 0), "None: dark");
});

test("colour layers go over the effect; 'None' shows only them; brightness scales them", () => {
  const sim = new RgbSimulator(LEDS, { rows: 6, cols: 21 });
  const layer = { id: "l", name: "Red", color: { h: 0, s: 255, v: 255 }, keys: ["2,1"] };
  sim.setLighting({ ...base, layers: [layer] });
  const f = sim.frame(0);
  assert.deepEqual(at(f, sim.ledOf("2,1")!), [255, 0, 0]);
  assert.deepEqual(at(f, sim.ledOf("2,2")!), [0, 0, 255]);

  sim.setLighting({ ...base, effect: 0, brightness: 128, layers: [layer] });
  const g = sim.frame(100);
  assert.deepEqual(at(g, sim.ledOf("2,1")!), [128, 0, 0]);
  assert.deepEqual(at(g, sim.ledOf("2,2")!), [0, 0, 0]);
});

test("reactive: a layer lights up when its key is pressed, then fades", () => {
  const sim = new RgbSimulator(LEDS, { rows: 6, cols: 21 });
  const layer = { id: "l", name: "React", color: { h: 0, s: 255, v: 255 }, keys: ["2,1"], anim: "reactive" as const, speed: 128 };
  sim.setLighting({ ...base, effect: 0, layers: [layer] });
  const led = sim.ledOf("2,1")!;
  assert.deepEqual(at(sim.frame(0), led), [0, 0, 0], "dark at rest");
  sim.press("2,1");
  assert.ok(at(sim.frame(16), led)[0] > 200, "lit when pressed");
  assert.deepEqual(at(sim.frame(3000), led), [0, 0, 0], "faded");

  sim.setLighting({ ...base, effect: 18 }); // Reactive Simple
  const k = sim.ledOf("3,3")!;
  assert.deepEqual(at(sim.frame(4000), k), [0, 0, 0]);
  sim.press("3,3");
  assert.ok(at(sim.frame(4016), k)[2] > 200);
});

test("Mix RGB: each region plays its own effect; colour layers still go on top", () => {
  const sim = new RgbSimulator(LEDS, { rows: 6, cols: 21 });
  const layer = { id: "l", name: "White", color: { h: 0, s: 0, v: 255 }, keys: ["0,0"] };
  sim.setLighting({
    ...base,
    effect: 24,
    layers: [layer],
    mix: {
      regions: [
        { keys: [], effects: [{ effect: 1, hue: 0, sat: 255, speed: 128, time: 5000 }] },
        { keys: ["2,1", "2,2"], effects: [{ effect: 1, hue: 85, sat: 255, speed: 128, time: 5000 }] },
      ],
    },
  });
  const f = sim.frame(0);
  assert.deepEqual(at(f, sim.ledOf("3,3")!), [255, 0, 0], "the base");
  assert.deepEqual(at(f, sim.ledOf("2,1")!), [0, 255, 0], "region 2");
  assert.deepEqual(at(f, sim.ledOf("0,0")!), [255, 255, 255], "the colour layer");
});

test("Mix RGB rotates a region's effects, fading between them", () => {
  const sim = new RgbSimulator(LEDS, { rows: 6, cols: 21 });
  sim.setLighting({
    ...base,
    effect: 24,
    mix: {
      regions: [
        {
          keys: [],
          effects: [
            { effect: 1, hue: 0, sat: 255, speed: 128, time: 3000 },
            { effect: 1, hue: 85, sat: 255, speed: 128, time: 3000 },
          ],
        },
      ],
    },
  });
  const k = sim.ledOf("3,3")!;
  // Frames as the screen asks for them (~30 a second).
  let t = 0;
  const until = (end: number) => {
    let f = sim.frame(t);
    while (t < end) f = sim.frame((t = Math.min(end, t + 33)));
    return f;
  };
  assert.ok(at(until(1500), k)[0] > 200, "the first, fully");
  assert.ok(at(until(2800), k)[0] < 100, "fading out before the switch");
  assert.ok(at(until(4500), k)[1] > 200, "then the second");
});

test("white backlights: QMK's LED matrix effects by name, in grey, with brightness layers", async () => {
  const white = (await import("../src/data/boards/k1_max_ansi_white.json")).default as unknown as {
    leds: Array<{ key: string; x: number; y: number; flags: number }>;
    effects: Array<[string, number]>;
    matrix: { rows: number; cols: number };
  };
  const id = (name: string) => white.effects.find(([n]) => n === name)![1];
  const sim = new RgbSimulator(white.leds, { ...white.matrix, white: { effects: white.effects } });
  const k = white.leds.findIndex((l) => l.key === "3,1");

  sim.setLighting({ effect: id("Solid"), hue: 170, sat: 255, brightness: 200, speed: 128 });
  assert.deepEqual(at(sim.frame(0), k), [200, 200, 200], "no colour: the hue is ignored");

  sim.setLighting({ effect: id("Breathing"), hue: 0, sat: 0, brightness: 255, speed: 255 });
  const levels = new Set<number>();
  for (let t = 0; t < 4000; t += 100) levels.add(sim.frame(t)[k * 3]);
  assert.ok(levels.size > 10, "breathing moves");

  sim.setLighting({ effect: id("Reactive simple"), hue: 0, sat: 0, brightness: 255, speed: 128 });
  const now = 10_000;
  assert.equal(sim.frame(now)[k * 3], 0, "dark at rest");
  sim.press("3,1");
  assert.ok(sim.frame(now + 50)[k * 3] > 200, "lit when pressed");

  // A brightness layer (hue/sat 0) over Solid, scaled by the base brightness; "Off" keeps a key dark.
  sim.setLighting({
    effect: id("Solid"),
    hue: 0,
    sat: 0,
    brightness: 128,
    speed: 0,
    layers: [
      { id: "a", name: "Full", color: { h: 0, s: 0, v: 255 }, keys: ["3,1"] },
      { id: "b", name: "Off", color: { h: 0, s: 0, v: 0 }, keys: ["0,0"] },
    ],
  });
  const f = sim.frame(now + 5000);
  assert.deepEqual(at(f, k), [128, 128, 128]);
  assert.deepEqual(at(f, 0), [0, 0, 0]);
  assert.deepEqual(at(f, 1), [128, 128, 128], "the others show the effect");
});
