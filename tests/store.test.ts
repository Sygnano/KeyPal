import "./v6board";
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, initApi } from "../src/lib/api";
import { allIds } from "../src/lib/board";
import { effectiveKeys } from "../src/lib/layers";
import { MACRO_SLOTS } from "../src/lib/limits";
import type { AppConfig, Lighting } from "../src/lib/types";
import {
  checkDirtyNow,
  dirtyCheckCount,
  lightingMode,
  restOfMix,
  useStore,
} from "../src/state/store";
import { draftProfile, freshStore, key, profile } from "./helpers";

const s = () => useStore.getState();
const dirty = () => JSON.stringify(s().saved) !== JSON.stringify(s().draft);
const solid: Lighting = {
  effect: 1,
  speed: 0,
  brightness: 200,
  hue: 10,
  sat: 255,
};

test("init brings a version 1 file up to date", async () => {
  const v1 = {
    version: 1,
    profiles: [
      profile("default", "Default"),
      {
        id: "p",
        name: "CS2",
        exes: ["C:\\Games\\cs2.exe"],
        binds: {},
        lighting: null,
      },
    ],
  } as unknown as AppConfig;
  await freshStore(v1);
  assert.equal(s().ready, true);
  assert.equal(s().draft.version, 2);
  assert.deepEqual(draftProfile("p").programs, [
    { path: "C:\\Games\\cs2.exe" },
  ]);
  assert.equal("exes" in draftProfile("p"), false);
  assert.equal(s().history.past.length, 0, "loading isn't an undo step");
});

test("apply saves the draft; discard goes back to what was saved", async () => {
  const { saved } = await freshStore();
  s().setBind("3,1", key(0x14));
  assert.equal(dirty(), true);
  assert.equal(s().dirty, true, "the maintained flag matches too");
  await s().apply();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].profiles[0].binds["3,1"], key(0x14));
  assert.equal(dirty(), false);
  assert.equal(s().dirty, false);

  s().setBind("3,2", key(0x15));
  s().discard();
  assert.equal(dirty(), false);
  assert.equal(
    s().dirty,
    false,
    "discard clears it, though it's itself a recordable edit",
  );
  assert.equal(draftProfile("default").binds["3,2"], undefined);
  s().undo();
  assert.deepEqual(
    draftProfile("default").binds["3,2"],
    key(0x15),
    "discard can be undone",
  );
  assert.equal(
    s().dirty,
    true,
    "undoing the discard brings the edit, and the flag, back",
  );
});

test("apply refuses what the keyboard can't hold", async () => {
  const { saved } = await freshStore();
  for (let i = 0; i <= MACRO_SLOTS; i++)
    s().setBind(`${Math.floor(i / 21)},${i % 21}`, {
      kind: "macro",
      name: "m",
      steps: [],
    });
  await s().apply();
  assert.equal(saved.length, 0);
  assert.match(s().error ?? "", /macros/);
});

test("undo and redo, with quick edits of the same thing merged", async () => {
  await freshStore();
  s().setBind("3,1", key(4));
  s().setBind("3,2", key(5));
  s().undo();
  assert.equal(draftProfile("default").binds["3,2"], undefined);
  assert.deepEqual(draftProfile("default").binds["3,1"], key(4));
  s().redo();
  assert.deepEqual(draftProfile("default").binds["3,2"], key(5));

  s().addProfile();
  const id = s().selectedProfileId;
  for (const name of ["C", "CS", "CS2"]) s().renameProfile(id, name);
  assert.equal(draftProfile(id).name, "CS2");
  s().undo();
  assert.equal(draftProfile(id).name, "Profile 1", "typing a name is one step");
  s().undo();
  assert.equal(s().draft.profiles.length, 1, "then the new profile goes");
  assert.equal(
    s().selectedProfileId,
    "default",
    "and the selection falls back to Default",
  );
  s().redo();
  s().redo();
  assert.equal(draftProfile(id).name, "CS2");

  s().setBind("0,0", key(9));
  assert.equal(s().history.future.length, 0, "a new edit drops the redo steps");
});

test("duplicate puts a copy under the original, without its programs", async () => {
  await freshStore({
    version: 2,
    profiles: [
      profile("default", "Default"),
      profile("a", "CS2", {
        programs: [{ path: "cs2.exe" }],
        binds: { "3,1": key(4) },
      }),
      profile("b", "Other"),
    ],
  });
  s().duplicateProfile("a");
  const names = s().draft.profiles.map((p) => p.name);
  assert.deepEqual(names, ["Default", "CS2", "CS2 copy", "Other"]);
  const copy = s().draft.profiles[2];
  assert.equal(s().selectedProfileId, copy.id);
  assert.notEqual(copy.id, "a");
  assert.deepEqual(copy.programs, []);
  assert.deepEqual(copy.binds, { "L2:3,1": key(4) });
  s().duplicateProfile("a");
  assert.equal(s().draft.profiles[2].name, "CS2 copy 2");
  s().duplicateProfile("default");
  assert.equal(s().draft.profiles[0].id, "default", "Default stays first");
  assert.equal(s().draft.profiles.at(-1)!.name, "Default copy");
});

test("program rules: add without duplicates, edit, remove", async () => {
  await freshStore({
    version: 2,
    profiles: [profile("default", "Default"), profile("a", "A")],
  });
  s().addProgram("a", { path: "C:\\x\\game.exe" });
  s().addProgram("a", { path: "c:\\X\\GAME.exe" });
  assert.equal(draftProfile("a").programs.length, 1);
  s().updateProgram("a", 0, {
    path: "C:\\x\\game.exe",
    match: "path",
    title: "",
  });
  assert.deepEqual(
    draftProfile("a").programs[0],
    { path: "C:\\x\\game.exe", match: "path" },
    "empty title dropped",
  );
  s().updateProgram("a", 0, {
    path: "C:\\x\\game.exe",
    match: "name",
    title: "Lobby",
  });
  assert.deepEqual(draftProfile("a").programs[0], {
    path: "C:\\x\\game.exe",
    title: "Lobby",
  });
  s().removeProgram("a", 0);
  assert.deepEqual(draftProfile("a").programs, []);
});

test("import adds profiles with fresh ids and names that don't clash", async () => {
  await freshStore({
    version: 2,
    profiles: [profile("default", "Default"), profile("a", "CS2")],
  });
  api.importProfiles = async () => [
    profile("default", "Default"),
    { ...profile("a", "CS2"), exes: ["x.exe"] } as never,
  ];
  await s().importProfiles();
  const names = s().draft.profiles.map((p) => p.name);
  assert.deepEqual(names, ["Default", "CS2", "Default (imported)", "CS2 2"]);
  assert.equal(new Set(s().draft.profiles.map((p) => p.id)).size, 4);
  assert.deepEqual(
    s().draft.profiles[3].programs,
    [{ path: "x.exe" }],
    "older files are migrated",
  );
  assert.match(s().notice ?? "", /Imported 2 profiles/);
  api.importProfiles = async () => null; // cancelled
  await s().importProfiles();
  assert.equal(s().draft.profiles.length, 4);
});

test("remaps are per layer; the tabs start on the default layer and can be renamed", async () => {
  await freshStore({
    version: 2,
    profiles: [profile("default", "Default", { binds: { "0,0": key(0x29) } })],
  });
  assert.equal(s().keyLayer, 2, "the default layer");
  assert.deepEqual(
    Object.keys(draftProfile("default").binds),
    ["L2:0,0"],
    "an older remap went on the default layer",
  );
  s().setKeyLayer(3);
  s().setPicked(["3,1", "L3:3,2"]);
  assert.deepEqual(
    s().picked,
    ["3,1", "3,2"],
    "the board picks keys, not bind ids",
  );
  s().setBindMany(["L3:3,1", "L3:3,2"], key(0x3a));
  assert.deepEqual(Object.keys(draftProfile("default").binds).sort(), [
    "L2:0,0",
    "L3:3,1",
    "L3:3,2",
  ]);
  s().setKeyLayer(0);
  assert.deepEqual(s().picked, [], "switching layer clears the selection");
  s().removeBinds(["L3:3,1"]);
  assert.deepEqual(Object.keys(draftProfile("default").binds).sort(), [
    "L2:0,0",
    "L3:3,2",
  ]);

  await s().renameLayer(3, "  Win Fn ");
  assert.deepEqual(s().settings.layerNames, { "3": "Win Fn" });
  await s().renameLayer(3, "");
  assert.deepEqual(
    s().settings.layerNames,
    {},
    "an empty name goes back to 'Layer 3'",
  );

  // Imports from before layers land on the default layer too.
  api.importProfiles = async () => [
    profile("x", "Old", { binds: { "1,1": key(4) } }),
  ];
  await s().importProfiles();
  assert.deepEqual(Object.keys(s().draft.profiles.at(-1)!.binds), ["L2:1,1"]);
});

test("colour layers: painting, quick colours, and a profile following Default", async () => {
  await freshStore({
    version: 2,
    profiles: [
      profile("default", "Default", { lighting: solid }),
      profile("a", "A"),
    ],
  });
  s().selectProfile("a");
  s().setTab("lighting");
  s().setPicked(["1,1", "1,2"]);
  s().addLayer();
  const layer = draftProfile("a").lighting!.layers![0];
  assert.deepEqual(layer.keys, ["1,1", "1,2"]);
  assert.equal(
    draftProfile("a").lighting!.effect,
    1,
    "took a copy of Default's lighting",
  );
  assert.equal(s().activeLayerId, layer.id);

  s().togglePicked("1,3");
  s().togglePicked("1,1");
  assert.deepEqual(
    draftProfile("a").lighting!.layers![0].keys,
    ["1,2", "1,3"],
    "clicks paint the active layer",
  );

  s().setActiveLayer(null);
  s().setKeyColors(["1,2", "e0:cw"], { h: 0, s: 255, v: 255 });
  const layers = draftProfile("a").lighting!.layers!;
  assert.equal(layers.length, 2);
  assert.deepEqual(layers[1].keys, ["1,2"], "the knob has no LED");
  assert.deepEqual(layers[0].keys, ["1,3"]);

  s().updateLayer(layers[1].id, { anim: "breathe", speed: 40 });
  assert.equal(draftProfile("a").lighting!.layers![1].anim, "breathe");
  assert.equal(
    draftProfile("default").lighting!.layers,
    undefined,
    "Default untouched",
  );
});

test("Mix RGB regions are painted like layers; the first region is the rest", async () => {
  await freshStore({
    version: 2,
    profiles: [profile("default", "Default", { lighting: solid })],
  });
  s().setTab("lighting");
  const mix = {
    regions: [
      {
        keys: [],
        effects: [{ effect: 5, hue: 0, sat: 255, speed: 128, time: 5000 }],
      },
      {
        keys: [],
        effects: [{ effect: 1, hue: 170, sat: 255, speed: 128, time: 5000 }],
      },
    ],
  };
  s().setLighting({ ...solid, effect: 24, mix });
  s().setActiveLayer("mix:1");
  s().setPicked(["2,1", "2,2", "e0:cw"]);
  const m = () => draftProfile("default").lighting!.mix!;
  assert.deepEqual(m().regions[1].keys, ["2,1", "2,2"]);
  assert.equal(restOfMix(m()).length, allIds("lighting").length - 2);

  s().setActiveLayer("mix:0");
  assert.equal(
    s().picked.length,
    allIds("lighting").length - 2,
    "the first region shows every other key",
  );
  s().togglePicked("0,0");
  assert.deepEqual(
    m().regions[1].keys.sort(),
    ["0,0", "2,1", "2,2"],
    "taking a key out of the rest moves it over",
  );
  assert.deepEqual(m().regions[0].keys, []);
  s().undo();
  assert.deepEqual(m().regions[1].keys, ["2,1", "2,2"]);
});

test("lighting modes: Like Default, Effect + layers, Mix RGB with its regions as layers", async () => {
  await freshStore({
    version: 2,
    profiles: [
      profile("default", "Default", { lighting: solid }),
      profile("p", "P"),
    ],
  });
  s().selectProfile("p");
  s().setTab("lighting");
  const l = () => draftProfile("p").lighting!;
  assert.equal(lightingMode(draftProfile("p")), "default");
  s().setLightingMode("layers");
  assert.deepEqual(
    { ...l(), layers: undefined },
    { ...solid, layers: undefined },
    "a copy of Default's",
  );
  s().setPicked(["1,1", "1,2"]);
  s().addLayer();
  assert.equal(Object.keys(effectiveKeys(l())).length, 2);

  s().setLightingMode("mix");
  assert.equal(l().effect, 24);
  assert.equal(l().mix?.regions.length, 1, "starts with the base only");
  assert.equal(
    Object.keys(effectiveKeys(l())).length,
    2,
    "the colour layer stays on, over the Mix RGB layers",
  );
  s().setKeyColors(["3,3"], { h: 0, s: 255, v: 255 });
  assert.equal(
    l().layers?.length,
    2,
    "colour layers can be added under Mix RGB too",
  );
  s().setActiveLayer(null);

  s().setPicked(["2,1", "2,2", "e0:cw"]);
  s().addRegion();
  assert.deepEqual(
    l().mix!.regions[1].keys,
    ["2,1", "2,2"],
    "a layer from the picked keys",
  );
  assert.equal(s().activeLayerId, "mix:1", "and it's the one being edited");
  s().addRegion();
  assert.equal(
    l().mix!.regions.length,
    2,
    "no more regions than the keyboard has (2 until it says)",
  );
  s().moveToRegion(["2,1"], 0);
  assert.deepEqual(l().mix!.regions[1].keys, ["2,2"], "back to the base");

  s().setLightingMode("layers");
  assert.equal(l().effect, solid.effect, "the effect it had");
  assert.equal(
    Object.keys(effectiveKeys(l())).length,
    3,
    "the colour layers are the same",
  );
  assert.deepEqual(
    l().mix!.regions[1].keys,
    ["2,2"],
    "the regions are kept for next time",
  );
  s().setLightingMode("mix");
  s().removeRegion(1);
  assert.equal(l().mix!.regions.length, 1);
  s().setLightingMode("default");
  assert.equal(draftProfile("p").lighting, null);
  s().undo();
  assert.equal(l().mix!.regions.length, 1);
});

test("profiles can be moved; Default stays first", async () => {
  await freshStore({
    version: 2,
    profiles: [
      profile("default", "Default"),
      profile("a", "A"),
      profile("b", "B"),
      profile("c", "C"),
    ],
  });
  const order = () =>
    s()
      .draft.profiles.map((p) => p.id)
      .join(",");
  s().moveProfile("c", 1);
  assert.equal(order(), "default,c,a,b");
  assert.ok(dirty(), "the order is saved on Apply (it decides ties)");
  s().moveProfile("c", 0);
  s().moveProfile("default", 2);
  assert.equal(order(), "default,c,a,b", "nothing goes above Default");
  s().moveProfile("a", 3);
  assert.equal(order(), "default,c,b,a");
  s().undo();
  assert.equal(order(), "default,c,a,b");
});

test("Default adopting the keyboard's lighting keeps unapplied edits", async () => {
  const { listeners } = await freshStore();
  s().setBind("3,1", key(4));
  listeners.configChanged!({
    version: 2,
    profiles: [profile("default", "Default", { lighting: solid })],
  });
  assert.deepEqual(draftProfile("default").lighting, solid);
  assert.deepEqual(
    draftProfile("default").binds["3,1"],
    key(4),
    "the edit is still there",
  );
  assert.deepEqual(s().saved.profiles[0].lighting, solid);
  assert.equal(
    s().history.past.length,
    0,
    "history restarts: undoing past this would lose the lighting",
  );
});

test("settings are saved when changed; key labels too", async () => {
  await freshStore();
  const saved: unknown[] = [];
  api.saveSettings = async (x) => void saved.push(x);
  await s().updateSettings({ notifyOnSwitch: false });
  assert.equal(s().settings.notifyOnSwitch, false);
  await s().setKeyLabels("0000040C");
  assert.equal(s().settings.keyLabels, "0000040C");
  assert.equal(s().keyLabels.active, "0000040C");
  assert.deepEqual(saved.at(-1), { ...s().settings });
});

test("apply keeps an edit made while it was saving", async () => {
  const { saved } = await freshStore();
  let finishSave!: () => void;
  api.saveConfig = async (c) => {
    saved.push(structuredClone(c));
    await new Promise<void>((r) => (finishSave = r));
  };
  s().setBind("3,1", key(0x14));
  const applying = s().apply();
  // The user keeps editing while the save is in flight.
  s().setBind("3,2", key(0x15));
  finishSave();
  await applying;
  assert.deepEqual(
    saved.at(-1)!.profiles[0].binds,
    { "3,1": key(0x14) },
    "what was sent is what was captured",
  );
  assert.deepEqual(
    s().saved.profiles[0].binds,
    { "3,1": key(0x14) },
    "saved is that same version",
  );
  assert.deepEqual(draftProfile("default").binds["3,2"], key(0x15));
  assert.equal(s().dirty, true, "the later edit is still unapplied");
});

test("an edit that is undone by hand stops counting as a change", async () => {
  await freshStore();
  const was = draftProfile("default").name;
  s().renameProfile("default", "Games");
  assert.equal(s().dirty, true);
  s().renameProfile("default", was);
  assert.equal(s().dirty, true, "the cheap flag is optimistic");
  checkDirtyNow();
  assert.equal(s().dirty, false, "the real comparison puts it right");
  assert.equal(dirty(), false);

  // And a drag never pays for that comparison: no deep compare while the edits keep coming.
  const before = dirtyCheckCount();
  for (let i = 0; i < 50; i++) s().setBind("3,1", key(0x04 + (i % 20)));
  assert.equal(dirtyCheckCount(), before, "the burst itself compares nothing");
  checkDirtyNow();
  assert.equal(s().dirty, true);
});

test("undo takes the row marker off a profile whose edit it undid", async () => {
  await freshStore({
    version: 2,
    profiles: [profile("default", "Default"), profile("p", "Game")],
  });
  s().renameProfile("p", "Games");
  s().selectProfile("default");
  s().setBind("3,1", key(0x14));
  assert.deepEqual([...s().dirtyProfiles].sort(), ["default", "p"]);
  s().undo();
  assert.equal(s().dirty, true, "the rename of Game is still unapplied");
  assert.deepEqual(s().dirtyProfiles, ["p"], "Default's marker goes with its undone edit");
  s().redo();
  assert.deepEqual([...s().dirtyProfiles].sort(), ["default", "p"]);
});

test("dragging a Mix RGB slider is one undo step", async () => {
  await freshStore();
  s().setLightingMode("mix");
  const steps = s().history.past.length;
  const oldest = s().history.past[0];
  const mix = () => draftProfile("default").lighting!.mix!;
  const wasSpeed = mix().regions[0].effects[0].speed;
  // 40 ticks of one drag, as MixPanel's patchAll sends them.
  for (let speed = 100; speed < 140; speed++) {
    const m = mix();
    s().setMix(
      {
        regions: m.regions.map((r, i) =>
          i === 0
            ? { ...r, effects: r.effects.map((e) => ({ ...e, speed })) }
            : r,
        ),
      },
      "0:all:speed",
    );
  }
  assert.equal(mix().regions[0].effects[0].speed, 139);
  assert.equal(
    s().history.past.length,
    steps + 1,
    "one step for the whole drag",
  );
  assert.equal(
    s().history.past[0],
    oldest,
    "and nothing was pushed out of the history",
  );
  s().undo();
  assert.equal(
    mix().regions[0].effects[0].speed,
    wasSpeed,
    "undo goes back to before the drag, in one go",
  );

  // A structural change is its own step.
  const n = s().history.past.length;
  s().setMix({ regions: mix().regions });
  assert.equal(s().history.past.length, n + 1);
});

test("a settings change made while init was still running is kept", async () => {
  // In the app this is showBoard writing `lastBoard` while init awaits the base keymap.
  await initApi();
  api.saveSettings = async () => {};
  api.getBaseKeymap = async () => {
    await useStore
      .getState()
      .updateSettings({ lastBoard: "q1_max_ansi_encoder" });
    return { source: "fallback", layer: 2, layers: [], board: null };
  };
  useStore.setState({ ready: false }, false);
  await useStore.getState().init();
  assert.equal(
    s().settings.lastBoard,
    "q1_max_ansi_encoder",
    "not reverted to the copy init started with",
  );
});

// ------------------------------------------------------------------ the macro bank

const macroAt = (profileId: string, keyId: string) => {
  const b = draftProfile(profileId).binds[keyId];
  assert.equal(b?.kind, "macro", `${keyId} plays a macro`);
  return b as Extract<typeof b, { kind: "macro" }>;
};
const bank = () => s().draft.macros ?? [];
const twoProfiles = () =>
  freshStore({ version: 2, profiles: [profile("default", "Default"), profile("a", "CS2")] });

test("macro bank: creating a macro makes a bank entry the key is linked to", async () => {
  await twoProfiles();
  s().createMacro("3,1", "Buy");
  const m = macroAt("default", "3,1");
  assert.equal(bank().length, 1);
  assert.equal(m.macroId, bank()[0].id);
  assert.equal(bank()[0].name, "Buy");
  // Names stay unique in the bank.
  s().createMacro("3,2", "Buy");
  assert.deepEqual(
    bank().map((x) => x.name),
    ["Buy", "Buy 2"],
  );
  // Removing the key leaves the entry in the bank.
  s().removeBind("3,1");
  assert.equal(bank().length, 2);
});

test("macro bank: an edit reaches every key using it, in every profile, as one undo step", async () => {
  await twoProfiles();
  s().createMacro("3,1", "Buy");
  const id = macroAt("default", "3,1").macroId!;
  s().selectProfile("a");
  s().useMacro("4,1", id);
  assert.equal(macroAt("a", "4,1").macroId, id);

  const before = s().history.past.length;
  // Recording: quick edits of one macro merge.
  s().setBind("4,1", { ...macroAt("a", "4,1"), steps: [{ op: "tap", keycode: 4 }] });
  s().setBind("4,1", { ...macroAt("a", "4,1"), steps: [{ op: "tap", keycode: 4 }, { op: "tap", keycode: 5 }] });
  assert.equal(s().history.past.length, before + 1, "one undo step");
  assert.deepEqual(macroAt("default", "3,1").steps, macroAt("a", "4,1").steps, "the other profile follows");
  assert.equal(bank()[0].steps.length, 2);
  // Renaming follows too (and, right after, merges with the edits before it).
  s().setBind("4,1", { ...macroAt("a", "4,1"), name: "Buy rifle" });
  assert.equal(macroAt("default", "3,1").name, "Buy rifle");

  s().undo();
  assert.equal(macroAt("default", "3,1").steps.length, 0, "undo takes it back on both keys");
  assert.equal(macroAt("a", "4,1").steps.length, 0);
  assert.equal(macroAt("a", "4,1").name, "Buy");
  assert.equal(bank()[0].steps.length, 0, "and in the bank");
});

test("macro bank: a copy, and making a key separate, give independent entries", async () => {
  await twoProfiles();
  s().createMacro("3,1", "Buy");
  const id = macroAt("default", "3,1").macroId!;
  s().setBind("3,1", { ...macroAt("default", "3,1"), steps: [{ op: "tap", keycode: 4 }] });

  s().copyMacro("3,2", id);
  const copy = macroAt("default", "3,2");
  assert.notEqual(copy.macroId, id);
  assert.equal(copy.name, "Buy (copy)");
  assert.deepEqual(copy.steps, [{ op: "tap", keycode: 4 }]);
  s().setBind("3,2", { ...copy, steps: [] });
  assert.equal(macroAt("default", "3,1").steps.length, 1, "editing the copy leaves the original");

  s().useMacro("3,3", id);
  s().unlinkMacro("3,3");
  const own = macroAt("default", "3,3");
  assert.notEqual(own.macroId, id);
  assert.equal(own.name, "Buy 2");
  s().setBind("3,3", { ...own, steps: [] });
  assert.equal(macroAt("default", "3,1").steps.length, 1, "the key made separate no longer changes the others");
});

test("macro bank: an entry in use can't be deleted; an unused one can", async () => {
  await twoProfiles();
  s().createMacro("3,1", "Buy");
  const id = macroAt("default", "3,1").macroId!;
  s().deleteBankMacro(id);
  assert.equal(bank().length, 1);
  assert.match(s().error ?? "", /still on a key/);
  s().removeBind("3,1");
  s().deleteBankMacro(id);
  assert.equal(bank().length, 0);
  assert.equal(s().draft.macros, undefined, "an empty bank leaves no field behind");
});

test("macro bank: macros from before the bank get an entry each on load", async () => {
  const hi = { kind: "macro" as const, name: "hi", steps: [{ op: "tap" as const, keycode: 11 }] };
  const file: AppConfig = {
    version: 2,
    profiles: [
      profile("default", "Default", { binds: { "L2:3,1": hi } }),
      profile("a", "CS2", { binds: { "L2:3,1": hi, "L2:3,2": { ...hi, name: "Other" } } }),
    ],
  };
  await freshStore(structuredClone(file));
  // Same content, but never merged: three keys, three entries, unique names.
  assert.deepEqual(
    bank().map((m) => m.name),
    ["hi", "hi 2", "Other"],
  );
  const ids = () => [macroAt("default", "L2:3,1"), macroAt("a", "L2:3,1"), macroAt("a", "L2:3,2")].map((b) => b.macroId);
  const first = ids();
  assert.equal(new Set(first).size, 3);
  assert.equal(s().dirty, false, "loading isn't an edit");
  // The same file gets the same ids every time (so the saved and adopted configs compare equal).
  await freshStore(structuredClone(file));
  assert.deepEqual(ids(), first);
});

test("macro bank: survives Apply and a reload", async () => {
  const { saved } = await twoProfiles();
  s().createMacro("L2:3,1", "Buy");
  await s().apply();
  const file = saved.at(-1)!;
  assert.equal(file.macros?.length, 1);
  await freshStore(file);
  assert.equal(bank()[0].name, "Buy");
  assert.equal(macroAt("default", "L2:3,1").macroId, bank()[0].id);
  assert.equal(s().dirty, false);
});

test("macro bank: imported macros join the bank, linked where the content is the same", async () => {
  await twoProfiles();
  s().createMacro("L2:3,1", "Buy");
  const id = macroAt("default", "L2:3,1").macroId!;
  s().setBind("L2:3,1", { ...macroAt("default", "L2:3,1"), steps: [{ op: "tap", keycode: 4 }] });
  const same = { kind: "macro" as const, name: "Buy", steps: [{ op: "tap" as const, keycode: 4 }], macroId: id };
  const clash = { kind: "macro" as const, name: "Buy", steps: [{ op: "tap" as const, keycode: 9 }], macroId: id };
  const fresh = { kind: "macro" as const, name: "Jump", steps: [], macroId: "m_elsewhere" };
  api.importProfiles = async () => [
    profile("x", "Imported", { binds: { "L2:3,1": same, "L2:3,2": clash, "L2:3,3": fresh, "L2:3,4": clash } }),
  ];
  await s().importProfiles();
  const p = s().draft.profiles.at(-1)!;
  const at = (k: string) => p.binds[k] as Extract<(typeof p.binds)[string], { kind: "macro" }>;
  assert.equal(at("L2:3,1").macroId, id, "same content: still linked");
  assert.notEqual(at("L2:3,2").macroId, id, "same id, other content: a new id");
  assert.equal(at("L2:3,2").macroId, at("L2:3,4").macroId, "…the same new id on every bind that carried it");
  assert.equal(at("L2:3,2").name, "Buy 2");
  assert.equal(at("L2:3,3").macroId, "m_elsewhere", "an id the bank lacks becomes an entry");
  assert.deepEqual(
    bank().map((m) => m.name),
    ["Buy", "Buy 2", "Jump"],
  );
});

test("the limit messages name the macro that costs the most", async () => {
  await freshStore();
  s().createMacro("0,0", "Long");
  const steps = Array.from({ length: 200 }, () => ({ op: "tap" as const, keycode: 4 }));
  s().setBind("0,0", { ...macroAt("default", "0,0"), steps });
  const id = macroAt("default", "0,0").macroId!;
  for (const k of ["0,1", "0,2", "0,3"]) s().useMacro(k, id);
  await s().apply();
  assert.match(s().error ?? "", /"Long" takes \d+ of them on its 4 keys/);
});
