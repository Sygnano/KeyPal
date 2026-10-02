import type { AppConfig, BaseKeymap, Bind, KeyId, Profile } from "./types";

/**
 * Remaps are made per keyboard layer. On the board a key is "3,1"; in `Profile.binds` it carries
 * its layer: "L2:3,1" (key 3,1 on layer 2), "L3:e0:cw" (the knob on layer 3). Files from before
 * layers had no prefix: those remaps were on the keyboard's default layer.
 */
const LAYER_ID = /^L(\d+):(.+)$/;
const KC_TRNS = 0x0001;
const QK_MOMENTARY = 0x5220;
const QK_LAYER_TAP = 0x4000;

/** "L2:3,1" → layer 2, key "3,1". No prefix: layer null (the default layer). */
export function splitLayer(id: KeyId): { layer: number | null; key: KeyId } {
  const m = LAYER_ID.exec(id);
  return m ? { layer: Number(m[1]), key: m[2] } : { layer: null, key: id };
}

/** "L2:3,1" → "3,1" (the key on the board). */
export const boardId = (id: KeyId): KeyId => splitLayer(id).key;

/** The bind id of a board key on a layer. */
export const bindId = (id: KeyId, layer: number): KeyId => `L${layer}:${boardId(id)}`;

/** The layer a bind id is on, `defaultLayer` for ids without one. */
export const layerOf = (id: KeyId, defaultLayer: number): number => splitLayer(id).layer ?? defaultLayer;

/**
 * What a key does on a layer, the way QMK works it out: a transparent key falls through to the
 * default layer (when it's below this one), then to layer 0. `bind` is a remap of the profile on a
 * lower layer that the key falls through to.
 */
export function resolveKey(
  base: BaseKeymap,
  layer: number,
  key: KeyId,
  binds: Record<KeyId, Bind> = {},
): { kc: number; from: number; bind?: Bind } {
  const chain = [layer];
  if (base.layer < layer) chain.push(base.layer);
  if (!chain.includes(0)) chain.push(0);
  for (const l of chain) {
    const bind = l === layer ? undefined : binds[bindId(key, l)];
    if (bind) return { kc: "keycode" in bind ? bind.keycode : 0, from: l, bind };
    const kc = base.layers[l]?.[key];
    if (kc !== undefined && kc !== KC_TRNS) return { kc, from: l };
  }
  return { kc: base.layers[layer]?.[key] ?? KC_TRNS, from: layer };
}

/** What a key does on its layer (see `resolveKey`), for its legend. */
export function keycodeAt(base: BaseKeymap, id: KeyId): number {
  return resolveKey(base, layerOf(id, base.layer), boardId(id)).kc;
}

/** Remaps saved without a layer go on `defaultLayer`. Same as the Rust side's `put_binds_on_layers`. */
export function putBindsOnLayers(config: AppConfig, defaultLayer: number): AppConfig {
  const fix = (p: Profile): Profile => {
    if (Object.keys(p.binds).every((k) => splitLayer(k).layer !== null)) return p;
    const binds: Record<KeyId, Bind> = {};
    for (const [k, b] of Object.entries(p.binds)) binds[splitLayer(k).layer === null ? bindId(k, defaultLayer) : k] = b;
    return { ...p, binds };
  };
  return { ...config, profiles: config.profiles.map(fix) };
}

/** What the app can tell about a keyboard layer from its keymap. */
export interface LayerInfo {
  index: number;
  /** The Mac/Win switch has it as the default layer now. */
  isDefault: boolean;
  /** Turned on by a key (MO(n), or LT(n, …)) on another layer: an Fn layer. */
  isFn: boolean;
  /** Every key transparent: nothing of its own. */
  empty: boolean;
}

export function layerInfos(base: BaseKeymap): LayerInfo[] {
  const reached = new Set<number>();
  base.layers.forEach((keys, from) => {
    for (const kc of Object.values(keys)) {
      let to = -1;
      if (kc >= QK_MOMENTARY && kc < QK_MOMENTARY + 0x20) to = kc & 0x1f;
      else if (kc >= QK_LAYER_TAP && kc < QK_LAYER_TAP + 0x1000) to = (kc >> 8) & 0x0f;
      if (to >= 0 && to !== from) reached.add(to);
    }
  });
  return base.layers.map((keys, index) => ({
    index,
    isDefault: index === base.layer,
    isFn: reached.has(index),
    empty: Object.values(keys).every((kc) => kc === KC_TRNS),
  }));
}

/** A layer's name: the user's own, else "Layer N". */
export function layerName(index: number, names: Record<string, string>): string {
  return names[String(index)]?.trim() || `Layer ${index}`;
}
