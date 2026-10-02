import { KEYS, KNOBS, encoderIds } from "./layout";
import type { KeyId } from "./types";

export type BoardMode = "keys" | "lighting";

/** Every pickable id in this mode: all keys, plus the knob turns when remapping. */
export function allIds(mode: BoardMode): KeyId[] {
  const ids = KEYS.map((k) => k.id);
  return mode === "keys" ? [...ids, ...KNOBS.flatMap((n) => [encoderIds(n).ccw, encoderIds(n).cw])] : ids;
}
