/**
 * The Lighting tab's pure logic: which mode a profile is in, how Mix RGB turns on and off, and
 * how the colour layers and regions are edited. Kept out of `state/store.ts` (which is mostly
 * actions) so it can be read and tested on its own; the store re-exports it for its importers.
 */
import { allIds } from "./board";
import { DEFAULT_MIX, MIX_RGB } from "./layers";
import { DEFAULT_LIGHTING } from "./profiles";
import type {
  AppConfig,
  ColorLayer,
  EngineState,
  KeyId,
  Lighting,
  MixLighting,
  Profile,
} from "./types";
import { DEFAULT_PROFILE_ID } from "./types";

/** The parts of the store's state these helpers read. */
export interface LightingState {
  draft: AppConfig;
  selectedProfileId: string;
  keyboardLighting: Lighting | null;
  engine: EngineState;
}

export const MIX_PREFIX = "mix:";
export const mixRegionOf = (id: string | null) =>
  id?.startsWith(MIX_PREFIX) ? Number(id.slice(MIX_PREFIX.length)) : null;

export type LightingMode = "default" | "layers" | "mix";

/** A profile's lighting mode as the Lighting tab shows it (null: Default not set up yet). */
export function lightingMode(p: Profile): LightingMode | null {
  if (!p.lighting) return p.id === DEFAULT_PROFILE_ID ? null : "default";
  return p.lighting.effect === MIX_RGB ? "mix" : "layers";
}

/** Mix RGB regions the keyboard has; 2 (the V6 8K's) until it says. */
export const mixRegionLimit = (s: { engine: EngineState }) =>
  s.engine.mixRegions || 2;

/** The lighting a profile edits: its own, or a copy of what it follows (Default's, the keyboard's). */
export function startingLighting(s: LightingState, p: Profile): Lighting {
  const def = s.draft.profiles[0];
  return structuredClone(
    p.lighting ??
      (p.id === DEFAULT_PROFILE_ID ? null : def.lighting) ??
      s.keyboardLighting ??
      DEFAULT_LIGHTING,
  );
}

/** The effect each profile had before Mix RGB was turned on, to go back to it (this session). */
const effectBeforeMix = new Map<string, number>();

/** `l` with Mix RGB on or off. Off goes back to the effect it had before (else Default's, the
 * keyboard's, or the fallback's). The regions and the colour layers are kept either way. */
export function withMixMode(
  s: LightingState,
  p: Profile,
  l: Lighting,
  on: boolean,
): Lighting {
  if (on === (l.effect === MIX_RGB)) return l;
  if (on) {
    effectBeforeMix.set(p.id, l.effect);
    return {
      ...l,
      effect: MIX_RGB,
      mix: l.mix ?? structuredClone(DEFAULT_MIX),
    };
  }
  const plain = [
    effectBeforeMix.get(p.id),
    s.draft.profiles[0].lighting?.effect,
    s.keyboardLighting?.effect,
    DEFAULT_LIGHTING.effect,
  ];
  return {
    ...l,
    effect:
      plain.find((e) => e !== undefined && e !== MIX_RGB) ??
      DEFAULT_LIGHTING.effect,
  };
}

/** Hues for new regions, in turn: blue, green, orange, purple, red. */
export const REGION_HUES = [170, 85, 21, 191, 0];

/** The selected profile's lighting as shown (its own, or Default's when it follows it). */
export function shownLighting(s: LightingState): Lighting | null {
  const p = s.draft.profiles.find((x) => x.id === s.selectedProfileId);
  return (
    p?.lighting ??
    (p?.id === DEFAULT_PROFILE_ID ? null : s.draft.profiles[0].lighting) ??
    null
  );
}

export function layersOf(s: LightingState): ColorLayer[] {
  return shownLighting(s)?.layers ?? [];
}

/** The keys of Mix RGB's first region: every key no other region has. */
export function restOfMix(mix: MixLighting): KeyId[] {
  const taken = new Set(mix.regions.slice(1).flatMap((r) => r.keys));
  return allIds("lighting").filter((k) => !taken.has(k));
}

/** Keys of what `activeLayerId` points at: a colour layer or a Mix RGB region. */
export function activeKeys(
  s: LightingState,
  id: string | null,
): KeyId[] | null {
  const region = mixRegionOf(id);
  if (region !== null) {
    const mix = shownLighting(s)?.mix;
    if (!mix?.regions[region]) return null;
    return region === 0 ? restOfMix(mix) : mix.regions[region].keys;
  }
  return (id && layersOf(s).find((l) => l.id === id)?.keys) || null;
}

/** Mix RGB region `region` gets exactly `keys`; they leave the other regions. */
export function setRegionKeys(
  mix: MixLighting,
  region: number,
  keys: KeyId[],
): MixLighting {
  const set = new Set(keys);
  return {
    regions: mix.regions.map((r, i) =>
      i === 0
        ? { ...r, keys: [] }
        : i === region
          ? { ...r, keys: [...keys] }
          : { ...r, keys: r.keys.filter((k) => !set.has(k)) },
    ),
  };
}
