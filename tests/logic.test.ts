import "./v6board";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindId,
  boardId,
  keycodeAt,
  layerInfos,
  layerName,
  layerOf,
  putBindsOnLayers,
  resolveKey,
  splitLayer,
} from "../src/lib/keyIds";
import { effectiveAnims } from "../src/lib/layers";
import { fallbackBaseKeymap } from "../src/lib/layout";
import {
  duplicateProfile,
  importedProfiles,
  uniqueName,
} from "../src/lib/profiles";
import {
  cleanRule,
  matchProfile,
  migratePrograms,
  ruleLabel,
  ruleScore,
  type Focus,
} from "../src/lib/programs";
import {
  clampGap,
  MAX_MACRO_GAP,
  macroBytes,
} from "../src/lib/limits";
import { DEFAULT_SETTINGS, type AppConfig, type Profile, type ProgramRule } from "../src/lib/types";
import {
  HISTORY_LIMIT,
  MERGE_MS,
  emptyHistory,
  record,
  redo,
  undo,
} from "../src/state/history";
import { key, profile } from "./helpers";
import FIXTURE from "./fixtures/config.json";

const focus = (path: string, title = ""): Focus => ({ path, title });

test("the shared fixture matches the Rust model", () => {
  // The same file `model.rs`'s `the_shared_fixture_round_trips` reads: if `types.ts` and the
  // serde structs drift, one of the two tests fails. Imported (not read by path) so esbuild
  // inlines it into the test bundle.
  const config = FIXTURE as AppConfig;
  assert.equal(config.version, 2);
  assert.equal(config.profiles.length, 2);
  assert.equal(config.profiles[0].lighting?.layers?.length, 1);
  assert.equal(config.profiles[1].lighting?.mix?.regions.length, 2);
  const macro = config.profiles[1].binds["e0:cw"];
  assert.equal(macro.kind === "macro" && macro.gap, 25);
  // The fields the app reads are all there (a missing one would be `undefined`, not a type error).
  const p = config.profiles[1];
  assert.equal(p.programs[0].match, "path");
  assert.equal(p.programs[0].title, "Counter-Strike");
  assert.deepEqual(p.lighting?.mix?.regions[1].keys, ["3,1"]);
});

test("rule scores match the Rust engine", () => {
  const game = focus("D:\\Games\\Foo\\bin\\Game.exe", "Foo — Main Menu");
  const r = (
    path: string,
    match?: ProgramRule["match"],
    title?: string,
  ): ProgramRule => ({ path, match, title });
  assert.equal(ruleScore(r("C:\\elsewhere\\game.exe"), game), 1);
  assert.equal(ruleScore(r("D:/games/foo", "folder"), game), 2);
  assert.equal(ruleScore(r("D:\\Games\\Foo\\", "folder"), game), 2);
  assert.equal(
    ruleScore(r("D:\\Games\\Fo", "folder"), game),
    null,
    "not a folder prefix",
  );
  assert.equal(ruleScore(r("d:\\games\\foo\\bin\\game.exe", "path"), game), 3);
  assert.equal(
    ruleScore(r("C:\\Games\\Foo\\bin\\Game.exe", "path"), game),
    null,
  );
  assert.equal(ruleScore(r("", undefined, "main menu"), game), 4);
  assert.equal(ruleScore(r("Game.exe", "name", "MENU"), game), 5);
  assert.equal(ruleScore(r("Game.exe", "name", "lobby"), game), null);
  assert.equal(ruleScore(r("", undefined, "  "), game), null);
});

test("the most specific profile wins, the first on a tie", () => {
  const config: AppConfig = {
    version: 2,
    profiles: [
      profile("default", "Default", { programs: [{ path: "chrome.exe" }] }),
      profile("a", "A", { programs: [{ path: "chrome.exe" }] }),
      profile("b", "B", { programs: [{ path: "chrome.exe", title: "Figma" }] }),
      profile("c", "C", { programs: [{ path: "chrome.exe" }] }),
    ],
  };
  const chrome = (t: string) => focus("C:\\Chrome\\chrome.exe", t);
  assert.equal(matchProfile(config, chrome("News")).id, "a");
  assert.equal(matchProfile(config, chrome("Design – Figma")).id, "b");
  assert.equal(matchProfile(config, focus("C:\\x\\other.exe")).id, "default");
  assert.equal(matchProfile(config, null).id, "default");
});

test("program rule helpers", () => {
  assert.deepEqual(
    migratePrograms({
      ...profile("a", "A"),
      programs: undefined,
      exes: ["a.exe", "A.EXE", "b.exe"],
    } as never).programs,
    [{ path: "a.exe" }, { path: "b.exe" }],
  );
  assert.deepEqual(cleanRule({ path: "x", match: "name", title: " " }), {
    path: "x",
  });
  assert.deepEqual(ruleLabel({ path: "C:\\G\\cs2.exe" }), {
    name: "cs2.exe",
    detail: "",
  });
  assert.deepEqual(ruleLabel({ path: "C:\\G\\cs2.exe", match: "path" }), {
    name: "cs2.exe",
    detail: "exact path",
  });
  assert.equal(
    ruleLabel({ path: "D:\\Games", match: "folder" }).name,
    "Games\\…",
  );
  assert.deepEqual(ruleLabel({ path: "", title: "Figma" }), {
    name: "Any program",
    detail: "title has “Figma”",
  });
});

test("layer ids", () => {
  assert.equal(bindId("3,1", 3), "L3:3,1");
  assert.equal(bindId("L3:3,1", 0), "L0:3,1");
  assert.equal(boardId("L12:e0:cw"), "e0:cw");
  assert.equal(layerOf("L3:e0:cw", 2), 3);
  assert.equal(layerOf("3,1", 2), 2, "no layer: the default one");
  assert.deepEqual(splitLayer("Lx:3,1"), { layer: null, key: "Lx:3,1" });
  const cfg = putBindsOnLayers(
    {
      version: 2,
      profiles: [
        profile("default", "Default", {
          binds: { "3,1": key(4), "L0:1,1": key(5) },
        }),
      ],
    },
    2,
  );
  assert.deepEqual(Object.keys(cfg.profiles[0].binds), ["L2:3,1", "L0:1,1"]);
});

test("keys fall through like QMK: the default layer, then layer 0", () => {
  const base = fallbackBaseKeymap(); // Keychron's: 0 Mac, 1 Mac Fn, 2 Win (default), 3 Win Fn
  assert.equal(base.layer, 2);
  assert.notEqual(
    base.layers[3]["0,1"],
    1,
    "Fn+F1 is a key of its own (brightness down)",
  );
  assert.equal(keycodeAt(base, "L3:0,1"), base.layers[3]["0,1"]);
  assert.equal(base.layers[3]["4,2"], 1, "Z is transparent on Win Fn");
  assert.equal(
    keycodeAt(base, "L3:4,2"),
    base.layers[2]["4,2"],
    "so Fn+Z types what the default layer has",
  );
  assert.deepEqual(resolveKey(base, 3, "4,2").from, 2);

  // A keymap that keeps its layout on layer 0 with an empty Win layer (like the default keymap).
  const layer0 = { "4,2": 0x1d, "3,1": 0x04 };
  const empty = { "4,2": 1, "3,1": 1 };
  const own = {
    ...base,
    layers: [layer0, { "4,2": 1, "3,1": 0x3a }, empty, empty],
  };
  assert.deepEqual(
    resolveKey(own, 2, "4,2"),
    { kc: 0x1d, from: 0 },
    "the empty default layer falls to layer 0",
  );
  assert.deepEqual(resolveKey(own, 1, "4,2"), { kc: 0x1d, from: 0 });
  assert.equal(
    resolveKey(own, 3, "3,1").from,
    0,
    "layer 3 → default (2) → layer 0",
  );
  // …and a remap of the profile on the layer it lands on shows through.
  const r = resolveKey(own, 2, "4,2", { "L0:4,2": key(0x05) });
  assert.deepEqual([r.kc, r.from, r.bind], [0x05, 0, key(0x05)]);
  assert.equal(
    resolveKey(own, 2, "4,2", { "L2:4,2": key(0x06) }).bind,
    undefined,
    "its own layer's remap is not 'from below'",
  );

  const infos = layerInfos({
    ...own,
    layers: [
      { "5,12": 0x5221, "0,0": 0x29 },
      { "0,0": 0x3a },
      { "0,0": 1 },
      { "0,0": 1 },
    ],
  });
  assert.deepEqual(
    infos.map((i) => [i.isDefault, i.isFn, i.empty]),
    [
      [false, false, false],
      [false, true, false],
      [true, false, true],
      [false, false, true],
    ],
  );
  assert.equal(layerName(3, { "3": " Gaming " }), "Gaming");
  assert.equal(layerName(1, { "3": "Gaming" }), "Layer 1");
});

test("history: steps, merging, limit", () => {
  const cfg = (n: number): AppConfig => ({
    version: 2,
    profiles: [profile("default", `v${n}`)],
  });
  let h = emptyHistory();
  h = record(h, cfg(0), null, 0);
  h = record(h, cfg(1), "g", 10);
  h = record(h, cfg(2), "g", 10 + MERGE_MS - 1);
  assert.equal(h.past.length, 2, "same group, soon after: merged");
  h = record(h, cfg(3), "g", 10 + 3 * MERGE_MS);
  assert.equal(h.past.length, 3, "same group, much later: a new step");
  const [back, h2] = undo(h, cfg(4))!;
  assert.equal(back.profiles[0].name, "v3");
  const [fwd] = redo(h2, back)!;
  assert.equal(fwd.profiles[0].name, "v4");
  assert.equal(undo(emptyHistory(), cfg(0)), null);
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = record(h, cfg(i), null, i);
  assert.equal(h.past.length, HISTORY_LIMIT);
});

test("profile copies and imports get unique names and ids", () => {
  const existing: Profile[] = [
    profile("default", "Default"),
    profile("a", "Game"),
    profile("b", "Game 2"),
  ];
  assert.equal(uniqueName("Game", existing), "Game 3");
  assert.equal(uniqueName("  ", existing), "Profile");
  const copy = duplicateProfile(
    { ...existing[1], programs: [{ path: "g.exe" }] },
    existing,
  );
  assert.equal(copy.name, "Game copy");
  assert.deepEqual(copy.programs, []);
  const added = importedProfiles(
    [existing[0], existing[1], existing[1]],
    existing,
  );
  assert.deepEqual(
    added.map((p) => p.name),
    ["Default (imported)", "Game 3", "Game 4"],
  );
  assert.ok(added.every((p) => !existing.some((e) => e.id === p.id)));
});

test("animated layers: the topmost visible layer decides", () => {
  const l = {
    effect: 1,
    speed: 0,
    brightness: 255,
    hue: 0,
    sat: 0,
    layers: [
      {
        id: "a",
        name: "A",
        color: { h: 0, s: 0, v: 255 },
        keys: ["1,1", "1,2"],
        anim: "cycle" as const,
        speed: 10,
      },
      { id: "b", name: "B", color: { h: 0, s: 0, v: 255 }, keys: ["1,2"] },
      {
        id: "c",
        name: "C",
        color: { h: 0, s: 0, v: 255 },
        keys: ["1,1"],
        anim: "breathe" as const,
        hidden: true,
      },
    ],
  };
  assert.deepEqual(effectiveAnims(l), { "1,1": { anim: "cycle", speed: 10 } });
});

test("layer names: colours on RGB boards, brightness on white backlights", async () => {
  const { layerName: colourLayerName } = await import("../src/lib/layers");
  const { setBoard } = await import("../src/lib/layout");
  const { V6_BOARD } = await import("./v6board");
  const white = (await import("../src/data/boards/k8_max_ansi_white.json"))
    .default;
  assert.equal(colourLayerName({ h: 0, s: 255, v: 255 }, []), "Red");
  setBoard(white as unknown as typeof V6_BOARD);
  try {
    assert.equal(colourLayerName({ h: 0, s: 0, v: 128 }, []), "Brightness 50%");
    assert.equal(
      colourLayerName({ h: 0, s: 0, v: 0 }, [
        {
          id: "a",
          name: "Brightness Off",
          color: { h: 0, s: 0, v: 0 },
          keys: [],
        },
      ]),
      "Brightness Off 2",
    );
  } finally {
    setBoard(V6_BOARD);
  }
});

test("text becomes the keys that type it in the layout", async () => {
  const { builtinLegends } = await import("../src/qmk/labels");
  const { typeText } = await import("../src/qmk/typeText");
  const layout = (id: string) =>
    new Map(
      Object.entries(builtinLegends(id)!).map(([kc, lg]) => [Number(kc), lg]),
    );
  const french = layout("0000040C");
  const us = layout("00000409");
  const keys = (text: string, legends = french) => {
    const r = typeText(text, legends);
    return r.ok ? r.keycodes : r.missing;
  };

  // AZERTY: "a" is on the Q position, "m" on the semicolon's, "@" is AltGr+0, "." is Shift+";".
  assert.deepEqual(
    keys("Bon@mail.fr"),
    [0x0205, 0x12, 0x11, 0x1427, 0x33, 0x14, 0x0c, 0x0f, 0x0236, 0x09, 0x15],
  );
  assert.deepEqual(
    keys("1 é"),
    [0x021e, 0x2c, 0x1f],
    "digits are shifted on AZERTY",
  );
  assert.deepEqual(keys("a\tb\r\nc"), [0x14, 0x2b, 0x05, 0x28, 0x06]);
  assert.deepEqual(keys("A?", us), [0x0204, 0x0238]);

  // Dead keys: the accent then the letter; alone, the accent then Space. "^" also has a plain key.
  assert.deepEqual(keys("ê"), [0x2f, 0x08]);
  assert.deepEqual(keys("Ë"), [0x022f, 0x0208]);
  assert.deepEqual(keys("ñ"), [0x141f, 0x11]);
  assert.deepEqual(keys("¨"), [0x022f, 0x2c]);
  assert.deepEqual(keys("^"), [0x1426], "AltGr+9 types it at once");
  assert.deepEqual(
    keys("ê"),
    [0x2f, 0x08],
    "a decomposed ê is the same letter",
  );

  assert.deepEqual(keys("€5 日", us), ["€", "日"]);
  assert.deepEqual(keys("ê", us), ["ê"], "no dead key on the US layout");
  assert.deepEqual(typeText("", french), { ok: true, keycodes: [] });
});

test("macro gap: its bytes, the field's clamping, and the module that plays it", () => {
  // 3 for the gap (whatever its value), 3 per step, 1 terminator: protocol::build_keymap's count.
  assert.equal(macroBytes([]), 4);
  assert.equal(macroBytes([{ op: "tap", keycode: 4 }, { op: "delay", ms: 5 }]), 10);
  assert.equal(clampGap(""), undefined);
  assert.equal(clampGap("abc"), undefined);
  assert.equal(clampGap("-3"), 0);
  assert.equal(clampGap("12.6"), 13);
  assert.equal(clampGap("99999"), MAX_MACRO_GAP);
  assert.equal(DEFAULT_SETTINGS.macroGap, 10);
});
