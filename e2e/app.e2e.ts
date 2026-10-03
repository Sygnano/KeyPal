/**
 * The flows a user actually walks through, in a real browser against the mock backend.
 *
 * These are deliberately about *behaviour the spec promises* — "Apply sends it, Discard takes it
 * back", "the play button forces a profile", "Settings can reach the guide from either mode" —
 * rather than about markup. Where a check depends on a class name or an aria-label, that name is
 * part of what the app promises to assistive technology anyway.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright-core";
import { browserPath, clickKey, closeGuide, commitHint, consoleErrors, openApp, pickBoard, start, type Harness } from "./harness";

const chrome = browserPath();

// Four flows at a time (21 s → 9 s): each has its own browser context and its own in-page mock,
// so they share nothing but the dev server. A new flow must keep it that way.
describe("the app in a browser", { skip: chrome ? false : "no Chrome or Edge installed", concurrency: 4 }, () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h?.close();
  });

  /** "+ New" in the sidebar: the `+` is aria-hidden, so its accessible name is just "New". */
  const newProfile = (page: Page) => page.locator(".sidebar .add-btn");
  /** The commit bar's Apply, not a profile row's play button. */
  const applyBtn = (page: Page) => page.locator(".commit-bar .btn-apply");

  /** A page that has been taken past the first run, with no console errors so far. */
  async function app(): Promise<Page> {
    const page = await h.page();
    await openApp(page);
    return page;
  }

  test("first run: the guide opens once, then a keyboard is picked and drawn", async () => {
    const page = await h.page();
    const guide = page.locator('[role="dialog"][aria-label="Getting started"]');
    await guide.waitFor({ timeout: 10000 });
    await guide.getByRole("button", { name: "Close" }).first().click();
    await guide.waitFor({ state: "hidden" });

    // Nothing is plugged in, so the main area asks for a keyboard.
    await page.locator(".first-run").waitFor();
    await pickBoard(page, "V6 8K ISO Knob");
    await page.locator(".board").waitFor({ timeout: 15000 });
    assert.ok((await page.locator(".cap[data-key]").count()) > 50, "the keyboard is drawn");

    // Reloading doesn't ask again: the board and "the guide was seen" are remembered per PC.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".board").waitFor({ timeout: 15000 });
    assert.equal(await guide.isVisible(), false, "the guide opens by itself only until it is closed once");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a remap reaches the keyboard only on Apply, and Discard takes it back", async () => {
    const page = await app();
    assert.equal(await commitHint(page).textContent(), "Everything applied");

    await clickKey(page, "3,1");
    const menu = page.locator('.key-menu[role="dialog"]');
    await menu.waitFor();
    await menu.locator(".picker-search").fill("F13");
    await menu.locator(".picker-grid .mini-cap").first().click();

    // The key wears its tape, the bind list lists it, and the commit bar says it isn't applied.
    await page.locator('.cap[data-key="3,1"].is-bound').waitFor();
    assert.equal(await commitHint(page).textContent(), "Unapplied changes");

    await applyBtn(page).click();
    await page.locator('.commit-hint:text("Everything applied")').waitFor();
    // It survives a reload, because Apply is what writes it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".board").waitFor({ timeout: 15000 });
    await page.locator('.cap[data-key="3,1"].is-bound').waitFor();

    // Now remap another key and throw it away.
    await clickKey(page, "3,2");
    await page.locator(".key-menu .picker-search").fill("F14");
    await page.locator(".key-menu .picker-grid .mini-cap").first().click();
    await page.locator('.cap[data-key="3,2"].is-bound').waitFor();
    await page.locator(".commit-bar .btn-discard").click();
    await page.locator('.cap[data-key="3,2"].is-bound').waitFor({ state: "detached" });
    await page.locator('.cap[data-key="3,1"].is-bound').waitFor({ state: "attached" });
    assert.equal(await commitHint(page).textContent(), "Everything applied");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a macro takes text, as the keys that type it on the layout shown", async () => {
    const page = await app();
    await clickKey(page, "3,1");
    const menu = page.locator('.key-menu[role="dialog"]');
    await menu.locator('[role="tab"]:text("Macro")').click();
    await menu.locator('button:text("Create macro")').click();

    await page.locator('.macro-tools button:text("Add text")').click();
    const text = page.locator(".macro .macro-text");
    const add = page.locator('.macro .code-row button:text("Add")');

    // A character the layout has no key for is named, and nothing can be added.
    await text.fill("日");
    await page.locator('.macro .parse-result.bad:text("日")').waitFor();
    assert.equal(await add.isDisabled(), true);

    // The mock's layout is French: "B" needs Shift, "@" is AltGr+0, and "ê" is the dead ^ then E.
    await text.fill("Bo@ê");
    await add.click();
    const steps = page.locator(".macro .recorder .step");
    await steps.nth(4).waitFor();
    assert.deepEqual(
      (await steps.allTextContents()).map((t) => t.trim()),
      ["Shift+B", "O", "Alt Gr+à", "^", "E"],
    );
    assert.equal(await text.inputValue(), "");
    assert.equal(await commitHint(page).textContent(), "Unapplied changes");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a macro follows the default gap until it is given its own, and keeps it through edits", async () => {
    const page = await app();
    await clickKey(page, "3,1");
    const menu = page.locator('.key-menu[role="dialog"]');
    await menu.locator('[role="tab"]:text("Macro")').click();
    await menu.locator('button:text("Create macro")').click();

    const gap = page.locator('.macro input[aria-label="Gap between keys, in milliseconds"]');
    assert.equal(await gap.inputValue(), "", "no gap of its own");
    assert.equal(await gap.getAttribute("placeholder"), "10", "the default from Settings shows through");

    await gap.fill("25");
    const useDefault = page.locator('.macro button:text("Use the default (10 ms)")');
    await useDefault.waitFor();
    // Another edit of the macro keeps its gap.
    await page.locator('.macro-tools button:text("Add delay")').click();
    await page.locator(".macro .recorder .step-delay").waitFor();
    assert.equal(await gap.inputValue(), "25");
    if (process.env.V6PS_SHOT) await page.locator(".macro").screenshot({ path: process.env.V6PS_SHOT });

    await useDefault.click();
    assert.equal(await gap.inputValue(), "");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("the macro bank: a macro used on a second key stays linked, a copy doesn't", async () => {
    const page = await app();
    const menu = page.locator('.key-menu[role="dialog"]');
    const delays = page.locator(".macro .recorder .step-delay");
    /** The Macro tab of a key's menu. */
    const macroTab = async (keyId: string) => {
      await clickKey(page, keyId);
      await menu.locator('[role="tab"]:text-is("Macro")').click();
    };

    // Key A: a new macro, "Buy", with one delay step.
    await macroTab("3,1");
    await menu.locator("input").fill("Buy");
    await menu.locator('button:text("Create macro")').click();
    await page.locator('.macro-tools button:text("Add delay")').click();
    await delays.first().waitFor();

    // Key B: the same macro from the bank, linked.
    await macroTab("3,2");
    await menu.locator('[role="tab"]:text-is("From bank")').click();
    assert.match((await menu.locator("select option").first().textContent()) ?? "", /Buy · used by 1 key/);
    await menu.locator('.bank-preview:text("50 ms")').waitFor();
    await menu.locator('button:text-is("Use macro")').click();
    await page.locator('.macro-shared-badge:text("Shared by 2 keys")').waitFor();
    assert.equal(await page.locator(".macro .macro-title").textContent(), "Buy");
    // Edited from B…
    await page.locator('.macro-tools button:text("Add delay")').click();
    await delays.nth(1).waitFor();
    // …A has it too.
    await page.keyboard.press("Escape");
    await macroTab("3,1");
    await menu.locator('button:text("Edit macro")').click();
    assert.equal(await delays.count(), 2, "key A follows the edit made from key B");

    // Key C: a copy, edited on its own.
    await macroTab("3,3");
    await menu.locator('[role="tab"]:text-is("From bank")').click();
    await menu.locator('button:text-is("Use a copy")').click();
    assert.equal(await page.locator(".macro .macro-title").textContent(), "Buy (copy)");
    assert.equal(await page.locator(".macro-shared").count(), 0, "a copy isn't shared");
    await page.locator('.macro-tools button:text("Add delay")').click();
    await delays.nth(2).waitFor();
    await page.keyboard.press("Escape");
    await macroTab("3,1");
    await menu.locator('button:text("Edit macro")').click();
    assert.equal(await delays.count(), 2, "the copy's edit didn't reach key A");

    // Make separate: B gets its own entry, A is no longer shared.
    await macroTab("3,2");
    await menu.locator('button:text("Edit macro")').click();
    await page.locator('.macro-shared button:text("Make separate")').click();
    await page.locator(".macro-shared").waitFor({ state: "detached" });
    assert.equal(await page.locator(".macro .macro-title").textContent(), "Buy 2");

    // Renaming: the name is text until Rename; Escape cancels, Enter saves.
    const rename = page.locator('.macro-head button:text-is("Rename")');
    await rename.click();
    await page.locator(".macro .macro-name").fill("Nope");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".macro .macro-title").textContent(), "Buy 2", "Escape keeps the name");
    await rename.click();
    await page.locator(".macro .macro-name").fill("Buy (copy)");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".macro .macro-title").textContent(), "Buy (copy) 2", "a name another macro has gets a number");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("undo and redo walk back through edits, and an edit undone by hand stops counting", async () => {
    const page = await app();
    await newProfile(page).click();
    const name = page.locator('.profile input[aria-label="Profile name"]').last();
    await name.waitFor();
    const given = await name.inputValue();

    await name.fill("Gaming");
    await page.locator('.commit-hint:text("Unapplied changes")').waitFor();
    await page.getByRole("button", { name: "Undo" }).click();
    assert.equal(await name.inputValue(), given, "the rename is undone in one step, not letter by letter");
    await page.getByRole("button", { name: "Redo" }).click();
    assert.equal(await name.inputValue(), "Gaming");

    // Applied, then renamed and renamed back: `dirty` is re-derived, so it goes quiet again.
    await applyBtn(page).click();
    await page.locator('.commit-hint:text("Everything applied")').waitFor();
    await name.fill("Something else");
    await page.locator('.commit-hint:text("Unapplied changes")').waitFor();
    await name.fill("Gaming");
    await page.locator('.commit-hint:text("Everything applied")').waitFor({ timeout: 5000 });
    assert.deepEqual(consoleErrors(page), []);
  });

  test("the play button forces a profile and the X gives it back to automatic", async () => {
    const page = await app();
    await newProfile(page).click();
    await applyBtn(page).click();
    await page.locator('.commit-hint:text("Everything applied")').waitFor();

    const row = page.locator(".profile").last();
    await row.locator(".play-btn").click();
    await row.locator(".play-btn.is-pinned").waitFor();
    assert.match((await row.locator(".profile-sub").textContent()) ?? "", /Forced/);

    await row.locator(".play-btn.is-pinned").click();
    await row.locator(".play-btn.is-pinned").waitFor({ state: "detached" });
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a profile that has never been applied says why its play button is off", async () => {
    const page = await app();
    await newProfile(page).click();
    const row = page.locator(".profile").last();
    // The reason has to be readable: WebView2 shows no tooltip on a disabled button.
    assert.equal(await row.locator(".play-btn").isDisabled(), true);
    assert.match((await row.locator(".profile-sub").textContent()) ?? "", /Apply to use this profile/);
    assert.deepEqual(consoleErrors(page), []);
  });

  test("exporting writes a file, and importing it back adds the profiles without replacing any", async () => {
    const page = await app();
    await newProfile(page).click();
    await page.locator('.profile input[aria-label="Profile name"]').last().fill("Exported");
    await applyBtn(page).click();
    await page.locator('.commit-hint:text("Everything applied")').waitFor();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "More for Exported" }).click();
    await page.getByRole("menuitem", { name: /Export to a file/ }).click();
    const file = await download;
    const path = await file.path();
    assert.ok(path, "a file was written");

    // Import it: fresh ids and unclashing names, nothing replaced.
    const before = await page.locator(".profile").count();
    // The mock's file input is never put in the DOM — it is created and clicked — so it has to be
    // caught as the file chooser it opens, the same way the real Tauri dialog would be.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Import profiles" }).click();
    await (await chooser).setFiles(path);
    // A custom profile keeps its name, made unique against the ones already there ("Exported 2").
    // A profile's name lives in an <input>, so it is that input's *value*: `hasText` can't see it,
    // and React sets the value as a property rather than an attribute.
    const names = page.locator('.profile input[aria-label="Profile name"]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.profile input[aria-label="Profile name"]')].some((i) => (i as HTMLInputElement).value === "Exported 2"),
      undefined,
      { timeout: 5000 },
    );
    assert.equal(await page.locator(".profile").count(), before + 1, "added, not replaced");
    assert.equal(await names.first().inputValue(), "Exported", "the one it was made from is untouched");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("Firmware mode: the preflight, both paths, and flashing refused in visible text", async () => {
    const page = await app();
    await page.getByRole("tab", { name: "Firmware" }).click();
    // The mock pretends QMK MSYS is installed, so `pickFwMode` opens on Advanced.
    await page.locator(".fw-workspace").waitFor({ timeout: 20000 });
    await page.locator(".check-row").first().waitFor();
    // Where the keyboard is sits beside the output; here the firmware is built, not downloaded.
    await page.locator(".fw-bottom .fw-step", { hasText: "Building the firmware" }).waitFor();

    // Over to the ready-made path, which is where someone with no build tools belongs.
    await page.getByRole("tab", { name: "Basic mode" }).click();
    await page.locator(".fw-basic-body").waitFor({ timeout: 20000 });
    const body = (await page.locator(".fw-basic-body").textContent()) ?? "";
    assert.match(body, /profile switcher/i);
    assert.match(body, /bootloader/i, "how to get back is on the page, not hidden in a tooltip");

    // The mock's USB scan reports a V6 8K ISO, which is the keyboard chosen, so flashing it is
    // allowed: the guard must not stand in the way of the ordinary case.
    const flash = page.getByRole("button", { name: /^Flash/ });
    assert.equal(await flash.isDisabled(), false, "the keyboard the app can see may be flashed");
    // Nobody has to pick a device when the app can see the keyboard itself.
    assert.equal(await page.locator(".device-picker").count(), 0);

    // Basic has no projects, so its sidebar is the preflight: the whole list, nothing to unfold.
    const aside = page.locator(".sidebar .fw-basic-aside");
    await aside.locator(".preflight .check-row").first().waitFor();
    assert.equal(await page.locator(".fw-main .preflight").count(), 0, "not a second one in the main area");
    assert.equal(await aside.locator(".preflight button.preflight-head").count(), 0, "no fold in the sidebar");

    // Where the keyboard is sits beside the output. Flashing walks its steps; the mock's keyboard
    // is back on USB afterwards but never answers with the module, so it says restarted, not ready.
    const steps = page.locator(".fw-bottom .fw-steps");
    assert.equal(await steps.locator(".fw-step").count(), 5);
    await flash.click();
    await steps.locator(".fw-step.is-active").first().waitFor();
    await steps.locator(".fw-steps-label", { hasText: "Keyboard restarted" }).waitFor();
    assert.equal(await steps.locator(".fw-step.is-done").count(), 5);
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a keyboard already in its bootloader: the picker opens on it, and can say it isn't", async () => {
    const page = await app();
    // The mock's USB scan then reports the V6 8K's bootloader and no keyboard.
    await page.goto(`${page.url().split("?")[0]}?bootloader`);
    await page.locator(".app").waitFor();
    await page.getByRole("tab", { name: "Firmware" }).click();
    await page.getByRole("tab", { name: "Basic mode" }).click();

    const picker = page.locator(".fw-basic .device-picker select");
    await picker.waitFor({ timeout: 20000 });
    assert.match((await picker.locator("option:checked").textContent()) ?? "", /DFU in FS Mode.*2E3C:DF11/);
    const flash = page.getByRole("button", { name: /^Flash/ });
    assert.equal(await flash.isDisabled(), false, "it opened on the right device: one click to flash");

    await picker.selectOption("");
    assert.equal(await flash.isDisabled(), true, "the user said it isn't their keyboard");
    assert.match((await page.locator(".device-picker .check-detail").textContent()) ?? "", /Choose the device/);

    // A project's Flash dialog asks the same way (make writes to whatever has that USB id).
    await page.getByRole("tab", { name: "Advanced mode" }).click();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await page.locator(".sidebar").getByRole("button", { name: /New/ }).first().click();
    const fresh = page.locator('[role="dialog"]');
    await fresh.locator("input").first().fill("Mine");
    await fresh.locator("select[size]").selectOption({ value: "keychron/v6_8k/iso_encoder" });
    await fresh.getByRole("button", { name: "Create" }).click();
    await page.getByRole("button", { name: "Flash…" }).click();
    const dialog = page.locator('[role="dialog"]', { hasText: "Flash Mine" });
    const mine = dialog.locator(".device-picker select");
    assert.match((await mine.locator("option:checked").textContent()) ?? "", /2E3C:DF11/);
    const go = dialog.getByRole("button", { name: "Flash", exact: true });
    assert.equal(await go.isDisabled(), false);
    await mine.selectOption("");
    assert.equal(await go.isDisabled(), true);
    assert.deepEqual(consoleErrors(page), []);
  });

  test("flashing is refused, in visible text, for a keyboard the app cannot see", async () => {
    // 221 of the 269 boards share one bootloader id, so once a keyboard is in bootloader mode the
    // app cannot check the model. It therefore wants to have seen the keyboard itself first.
    const page = await app();
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.locator('[role="dialog"][aria-label="Settings"]');
    await settings.waitFor();
    await settings.getByRole("button", { name: /Another one/ }).click();
    await settings.locator(".picker-search").fill("Q1 Max ANSI Knob");
    await settings.locator('[role="option"]').first().click();
    await settings.getByRole("button", { name: "Close" }).first().click();

    await page.getByRole("tab", { name: "Firmware" }).click();
    await page.getByRole("tab", { name: "Basic mode" }).click();
    await page.locator(".fw-basic-body").waitFor({ timeout: 20000 });

    const flash = page.getByRole("button", { name: /^Flash/ });
    assert.equal(await flash.isDisabled(), true, "the app has never seen a Q1 Max");
    // And it says so where the user can read it: a disabled button shows no tooltip in WebView2.
    const why = (await page.locator(".fw-basic .warn").first().textContent()) ?? "";
    assert.match(why, /isn't a Q1 Max|can't see|Plug the/i, why);
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a flash backs up the keyboard's firmware first, and the backup can be written back", async () => {
    const page = await app();
    await page.getByRole("tab", { name: "Firmware" }).click();
    await page.getByRole("tab", { name: "Basic mode" }).click();
    await page.locator(".fw-basic-body").waitFor({ timeout: 20000 });
    const option = page.locator(".fw-basic .backup-option input[type=checkbox]");
    assert.equal(await option.isChecked(), true, "on unless the user turns it off");

    await page.getByRole("button", { name: /^Flash/ }).click();
    await page.locator(".fw-bottom .fw-steps-label", { hasText: "Keyboard restarted" }).waitFor();

    await page.locator(".fw-basic .backup-option").getByRole("button", { name: "Backups…" }).click();
    const dialog = page.locator('[role="dialog"][aria-label="Firmware backups"]');
    const rows = dialog.locator(".backup-row");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 1, "the flash made one");
    assert.match((await rows.first().textContent()) ?? "", /V6 8K/);

    // On demand: nothing written, one more backup.
    await dialog.getByRole("button", { name: /^Back up/ }).click();
    await dialog.locator(".fw-ready").waitFor();
    assert.equal(await rows.count(), 2);

    // Restore asks once more on the same button, then writes it back like a flash.
    const restore = rows.last().getByRole("button", { name: "Restore" });
    await restore.click();
    await rows.last().getByRole("button", { name: "Write it back?" }).click();
    await dialog.locator(".fw-ready", { hasText: "backup" }).waitFor();

    await rows.first().getByRole("button", { name: "Delete" }).click();
    await rows.first().getByRole("button", { name: "Delete for good?" }).click();
    // The restore backed up what it replaced: 3 made, 1 deleted.
    await page.waitForFunction(() => document.querySelectorAll(".backup-row").length === 2);
    assert.deepEqual(consoleErrors(page), []);
  });

  test("Settings reaches the guide and the installer from Firmware mode too", async () => {
    const page = await app();
    await page.getByRole("tab", { name: "Firmware" }).click();
    await page.locator(".fw-basic, .fw-workspace").waitFor({ timeout: 20000 });

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.locator('[role="dialog"][aria-label="Settings"]');
    await settings.waitFor();
    await settings.getByRole("button", { name: /Getting started/ }).click();
    // Used to close Settings and open nothing at all on this side of the app.
    await page.locator('[role="dialog"][aria-label="Getting started"]').waitFor({ timeout: 5000 });
    await closeGuide(page);
    assert.deepEqual(consoleErrors(page), []);
  });

  test("Settings: the theme applies at once and is remembered", async () => {
    const page = await app();
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.locator('[role="dialog"][aria-label="Settings"]');
    await settings.waitFor();
    await settings.getByRole("radio", { name: "Light", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await settings.getByRole("button", { name: "Close" }).first().click();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".board").waitFor({ timeout: 15000 });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light", "kept per PC");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("the Lighting tab paints a layer on the keys that are picked", async () => {
    const page = await app();
    await page.getByRole("tab", { name: "Lighting" }).click();
    await page.locator(".lighting").waitFor();

    // Default has no lighting of its own until a mode is chosen here.
    await page.getByRole("radio", { name: "Effect + layers" }).click();
    await page.locator(".layer-row.is-base").waitFor();

    await clickKey(page, "3,1");
    const add = page.getByRole("button", { name: /Add layer/ });
    await add.waitFor();
    await add.click();
    await page.locator(".layer-row").first().waitFor();
    assert.equal(await commitHint(page).textContent(), "Unapplied changes");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("the keyboard tester shows keys going down and up, and editing comes back after it", async () => {
    const page = await app();
    // A remap to hide while testing, and to delete afterwards.
    await clickKey(page, "3,1");
    await page.locator(".key-menu .picker-search").fill("F13");
    await page.locator(".key-menu .picker-grid .mini-cap").first().click();
    await page.locator('.cap[data-key="3,1"].is-bound').waitFor();
    await page.keyboard.press("Escape"); // the menu

    const toggle = page.getByRole("button", { name: "Test keyboard" });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".tape").count(), 0, "no remap tapes while testing");
    const count = page.locator(".tester-count");
    assert.match((await count.textContent()) ?? "", /^0 of \d+ keys tested$/);

    // KeyA types KC_A, the key at 3,1: down while held, tested once released.
    const slotA = page.locator('.cap-slot:has(> .cap[data-key="3,1"])');
    await page.keyboard.down("KeyA");
    await page.locator('.cap-slot.is-down:has(> .cap[data-key="3,1"])').waitFor();
    assert.match((await count.textContent()) ?? "", /^1 of/);
    await page.keyboard.up("KeyA");
    assert.equal(await page.locator(".cap-slot.is-down").count(), 0);
    assert.match((await slotA.getAttribute("class")) ?? "", /is-tested/);

    // Tab, Space and Escape are keys to test, not app shortcuts; Ctrl+Z undoes nothing.
    for (const key of ["Tab", "Space", "Escape", "Control+z"]) await page.keyboard.press(key);
    assert.equal(await toggle.getAttribute("aria-pressed"), "true", "only the toggle leaves");
    assert.match((await count.textContent()) ?? "", /^6 of/, "A, Tab, Space, Esc, Ctrl, Z");
    await page.locator('.cap[data-key="3,1"]').click();
    assert.equal(await page.locator(".key-menu").count(), 0, "clicking a key opens nothing");

    // Leaving the window lets go of every key.
    await page.keyboard.down("KeyS");
    await page.locator(".cap-slot.is-down").waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert.equal(await page.locator(".cap-slot.is-down").count(), 0);
    await page.keyboard.up("KeyS");

    await page.getByRole("button", { name: "Reset" }).click();
    assert.match((await count.textContent()) ?? "", /^0 of/);
    assert.equal(await page.locator(".cap-slot.is-tested").count(), 0);

    // Off again: the tape is back and Delete removes the picked key's remap.
    await toggle.click();
    await page.locator('.cap[data-key="3,1"].is-bound').waitFor();
    await page.locator('.cap[data-key="3,1"]').click({ modifiers: ["Control"] });
    await page.keyboard.press("Delete");
    await page.locator('.cap[data-key="3,1"].is-bound').waitFor({ state: "detached" });
    assert.deepEqual(consoleErrors(page), []);
  });

  test("with a current profile switcher, the tester takes its keys from the keyboard, Fn and knob included", async () => {
    const page = await app();
    // The mock then plays a V6 8K with the current module, which reports its keys itself.
    await page.goto(`${page.url().split("?")[0]}?keyboard`);
    await page.locator(".board").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Test keyboard" }).click();
    const count = page.locator(".tester-count");
    assert.match((await count.textContent()) ?? "", /^0 of 110 keys tested$/, "the knob counts: the keyboard reports it");
    assert.equal(await page.locator(".tester-note").count(), 0, "no note about what Windows can't see");

    await page.keyboard.down("KeyA");
    await page.locator('.cap-slot.is-down:has(> .cap[data-key="3,1"])').waitFor();
    await page.keyboard.up("KeyA");
    await page.locator(".cap-slot.is-down").waitFor({ state: "detached" });

    // Fn (the mock's stand-in: ContextMenu) never reaches Windows, but the keyboard reports it.
    await page.keyboard.press("ContextMenu");
    await page.locator('.cap-slot.is-tested:has(> .cap[data-key="5,12"])').waitFor();
    // A knob turn flashes the knob and its turn; it isn't a key to count.
    await page.keyboard.press("AudioVolumeUp");
    await page.locator('.knob-turn.is-turning[data-key="e0:cw"]').waitFor();
    assert.match((await count.textContent()) ?? "", /^2 of/);
    assert.equal(await page.locator(".tester-last kbd").textContent(), "Knob ↻");
    assert.deepEqual(consoleErrors(page), []);
  });

  test("a keyboard that can't start reporting keys: the tester says so and uses Windows' keys", async () => {
    const page = await app();
    await page.goto(`${page.url().split("?")[0]}?keyboard=busy`);
    await page.locator(".board").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Test keyboard" }).click();
    await page.locator(".tester-note", { hasText: "couldn't start reporting" }).waitFor();
    assert.match((await page.locator(".tester-count").textContent()) ?? "", /^0 of 109 keys tested$/, "Windows can't see the knob");
    await page.keyboard.down("KeyA");
    await page.locator('.cap-slot.is-down:has(> .cap[data-key="3,1"])').waitFor();
    await page.keyboard.up("KeyA");
    assert.deepEqual(consoleErrors(page), []);
  });
});
