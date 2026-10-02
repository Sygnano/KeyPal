/**
 * The keyboard tester's plumbing, no React: where key events come from, and the sound it plays.
 */
import { api } from "./api";
import type { KeyId } from "./types";
import { valueOf } from "../qmk/keycodes";
import { DOM_CODE_TO_QMK } from "../qmk/labels";

/** A key went down or came up (a knob turn: down, then up at once). */
export type KeyHandler = (key: KeyId, down: boolean) => void;
/** Starts delivering key events to `onKey`; returns the function that stops it. */
export type KeySource = (onKey: KeyHandler) => () => void;

/** A knob turn ("e0:cw"), not a cap. */
export const isTurn = (id: KeyId) => /^e\d+:(cw|ccw)$/.test(id);

/**
 * Keys as Windows sees them: the keycode a key typed, found back on the drawn keyboard by
 * `keyOfKc` (the key typing it on the default layer). Fn, the knob and keys the keyboard handles
 * itself never reach the app, and a remapped key shows up as the key it types.
 */
export function windowKeySource(keyOfKc: (kc: number) => KeyId | undefined): KeySource {
  return (onKey) => {
    const handle = (e: KeyboardEvent) => {
      if (e.repeat || !testerOwns(e)) return;
      const name = DOM_CODE_TO_QMK[e.code];
      const kc = name ? valueOf(name) : undefined;
      const key = kc === undefined ? undefined : keyOfKc(kc);
      if (key) onKey(key, e.type === "keydown");
    };
    window.addEventListener("keydown", handle, true);
    window.addEventListener("keyup", handle, true);
    return () => {
      window.removeEventListener("keydown", handle, true);
      window.removeEventListener("keyup", handle, true);
    };
  };
}

/** How often the keyboard is asked again (it stops reporting 5 s after the last time). */
const RENEW_MS = 2000;

/**
 * Keys as the keyboard sees them (the profile switcher's `key-event`): every physical key by its
 * matrix position, before any remap, Fn and the knob included. `onRefused`: the keyboard answered
 * that it couldn't start reporting (its firmware had no slot free for it).
 */
export function firmwareKeySource(onRefused: () => void): KeySource {
  return (onKey) => {
    let live = true;
    const ask = (on: boolean) =>
      void api.setKeyReport(on).then(
        (reporting) => live && on && !reporting && onRefused(),
        () => {},
      );
    ask(true);
    const renew = setInterval(() => ask(true), RENEW_MS);
    const unlisten = api.onKeyEvent((e) => live && onKey(e.key, e.down));
    return () => {
      live = false;
      clearInterval(renew);
      void unlisten.then((off) => off());
      ask(false);
    };
  };
}

/**
 * While the tester is on, a key is the tester's and nothing else's: Tab, Space, Backspace, F5, Alt
 * or F10 must not act on the app (the tester calls `preventDefault`, and the app's own shortcuts
 * check the store's `testing`). A dialog (Settings) and text fields keep their keys.
 */
export function testerOwns(e: KeyboardEvent): boolean {
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select, [contenteditable], [role=dialog]")))
    return false;
  return !document.querySelector('[role="dialog"][aria-modal="true"]');
}

// ------------------------------------------------------------------ the sound

let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** The AudioContext, made on first use (inside a user gesture, or the browser keeps it muted). */
function context(): AudioContext | null {
  if (!audio) {
    try {
      audio = new AudioContext();
    } catch {
      return null; // No audio here: the tester stays silent.
    }
  }
  if (audio.state === "suspended") void audio.resume().catch(() => {});
  return audio;
}

/** Wakes the audio up from a click, so the first keypress isn't the one that starts it. */
export const primeKeySound = () => void context();

/** White noise to filter, made once. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!noise) {
    const n = Math.round(ctx.sampleRate * 0.08);
    noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/** A burst of filtered noise starting at `t`, falling off over `decay` seconds. */
function burst(ctx: AudioContext, t: number, type: BiquadFilterType, freq: number, q: number, level: number, decay: number) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
  src.stop(t + decay + 0.01);
}

/**
 * A mechanical key going down: the switch's click, then the keycap bottoming out on the plate
 * (a short low thud and the case's resonance). `wide` keys (space bar, shifts, Enter) sound
 * deeper, as their stabilisers do. A little random variation, so a run of keys doesn't sound
 * like one sample repeated.
 */
export function playKeySound(wide = false): void {
  const ctx = context();
  if (!ctx) return;
  const t = ctx.currentTime + 0.002;
  const vary = 0.9 + Math.random() * 0.2;
  // The click: bright and very short.
  burst(ctx, t, "highpass", 3800 * vary, 0.8, 0.35, 0.012);
  // Bottom-out: the cap hitting the plate, a few ms later.
  const thud = ctx.createOscillator();
  thud.type = "triangle";
  const base = (wide ? 110 : 170) * vary;
  thud.frequency.setValueAtTime(base * 1.6, t + 0.004);
  thud.frequency.exponentialRampToValueAtTime(base, t + 0.04);
  const thudGain = ctx.createGain();
  thudGain.gain.setValueAtTime(0.0001, t);
  thudGain.gain.exponentialRampToValueAtTime(wide ? 0.5 : 0.35, t + 0.006);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, t + (wide ? 0.09 : 0.06));
  thud.connect(thudGain).connect(ctx.destination);
  thud.start(t);
  thud.stop(t + 0.1);
  // The case's body: a band of noise around the plate's ring.
  burst(ctx, t + 0.004, "bandpass", (wide ? 900 : 1500) * vary, 1.4, wide ? 0.3 : 0.22, wide ? 0.07 : 0.045);
}
