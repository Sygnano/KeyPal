/**
 * Drives the real UI in a real browser, against the mock backend.
 *
 * There is no `window.__TAURI_INTERNALS__` in a plain browser, so `main.tsx` calls `initApi()`,
 * which lazily imports `createMockBackend()` and the whole app runs with profiles in
 * `localStorage` — the same setup as `pnpm dev:ui`. That makes these tests the only ones that go
 * through React, the DOM and the CSS rather than stopping at the store.
 *
 * `playwright-core` plus a Chrome that is already installed: no 400 MB browser download, on this PC
 * or on a GitHub runner (both have one). If none is found the suite says so and skips, rather than
 * failing a build over a missing browser.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { existsSync } from "node:fs";

/** Where Chrome (or Edge, which is the same engine) usually lives, per platform. */
const BROWSERS = [
  process.env.E2E_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p);

export const browserPath = (): string | null =>
  BROWSERS.find((p) => existsSync(p)) ?? null;

/** The dev server and the browser, started once for the whole file. */
export interface Harness {
  page(): Promise<Page>;
  close(): Promise<void>;
}

export async function start(): Promise<Harness> {
  const executablePath = browserPath();
  if (!executablePath) throw new Error("no Chrome or Edge found");

  // Vite in the same process: no child process to wait for or to leave behind.
  const server: ViteDevServer = await createServer({
    configFile: "vite.config.ts",
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "error",
    clearScreen: false,
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error("vite gave no address");

  const browser: Browser = await chromium.launch({
    executablePath,
    headless: true,
  });
  const contexts: BrowserContext[] = [];

  return {
    /** A page with its own storage: every test starts on a keyboard nobody has set up yet. */
    async page() {
      const context = await browser.newContext({
        viewport: { width: 1500, height: 950 },
      });
      contexts.push(context);
      // Short: a flow that is going to fail should say so quickly, not sit on Playwright's
      // 30-second default ten times over.
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      // A console error in the app is a failure: React does not throw for most of them.
      const problems: string[] = [];
      page.on(
        "console",
        (m) => m.type() === "error" && problems.push(m.text()),
      );
      page.on("pageerror", (e) => problems.push(String(e)));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".app, .loading");
      Object.assign(page, { problems });
      return page;
    },
    async close() {
      await Promise.all(contexts.map((c) => c.close().catch(() => {})));
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

/** Console errors the page collected, for a test to assert on. */
export const consoleErrors = (page: Page): string[] =>
  (page as Page & { problems?: string[] }).problems ?? [];

/**
 * Past the first-run screen and the guide, onto the V6 8K ISO: what every flow but the first-run
 * test needs before it can start.
 */
export async function openApp(
  page: Page,
  board = "V6 8K ISO Knob",
): Promise<void> {
  await closeGuide(page);
  // The main area shows the board picker until a keyboard is known.
  if (
    await page
      .locator(".first-run")
      .isVisible()
      .catch(() => false)
  ) {
    await pickBoard(page, board);
  }
  await page.waitForSelector(".board", { timeout: 15000 });
}

export async function closeGuide(page: Page): Promise<void> {
  const guide = page.locator('[role="dialog"][aria-label="Getting started"]');
  if (await guide.isVisible().catch(() => false)) {
    await guide.getByRole("button", { name: "Close" }).first().click();
    await guide.waitFor({ state: "hidden" });
  }
}

export async function pickBoard(page: Page, name: string): Promise<void> {
  await page
    .locator(".first-run .picker-search, .settings .picker-search")
    .first()
    .fill(name);
  await page.locator('[role="option"]', { hasText: name }).first().click();
}

/** Clicks a key on the drawn keyboard (`data-key` is "row,col", or "e0:cw" for a knob). */
export async function clickKey(page: Page, keyId: string): Promise<void> {
  await page.locator(`.cap[data-key="${keyId}"]`).click();
}

/** The commit bar's own summary of whether anything is unapplied. */
export const commitHint = (page: Page) => page.locator(".commit-hint");
