// Run with: pnpm test
import { readdirSync, readFileSync } from "node:fs";
import type { BoardData } from "../src/lib/boards";
import { BOARDS } from "../src/lib/boards";
import {
  KEYS,
  LEDS,
  KNOBS,
  fallbackBaseKeymap,
  setBoard,
} from "../src/lib/layout";
import V6 from "../src/data/boards/v6_8k_iso_encoder.json";
import { MODULE_VERSION } from "../src/lib/limits";
import { MODULE_VERSION as MOCK_MODULE_VERSION } from "../src/lib/firmwareMock";
import { keycodeToString, valueOf } from "../src/qmk/keycodes";
import {
  builtinLegends,
  keycodeLabel,
  legendFor,
  setLegends,
} from "../src/qmk/labels";
import { parseKeycode } from "../src/qmk/parse";
import {
  clearKeys,
  effectiveKeys,
  migrateLighting,
  paintKeys,
} from "../src/lib/layers";

let failures = 0;
function eq(what: string, got: unknown, want: unknown) {
  if (got !== want) {
    failures++;
    console.error(`FAIL ${what}: got ${String(got)}, want ${String(want)}`);
  }
}

const cases: Array<[string, number]> = [
  ["KC_A", 0x0004],
  ["kc_a", 0x0004],
  ["KC_BTN5", 0x00d5],
  ["LCTL(KC_C)", 0x0106],
  ["C(KC_C)", 0x0106],
  ["LCTL(LSFT(KC_A))", 0x0304],
  ["RCTL(KC_A)", 0x1104],
  ["ALGR(KC_E)", 0x1408],
  ["MEH(KC_F1)", 0x073a],
  ["MO(1)", 0x5221],
  ["TG(3)", 0x5263],
  ["LT(2, KC_SPC)", 0x422c],
  ["MT(MOD_LCTL | MOD_LSFT, KC_A)", 0x2304],
  ["LCTL_T(KC_ESC)", 0x2129],
  ["OSM(MOD_RSFT)", 0x52b2],
  ["LM(1, MOD_LALT)", 0x5024],
  ["0x5221", 0x5221],
  ["KC_TASK", 0x7e06],
];
for (const [src, want] of cases) {
  const r = parseKeycode(src);
  eq(`parse ${src}`, r.ok ? r.value : r.error, want);
  if (r.ok) {
    const back = parseKeycode(keycodeToString(r.value));
    eq(
      `roundtrip ${src} (${keycodeToString(r.value)})`,
      back.ok ? back.value : back.error,
      want,
    );
  }
}
for (const bad of [
  "",
  "FOO",
  "LCTL(RCTL(KC_A))",
  "LT(16, KC_A)",
  "MO(1",
  "LCTL(MO(1))",
]) {
  eq(`reject "${bad}"`, parseKeycode(bad).ok, false);
}

eq("US label KC_Q", keycodeLabel(valueOf("KC_Q")!), "Q");
eq(
  "US legend KC_2",
  JSON.stringify(legendFor(valueOf("KC_2")!)),
  JSON.stringify({ base: "2", shift: "@" }),
);
eq("unknown layout", builtinLegends("12345678"), null);
setLegends(builtinLegends("0000040c")!);
eq("FR label KC_Q", keycodeLabel(valueOf("KC_Q")!), "A");
eq("label KC_SCLN", keycodeLabel(valueOf("KC_SCLN")!), "M");
eq("label LCTL(KC_Q)", keycodeLabel(0x0114), "Ctrl+A");
eq("label MS_BTN5", keycodeLabel(0x00d5), "Mouse 5");

{
  const c = readFileSync("firmware/profile_switcher.c", "utf8");
  eq(
    "MODULE_VERSION is the module's PS_PROTO_VERSION",
    Number(/#define PS_PROTO_VERSION (\d+)/.exec(c)?.[1]),
    MODULE_VERSION,
  );
  // A mock a version behind makes the browser preview show notices the real app never shows.
  eq(
    "the browser mock pretends to the same module version",
    MOCK_MODULE_VERSION,
    MODULE_VERSION,
  );
}

setBoard(V6 as unknown as BoardData);
eq("V6: layout key count", KEYS.length, 110);
eq("V6: one knob", KNOBS.join(","), "0");
eq("V6: LEDs", LEDS.length, 109);
{
  const fb = fallbackBaseKeymap();
  eq(
    "V6: four stock layers, default 2",
    `${fb.layers.length}/${fb.layer}`,
    "4/2",
  );
  eq("V6: Esc on layer 2", keycodeToString(fb.layers[2]["0,0"]), "KC_ESC");
  eq("V6: knob on layer 2", keycodeToString(fb.layers[2]["e0:cw"]), "KC_VOLU");
}

// Every Keychron board: its file loads, keys sit in its matrix, LEDs are over keys, and the stock
// keymap's names are keycodes (Keychron's own keys resolved per board by the generator).
{
  // Keymaps that use a key their own VIA list lacks (Keychron's data): shown blank, not an error.
  const KNOWN_GAPS = new Set(["BL_SPI", "BL_SPD", "OS_MAC", "OS_WIN"]);
  const files = readdirSync("src/data/boards").filter(
    (f) => f !== "index.json",
  );
  eq("one file per board in the index", files.length, BOARDS.length);
  const problems: string[] = [];
  for (const f of files) {
    const b = JSON.parse(
      readFileSync(`src/data/boards/${f}`, "utf8"),
    ) as BoardData;
    setBoard(b);
    const ids = new Set(KEYS.map((k) => k.id));
    if (!KEYS.length) problems.push(`${b.id}: no keys`);
    if (KEYS.some((k) => k.row >= b.matrix.rows || k.col >= b.matrix.cols))
      problems.push(`${b.id}: key outside the matrix`);
    if (KEYS.some((k) => !k.r && (k.x < -0.01 || k.y < -0.01)))
      problems.push(`${b.id}: key left of or above the board`);
    if (LEDS.some((l) => !ids.has(l.key)))
      problems.push(`${b.id}: LED under no key`);
    if (KNOBS.length !== b.encoders) problems.push(`${b.id}: knobs`);
    for (const layer of b.keymap?.layers ?? []) {
      for (const name of layer) {
        if (name && !parseKeycode(name).ok && !KNOWN_GAPS.has(name))
          problems.push(`${b.id}: ${name}`);
      }
    }
    if (b.keymap && fallbackBaseKeymap().layer >= b.keymap.layers.length)
      problems.push(`${b.id}: default layer`);
  }
  eq("every board", problems.slice(0, 8).join("; "), "");
  setBoard(V6 as unknown as BoardData);
}

{
  const us = parseKeycode("KC_EXLM");
  eq(
    "US alias KC_EXLM refused with a hint",
    !us.ok && us.error.includes("US-layout"),
    true,
  );
  eq("US alias inside a wrapper too", parseKeycode("LCTL(KC_AT)").ok, false);
}

{
  const red = { h: 0, s: 255, v: 255 };
  const white = { h: 0, s: 0, v: 255 };
  const base = { effect: 1, speed: 0, brightness: 255, hue: 0, sat: 0 };
  const j = (x: unknown) => JSON.stringify(x);
  const old = migrateLighting({
    ...base,
    keys: { "1,1": red, "1,2": white, "1,3": red },
  })!;
  eq("migrate: no flat keys left", "keys" in old, false);
  eq(
    "migrate: one layer per colour",
    j(old.layers!.map((l) => [l.name, l.keys])),
    j([
      ["Red", ["1,1", "1,3"]],
      ["White", ["1,2"]],
    ]),
  );
  eq(
    "migrate: same colours",
    j(effectiveKeys(old)),
    j({ "1,1": red, "1,3": red, "1,2": white }),
  );

  const layers = [
    { id: "a", name: "All", color: white, keys: ["1,1", "1,2", "1,3"] },
    { id: "b", name: "Top", color: red, keys: ["1,2"] },
  ];
  eq("higher layer wins", j(effectiveKeys({ ...base, layers })["1,2"]), j(red));
  eq(
    "hidden layer skipped",
    j(
      effectiveKeys({
        ...base,
        layers: [layers[0], { ...layers[1], hidden: true }],
      })["1,2"],
    ),
    j(white),
  );
  eq(
    "clear drops emptied layers",
    j(clearKeys(layers, ["1,2"]).map((l) => l.id)),
    j(["a"]),
  );
  eq(
    "clear keeps the active one",
    j(clearKeys(layers, ["1,2"], "b").map((l) => l.keys)),
    j([["1,1", "1,3"], []]),
  );
  const [painted, target] = paintKeys(layers, ["1,1", "e0:cw"], red);
  eq("paint joins the same-colour layer", target, "b");
  eq(
    "paint moves the key, skips the knob",
    j(painted.map((l) => l.keys)),
    j([
      ["1,2", "1,3"],
      ["1,2", "1,1"],
    ]),
  );
  const [fresh, id] = paintKeys(layers, ["1,3"], { h: 85, s: 255, v: 255 });
  eq(
    "paint a new colour: new top layer",
    j([fresh.length, fresh[2].id === id, fresh[2].name]),
    j([3, true, "Green"]),
  );
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`selftest ok (${cases.length} parser cases)`);
