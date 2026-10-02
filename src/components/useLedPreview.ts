import { useEffect, useMemo, useRef, type RefObject } from "react";
import { BOARD, LEDS } from "../lib/layout";
import { RgbSimulator } from "../lib/rgb/simulator";
import type { KeyId, Lighting } from "../lib/types";
import { valueOf } from "../qmk/keycodes";
import { DOM_CODE_TO_QMK } from "../qmk/labels";
import { isEditable } from "../lib/appFeel";
import { useStructuralKey } from "../lib/structuralKey";

/** Redraws per second on screen (the simulation itself steps at the keyboard's ~60 fps). */
const DRAW_MS = 33;

/**
 * Plays a profile's lighting on the drawn keyboard: an `RgbSimulator` stepped in time, its LED
 * colours written straight into each key's `--led` (no React render per frame), and the board's
 * `--glow` from their average. Keys pressed while the app is in front feed the reactive effects.
 * `playing` false freezes the current frame.
 */
export function useLedPreview(opts: {
  board: RefObject<HTMLElement>;
  lighting: Lighting | null;
  on: boolean;
  playing: boolean;
  /** The key that types a keycode, for keypresses. */
  keyOfKc(kc: number): KeyId | undefined;
}) {
  const { board, lighting, on, playing, keyOfKc } = opts;
  // The board shown (the main area remounts when it changes).
  const sim = useMemo(
    () => new RgbSimulator(LEDS, { center: BOARD.center, ...BOARD.matrix, white: BOARD.lighting === "white" ? { effects: BOARD.effects } : undefined }),
    [],
  );
  const keyOf = useRef(keyOfKc);
  keyOf.current = keyOfKc;

  const lightingKey = useStructuralKey(lighting);
  // `lighting` deliberately isn't a dependency: it is a fresh object on every render, and what
  // matters is whether its contents changed (`lightingKey`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lightingKey` stands for `lighting`, see above
  useEffect(() => {
    sim.setLighting(lighting);
  }, [sim, lightingKey]);

  useEffect(() => {
    const el = board.current;
    if (!el || !on) return;
    const slots = LEDS.map((l) => el.querySelector<HTMLElement>(`[data-key="${l.key}"]`)?.parentElement ?? null);
    const shown: string[] = [];
    let raf = 0;
    let last = -Infinity;

    const paint = (now: number) => {
      const rgb = sim.frame(now);
      slots.forEach((slot, i) => {
        if (!slot) return;
        const css = ledCss(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        if (shown[i] !== css) {
          shown[i] = css;
          slot.style.setProperty("--led", css);
        }
      });
      const [r, g, b] = sim.average(rgb);
      el.style.setProperty("--glow", ledCss(r, g, b));
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < DRAW_MS || document.hidden) return;
      last = now;
      paint(now);
    };
    if (playing) raf = requestAnimationFrame(loop);
    else paint(performance.now());

    const onKey = (e: KeyboardEvent) => {
      // Typing a layer name or a macro shouldn't drive the keyboard's reactive effects.
      if (e.repeat || isEditable(e.target)) return;
      const name = DOM_CODE_TO_QMK[e.code];
      const kc = name ? valueOf(name) : undefined;
      const key = kc === undefined ? undefined : keyOf.current(kc);
      if (key) sim.press(key);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    };
    // Paused, an edit repaints the frozen frame; playing, the loop picks it up anyway.
  }, [sim, board, on, playing, playing ? -1 : lightingKey]);

  // Off (another tab): the keys go back to plain caps.
  useEffect(() => {
    const el = board.current;
    if (on || !el) return;
    el.querySelectorAll<HTMLElement>(".cap-slot").forEach((slot) => slot.style.removeProperty("--led"));
    el.style.removeProperty("--glow");
  }, [board, on]);
}

/**
 * An LED as a light: its hue at full strength, and its brightness as opacity (a dark LED shows
 * nothing, rather than a black key).
 */
function ledCss(r: number, g: number, b: number): string {
  const m = Math.max(r, g, b);
  if (m < 3) return "transparent";
  const k = 255 / m;
  return `rgb(${Math.round(r * k)} ${Math.round(g * k)} ${Math.round(b * k)} / ${(m / 255).toFixed(2)})`;
}
