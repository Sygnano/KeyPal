import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { allIds } from "../lib/board";
import {
  WHITE_LEVELS,
  brightnessLabel,
  effectCss,
  hsvToCss,
} from "../lib/color";
import {
  BOARD,
  COLOR_EFFECTS,
  RGB_EFFECTS,
  SPEED_EFFECTS,
} from "../lib/layout";
import { DEFAULT_LIGHTING } from "../lib/profiles";
import {
  DEFAULT_PROFILE_ID,
  type Anim,
  type ColorLayer,
  type Lighting,
} from "../lib/types";
import {
  lightingMode,
  mixRegionLimit,
  mixRegionOf,
  useSelectedProfile,
  useStore,
  type LightingMode,
} from "../state/store";
import { ColourPicker } from "./ColourPicker";
import {
  DEFAULT_MIX,
  MIX_RGB,
  MixEffectValues,
  MixRegionDetails,
  mixSwatch,
  regionKeyCount,
  regionName,
} from "./MixPanel";
import { CrossIcon } from "./ProfileList";
import { useStructuralKey } from "../lib/structuralKey";

/** Which effects use the speed and the colour, from the board's own VIA definition (the V6 8K's
 * rules used to be hard-coded here, which was wrong for every other board). */
const usesSpeed = (e: number) => SPEED_EFFECTS.has(e);
const usesColor = (e: number) => COLOR_EFFECTS.has(e);
/** Keychron's own Per Key RGB uses a table edited in Keychron Launcher (colour layers do that here). */
const KEYCHRON_ONLY = new Set([23]);

const ANIMS: Array<[Anim, string]> = [
  ["static", "Still"],
  ["breathe", "Breathe"],
  ["cycle", "Colour cycle"],
  ["reactive", "Light up when pressed"],
];
/** White backlights: no colour, so no colour cycle. */
const WHITE_ANIMS = ANIMS.filter(([a]) => a !== "cycle");
const effectName = (id: number) =>
  RGB_EFFECTS.find(([, e]) => e === id)?.[0] ?? `Effect ${id}`;
/** QMK's LED matrix effects that use the speed ("Alphas & mods" uses it as the modifiers' extra brightness). */
const whiteUsesSpeed = (e: number) => e > 0 && effectName(e) !== "Solid";

/** The Lighting tab's three ways, with what each means. */
const MODES: Array<[LightingMode, string, string]> = [
  [
    "default",
    "Like Default",
    "This profile shows Default's lighting, and follows it when Default changes.",
  ],
  [
    "layers",
    "Effect + layers",
    "One effect under the whole keyboard, with colour layers on top: as many as you like, each still or animated.",
  ],
  [
    "mix",
    "Mix RGB",
    "Keychron's Mix RGB: groups of keys each playing their own effects in turn, with colour layers on top.",
  ],
];
const WHITE_LAYERS_HELP =
  "One effect under the whole keyboard, with brightness layers on top: some keys brighter, dimmer or off, still or animated.";

/**
 * Lighting is a stack, like an image editor's layers: the base at the bottom, layers above it,
 * the higher one winning where they overlap. "Effect + layers": the base is one effect for the
 * whole keyboard, the layers are colours on some keys. "Mix RGB": Keychron's regions are the
 * layers, each playing its own effects; the base is every key in no other region. One colour
 * picker edits whatever is selected in the stack. White backlights: the same without Mix RGB,
 * the layers being brightness.
 */
export function LightingPanel() {
  if (BOARD.lighting === "none") return <NoLighting />;
  return <StackLighting />;
}

function NoLighting() {
  return (
    <section className="panels lighting">
      <div className="panel layer-details">
        <h2 className="panel-title">Lighting</h2>
        <p className="option-text">The {BOARD.name} has no backlight to set.</p>
      </div>
    </section>
  );
}

function StackLighting() {
  const white = BOARD.lighting === "white";
  const profile = useSelectedProfile();
  const defaultLighting = useStore((s) => s.draft.profiles[0].lighting);
  const keyboardLighting = useStore((s) => s.keyboardLighting);
  const activeLayerId = useStore((s) => s.activeLayerId);
  const setLighting = useStore((s) => s.setLighting);
  const setLightingMode = useStore((s) => s.setLightingMode);
  const engine = useStore((s) => s.engine);
  const isDefault = profile.id === DEFAULT_PROFILE_ID;
  const [live, setLive] = useState(false);

  const own = profile.lighting;
  const shown: Lighting | null = own ?? (isDefault ? null : defaultLighting);
  const inherits = !isDefault && own === null;
  const mode = lightingMode(profile);
  const layers = shown?.layers ?? [];
  const mixOn = shown?.effect === MIX_RGB;
  const mix = mixOn ? shown?.mix : undefined;
  const active = layers.find((l) => l.id === activeLayerId) ?? null;
  const region = mix ? mixRegionOf(activeLayerId) : null;
  // Keychron's Mix RGB: on 82 of their 97 boards. The keyboard says whether it has it.
  const mixAvailable = !white && (!engine.connected || engine.mixRgb || mixOn);
  const modes = MODES.filter(
    ([m]) => (m !== "default" || !isDefault) && (m !== "mix" || mixAvailable),
  );
  const modeHelp = (m: LightingMode) =>
    white && m === "layers"
      ? WHITE_LAYERS_HELP
      : MODES.find(([id]) => id === m)?.[2];

  const start = () =>
    structuredClone(defaultLighting ?? keyboardLighting ?? DEFAULT_LIGHTING);
  const change = (patch: Partial<Lighting>) =>
    setLighting({ ...(own ?? shown ?? start()), ...patch });
  const editable = !!shown && !inherits;

  // Live preview: show every change on the keyboard while it's on; stop when leaving the tab.
  const shownKey = useStructuralKey(shown);
  useEffect(() => {
    if (!live || !shown) return;
    const t = setTimeout(() => api.previewLighting(shown).catch(() => {}), 40);
    return () => clearTimeout(t);
    // `shown` deliberately isn't a dependency: `shownKey` is the same thing without a new
    // reference on every render (see useStructuralKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, shownKey]);
  useEffect(() => () => void api.previewLighting(null).catch(() => {}), []);
  const toggleLive = (on: boolean) => {
    setLive(on);
    if (!on) api.previewLighting(null).catch(() => {});
  };

  return (
    <section className="panels lighting">
      <div className="panel lighting-stack">
        <div className="panel-head">
          <h2 className="panel-title">Lighting for {profile.name}</h2>
          <label
            className="check"
            title="Show every change on the keyboard as you make it"
          >
            <input
              type="checkbox"
              checked={live}
              disabled={!engine.connected || !shown}
              onChange={(e) => toggleLive(e.target.checked)}
            />
            Live preview
          </label>
        </div>

        <div
          className="segmented lighting-mode"
          role="radiogroup"
          aria-label="Lighting"
          style={{ gridTemplateColumns: `repeat(${modes.length}, 1fr)` }}
        >
          {modes.map(([m, label]) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setLightingMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="option-text small mode-help">
          {mode
            ? modeHelp(mode)
            : "Default takes the keyboard's own lighting the first time it connects, so switching back from a game restores exactly what you had. Or choose one above to set it up now."}
        </p>

        {shown &&
          (mixOn ? (
            <MixStack
              lighting={shown}
              activeId={activeLayerId}
              disabled={!editable}
            />
          ) : (
            <LayerStack
              lighting={shown}
              activeId={active?.id ?? null}
              disabled={!editable}
            />
          ))}
      </div>

      {/* Middle: the details of what's selected. */}
      {active ? (
        <LayerDetails layer={active} />
      ) : mixOn && mix ? (
        <MixRegionDetails key={region ?? 0} mix={mix} region={region ?? 0} />
      ) : mixOn ? (
        <MixOwnRegions />
      ) : (
        <div
          className={`panel lighting-effects ${editable ? "" : "is-disabled"}`}
        >
          <h2 className="panel-title">Base effect</h2>
          <div
            className="effect-grid"
            role="radiogroup"
            aria-label="Base effect"
          >
            {RGB_EFFECTS.filter(([, id]) => white || id !== MIX_RGB).map(
              ([name, id]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={shown?.effect === id}
                  disabled={!editable}
                  title={
                    !white && KEYCHRON_ONLY.has(id)
                      ? "Keychron's own effect, set up in Keychron Launcher"
                      : undefined
                  }
                  onClick={() => change({ effect: id })}
                >
                  {id === 0 && layers.length ? "None (layers only)" : name}
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {/* Right: its colour. */}
      {active ? (
        <LayerColour layer={active} />
      ) : mixOn && mix ? (
        <MixEffectValues
          mix={mix}
          region={region ?? 0}
          brightness={
            region === null && shown ? (
              <Slider
                label="Brightness (whole keyboard)"
                value={shown.brightness}
                disabled={!editable}
                onChange={(brightness) => change({ brightness })}
              />
            ) : null
          }
          renderPicker={(value, onChange) => (
            <ColourPicker
              value={{ ...value, v: 255 }}
              noBrightness
              onChange={({ h, s }) => onChange(h, s)}
            />
          )}
        />
      ) : white ? (
        <WhiteValues
          lighting={shown}
          disabled={!editable}
          onChange={change}
          inherits={inherits}
        />
      ) : (
        <EffectColour
          lighting={shown}
          disabled={!editable}
          onChange={change}
          inherits={inherits}
        />
      )}
    </section>
  );
}

/** Colour layers, top first, each with hide, move up/down and delete. */
function ColourLayerRows({
  layers,
  activeId,
}: {
  layers: ColorLayer[];
  activeId: string | null;
}) {
  const { setActiveLayer, updateLayer, removeLayer, moveLayer } =
    useStore.getState();
  const top = [...layers].reverse();
  return (
    <>
      {top.map((l, i) => (
        <li
          key={l.id}
          className={`layer-row ${l.id === activeId ? "is-active" : ""} ${l.hidden ? "is-hidden" : ""}`}
        >
          <button
            className="layer-main"
            onClick={() => setActiveLayer(l.id === activeId ? null : l.id)}
          >
            <span
              className={`swatch small ${l.anim && l.anim !== "static" ? `anim-${l.anim}` : ""}`}
              style={{ background: hsvToCss(l.color) }}
            />
            <span className="layer-name">{l.name}</span>
            <span className="layer-count">
              {l.keys.length} key{l.keys.length === 1 ? "" : "s"}
            </span>
          </button>
          <button
            className="icon-btn small"
            title={l.hidden ? "Show this layer" : "Hide this layer"}
            aria-label={l.hidden ? `Show ${l.name}` : `Hide ${l.name}`}
            aria-pressed={!l.hidden}
            onClick={() => updateLayer(l.id, { hidden: !l.hidden })}
          >
            <EyeIcon off={!!l.hidden} />
          </button>
          <button
            className="icon-btn small"
            title="Move up (drawn over the layers below)"
            aria-label={`Move ${l.name} up`}
            disabled={i === 0}
            onClick={() => moveLayer(l.id, 1)}
          >
            ↑
          </button>
          <button
            className="icon-btn small"
            title="Move down"
            aria-label={`Move ${l.name} down`}
            disabled={i === top.length - 1}
            onClick={() => moveLayer(l.id, -1)}
          >
            ↓
          </button>
          <button
            className="icon-btn small danger"
            title="Delete layer"
            aria-label={`Delete ${l.name}`}
            onClick={() => removeLayer(l.id)}
          >
            <CrossIcon />
          </button>
        </li>
      ))}
    </>
  );
}

/** "Effect + layers": colour layers, top first, then the base effect (drawn under everything). */
function LayerStack({
  lighting,
  activeId,
  disabled,
}: {
  lighting: Lighting;
  activeId: string | null;
  disabled: boolean;
}) {
  const picked = useStore((s) => s.picked);
  const { setActiveLayer, addLayer } = useStore.getState();
  const layers = lighting.layers ?? [];
  const fromPicked = !activeId && picked.length > 0;

  return (
    <>
      <ol
        className={`layer-stack ${disabled ? "is-disabled" : ""}`}
        aria-label="Lighting layers, top first"
      >
        <ColourLayerRows layers={layers} activeId={activeId} />
        <li className={`layer-row is-base ${activeId ? "" : "is-active"}`}>
          <button className="layer-main" onClick={() => setActiveLayer(null)}>
            <span
              className="swatch small effect-swatch"
              style={
                lighting.effect !== 0
                  ? {
                      background:
                        BOARD.lighting === "white"
                          ? hsvToCss({ h: 0, s: 0, v: lighting.brightness })
                          : effectCss(lighting),
                    }
                  : undefined
              }
            />
            <span className="layer-name">Base</span>
            <span className="layer-count">
              {lighting.effect === 0 && layers.length
                ? "None (layers only)"
                : effectName(lighting.effect)}
            </span>
          </button>
        </li>
      </ol>

      <div className="option-actions">
        <button
          className="btn btn-ghost"
          disabled={disabled}
          onClick={() => addLayer()}
        >
          {fromPicked
            ? `+ Add layer from ${picked.length} selected key${picked.length === 1 ? "" : "s"}`
            : "+ Add layer"}
        </button>
      </div>
      <p className="option-text small">
        {layers.length
          ? "Where layers overlap, the higher one wins. Select a layer, then click keys to add or remove them."
          : BOARD.lighting === "white"
            ? "Add a layer to give keys a brightness of their own over the base effect (or turn them off), still or animated. Stack several to fine-tune."
            : "Add a layer to paint keys a colour of their own over the base effect, still or animated. Stack several to fine-tune."}
      </p>
    </>
  );
}

/**
 * "Mix RGB": colour layers on top (the module paints them over any effect), then Keychron's Mix
 * RGB layers (regions 2…, each playing its own effects), then the base (region 1: every key in no
 * other region).
 */
function MixStack({
  lighting,
  activeId,
  disabled,
}: {
  lighting: Lighting;
  activeId: string | null;
  disabled: boolean;
}) {
  const picked = useStore((s) => s.picked);
  const limit = useStore(mixRegionLimit);
  const { setActiveLayer, addLayer, addRegion, removeRegion, setMix } =
    useStore.getState();
  const mix = lighting.mix;
  const layers = lighting.layers ?? [];
  const region = mixRegionOf(activeId);
  const full = !mix || mix.regions.length >= limit;
  const fromPicked = !activeId && picked.length > 0;
  const rows = mix
    ? mix.regions
        .map((r, i) => [r, i] as const)
        .slice(1)
        .reverse()
    : [];

  return (
    <>
      <ol
        className={`layer-stack ${disabled ? "is-disabled" : ""}`}
        aria-label="Lighting layers, top first"
      >
        <ColourLayerRows layers={layers} activeId={activeId} />
        {layers.length > 0 && (
          <li className="layer-divider" aria-hidden>
            Mix RGB
          </li>
        )}
        {mix ? (
          <>
            {rows.map(([r, i]) => {
              const id = `mix:${i}`;
              const n = regionKeyCount(mix, i);
              return (
                <li
                  key={id}
                  className={`layer-row is-mix ${region === i ? "is-active" : ""}`}
                >
                  <button
                    className="layer-main"
                    onClick={() => setActiveLayer(region === i ? null : id)}
                  >
                    <span
                      className="swatch small"
                      style={{ background: mixSwatch(r.effects[0]) }}
                    />
                    <span className="layer-name">{regionName(i)}</span>
                    <span className="layer-count">
                      {n} key{n === 1 ? "" : "s"} · {r.effects.length} effect
                      {r.effects.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  <button
                    className="icon-btn small danger"
                    title="Delete (its keys go back to the base)"
                    aria-label={`Delete ${regionName(i)}`}
                    onClick={() => removeRegion(i)}
                  >
                    <CrossIcon />
                  </button>
                </li>
              );
            })}
            <li
              className={`layer-row is-base ${activeId === null ? "is-active" : ""}`}
            >
              <button
                className="layer-main"
                onClick={() => setActiveLayer(null)}
              >
                <span
                  className="swatch small"
                  style={{ background: mixSwatch(mix.regions[0]?.effects[0]) }}
                />
                <span className="layer-name">Base</span>
                <span className="layer-count">
                  {regionKeyCount(mix, 0)} keys ·{" "}
                  {mix.regions[0]?.effects.length ?? 0} effect
                  {mix.regions[0]?.effects.length === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          </>
        ) : (
          <li className="layer-row is-region is-note">
            <span className="layer-name">
              Mix RGB layers saved in the keyboard (Keychron Launcher)
            </span>
            <button
              className="link-btn"
              disabled={disabled}
              onClick={() => setMix(structuredClone(DEFAULT_MIX))}
            >
              Set them here
            </button>
          </li>
        )}
      </ol>

      <div className="option-actions">
        <button
          className="btn btn-ghost"
          disabled={disabled}
          title="A colour, still or animated, on some keys, drawn over everything"
          onClick={() => addLayer()}
        >
          + Colour layer
        </button>
        <button
          className="btn btn-ghost"
          disabled={disabled || full}
          title={
            !mix
              ? "Set the Mix RGB layers here first"
              : full
                ? `The keyboard has ${limit} Mix RGB regions: the base and ${limit - 1} more`
                : "Keys playing effects of their own, like the base"
          }
          onClick={() => addRegion()}
        >
          + Mix RGB layer
        </button>
      </div>
      <p className="option-text small">
        {fromPicked &&
          `New layers take the ${picked.length} selected key${picked.length === 1 ? "" : "s"}. `}
        Colour layers are drawn over the Mix RGB layers, as many as you like.
        Every key plays one Mix RGB layer: the base, or one above it ({limit} in
        all on this keyboard). Select a layer, then click keys to add them.
      </p>
    </>
  );
}

/** Mix RGB with the regions saved in the keyboard. */
function MixOwnRegions() {
  return (
    <div className="panel layer-details">
      <h2 className="panel-title">Mix RGB</h2>
      <p className="option-text">
        The keyboard plays the regions saved in it with Keychron Launcher. "Set
        them here" in the stack to change them per profile.
      </p>
    </div>
  );
}

function LayerDetails({ layer }: { layer: ColorLayer }) {
  const { updateLayer, removeLayer, setPicked } = useStore.getState();
  const anim = layer.anim ?? "static";
  const white = BOARD.lighting === "white";
  return (
    <div className="panel layer-details">
      <h2 className="panel-title">Layer</h2>
      <label className="field">
        <span>Name</span>
        <input
          value={layer.name}
          maxLength={40}
          onChange={(e) => updateLayer(layer.id, { name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Animation</span>
        <select
          value={anim}
          onChange={(e) => {
            const next = e.target.value as Anim;
            updateLayer(
              layer.id,
              next === "static"
                ? { anim: undefined, speed: undefined }
                : { anim: next, speed: layer.speed ?? 128 },
            );
          }}
        >
          {(white ? WHITE_ANIMS : ANIMS).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {anim !== "static" && (
        <Slider
          label="Animation speed"
          value={layer.speed ?? 128}
          onChange={(speed) => updateLayer(layer.id, { speed })}
        />
      )}
      {anim === "reactive" && (
        <p className="option-text small">
          Dark until pressed, then fades out. Pair it with the base effect
          "None" for keys that only light up as you type.
        </p>
      )}
      <p className="option-text">
        <strong>
          {layer.keys.length} key{layer.keys.length === 1 ? "" : "s"}
        </strong>{" "}
        in this layer. On the board, click a key to add or remove it, drag a box
        to add keys (Alt+drag to take them out). Esc when done.
      </p>
      <div className="option-actions">
        <button
          className="btn btn-ghost"
          onClick={() => setPicked(allIds("lighting"))}
        >
          All keys
        </button>
        <button
          className="btn btn-ghost"
          disabled={!layer.keys.length}
          onClick={() => setPicked([])}
        >
          No keys
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => updateLayer(layer.id, { hidden: !layer.hidden })}
        >
          {layer.hidden ? "Show" : "Hide"}
        </button>
        <button
          className="btn btn-ghost danger"
          onClick={() => removeLayer(layer.id)}
        >
          Delete layer
        </button>
      </div>
    </div>
  );
}

function LayerColour({ layer }: { layer: ColorLayer }) {
  const firmware = useStore((s) => s.engine.firmware);
  const updateLayer = useStore((s) => s.updateLayer);
  if (BOARD.lighting === "white") return <LayerBrightness layer={layer} />;
  return (
    <div className="panel key-colours">
      <h2 className="panel-title">
        Colour <span className="muted">· {layer.name}</span>
      </h2>
      <ColourPicker
        value={layer.color}
        onChange={(color) => updateLayer(layer.id, { color })}
      />
      {firmware === "missing" && (
        <p className="warn">
          Colour layers need the profile switcher firmware on the keyboard.
        </p>
      )}
    </div>
  );
}

/** A white backlight's layer: how bright its keys are. */
function LayerBrightness({ layer }: { layer: ColorLayer }) {
  const engine = useStore((s) => s.engine);
  const updateLayer = useStore((s) => s.updateLayer);
  // A name the app gave ("Brightness 50%") follows the brightness; one the user typed stays.
  const autoName = /^Brightness (\d+%|Off)( \d+)?$/.test(layer.name);
  const set = (v: number) =>
    updateLayer(layer.id, {
      color: { h: 0, s: 0, v },
      ...(autoName ? { name: `Brightness ${brightnessLabel(v)}` } : {}),
    });
  const old = engine.connected && engine.firmware !== "ok";
  return (
    <div className="panel key-colours">
      <h2 className="panel-title">
        Brightness <span className="muted">· {layer.name}</span>
      </h2>
      <div className="level-row" role="group" aria-label="Brightness">
        {WHITE_LEVELS.map(([name, hsv]) => (
          <button
            key={name}
            className="btn btn-ghost small"
            aria-pressed={layer.color.v === hsv.v}
            onClick={() => set(hsv.v)}
          >
            {name}
          </button>
        ))}
      </div>
      <Slider label="Brightness" value={layer.color.v} onChange={set} />
      <p className="option-text small">
        Scaled by the base brightness, like the effect. "Off" keeps these keys
        dark.
      </p>
      {old && (
        <p className="warn">
          Brightness layers need a newer profile switcher firmware on the
          keyboard. Until then the keyboard shows the base effect only.
        </p>
      )}
    </div>
  );
}

/** A white backlight's base: effect brightness and speed (there's no colour). */
function WhiteValues(props: {
  lighting: Lighting | null;
  disabled: boolean;
  inherits: boolean;
  onChange(patch: Partial<Lighting>): void;
}) {
  const { lighting: l, disabled, inherits, onChange } = props;
  const hasLayers = !!l?.layers?.length;
  return (
    <div className={`panel lighting-values ${disabled ? "is-disabled" : ""}`}>
      <h2 className="panel-title">
        Brightness and motion <span className="muted">· Base</span>
      </h2>
      {l && (
        <>
          <Slider
            label="Brightness"
            value={l.brightness}
            disabled={disabled || (l.effect === 0 && !hasLayers)}
            onChange={(brightness) => onChange({ brightness })}
          />
          <Slider
            label="Speed"
            value={l.speed}
            disabled={disabled || !whiteUsesSpeed(l.effect)}
            onChange={(speed) => onChange({ speed })}
          />
          <p className="option-text">
            {l.effect === 0
              ? hasLayers
                ? "No base effect: only the layers light up."
                : "The backlight is off."
              : "A white backlight: the effect sets how bright each key is."}
          </p>
          {inherits && (
            <p className="option-text">
              Choose "Effect + layers" above to change these for this profile.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function EffectColour(props: {
  lighting: Lighting | null;
  disabled: boolean;
  inherits: boolean;
  onChange(patch: Partial<Lighting>): void;
}) {
  const { lighting: l, disabled, inherits, onChange } = props;
  const hasLayers = !!l?.layers?.length;
  return (
    <div className={`panel lighting-values ${disabled ? "is-disabled" : ""}`}>
      <h2 className="panel-title">
        Colour and motion <span className="muted">· Base</span>
      </h2>
      {l && (
        <>
          <Slider
            label="Brightness"
            value={l.brightness}
            disabled={disabled || (l.effect === 0 && !hasLayers)}
            onChange={(brightness) => onChange({ brightness })}
          />
          <Slider
            label="Speed"
            value={l.speed}
            disabled={disabled || !usesSpeed(l.effect)}
            onChange={(speed) => onChange({ speed })}
          />
          {usesColor(l.effect) ? (
            <ColourPicker
              value={{ h: l.hue, s: l.sat, v: l.brightness }}
              disabled={disabled}
              onChange={({ h, s, v }) =>
                onChange({ hue: h, sat: s, brightness: v })
              }
            />
          ) : (
            <p className="option-text">
              {l.effect === 0
                ? "No base effect: only the layers light up."
                : "This effect picks its own colours."}
            </p>
          )}
          {inherits && (
            <p className="option-text">
              Choose "Effect + layers" above to change these for this profile.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {off && (
        <path
          d="M2.5 13.5l11-11"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  disabled?: boolean;
  className?: string;
  onChange(v: number): void;
}) {
  return (
    <label className={`slider ${props.className ?? ""}`}>
      <span className="slider-label">
        {props.label}
        <span className="slider-value">
          {Math.round((props.value / 255) * 100)}%
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={255}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}
