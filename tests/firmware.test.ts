import "./v6board";
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, initApi } from "../src/lib/api";
import { createFirmwareMock } from "../src/lib/firmwareMock";
import {
  fileKey,
  parseProblem,
  pickFwMode,
  tabsOf,
  useFirmware,
  withoutAddedLines,
} from "../src/state/firmwareStore";

const pristine = useFirmware.getState();
const f = () => useFirmware.getState();
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), "timed out");
};

async function fresh() {
  await initApi();
  Object.assign(api, createFirmwareMock());
  useFirmware.setState({ ...pristine }, true);
  await f().init();
}

test("problems are read from gcc and make output", () => {
  assert.deepEqual(
    parseProblem(
      "keyboards/keychron/v6_8k/iso_encoder/keymaps/v6ps_my_v6/keymap.c:12:5: error: 'KC_FOO' undeclared",
    ),
    {
      projectId: "my_v6",
      path: "keymap.c",
      line: 12,
      col: 5,
      severity: "error",
      message: "'KC_FOO' undeclared",
    },
  );
  assert.equal(
    parseProblem(
      "keyboards/x/keymaps/v6ps_a/inc/config.h:3: warning: redefined",
    )?.path,
    "inc/config.h",
  );
  assert.equal(
    parseProblem(
      "keyboards/x/keymaps/v6ps_a/rules.mk:2: *** missing separator.  Stop.",
    )?.message,
    "missing separator.  Stop.",
  );
  assert.equal(parseProblem("Compiling: quantum/keymap.c    [OK]"), null);
  assert.equal(
    parseProblem("keyboards/x/keymaps/keychron/keymap.c:1:1: error: not ours"),
    null,
  );
});

test("preflight: download the firmware, then keyboards and templates appear", async () => {
  await fresh();
  assert.equal(f().status?.source.state, "missing");
  assert.deepEqual(f().keyboards, []);
  await f().downloadSource();
  await until(() => f().job?.state === "ok");
  assert.equal(f().job?.kind, "source");
  assert.ok(
    f().log.some((l) => l.includes("Cloning")),
    "the log shows git's output",
  );
  await until(
    () => f().status?.source.state === "ok" && f().keyboards.length > 0,
  );
  assert.match(f().notice ?? "", /ready/);
});

test("projects and files, with undo and redo", async () => {
  await fresh();
  await f().downloadSource();
  await until(() => f().status?.source.state === "ok");
  assert.equal(
    await f().createProject(
      "My V6",
      "keychron/v6_8k/iso_encoder",
      { kind: "keymap", name: "keychron" },
      true,
    ),
    true,
  );
  const id = "my_v6";
  assert.deepEqual(f().projects.find((p) => p.id === id)?.files, [
    "keymap.c",
    "profile_switcher.c",
    "rules.mk",
  ]);
  assert.equal(f().activeKey, fileKey(id, "keymap.c"), "opens its keymap");

  assert.equal(await f().createFile(id, "config.h", "#pragma once\n"), true);
  assert.equal(await f().createFile(id, "config.h"), false, "already there");
  assert.match(f().error ?? "", /already exists/);
  await f().renameFile(id, "config.h", "my_config.h");
  assert.ok(
    f().openFiles.includes(fileKey(id, "my_config.h")),
    "its tab follows the rename",
  );
  await f().deleteFile(id, "my_config.h");
  assert.ok(
    !f()
      .projects.find((p) => p.id === id)!
      .files.includes("my_config.h"),
  );
  assert.ok(
    !f().openFiles.includes(fileKey(id, "my_config.h")),
    "its tab closed",
  );

  await f().undo(); // the delete
  assert.equal(await api.fwReadFile(id, "my_config.h"), "#pragma once\n");
  await f().undo(); // the rename
  assert.ok(
    f()
      .projects.find((p) => p.id === id)!
      .files.includes("config.h"),
  );
  await f().redo();
  assert.ok(
    f()
      .projects.find((p) => p.id === id)!
      .files.includes("my_config.h"),
  );

  await f().renameProject(id, "Renamed");
  await f().deleteProject(id);
  assert.equal(f().projects.length, 0);
  await f().undo();
  assert.equal(
    f().projects[0]?.name,
    "Renamed",
    "deleting a project can be undone, files and all",
  );
  assert.equal(await api.fwReadFile(id, "my_config.h"), "#pragma once\n");
  await f().undo(); // the rename
  assert.equal(f().projects[0]?.name, "My V6");
});

test("each firmware keeps its own tabs; firmwares can be moved", async () => {
  await fresh();
  await f().createProject(
    "One",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    true,
  );
  await f().openFile("one", "rules.mk");
  await f().createProject(
    "Two",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    false,
  );
  const tabs = () => tabsOf(f().openFiles, f().selectedId);
  assert.equal(f().selectedId, "two");
  assert.deepEqual(tabs(), [fileKey("two", "keymap.c")], "only its own files");
  assert.equal(f().activeKey, fileKey("two", "keymap.c"));

  f().selectProject("one");
  assert.deepEqual(tabs(), [
    fileKey("one", "keymap.c"),
    fileKey("one", "rules.mk"),
  ]);
  assert.equal(
    f().activeKey,
    fileKey("one", "rules.mk"),
    "the tab it had in front",
  );
  f().setActive(fileKey("one", "keymap.c"));
  f().selectProject("two");
  f().closeFile(fileKey("two", "keymap.c"));
  assert.equal(f().activeKey, null, "its last tab closed: nothing open for it");
  f().selectProject("one");
  assert.equal(f().activeKey, fileKey("one", "keymap.c"));

  assert.deepEqual(
    f().projects.map((p) => p.id),
    ["one", "two"],
    "in the order they were made",
  );
  await f().moveProject("two", 0);
  assert.deepEqual(
    f().projects.map((p) => p.id),
    ["two", "one"],
  );
  await f().refreshProjects();
  assert.deepEqual(
    f().projects.map((p) => p.id),
    ["two", "one"],
    "kept",
  );
  await f().undo();
  assert.deepEqual(
    f().projects.map((p) => p.id),
    ["one", "two"],
  );
});

test("edits: unsaved until saved; a build saves first and points at its errors", async () => {
  await fresh();
  await f().createProject(
    "Plain",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    false,
  );
  await f().createFile("plain", "keymap.c", "// ok\n");
  const key = fileKey("plain", "keymap.c");
  f().edit(key, "// ok\n#error nope\n");
  assert.notEqual(f().buffers[key].text, f().buffers[key].saved, "dirty");
  await f().build("plain");
  assert.equal(
    f().buffers[key].saved,
    "// ok\n#error nope\n",
    "saved before building",
  );
  await until(() => f().job?.state === "failed");
  assert.deepEqual(
    f().problems.map((p) => [p.path, p.line, p.severity]),
    [["keymap.c", 2, "error"]],
  );
  await f().showProblem(f().problems[0]);
  assert.deepEqual([f().activeKey, f().reveal?.line], [key, 2]);

  f().edit(key, "// fixed\n");
  await f().build("plain");
  await until(() => f().job?.state === "ok");
  assert.deepEqual(f().problems, []);
  assert.ok(
    f().projects[0].lastBuild,
    "the firmware file is kept with the project",
  );

  // One task at a time.
  await f().build("plain");
  await f().downloadSource();
  assert.match(f().error ?? "", /Wait for the current task/);
  await f().cancelJob();
  await until(() => f().job?.state === "cancelled");
});

test("the module can be added, and that addition undone", async () => {
  await fresh();
  await f().createProject(
    "Mod",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    false,
  );
  assert.deepEqual(
    f().projects[0].files,
    ["config.h", "keymap.c", "rules.mk"],
    "empty files to fill in",
  );
  assert.equal(f().projects[0].moduleVersion, null);
  await api.fwWriteFile("mod", "rules.mk", "VIA_ENABLE = yes\n");
  await f().openFile("mod", "rules.mk");
  await f().addModule("mod");
  assert.equal(f().projects[0].moduleVersion, f().status?.moduleVersion);
  assert.ok(f().projects[0].files.includes("profile_switcher.c"));
  assert.match(await api.fwReadFile("mod", "rules.mk"), /profile_switcher\.c/);
  assert.match(
    f().buffers[fileKey("mod", "rules.mk")].text,
    /profile_switcher\.c/,
    "the open tab shows it",
  );
  await f().undo();
  assert.ok(!f().projects[0].files.includes("profile_switcher.c"));
  assert.equal(await api.fwReadFile("mod", "rules.mk"), "VIA_ENABLE = yes\n");
});

test("undoing the module takes out only its lines, and keeps what was written since", async () => {
  // The pure part: the operation's own lines go, the rest stays.
  const before = "VIA_ENABLE = yes";
  const after = "VIA_ENABLE = yes\n# Profile switcher (KBoard Companion)\nDEFERRED_EXEC_ENABLE = yes\nSRC += profile_switcher.c\n";
  const edited = `${after}KEY_OVERRIDE_ENABLE = yes\n`;
  assert.equal(withoutAddedLines(edited, before, after), "VIA_ENABLE = yes\nKEY_OVERRIDE_ENABLE = yes\n");
  assert.equal(
    withoutAddedLines(after.replace("DEFERRED_EXEC_ENABLE = yes", "DEFERRED_EXEC_ENABLE = no"), before, after),
    "VIA_ENABLE = yes\nDEFERRED_EXEC_ENABLE = no\n",
    "a line of the module's that the user changed is theirs now",
  );
  assert.equal(withoutAddedLines("A\n", "A\n", "A\n"), "A\n", "nothing added, nothing taken");

  // Through the store: an edit of rules.mk made after adding the module survives its undo.
  await fresh();
  await f().createProject("Mod", "keychron/v6_8k/iso_encoder", { kind: "empty" }, false);
  await api.fwWriteFile("mod", "rules.mk", "VIA_ENABLE = yes\n");
  await f().addModule("mod");
  await f().openFile("mod", "rules.mk");
  const key = fileKey("mod", "rules.mk");
  f().edit(key, `${f().buffers[key].text}KEY_OVERRIDE_ENABLE = yes\n`);
  await f().undo(); // refused: the tab has unsaved edits the undo would change
  assert.match(f().error ?? "", /save rules\.mk first/);
  assert.ok(f().projects[0].files.includes("profile_switcher.c"), "nothing changed");
  await f().save(key);
  await f().undo();
  assert.equal(await api.fwReadFile("mod", "rules.mk"), "VIA_ENABLE = yes\nKEY_OVERRIDE_ENABLE = yes\n");
  assert.equal(f().buffers[key].text, "VIA_ENABLE = yes\nKEY_OVERRIDE_ENABLE = yes\n", "the open tab follows");
  assert.ok(!f().projects[0].files.includes("profile_switcher.c"));
  // Redo adds the module again, still keeping the edit.
  await f().redo();
  const redone = await api.fwReadFile("mod", "rules.mk");
  assert.match(redone, /KEY_OVERRIDE_ENABLE = yes/);
  assert.match(redone, /profile_switcher\.c/);
  assert.ok(f().projects[0].files.includes("profile_switcher.c"));
});

test("undoing the module refuses when the module file was edited since", async () => {
  await fresh();
  await f().createProject("Mod", "keychron/v6_8k/iso_encoder", { kind: "empty" }, false);
  await f().addModule("mod");
  await api.fwWriteFile("mod", "profile_switcher.c", "/* mine now */\n");
  const steps = f().past.length;
  await f().undo();
  assert.match(f().error ?? "", /profile_switcher\.c was edited/);
  assert.equal(await api.fwReadFile("mod", "profile_switcher.c"), "/* mine now */\n", "the edit is kept");
  assert.equal(f().past.length, steps, "the step stays, nothing was undone");
});

test("the module can go into a copy, leaving the original as it was", async () => {
  await fresh();
  await f().createProject(
    "Mine",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    false,
  );
  const copyId = await f().duplicateProject("mine");
  assert.equal(copyId, "mine_copy");
  assert.deepEqual(
    f().projects.map((p) => p.name),
    ["Mine", "Mine (copy)"],
    "right after the original",
  );
  await f().addModule(copyId!);
  assert.equal(f().projects[1].moduleVersion, f().status?.moduleVersion);
  assert.equal(
    f().projects[0].moduleVersion,
    null,
    "the original is untouched",
  );
  assert.notEqual(
    f().projects[0].buildId,
    f().projects[1].buildId,
    "each builds into a firmware of its own",
  );
  await f().undo(); // the module
  await f().undo(); // the copy
  assert.deepEqual(
    f().projects.map((p) => p.name),
    ["Mine"],
  );
});

test("which firmware is on the keyboard: flashing marks it, and the keyboard has the last word", async () => {
  await fresh();
  await f().createProject(
    "One",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    true,
  );
  await f().createProject(
    "Two",
    "keychron/v6_8k/iso_encoder",
    { kind: "empty" },
    true,
  );
  assert.ok(f().projects.every((p) => !p.flashed));

  await f().build("one");
  await until(() => f().job?.state === "ok");
  await f().flash("one");
  await until(() => f().job?.state === "ok");
  await f().refreshProjects();
  assert.deepEqual(
    f().projects.map((p) => p.flashed),
    [true, false],
    "the app knows what it flashed",
  );

  // Flashed by hand outside the app: the user says so, and only one project can hold the mark.
  await f().setFlashed("two", true);
  assert.deepEqual(
    f().projects.map((p) => p.flashed),
    [false, true],
  );
  await f().undo();
  assert.deepEqual(
    f().projects.map((p) => p.flashed),
    [true, false],
    "undo puts the mark back where it was",
  );

  // A keyboard running one of the app's builds names its firmware itself, and corrects the mark.
  await f().matchKeyboard(f().projects[1].buildId);
  assert.deepEqual(
    f().projects.map((p) => p.flashed),
    [false, true],
  );
  await f().matchKeyboard(0);
  assert.deepEqual(
    f().projects.map((p) => p.flashed),
    [false, true],
    "older firmware can't say: the mark stands",
  );
  await f().matchKeyboard(0x1234);
  assert.deepEqual(
    f().projects.map((p) => p.flashed),
    [false, true],
    "firmware the app didn't build changes nothing",
  );

  // Edited after it was put on the keyboard: still the one on it, but not as it is now.
  const two = () => f().projects.find((p) => p.id === "two")!;
  assert.equal(two().unflashedChanges, false);
  await f().createFile("two", "extra.h", "#pragma once\n");
  assert.equal(two().flashed && two().unflashedChanges, true, "its changes aren't on the keyboard");
  // Flashed outside the app: the user says this version is on it now.
  await f().setFlashed("two", true);
  assert.equal(two().flashed && !two().unflashedChanges, true);
});

test("flashing builds first when the last build isn't of the files as they are", async () => {
  await fresh();
  await f().createProject("One", "keychron/v6_8k/iso_encoder", { kind: "empty" }, true);
  const one = () => f().projects.find((p) => p.id === "one")!;
  assert.equal(one().buildOutdated, true, "never built");

  // No build yet: the flash builds it, then writes it.
  await f().flash("one");
  await until(() => f().job?.state === "ok");
  await f().refreshProjects();
  assert.ok(one().lastBuild && !one().buildOutdated && one().flashed && !one().unflashedChanges);

  // An update after that (here a new file): outdated again, and flashing rebuilds it.
  await f().createFile("one", "extra.h", "#pragma once\n");
  assert.equal(one().buildOutdated && one().unflashedChanges, true);
  await f().flash("one");
  await until(() => f().job?.state === "ok");
  await f().refreshProjects();
  assert.ok(!one().buildOutdated && !one().unflashedChanges, "what's on the keyboard is the project as it is");
});

test("the ready-made path: which mode the tab opens on, the flashing tools, and the firmware for this board", async () => {
  await fresh();

  // Nothing installed and no projects: the tab opens on the ready-made path.
  assert.equal(pickFwMode(null, "missing", 0), "basic");
  assert.equal(
    pickFwMode(null, "missing", 2),
    "advanced",
    "someone with projects of their own builds them",
  );
  assert.equal(
    pickFwMode(null, "ok", 0),
    "advanced",
    "the build tools are already there",
  );
  assert.equal(
    pickFwMode("basic", "ok", 3),
    "basic",
    "the user's choice always wins",
  );
  assert.equal(pickFwMode("advanced", "missing", 0), "advanced");
  assert.equal(
    pickFwMode(null, undefined, 0),
    "basic",
    "before the status is in",
  );

  // The flashing tools are the ready-made path's only install, and it can be done ahead of time.
  assert.equal(f().status?.flashTools.state, "missing");
  await f().downloadTools();
  await until(() => f().job?.state === "ok");
  await f().refreshStatus();
  assert.equal(f().status?.flashTools.state, "ok");

  // What the app has ready-made for a board, and a board a release didn't build.
  await f().loadPrebuilt("v6_8k_iso_encoder");
  await until(() => !f().prebuiltLoading);
  assert.equal(f().prebuilt?.entry?.keymap, "keychron");
  assert.equal(f().prebuiltError, null);
  await f().loadPrebuilt("q0_max");
  await until(() => !f().prebuiltLoading);
  assert.equal(f().prebuilt?.entry, null, "no firmware for it in this release");
});

test("the flash tracker goes from getting the firmware to keyboard ready", async () => {
  const { FLASH_STEPS, flashProgress } = await import("../src/lib/flashSteps");
  const n = FLASH_STEPS.length;
  const job = (
    state: "running" | "ok" | "failed" | "cancelled",
    step: string | null,
  ) => ({ kind: "flash" as const, state, step });

  // Nothing started: nothing ticked, and a keyboard that already has the module is at the end.
  const idle = flashProgress({ job: null, keyboard: "back" });
  assert.deepEqual([idle.states, idle.count], [Array(n).fill("pending"), 0]);
  const ready = flashProgress({ job: null, keyboard: "ready" });
  assert.deepEqual(
    [ready.count, ready.tone, ready.label],
    [n, "ok", "Keyboard ready"],
  );
  // Another task (a tools download, a test build) isn't a flash.
  assert.equal(
    flashProgress({
      job: {
        kind: "tools",
        state: "running",
        step: "Downloading dfu-util.exe",
      },
      keyboard: "away",
    }).count,
    0,
  );
  // Advanced builds its firmware, Basic downloads it.
  assert.equal(
    flashProgress({ job: null, keyboard: "away", builds: true }).labels[0],
    "Building the firmware",
  );
  assert.equal(idle.labels[0], "Getting the firmware");

  // The texts are the ones `quick::flash_prebuilt` sends.
  const steps = [
    "Finding the ready-made firmware",
    "Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in",
    "Flashing",
    "Waiting for the keyboard to restart",
  ];
  steps.forEach((text, i) => {
    const p = flashProgress({ job: job("running", text), keyboard: "away" });
    assert.equal(p.count, i + 1, text);
    assert.equal(p.states[i], "active");
    assert.ok(p.states.slice(0, i).every((s) => s === "done"));
  });
  assert.equal(
    flashProgress({
      job: job("running", "Downloading the firmware (74 KB)"),
      keyboard: "away",
    }).count,
    1,
  );

  // It stopped while waiting: that step is the one marked, whatever the keyboard had before.
  const stopped = flashProgress({
    job: job("failed", steps[1]),
    keyboard: "ready",
  });
  assert.deepEqual(
    [stopped.states[1], stopped.tone, stopped.count],
    ["failed", "bad", 2],
  );

  // Written, but nothing has shown up yet; then it is back; then it answers with the module.
  const written = flashProgress({ job: job("ok", steps[3]), keyboard: "away" });
  assert.deepEqual(
    [written.states[n - 1], written.tone, written.count],
    ["active", "busy", n],
  );
  const back = flashProgress({ job: job("ok", steps[3]), keyboard: "back" });
  assert.deepEqual(
    [back.states, back.label],
    [Array(n).fill("done"), "Keyboard restarted"],
  );
  assert.equal(
    flashProgress({ job: job("ok", steps[3]), keyboard: "ready" }).label,
    "Keyboard ready",
  );
});

test("a project's flash uses the same steps as the ready-made one", async () => {
  const { flashProgress } = await import("../src/lib/flashSteps");
  const at = (step: string | null) =>
    flashProgress({
      job: { kind: "flash", state: "running", step },
      keyboard: "away",
    });

  // A project is built first (its own task), then flashed through the same guarded path.
  const building = flashProgress({
    job: { kind: "build", state: "running", step: "Building" },
    keyboard: "away",
    builds: true,
  });
  assert.equal(building.count, 0, "a build isn't a flash");
  assert.equal(building.labels[0], "Building the firmware");

  const steps = [
    "Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in",
    "Flashing",
    "Waiting for the keyboard to restart",
  ];
  steps.forEach((text, i) => {
    const p = at(text);
    assert.equal(p.count, i + 2, text);
    assert.equal(p.states[i + 1], "active");
  });
  // A flash that fails while waiting marks that step.
  const failed = flashProgress({
    job: { kind: "flash", state: "failed", step: steps[0] },
    keyboard: "back",
  });
  assert.deepEqual(
    [failed.states[1], failed.label],
    ["failed", "Stopped: waiting for the bootloader"],
  );
});

test("the device to flash: preselected when it can only be the keyboard, never guessed among several", async () => {
  const { flashTarget } = await import("../src/lib/flashTarget");
  const { boardInfo } = await import("../src/lib/boards");
  const v6 = boardInfo("v6_8k_iso_encoder")!;
  const dev = (
    kind: "keyboard" | "bootloader",
    vid: number,
    pid: number,
    instance: string,
    description = "",
  ) => ({
    vid,
    pid,
    kind,
    bootloader: kind === "bootloader" ? "DFU" : null,
    driver: "WinUSB",
    description,
    instance,
  });
  const keyboard = dev("keyboard", v6.vid, v6.pid, "KB");
  const at32 = dev("bootloader", 0x2e3c, 0xdf11, "AT32", "DFU in FS Mode");
  const stm32 = dev("bootloader", 0x0483, 0xdf11, "STM32", "STM32 BOOTLOADER");

  // The keyboard is there, running: nothing to pick, the backend follows it into its bootloader.
  const seen = flashTarget(v6, [keyboard], null);
  assert.deepEqual(
    [seen.needsPick, seen.blocked, seen.chosen],
    [false, null, null],
  );

  // Already in its bootloader when the app looked: the picker opens on it.
  const one = flashTarget(v6, [at32], null);
  assert.deepEqual(
    [one.needsPick, one.chosen, one.blocked],
    [true, "AT32", null],
  );
  // The user says it isn't theirs: nothing is flashed.
  const refused = flashTarget(v6, [at32], "");
  assert.equal(refused.chosen, null);
  assert.match(refused.blocked ?? "", /Choose the device/);

  // A bootloader of another kind can't be this keyboard: not offered, not flashed.
  const other = flashTarget(v6, [stm32], null);
  assert.deepEqual([other.needsPick, other.candidates.length], [false, 0]);
  assert.match(other.blocked ?? "", /Plug the/);

  // Two that could be it: no guess, and picking one still waits for the other to be unplugged.
  const twin = { ...at32, instance: "AT32-2" };
  const two = flashTarget(v6, [at32, twin], null);
  assert.equal(two.chosen, null);
  assert.match(
    flashTarget(v6, [at32, twin], "AT32-2").blocked ?? "",
    /2 devices/,
  );

  // A pick that has since been unplugged doesn't carry over to whatever replaced it.
  assert.equal(flashTarget(v6, [twin], "AT32").chosen, null);
});

test("the firmware is backed up before a flash, on its own, and written back", async () => {
  const { flashProgress } = await import("../src/lib/flashSteps");
  // `backup::read`'s step sits on the write step, with its own label.
  const reading = flashProgress({
    job: {
      kind: "flash",
      state: "running",
      step: "Backing up the firmware on the keyboard",
    },
    keyboard: "away",
  });
  assert.deepEqual(
    [reading.count, reading.label, reading.states[1]],
    [3, "Backing up the firmware", "done"],
  );
  // A failed backup stops the flash before anything is written: that step is the one marked.
  assert.equal(
    flashProgress({
      job: {
        kind: "flash",
        state: "failed",
        step: "Backing up the firmware on the keyboard",
      },
      keyboard: "back",
    }).states[2],
    "failed",
  );

  let backupFirst = true;
  await initApi();
  Object.assign(api, createFirmwareMock(() => backupFirst));
  useFirmware.setState({ ...pristine }, true);
  await f().init();
  const idle = () => f().job?.state !== "running";
  assert.deepEqual(f().backups, []);

  await f().flashPrebuilt("v6_8k_iso_encoder");
  await until(() => idle() && f().backups.length === 1);
  assert.equal(f().backups[0].board, "v6_8k_iso_encoder");

  // Turned off: the flash writes without reading first.
  backupFirst = false;
  await f().flashPrebuilt("v6_8k_iso_encoder");
  await until(idle);
  await f().refreshBackups();
  assert.equal(f().backups.length, 1, "no backup with the setting off");

  // On its own: a backup task, nothing written.
  await f().backUp("v6_8k_iso_encoder");
  assert.equal(f().job?.kind, "backup");
  await until(() => idle() && f().backups.length === 2);
  assert.ok(f().backups[0].at > f().backups[1].at, "newest first");

  // Restoring is a flash task (the tracker follows it).
  await f().restoreBackup(f().backups[1].id);
  assert.equal(f().job?.kind, "flash");
  await until(idle);
  assert.equal(f().job?.state, "ok");
  await f().restoreBackup("gone");
  assert.match(f().error ?? "", /gone/);
  f().clearError();

  await f().deleteBackup(f().backups[0].id);
  assert.equal(f().backups.length, 1);
});
