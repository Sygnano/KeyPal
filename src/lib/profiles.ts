import { keycodeLabel } from "../qmk/labels";
import { DEFAULT_PROFILE_ID, type AppConfig, type Bind, type Lighting, type Profile } from "./types";

/**
 * Last-resort lighting, only when neither Default nor the keyboard has told us anything yet:
 * Keychron's own default, a rainbow wave ("Cycle Left Right"). Normally Default adopts the
 * keyboard's lighting when it first connects.
 */
export const DEFAULT_LIGHTING: Lighting = { effect: 5, speed: 128, brightness: 200, hue: 0, sat: 255 };

export function newDefaultConfig(): AppConfig {
  return {
    version: 2,
    profiles: [{ id: DEFAULT_PROFILE_ID, name: "Default", programs: [], binds: {}, lighting: null }],
  };
}

export function newId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** New custom profiles start as a copy of the default profile's binds and lighting. */
export function createProfileFrom(def: Profile, existing: Profile[]): Profile {
  let n = existing.length;
  let name = `Profile ${n}`;
  while (existing.some((p) => p.name === name)) name = `Profile ${++n}`;
  return {
    id: newId(),
    name,
    programs: [],
    binds: structuredClone(def.binds),
    lighting: def.lighting ? structuredClone(def.lighting) : null,
  };
}

/** `name`, or "name 2", "name 3"… when another profile has it. */
export function uniqueName(name: string, existing: Profile[]): string {
  const base = name.trim() || "Profile";
  let out = base;
  for (let n = 2; existing.some((p) => p.name === out); n++) out = `${base} ${n}`;
  return out;
}

/**
 * A copy of a profile as a new custom profile: same remaps and lighting, no programs (the same
 * program in two profiles would only ever pick the first).
 */
export function duplicateProfile(p: Profile, existing: Profile[]): Profile {
  return {
    ...structuredClone(p),
    id: newId(),
    name: uniqueName(`${p.name} copy`, existing),
    programs: [],
  };
}

/**
 * Profiles read from a file, ready to add: fresh ids and names that don't clash. The default
 * profile of a backup comes in as a custom profile.
 */
export function importedProfiles(incoming: Profile[], existing: Profile[]): Profile[] {
  const out: Profile[] = [];
  for (const p of incoming) {
    const name = p.id === DEFAULT_PROFILE_ID ? `${p.name} (imported)` : p.name;
    out.push({ ...structuredClone(p), id: newId(), name: uniqueName(name, [...existing, ...out]) });
  }
  return out;
}


/** A key remapped to KC_NO: it does nothing. */
export const DISABLED_BIND: Bind = { kind: "key", keycode: 0 };

export function isDisabled(bind: Bind | undefined): boolean {
  return bind?.kind === "key" && bind.keycode === 0;
}

export function bindLabel(bind: Bind): string {
  switch (bind.kind) {
    case "key":
      return bind.keycode === 0 ? "Disabled" : keycodeLabel(bind.keycode);
    case "qmk":
      return bind.source.length > 14 ? keycodeLabel(bind.keycode) : bind.source;
    case "macro":
      return bind.name || "Macro";
  }
}

export function bindKindLabel(bind: Bind): string {
  if (isDisabled(bind)) return ""; // the "Disabled" label says it all
  return bind.kind === "key" ? "Key" : bind.kind === "qmk" ? "QMK code" : "Macro";
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

