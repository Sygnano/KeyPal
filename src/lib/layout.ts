import { setCustomKeycodes } from "../qmk/keycodes";
import { parseKeycode } from "../qmk/parse";
import type { BoardData, RawKey } from "./boards";
import type { BaseKeymap, KeyId } from "./types";

/**
 * The keyboard being shown: its keys, knobs, LEDs and effects. `setBoard` swaps it; these are live
 * bindings (`export let`), so importers always read the current board, and the app remounts its
 * main area when it changes (store `boardVersion`).
 */

export interface KeyGeom extends RawKey {
  id: KeyId;
}

/** A board with no keys: before the first keyboard is known. */
const EMPTY: BoardData = {
  id: "",
  name: "",
  vid: 0,
  pid: 0,
  matrix: { rows: 0, cols: 0 },
  encoders: 0,
  firmware: null,
  lighting: "none",
  effects: [],
  speedEffects: [],
  colorEffects: [],
  mix: false,
  customKeycodes: [],
  center: [112, 32],
  keys: [],
  leds: [],
  keymap: null,
};

export let BOARD: BoardData = EMPTY;
export let KEYS: KeyGeom[] = [];
export let KEY_BY_ID = new Map<KeyId, KeyGeom>();
export let BOARD_WIDTH_U = 0;
export let BOARD_HEIGHT_U = 0;
/** Knob numbers (0, 1…), from the layout. */
export let KNOBS: number[] = [];
export let RGB_EFFECTS: ReadonlyArray<readonly [string, number]> = [];
/** Which effects use the speed and the colour, from the board's VIA definition. */
export let SPEED_EFFECTS: ReadonlySet<number> = new Set();
export let COLOR_EFFECTS: ReadonlySet<number> = new Set();
/** The keyboard's LEDs (g_led_config): the key over each, and its position on QMK's 224 × 64 grid. */
export let LEDS: ReadonlyArray<{
  key: KeyId;
  x: number;
  y: number;
  flags?: number;
}> = [];

/** The ids of a knob's two turns. */
export const encoderIds = (knob: number) =>
  ({ ccw: `e${knob}:ccw`, cw: `e${knob}:cw` }) as const;
/** Knob 0's (most boards have one knob at most). */
export const ENCODER_IDS = encoderIds(0);

/** Makes `board` the one shown. */
/** `fallbackBaseKeymap`'s last answer; cleared by `setBoard`. */
let fallbackCache: BaseKeymap | null = null;

export function setBoard(board: BoardData) {
  // Rotated keys (Alice layouts) can reach left of or above 0: shift everything to start at 0, 0.
  const corners = board.keys.flatMap(keyCorners);
  const minX = Math.min(0, ...corners.map(([x]) => x));
  const minY = Math.min(0, ...corners.map(([, y]) => y));
  fallbackCache = null;
  BOARD = board;
  KEYS = board.keys.map((k) => ({
    ...k,
    x: k.x - minX,
    y: k.y - minY,
    ...(k.r ? { rx: (k.rx ?? 0) - minX, ry: (k.ry ?? 0) - minY } : {}),
    id: `${k.row},${k.col}`,
  }));
  KEY_BY_ID = new Map(KEYS.map((k) => [k.id, k]));
  const all = KEYS.flatMap(keyCorners);
  BOARD_WIDTH_U = all.length ? Math.max(...all.map(([x]) => x)) : 0;
  BOARD_HEIGHT_U = all.length ? Math.max(...all.map(([, y]) => y)) : 0;
  KNOBS = [
    ...new Set(
      KEYS.flatMap((k) => (k.encoder === undefined ? [] : [k.encoder])),
    ),
  ].sort((a, b) => a - b);
  RGB_EFFECTS = board.effects;
  SPEED_EFFECTS = new Set(board.speedEffects ?? []);
  COLOR_EFFECTS = new Set(board.colorEffects ?? []);
  LEDS = board.leds;
  setCustomKeycodes(board.customKeycodes ?? []);
}

/** A key's corners on the board, rotation applied. */
function keyCorners(k: RawKey): Array<[number, number]> {
  const pts: Array<[number, number]> = [
    [k.x, k.y],
    [k.x + k.w, k.y],
    [k.x, k.y + k.h],
    [k.x + k.w, k.y + k.h],
  ];
  if (k.w2 !== undefined)
    pts.push(
      [k.x + (k.x2 ?? 0), k.y + (k.y2 ?? 0)],
      [k.x + (k.x2 ?? 0) + k.w2, k.y + (k.y2 ?? 0) + (k.h2 ?? k.h)],
    );
  if (!k.r) return pts;
  const a = (k.r * Math.PI) / 180;
  const [cx, cy] = [k.rx ?? 0, k.ry ?? 0];
  return pts.map(([x, y]) => [
    cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  ]);
}

/** Keychron's stock keymap for the board shown, for when the keyboard hasn't told us its own. */
export function fallbackBaseKeymap(): BaseKeymap {
  // Parsing a whole stock keymap through `parseKeycode` on every `get_base_keymap` and every
  // `base-keymap` event is wasted work: it only changes when the board does.
  if (fallbackCache && fallbackCache.board === (BOARD.id || null))
    return fallbackCache;
  const km = BOARD.keymap;
  if (!km)
    return (fallbackCache = {
      source: "fallback",
      layer: 0,
      layers: [],
      board: BOARD.id || null,
    });
  const value = (name: string | undefined) => {
    if (!name) return 0;
    const r = parseKeycode(name);
    return r.ok ? r.value : 0;
  };
  const layers = km.layers.map((names, l) => {
    const keys: Record<KeyId, number> = {};
    BOARD.keys.forEach((k, i) => (keys[`${k.row},${k.col}`] = value(names[i])));
    (km.encoders[l] ?? []).forEach(([ccw, cw], knob) => {
      keys[encoderIds(knob).ccw] = value(ccw);
      keys[encoderIds(knob).cw] = value(cw);
    });
    return keys;
  });
  return (fallbackCache = {
    source: "fallback",
    layer: km.defaultLayer,
    layers,
    board: BOARD.id,
  });
}

/** A knob turn ("e0:cw"), not a key. */
export function isEncoderId(id: KeyId): boolean {
  return /^e\d+:/.test(id);
}

export interface IsoShape {
  /** Offset of the bounding box from the key's x, in units (negative for ISO Enter). */
  left: number;
  width: number;
  /** Polygon points in units, relative to the bounding box. */
  points: Array<[number, number]>;
}

/** Stepped outline for ISO Enter (a wide top rect over a taller body), otherwise null. */
export function isoShape(k: KeyGeom): IsoShape | null {
  if (k.w2 === undefined || k.x2 === undefined || k.h2 === undefined)
    return null;
  if (k.w2 === k.w && k.h2 === k.h && !k.x2 && !k.y2) return null;
  const left = Math.min(0, k.x2);
  const right = Math.max(k.w, k.x2 + k.w2);
  const pts: Array<[number, number]> = [
    [k.x2, 0],
    [right, 0],
    [right, k.h],
    [0, k.h],
    [0, k.h2],
    [k.x2, k.h2],
  ];
  return {
    left,
    width: right - left,
    points: pts.map(([x, y]) => [x - left, y]),
  };
}
