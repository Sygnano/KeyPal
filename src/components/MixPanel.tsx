import { useState, type ReactNode } from "react";
import { allIds } from "../lib/board";
import { hsvToCss } from "../lib/color";
import { RGB_EFFECTS } from "../lib/layout";
import type { MixEffect, MixLighting } from "../lib/types";
import { restOfMix, useStore } from "../state/store";

/** Keychron's Mix RGB (effect 24): each region plays up to this many effects in turn. */
export const MIX_EFFECTS_PER_REGION = 5;
export { DEFAULT_MIX, MIX_RGB } from "../lib/layers";

/** Effects a region can play: Keychron refuses Per Key RGB and Mix RGB itself. */
export const mixEffects = () => RGB_EFFECTS.filter(([, id]) => id > 0 && id < 23);
const usesColor = (e: number) => (e >= 1 && e <= 3) || (e >= 18 && e <= 20) || e === 22;
const usesSpeed = (e: number) => e > 1;

/** Region 1 is the base (every key no other region has); the others are "Mix layer 1"… */
export const regionName = (i: number) => (i === 0 ? "Base" : `Mix layer ${i}`);
const effectName = (id: number) => RGB_EFFECTS.find(([, e]) => e === id)?.[0] ?? `Effect ${id}`;

export function regionKeyCount(mix: MixLighting, i: number): number {
  return i === 0 ? restOfMix(mix).length : (mix.regions[i]?.keys.length ?? 0);
}

/** A region's swatch: its first effect's colour, or a rainbow for effects with their own colours. */
export function mixSwatch(fx: MixEffect | undefined): string | undefined {
  if (!fx) return undefined;
  return usesColor(fx.effect) ? hsvToCss({ h: fx.hue, s: fx.sat, v: 255 }) : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)";
}

/** Middle panel for a region (the base, or one above it): which keys, and the effects it plays in turn. */
export function MixRegionDetails({ mix, region }: { mix: MixLighting; region: number }) {
  const { setMix, setPicked, removeRegion } = useStore.getState();
  const mixRgb = useStore((s) => s.engine.mixRgb);
  const connected = useStore((s) => s.engine.connected);
  const [selected, setSelected] = useState(0);
  const r = mix.regions[region];
  if (!r) return null;
  const effects = r.effects;
  const n = regionKeyCount(mix, region);

  // No group: adding or removing an effect is a step of its own. `patch` merges quick edits of
  // one field of one effect (typing a duration), like every other field in the app.
  const setEffects = (next: MixEffect[], group?: string) =>
    setMix({ regions: mix.regions.map((x, i) => (i === region ? { ...x, effects: next } : x)) }, group);
  const patch = (i: number, p: Partial<MixEffect>) =>
    setEffects(
      effects.map((e, j) => (j === i ? { ...e, ...p } : e)),
      `${region}:${i}:${Object.keys(p).sort().join(",")}`,
    );

  return (
    <div className="panel layer-details">
      <h2 className="panel-title">{region === 0 ? "Base effects" : regionName(region)}</h2>
      {region === 0 ? (
        <p className="option-text">
          <strong>
            {n} key{n === 1 ? "" : "s"}
          </strong>
          : every key that isn't in a layer above plays these.
        </p>
      ) : (
        <>
          <p className="option-text">
            <strong>
              {n} key{n === 1 ? "" : "s"}
            </strong>
            . Click keys on the board to add or remove them, drag a box to add (Alt+drag to take out). Esc when done.
          </p>
          <div className="option-actions">
            <button className="btn btn-ghost" onClick={() => setPicked(allIds("lighting"))}>
              All keys
            </button>
            <button className="btn btn-ghost" disabled={!n} onClick={() => setPicked([])}>
              No keys
            </button>
            <button className="btn btn-ghost danger" onClick={() => removeRegion(region)}>
              Delete layer
            </button>
          </div>
        </>
      )}

      <h3 className="sub-title">Effects, played in turn</h3>
      <ol className="mix-effects">
        {effects.map((e, i) => (
          <li key={i} className={`mix-effect ${i === selected ? "is-active" : ""}`} onClick={() => setSelected(i)}>
            <select value={e.effect} onChange={(ev) => patch(i, { effect: Number(ev.target.value) })} aria-label="Effect">
              {mixEffects().map(([name, id]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            {effects.length > 1 && (
              <label className="mix-time" title="How long it plays before the next one">
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={Math.round(e.time / 1000)}
                  onChange={(ev) => patch(i, { time: Math.max(1, Math.min(600, Number(ev.target.value) || 1)) * 1000 })}
                />
                s
              </label>
            )}
            <button
              className="icon-btn small danger"
              aria-label={`Remove ${effectName(e.effect)}`}
              disabled={effects.length === 1}
              onClick={(ev) => {
                ev.stopPropagation();
                setEffects(effects.filter((_, j) => j !== i));
                setSelected(0);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      <button
        className="btn btn-ghost"
        disabled={effects.length >= MIX_EFFECTS_PER_REGION}
        onClick={() => {
          setEffects([...effects, { ...effects[effects.length - 1], time: 5000 }]);
          setSelected(effects.length);
        }}
      >
        + Add an effect
      </button>
      {connected && !mixRgb && <p className="warn">This keyboard didn't answer Keychron's Mix RGB command.</p>}
    </div>
  );
}

/** Right panel: speed and colour of a region's effects (and, for the base, the keyboard's brightness). */
export function MixEffectValues(props: {
  mix: MixLighting;
  region: number;
  brightness?: ReactNode;
  renderPicker(value: { h: number; s: number }, onChange: (h: number, s: number) => void): JSX.Element;
}) {
  const { mix, region, brightness, renderPicker } = props;
  const setMix = useStore((s) => s.setMix);
  const r = mix.regions[region];
  if (!r) return null;
  // One undo step per drag of the speed slider or the colour wheel, not one per tick.
  const patchAll = (p: Partial<MixEffect>) =>
    setMix(
      { regions: mix.regions.map((x, i) => (i === region ? { ...x, effects: x.effects.map((e) => ({ ...e, ...p })) } : x)) },
      `${region}:all:${Object.keys(p).sort().join(",")}`,
    );
  const first = r.effects[0];
  return (
    <div className="panel lighting-values">
      <h2 className="panel-title">
        Colour and motion <span className="muted">· {regionName(region)}</span>
      </h2>
      {brightness}
      {first && usesSpeed(first.effect) && (
        <label className="slider">
          <span className="slider-label">
            Speed<span className="slider-value">{Math.round((first.speed / 255) * 100)}%</span>
          </span>
          <input type="range" min={0} max={255} value={first.speed} onChange={(e) => patchAll({ speed: Number(e.target.value) })} />
        </label>
      )}
      {first && r.effects.some((e) => usesColor(e.effect)) ? (
        renderPicker({ h: first.hue, s: first.sat }, (hue, sat) => patchAll({ hue, sat }))
      ) : (
        <p className="option-text">These effects pick their own colours.</p>
      )}
      <p className="option-text small">Applies to every effect of this {region === 0 ? "base" : "region"}. Brightness is the whole keyboard's (on the base).</p>
    </div>
  );
}
