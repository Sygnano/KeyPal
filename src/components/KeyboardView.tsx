import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { isEditable } from "../lib/appFeel";
import { allIds, type BoardMode } from "../lib/board";
import { bindId, resolveKey } from "../lib/keyIds";
import { MIX_RGB } from "../lib/layers";
import {
  BOARD,
  BOARD_HEIGHT_U,
  BOARD_WIDTH_U,
  encoderIds,
  KEYS,
  isoShape,
  type KeyGeom,
} from "../lib/layout";
import { bindLabel, isDisabled } from "../lib/profiles";
import { REACTIVE_EFFECTS } from "../lib/rgb/effects";
import { REACTIVE_LED_EFFECTS } from "../lib/rgb/ledEffects";
import type { Bind, KeyId, Lighting } from "../lib/types";
import { keycodeLabel, legendFor } from "../qmk/labels";
import { useSelectedProfile, useStore } from "../state/store";
import { BoardContextMenu } from "./BoardContextMenu";
import { KeyMenu } from "./KeyMenu";
import { KeyTester } from "./KeyTester";
import { CrossIcon } from "./ProfileList";
import { useLedPreview } from "./useLedPreview";

const GAP = 0.08; // space between caps, in units
const TOP_PAD = 0.75; // room above the F-row for the knob rotation targets
const DRAG_START_PX = 4; // a press that moves further than this draws a selection box

interface Drag {
  x: number;
  y: number;
  keyId: KeyId | null;
  additive: boolean;
  /** Alt+drag while painting a layer: the box takes keys out. */
  subtract: boolean;
  before: KeyId[];
  active: boolean;
  /** Key rectangles relative to the board, measured when the drag starts. */
  rects: Array<[KeyId, DOMRect]>;
}

/** The on-screen lighting plays unless paused (remembered on this PC; still by default with reduced motion). */
const PREVIEW_KEY = "v6ps-led-preview";
function initialPlaying(): boolean {
  try {
    const saved = localStorage.getItem(PREVIEW_KEY);
    if (saved) return saved === "on";
  } catch {
    // Storage blocked: the default below.
  }
  return !(
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Whether a lighting reacts to keypresses anywhere (base effect, a Mix RGB region, a layer). */
function reactsToKeys(l: Lighting | null): boolean {
  if (!l) return false;
  if (BOARD.lighting === "white") {
    const name = BOARD.effects.find(([, id]) => id === l.effect)?.[0];
    if (name && REACTIVE_LED_EFFECTS.has(name)) return true;
  } else if (REACTIVE_EFFECTS.has(l.effect)) return true;
  if (
    l.effect === MIX_RGB &&
    l.mix?.regions.some((r) =>
      r.effects.some((e) => REACTIVE_EFFECTS.has(e.effect)),
    )
  )
    return true;
  return !!l.layers?.some(
    (layer) => !layer.hidden && layer.anim === "reactive",
  );
}

export function KeyboardView({ mode }: { mode: BoardMode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [unit, setUnit] = useState(48);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [menuTargets, setMenuTargets] = useState<KeyId[]>([]);
  const [playing, setPlaying] = useState(initialPlaying);
  // "Test keyboard": base legends, no tapes, and the board can't be edited.
  const testing = useStore((s) => s.testing);
  const profile = useSelectedProfile();
  const defaultLighting = useStore((s) => s.draft.profiles[0].lighting);
  const base = useStore((s) => s.base);
  const menuKeyId = useStore((s) => s.menuKeyId);
  const menuTab = useStore((s) => s.menuTab);
  const selectedKeyId = useStore((s) => s.selectedKeyId);
  const picked = useStore((s) => s.picked);
  // Remaps are edited on the layer picked in the tabs; lighting shows the default layer's legends.
  const layer = useStore((s) =>
    mode === "keys" && !s.testing ? s.keyLayer : s.base.layer,
  );
  const bid = (id: KeyId) => bindId(id, layer);
  /** What the key does on the layer shown: its own keycode, or (transparent) the layer below's,
   * possibly a remap of this profile there. */
  const keyOn = (id: KeyId) => {
    const r = resolveKey(base, layer, id, profile.binds);
    return {
      kc: r.kc,
      below: r.from !== layer,
      inherited: r.bind,
      from: r.from,
    };
  };
  // Painting a colour layer: clicks toggle keys, boxes add (Alt: remove), nothing clears it by accident.
  const painting = useStore(
    (s) => mode === "lighting" && s.activeLayerId !== null,
  );
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const {
    openMenu,
    removeBind,
    setPicked,
    togglePicked,
    removeBinds,
    setKeyColors,
  } = useStore.getState();

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const u = Math.floor(entry.contentRect.width / BOARD_WIDTH_U);
      setUnit(Math.max(30, Math.min(64, u)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl+A selects every key, Esc clears, Delete resets the picked keys (remaps or colours).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        useStore.getState().testing ||
        isEditable(e.target) ||
        document.querySelector(".key-menu, .ctx")
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setPicked(allIds(mode));
      } else if (e.key === "Escape") {
        // While painting a layer, Esc leaves the layer (its keys stay) rather than emptying it.
        if (mode === "lighting" && useStore.getState().activeLayerId)
          useStore.getState().setActiveLayer(null);
        else setPicked([]);
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        useStore.getState().picked.length
      ) {
        const ids = useStore.getState().picked;
        if (mode === "keys")
          removeBinds(
            ids.map((id) => bindId(id, useStore.getState().keyLayer)),
          );
        else if (useStore.getState().activeLayerId)
          setPicked([]); // out of the layer being edited
        else setKeyColors(ids, null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, setPicked, removeBinds, setKeyColors]);

  const lighting: Lighting | null = profile.lighting ?? defaultLighting;
  // The lighting preview (not on boards without a backlight).
  const lit = mode === "lighting" && BOARD.lighting !== "none";
  const knobs = KEYS.filter((k) => k.encoder !== undefined);

  // The lighting, played on the drawn keyboard. Keypresses find their key by the keycode it types
  // on the default layer (the layer shown here).
  const kcToKey = useMemo(() => {
    const m = new Map<number, KeyId>();
    for (const k of KEYS) {
      const kc = resolveKey(base, base.layer, k.id, {}).kc;
      if (!m.has(kc)) m.set(kc, k.id);
    }
    return m;
  }, [base]);
  useLedPreview({
    board: boardRef,
    lighting,
    on: lit,
    playing,
    keyOfKc: (kc) => kcToKey.get(kc),
  });
  const togglePlaying = () => {
    setPlaying(!playing);
    try {
      localStorage.setItem(PREVIEW_KEY, playing ? "off" : "on");
    } catch {
      // Not remembered: fine.
    }
  };

  const style = {
    "--u": `${unit}px`,
    width: BOARD_WIDTH_U * unit,
    height: (BOARD_HEIGHT_U + TOP_PAD) * unit,
  } as CSSProperties;

  // ------------------------------------------------------------------ pointer: click and box select

  const boardPoint = (e: PointerEvent) => {
    const r = boardRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // The whole stage (inside its frame) is where a box can start, not only the keyboard.
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || testing) return;
    const target = e.target as HTMLElement;
    if (target.closest(".key-menu, .tape-x, .stage-tools")) return;
    const board = boardRef.current!;
    const origin = board.getBoundingClientRect();
    const rects: Array<[KeyId, DOMRect]> = [
      ...board.querySelectorAll<HTMLElement>("[data-key]"),
    ].map((el) => {
      const r = el.getBoundingClientRect();
      return [
        el.dataset.key!,
        new DOMRect(
          r.left - origin.left,
          r.top - origin.top,
          r.width,
          r.height,
        ),
      ];
    });
    const additive = painting || e.ctrlKey || e.shiftKey || e.metaKey;
    drag.current = {
      ...boardPoint(e),
      keyId: target.closest<HTMLElement>("[data-key]")?.dataset.key ?? null,
      additive,
      subtract: painting && e.altKey,
      before: additive ? useStore.getState().picked : [],
      active: false,
      rects,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = boardPoint(e);
    if (!d.active) {
      if (Math.hypot(p.x - d.x, p.y - d.y) < DRAG_START_PX) return;
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      openMenu(null);
    }
    const left = Math.min(d.x, p.x);
    const top = Math.min(d.y, p.y);
    const width = Math.abs(p.x - d.x);
    const height = Math.abs(p.y - d.y);
    setBox({ left, top, width, height });
    const hits = d.rects
      .filter(
        ([, r]) =>
          r.left < left + width &&
          r.right > left &&
          r.top < top + height &&
          r.bottom > top,
      )
      .map(([id]) => id);
    setPicked(
      d.subtract
        ? d.before.filter((id) => !hits.includes(id))
        : [...d.before, ...hits],
    );
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.active) {
      setBox(null);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      return;
    }
    // A plain click.
    if (!d.keyId) {
      if (!painting) setPicked([]);
      openMenu(null);
    } else if (d.additive) {
      togglePicked(d.keyId);
    } else {
      setPicked([d.keyId]);
      if (mode === "keys")
        openMenu(menuKeyId === bid(d.keyId) ? null : bid(d.keyId));
    }
  };

  // Right-click acts on the picked keys when the key under the pointer is one of them, else on that key.
  const onContextMenu = (e: React.MouseEvent) => {
    if (testing) return;
    const keyId =
      (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset
        .key ?? null;
    const current = useStore.getState().picked;
    let targets = current;
    if (keyId && !current.includes(keyId)) {
      targets = [keyId];
      if (!painting) setPicked(targets);
    }
    setMenuTargets(targets);
    openMenu(null);
  };

  const keyboardActivate = (id: KeyId) => {
    // Enter/Space on a focused key (mouse clicks are handled on pointer up).
    if (testing) return;
    if (painting) return togglePicked(id);
    setPicked([id]);
    if (mode === "keys") openMenu(menuKeyId === bid(id) ? null : bid(id));
  };

  return (
    <section
      className={`stage ${mode === "lighting" ? "is-lighting" : ""} ${mode === "keys" && layer !== base.layer ? "is-other-layer" : ""} ${box ? "is-boxing" : ""} ${testing ? "is-testing" : ""}`}
      aria-label="Keyboard"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setBox(null);
      }}
    >
      {lit && (
        <div className="stage-tools">
          {!testing && playing && reactsToKeys(lighting) && (
            <span className="muted">Type to see it react</span>
          )}
          <button
            className="icon-btn"
            aria-pressed={!playing}
            title={
              playing
                ? "Pause the lighting on screen"
                : "Play the lighting on screen"
            }
            aria-label={
              playing
                ? "Pause the lighting preview"
                : "Play the lighting preview"
            }
            onClick={togglePlaying}
          >
            {playing ? <PauseIcon /> : <PlayGlyph />}
          </button>
        </div>
      )}
      <div className="stage-inner" ref={wrapRef}>
        <BoardContextMenu
          mode={mode}
          layer={layer}
          targets={menuTargets}
          disabled={testing}
        >
          <div
            ref={boardRef}
            className={`board ${lit ? "is-lit" : ""} ${lit && BOARD.lighting === "white" ? "is-white" : ""}`}
            style={style}
            onContextMenu={onContextMenu}
          >
            {mode === "keys" &&
              knobs.map((knob) => {
                const ids = encoderIds(knob.encoder!);
                // Its two turns, just above the knob.
                return (
                  <div
                    key={knob.id}
                    className="knob-turns"
                    style={{
                      left: knob.x * unit - unit * 0.3,
                      top: knob.y * unit,
                      width: (knob.w + 0.6) * unit,
                    }}
                  >
                    {(["ccw", "cw"] as const).map((dir) => (
                      <KnobTurn
                        key={dir}
                        dir={dir}
                        id={ids[dir]}
                        bind={
                          testing ? undefined : profile.binds[bid(ids[dir])]
                        }
                        baseKc={keyOn(ids[dir]).kc}
                        selected={
                          !testing &&
                          (selectedKeyId === bid(ids[dir]) ||
                            pickedSet.has(ids[dir]))
                        }
                        onActivate={() => keyboardActivate(ids[dir])}
                      />
                    ))}
                  </div>
                );
              })}

            {KEYS.map((k) => {
              const on = keyOn(k.id);
              return (
                <Keycap
                  key={k.id}
                  geom={k}
                  unit={unit}
                  baseKc={on.kc}
                  fromBelow={on.below}
                  inherited={testing ? undefined : on.inherited}
                  inheritedFrom={on.from}
                  bind={testing ? undefined : profile.binds[bid(k.id)]}
                  showBinds={mode === "keys" && !testing}
                  picked={!testing && pickedSet.has(k.id)}
                  selected={
                    !testing && mode === "keys" && selectedKeyId === bid(k.id)
                  }
                  menuOpen={
                    !testing && mode === "keys" && menuKeyId === bid(k.id)
                  }
                  onActivate={() => keyboardActivate(k.id)}
                  onRemove={() => removeBind(bid(k.id))}
                />
              );
            })}

            {box && <div className="marquee" style={box} />}
            {mode === "keys" && menuKeyId && !testing && (
              <KeyMenu
                key={`${menuKeyId}:${menuTab ?? ""}`}
                keyId={menuKeyId}
                unit={unit}
                topPad={TOP_PAD}
              />
            )}
          </div>
        </BoardContextMenu>
      </div>
      {testing && <KeyTester board={boardRef} />}
    </section>
  );
}

interface KeycapProps {
  geom: KeyGeom;
  unit: number;
  baseKc: number;
  /** Transparent on this layer: the legend is the layer below's key. */
  fromBelow?: boolean;
  /** …and there this profile remaps it (shown dimmed, edited on that layer). */
  inherited?: Bind;
  inheritedFrom?: number;
  bind?: Bind;
  showBinds: boolean;
  picked: boolean;
  selected: boolean;
  menuOpen: boolean;
  onActivate(): void;
  onRemove(): void;
}

/**
 * A board has up to ~110 keys and every keystroke re-renders the view, so a cap that hasn't
 * changed shouldn't be redrawn. `onActivate` and `onRemove` are deliberately left out of the
 * comparison: they are fresh closures on every render but each one only captures its own key's
 * id, which never changes for a given cap (it is the React key).
 */
const Keycap = memo(KeycapView, (a, b) => {
  const same = (k: keyof KeycapProps) => a[k] === b[k];
  return (
    [
      "geom",
      "unit",
      "baseKc",
      "fromBelow",
      "inherited",
      "inheritedFrom",
      "bind",
      "showBinds",
      "picked",
      "selected",
      "menuOpen",
    ] as const
  ).every(same);
});

function KeycapView(props: KeycapProps) {
  const {
    geom: k,
    unit,
    baseKc,
    fromBelow,
    inherited,
    inheritedFrom,
    bind,
    showBinds,
    picked,
    selected,
    menuOpen,
    onActivate,
    onRemove,
  } = props;
  const iso = isoShape(k);
  const left = (k.x + (iso?.left ?? 0) + GAP / 2) * unit;
  const width = ((iso?.width ?? k.w) - GAP) * unit;
  const top = (k.y + TOP_PAD + GAP / 2) * unit;
  const height = (k.h - GAP) * unit;
  const legend = legendFor(baseKc);
  const isKnob = k.encoder !== undefined;
  const tone = capTone(k, baseKc);
  const shownBind = showBinds ? bind : undefined;

  const clip = iso
    ? `polygon(${iso.points
        .map(([x, y]) => `${(x / iso.width) * 100}% ${(y / k.h) * 100}%`)
        .join(", ")})`
    : undefined;

  const classes = [
    "cap",
    `tone-${tone}`,
    isKnob ? "is-knob" : "",
    iso ? "is-iso" : "",
    shownBind ? "is-bound" : "",
    isDisabled(shownBind) ? "is-off" : "",
    fromBelow ? "is-below" : "",
    picked ? "is-picked" : "",
    selected ? "is-selected" : "",
    menuOpen ? "is-menu" : "",
  ].join(" ");

  // Rotated keys (Alice layouts) turn around their rotation point, given in board units.
  const rotation = k.r
    ? {
        transform: `rotate(${k.r}deg)`,
        transformOrigin: `${((k.rx ?? 0) - k.x - (iso?.left ?? 0) - GAP / 2) * unit}px ${((k.ry ?? 0) - k.y - GAP / 2) * unit}px`,
      }
    : {};
  const slotStyle = { left, top, width, height, ...rotation } as CSSProperties;

  return (
    <div className="cap-slot" style={slotStyle}>
      <button
        type="button"
        className={classes}
        style={{ clipPath: clip }}
        data-key={k.id}
        aria-pressed={picked}
        aria-label={`${keycodeLabel(baseKc)}${shownBind ? `, remapped to ${bindLabel(shownBind)}` : ""}`}
        onClick={(e) => e.detail === 0 && onActivate()}
      >
        <span
          className="cap-top"
          style={
            iso
              ? { width: `${(k.w / iso.width) * 100}%`, right: 0, left: "auto" }
              : undefined
          }
        >
          {legend.shift ? (
            <>
              <span className="legend-shift">{legend.shift}</span>
              <span className="legend-base">{legend.base}</span>
            </>
          ) : (
            <span
              className={`legend-main ${legend.base.length > 2 ? "is-word" : ""}`}
            >
              {legend.base}
            </span>
          )}
          {legend.altgr && <span className="legend-altgr">{legend.altgr}</span>}
        </span>
      </button>

      {showBinds && !bind && inherited && (
        <div
          className={`tape is-inherited ${isDisabled(inherited) ? "is-off" : ""}`}
          style={{
            fontSize: Math.max(10, unit * 0.23),
            maxWidth: Math.max(width + unit * 0.3, unit * 1.2),
          }}
          title={`${bindLabel(inherited)}: remapped on layer ${inheritedFrom}, which this key falls through to`}
        >
          <span className="tape-label">
            {inherited.kind === "macro" && <span className="tape-kind">M</span>}
            {bindLabel(inherited)}
          </span>
        </div>
      )}
      {shownBind && (
        <div
          className={`tape ${isDisabled(shownBind) ? "is-off" : ""}`}
          style={{
            fontSize: Math.max(10, unit * 0.23),
            maxWidth: Math.max(width + unit * 0.3, unit * 1.2),
          }}
          title={bindLabel(shownBind)}
        >
          <button
            type="button"
            className="tape-label"
            data-key={k.id}
            onClick={(e) => e.detail === 0 && onActivate()}
          >
            {shownBind.kind === "macro" && <span className="tape-kind">M</span>}
            {bindLabel(shownBind)}
          </button>
          <button
            type="button"
            className="tape-x"
            aria-label="Remove this remap"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <CrossIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function KnobTurn(props: {
  dir: "ccw" | "cw";
  id: KeyId;
  bind?: Bind;
  baseKc?: number;
  selected: boolean;
  onActivate(): void;
}) {
  const { dir, id, bind, baseKc, selected, onActivate } = props;
  const what = bind
    ? bindLabel(bind)
    : baseKc !== undefined
      ? keycodeLabel(baseKc)
      : "";
  return (
    <button
      type="button"
      className={`knob-turn ${bind ? "is-bound" : ""} ${selected ? "is-selected" : ""}`}
      data-key={id}
      title={`Knob ${dir === "cw" ? "clockwise" : "counter-clockwise"}: ${what}`}
      onClick={(e) => e.detail === 0 && onActivate()}
    >
      <span aria-hidden>{dir === "cw" ? "↻" : "↺"}</span>
      <span className="knob-turn-label">{what}</span>
    </button>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M5 3.5v9M11 3.5v9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
    </svg>
  );
}

/** Keychron's colourway: grey alphas, darker mods, accent Esc/Enter/knob. Derived from the key's
 * keycode and shape, not from the V6 8K's key ids, so it holds for every board. */
function capTone(k: KeyGeom, kc: number): "alpha" | "mod" | "accent" {
  // The knob, Esc (0x29), Enter (0x28, ANSI or ISO — the ISO one has a second rectangle).
  if (
    k.encoder !== undefined ||
    kc === 0x29 ||
    kc === 0x28 ||
    k.w2 !== undefined
  )
    return "accent";
  const letterOrDigit =
    (kc >= 0x04 && kc <= 0x27) ||
    (kc >= 0x2d && kc <= 0x38) ||
    kc === 0x64 ||
    kc === 0x32;
  const numpadDigit = kc >= 0x59 && kc <= 0x63;
  // F1–F4 and F9–F12 are alpha; F5–F8 are mod (Keychron's colourway).
  const fKeyAlpha = (kc >= 0x3a && kc <= 0x3d) || (kc >= 0x42 && kc <= 0x45);
  if (letterOrDigit || numpadDigit || fKeyAlpha || kc === 0x2c) return "alpha";
  return "mod";
}
