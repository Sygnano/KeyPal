import { PRESETS, brightnessLabel, sameHsv } from "./color";
import { BOARD, isEncoderId } from "./layout";
import { migratePrograms } from "./programs";
import type { Anim, AppConfig, ColorLayer, Hsv, KeyId, Lighting, MixLighting } from "./types";

/** Keychron's Mix RGB effect: regions of keys, each playing its own effects. */
export const MIX_RGB = 24;

/** Mix RGB a profile starts with: one region, every key, playing a left-right colour cycle.
 * More regions are added like layers. */
export const DEFAULT_MIX: MixLighting = {
  regions: [{ keys: [], effects: [{ effect: 5, hue: 0, sat: 255, speed: 128, time: 5000 }] }],
};

/**
 * Colour layers, bottom to top: the topmost visible layer holding a key gives its colour. Same
 * rule as `Lighting::for_keyboard` in the Rust core. Without layers, an older file's `keys`.
 * They go over any effect, Mix RGB's regions included.
 */
export function effectiveKeys(l: Lighting | null | undefined): Record<KeyId, Hsv> {
  if (!l) return {};
  if (!l.layers?.length) return l.keys ?? {};
  const out: Record<KeyId, Hsv> = {};
  for (const layer of l.layers) if (!layer.hidden) for (const k of layer.keys) out[k] = layer.color;
  return out;
}

export function newLayerId(): string {
  return `l_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** "Red" for a preset colour, else "Colour" ("Brightness 50%" on a white backlight); numbered when
 * the name is taken. */
export function layerName(color: Hsv, layers: ColorLayer[]): string {
  const base =
    BOARD.lighting === "white"
      ? `Brightness ${brightnessLabel(color.v)}`
      : (PRESETS.find(([, p]) => sameHsv(p, color))?.[0] ?? "Colour");
  let name = base;
  for (let n = 2; layers.some((l) => l.name === name); n++) name = `${base} ${n}`;
  return name;
}

/** Older files: one flat colour per key. Becomes one layer per colour. */
export function migrateLighting(l: Lighting | null): Lighting | null {
  if (!l?.keys || l.layers?.length) return l;
  const layers: ColorLayer[] = [];
  for (const [id, hsv] of Object.entries(l.keys)) {
    const same = layers.find((x) => sameHsv(x.color, hsv));
    if (same) same.keys.push(id);
    else layers.push({ id: newLayerId(), name: layerName(hsv, layers), color: { ...hsv }, keys: [id] });
  }
  const { keys: _old, ...rest } = l;
  return layers.length ? { ...rest, layers } : rest;
}

/** A config from disk (or an import) brought up to date: colour layers, program rules. */
export function migrateConfig(c: AppConfig): AppConfig {
  return {
    ...c,
    version: 2,
    profiles: c.profiles.map((p) => ({ ...migratePrograms(p), lighting: migrateLighting(p.lighting) })),
  };
}

/** Topmost visible layer holding each key, with its animation (what the keyboard draws). */
export function effectiveAnims(l: Lighting | null | undefined): Record<KeyId, { anim: Anim; speed: number }> {
  const out: Record<KeyId, { anim: Anim; speed: number }> = {};
  for (const layer of l?.layers ?? []) {
    if (layer.hidden) continue;
    for (const k of layer.keys) {
      if (layer.anim && layer.anim !== "static") out[k] = { anim: layer.anim, speed: layer.speed ?? 128 };
      else delete out[k];
    }
  }
  return out;
}

/** Knob ids have no LED. */
export const lightable = (ids: KeyId[]) => ids.filter((id) => !isEncoderId(id));

/**
 * Take keys out of every layer. Layers this empties are dropped (they only held these keys),
 * except `keep`.
 */
export function clearKeys(layers: ColorLayer[], ids: KeyId[], keep?: string): ColorLayer[] {
  const drop = new Set(ids);
  return layers.flatMap((l) => {
    if (!l.keys.some((k) => drop.has(k))) return [l];
    const keys = l.keys.filter((k) => !drop.has(k));
    return keys.length || l.id === keep ? [{ ...l, keys }] : [];
  });
}

/**
 * Give keys one colour (the quick colours of the right-click menu): they leave the other
 * layers and join the topmost visible layer of that colour, or a new layer on top.
 * Returns the layers and the id of the layer that got them.
 */
export function paintKeys(layers: ColorLayer[], ids: KeyId[], color: Hsv): [ColorLayer[], string] {
  const keys = lightable(ids);
  const rest = clearKeys(layers, keys);
  const target = [...rest].reverse().find((l) => !l.hidden && sameHsv(l.color, color));
  if (target) {
    return [rest.map((l) => (l === target ? { ...l, keys: [...l.keys, ...keys] } : l)), target.id];
  }
  const layer: ColorLayer = { id: newLayerId(), name: layerName(color, rest), color: { ...color }, keys };
  return [[...rest, layer], layer.id];
}
