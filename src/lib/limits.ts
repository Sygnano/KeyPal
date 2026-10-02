import type { AppConfig, MacroStep } from "./types";

/** The firmware module's protocol version bundled with the app (PS_PROTO_VERSION in
 * firmware/profile_switcher.c; the self-test checks they match). The app speaks only this one: a
 * keyboard with any other comes in as `firmware: "missing"`, with a note saying what to do. */
export const MODULE_VERSION = 1;

/**
 * What the keyboard's profile switcher is, as the UI is allowed to say it: present and current,
 * present but older than this app would like, or not there at all. **No version number is ever
 * shown.** "old" can't happen while the app speaks a single version (the backend reports any other
 * as missing); it is kept for the first protocol change after 1.0.
 */
export type ModuleState = "missing" | "old" | "current";

export function moduleStatus(engine: { connected: boolean; firmware: string; firmwareVersion: number }): ModuleState {
  if (!engine.connected || engine.firmware !== "ok") return "missing";
  return engine.firmwareVersion < MODULE_VERSION ? "old" : "current";
}

/** The keyboard runs the profile switcher: every command of the protocol works (restart into the
 * bootloader, key reports, layers, per-key lighting). */
export const hasModule = (engine: { connected: boolean; firmware: string }) =>
  engine.connected && engine.firmware === "ok";

/** The longest gap between macro keys the UI offers, in ms (the protocol carries up to 65535). */
export const MAX_MACRO_GAP = 1000;

/** A gap field's text → ms within 0..MAX_MACRO_GAP, or undefined when it's empty or not a number. */
export function clampGap(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Math.round(Number(text));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_MACRO_GAP, n)) : undefined;
}

/** Must match PS_MACRO_BUFFER_SIZE / PS_MAX_MACROS in firmware/profile_switcher.c */
export const MACRO_BUFFER_BYTES = 2048;
export const MACRO_SLOTS = 64;

/** Bytes a macro takes in the keyboard's RAM: its gap (3, whatever the value), 3 per step, and the
 * terminator. Must match `protocol::build_keymap`. */
export function macroBytes(steps: MacroStep[]): number {
  return 3 + steps.length * 3 + 1;
}

/** Returns a human-readable problem that prevents applying, or null. */
export function validateConfig(config: AppConfig): string | null {
  for (const p of config.profiles) {
    const macros = Object.values(p.binds).filter((b) => b.kind === "macro");
    const bytes = macros.reduce(
      (n, b) => n + (b.kind === "macro" ? macroBytes(b.steps) : 0),
      0,
    );
    // A macro shared by several keys takes a slot and its bytes on each one: name the costliest.
    const costliest = () => {
      const by = new Map<string, { name: string; keys: number; bytes: number }>();
      for (const b of macros) {
        if (b.kind !== "macro") continue;
        const k = b.macroId ?? `name:${b.name}`;
        const e = by.get(k) ?? { name: b.name, keys: 0, bytes: 0 };
        by.set(k, { ...e, keys: e.keys + 1, bytes: e.bytes + macroBytes(b.steps) });
      }
      return [...by.values()].sort((a, b) => b.bytes - a.bytes || b.keys - a.keys)[0];
    };
    const on = (keys: number) => (keys > 1 ? ` on its ${keys} keys` : "");
    if (macros.length > MACRO_SLOTS) {
      const top = costliest();
      const most = top.keys > 1 ? ` "${top.name}" alone is on ${top.keys} keys.` : "";
      return `${p.name} has ${macros.length} macros; the keyboard holds ${MACRO_SLOTS}.${most}`;
    }
    if (bytes > MACRO_BUFFER_BYTES) {
      const top = costliest();
      return `${p.name}'s macros need ${bytes} bytes; the keyboard holds ${MACRO_BUFFER_BYTES}. "${top.name}" takes ${top.bytes} of them${on(top.keys)}.`;
    }
    if (!p.name.trim()) return "Every profile needs a name.";
  }
  return null;
}
