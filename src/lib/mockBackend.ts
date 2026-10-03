/**
 * The browser-only stand-in for the Rust side, so `pnpm dev:ui` and the tests work without a
 * keyboard. It is loaded with a dynamic `import()` (see `initApi` in `api.ts`) so it never ends up
 * in the production bundle: the real app always runs inside Tauri.
 */
import { createFirmwareMock } from "./firmwareMock";
import { BOARD, fallbackBaseKeymap } from "./layout";
import { newDefaultConfig } from "./profiles";
import { builtinLegends, DOM_CODE_TO_QMK } from "../qmk/labels";
import { valueOf } from "../qmk/keycodes";
import { resolveKey } from "./keyIds";
import { encoderIds, KEYS } from "./layout";
import { MODULE_VERSION } from "./limits";
import { safeFileName, type Backend, type KeyEvent } from "./api";
import {
  DEFAULT_SETTINGS,
  type AppConfig,
  type EngineState,
  type FocusState,
  type Profile,
} from "./types";

/**
 * The same checks `storage::import_profiles` makes on the Rust side. Without them the browser
 * preview accepted files the real app rejects, which is exactly the kind of drift that makes a
 * preview say "it works".
 */
function checkImported(data: unknown): Profile[] {
  const bad = () => {
    throw new Error("That file is not a profile file from this app.");
  };
  if (!data || typeof data !== "object") return bad();
  const d = data as Record<string, unknown>;
  const formats = [
    "kboard-companion/profiles",
    "keypal/profiles",
    "keychron-companion/profiles",
    "v6-profile-switcher/profiles",
  ];
  const profiles =
    typeof d.format === "string"
      ? formats.includes(d.format) && Array.isArray(d.profiles)
        ? (d.profiles as Profile[])
        : bad()
      : Array.isArray(d.profiles)
        ? (d.profiles as Profile[])
        : typeof d.id === "string" && typeof d.name === "string"
          ? [d as unknown as Profile]
          : bad();
  if (!profiles.length) throw new Error("That file has no profiles in it.");
  for (const p of profiles) {
    if (
      !p ||
      typeof p.id !== "string" ||
      typeof p.name !== "string" ||
      typeof p.binds !== "object"
    )
      return bad();
  }
  return profiles;
}

/** Browser-only stand-in so `pnpm dev:ui` works without the Rust side. */
export function createMockBackend(): Backend {
  const KEY = "v6ps-mock-config";
  const AUTOSTART_KEY = "v6ps-mock-autostart";
  const SETTINGS_KEY = "v6ps-mock-settings";
  const read = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private window or tests: the mock just forgets.
    }
  };
  // `?keyboard` in the preview's address: a V6 8K ISO plugged in, with the current profile switcher
  // (the keyboard tester then takes its keys from "the keyboard", see `setKeyReport`).
  const plugged = hasFlag("keyboard");
  let engine: EngineState = {
    connected: plugged,
    firmware: plugged ? "ok" : "unknown",
    firmwareVersion: plugged ? MODULE_VERSION : 0,
    buildId: 0,
    mixRgb: false,
    mixRegions: 0,
    board: plugged ? "v6_8k_iso_encoder" : null,
    unreachable: null,
    mode: "auto",
    activeProfileId: "default",
    lastError: null,
  };
  const focus: FocusState = { exe: null, path: null, title: null };
  const listeners = new Set<(s: EngineState) => void>();
  const emit = () => listeners.forEach((l) => l(engine));
  const keyListeners = new Set<(e: KeyEvent) => void>();
  const keyReports = mockKeyReports((e) => keyListeners.forEach((l) => l(e)));
  return {
    ...createFirmwareMock(() => {
      const raw = read(SETTINGS_KEY);
      return raw ? JSON.parse(raw).fwBackup !== false : true;
    }),
    async loadConfig() {
      const raw = read(KEY);
      return raw ? (JSON.parse(raw) as AppConfig) : newDefaultConfig();
    },
    async saveConfig(config) {
      write(KEY, JSON.stringify(config));
    },
    async getEngineState() {
      return engine;
    },
    async getFocusState() {
      return focus;
    },
    async setOverride(profileId) {
      engine = {
        ...engine,
        mode: profileId ? "manual" : "auto",
        activeProfileId: profileId ?? "default",
      };
      emit();
    },
    getBaseKeymap: async () => fallbackBaseKeymap(),
    refreshBaseKeymap: async () => fallbackBaseKeymap(),
    previewLighting: async () => {},
    // Something to adopt, so "Default takes the keyboard's own lighting on first connect" can be
    // seen in the preview: Keychron's rainbow wave, as a real board ships.
    getKeyboardLighting: async () => ({
      effect: 6,
      hue: 0,
      sat: 255,
      brightness: 180,
      speed: 128,
    }),
    async pickExe() {
      const name = window.prompt(
        "Mock file picker: type an exe path",
        "C:\\Games\\cs2.exe",
      );
      return name || null;
    },
    async pickFolder() {
      const name = window.prompt(
        "Mock folder picker: type a folder",
        "C:\\Games",
      );
      return name || null;
    },
    listRunningPrograms: async () => [
      {
        path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        name: "chrome.exe",
        title: "Figma – Design",
      },
      {
        path: "C:\\Games\\Counter-Strike 2\\game\\bin\\win64\\cs2.exe",
        name: "cs2.exe",
        title: "Counter-Strike 2",
      },
      {
        path: "C:\\Windows\\explorer.exe",
        name: "explorer.exe",
        title: "Downloads",
      },
    ],
    getProgramIcon: async () => null,
    getAutostart: async () => read(AUTOSTART_KEY) === "1",
    async setAutostart(enabled) {
      write(AUTOSTART_KEY, enabled ? "1" : "0");
    },
    async getSettings() {
      const raw = read(SETTINGS_KEY);
      return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    },
    async saveSettings(settings) {
      write(SETTINGS_KEY, JSON.stringify(settings));
    },
    getAppInfo: async () => ({
      version: "dev",
      configDir: "(browser storage)",
      logDir: "(browser console)",
    }),
    checkUpdate: async () => null,
    async installUpdate() {
      throw new Error("No updates in the browser preview.");
    },
    openFolder: async () => {},
    async exportProfiles(profiles, suggestedName) {
      const file = {
        format: "kboard-companion/profiles",
        version: 2,
        keyboard: BOARD.firmware ?? BOARD.id,
        profiles,
      };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
      );
      a.download = `${safeFileName(suggestedName)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    },
    importProfiles: () =>
      new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        // A cancelled file picker fires no `change` event at all, so without this the promise
        // never settled and the app sat on "busy" for ever.
        let settled = false;
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.removeEventListener("focus", onCancel);
          fn();
        };
        const onCancel = () => setTimeout(() => done(() => resolve(null)), 300);
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return done(() => resolve(null));
          try {
            const data = JSON.parse(await file.text());
            const profiles = checkImported(data);
            done(() => resolve(profiles));
          } catch (e) {
            done(() => reject(e instanceof Error ? e : new Error(String(e))));
          }
        };
        window.addEventListener("focus", onCancel, { once: true });
        input.click();
      }),
    log: async (level, message) => {
      console[level](message);
    },
    listKeyboardLayouts: async () => ({
      current: "0000040C",
      layouts: [
        { id: "0000040C", name: "French", installed: true },
        { id: "00000409", name: "US", installed: false },
      ],
    }),
    async getLayoutLegends(id) {
      const legends = builtinLegends(id);
      if (!legends) throw new Error(`no built-in legends for layout ${id}`);
      return legends;
    },
    async onEngineState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onBaseKeymap: async () => () => {},
    onConfigChanged: async () => () => {},
    onKeyboardLighting: async () => () => {},
    onFocusState: async () => () => {},
    async setKeyReport(on) {
      // `?keyboard=busy`: a keyboard whose firmware has no slot free to send key reports.
      if (!engine.connected || engine.firmware !== "ok" || flagValue("keyboard") === "busy") return false;
      keyReports.set(on);
      return on;
    },
    async onKeyEvent(cb) {
      keyListeners.add(cb);
      return () => keyListeners.delete(cb);
    },
  };
}

function hasFlag(name: string): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).has(name);
}

function flagValue(name: string): string | null {
  return typeof location !== "undefined" ? new URLSearchParams(location.search).get(name) : null;
}

/**
 * The module's key reports, played by the browser: a key pressed on the PC's keyboard is reported
 * at the position typing it on the default layer, like the keyboard would (the knob turns through
 * the volume keys). ContextMenu stands in for Fn, which never reaches a browser: it's the key
 * Windows can't see that the real module reports. Stops 5 s after the last renewal, like the module.
 */
function mockKeyReports(emit: (e: KeyEvent) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keyOf = (code: string): string | undefined => {
    const base = fallbackBaseKeymap();
    const layer = base.layers[base.layer] ?? {};
    if (code === "ContextMenu")
      return KEYS.find((k) => isMo(layer[k.id]))?.id;
    const name = DOM_CODE_TO_QMK[code];
    const kc = name ? valueOf(name) : undefined;
    if (kc === undefined) return undefined;
    const ids = [
      ...KEYS.map((k) => k.id),
      ...KEYS.filter((k) => k.encoder !== undefined).flatMap((k) => Object.values(encoderIds(k.encoder!))),
    ];
    return ids.find((id) => resolveKey(base, base.layer, id, {}).kc === kc);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const key = keyOf(e.code);
    if (!key) return;
    emit({ key, down: e.type === "keydown" });
    // A knob turn is a press and a release at once.
    if (/^e\d+:/.test(key) && e.type === "keydown") emit({ key, down: false });
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
  };
  return {
    set(on: boolean) {
      if (!on) return stop();
      if (!timer) {
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKey, true);
      }
      clearTimeout(timer);
      timer = setTimeout(stop, 5000);
    },
  };
}

/** QK_MOMENTARY (MO(n)): 0x5220–0x523F. */
const isMo = (kc: number | undefined) => kc !== undefined && kc >= 0x5220 && kc <= 0x523f;
