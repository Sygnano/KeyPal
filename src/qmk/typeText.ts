import { currentLegends, type Legend } from "./labels";

/** LSFT(kc) and RALT(kc): Windows' AltGr is the right Alt key. */
const SHIFT = 0x0200;
const ALTGR = 0x1400;

const KC_ENT = 0x28;
const KC_TAB = 0x2b;
const KC_SPC = 0x2c;

/** Combining accent (what a letter decomposes to) → the character its dead key shows. */
const ACCENTS: Record<string, string> = {
  "\u0300": "`",
  "\u0301": "´",
  "\u0302": "^",
  "\u0303": "~",
  "\u0308": "¨",
};

type Strokes = Map<string, { keycode: number; level: number }>;

/**
 * Character → the key that types it in a layout: the keys that type it at once, and apart from them the
 * dead keys (French has both for "^"). A plain key wins over Shift, Shift over AltGr.
 */
function strokes(legends: ReadonlyMap<number, Legend>): { direct: Strokes; dead: Strokes } {
  const direct: Strokes = new Map();
  const deadKeys: Strokes = new Map();
  const put = (ch: string | undefined, keycode: number, level: number, dead: boolean) => {
    if (!ch) return;
    const into = dead ? deadKeys : direct;
    const had = into.get(ch);
    if (!had || level < had.level) into.set(ch, { keycode, level });
  };
  for (const [kc, lg] of legends) {
    const dead = (level: "base" | "shift" | "altgr") => lg.dead?.includes(level) ?? false;
    const lower = lg.base.toLowerCase();
    if (!lg.shift && lower !== lg.base) {
      // A letter key: its legend is the one capital, like on a keycap.
      put(lower, kc, 0, dead("base"));
      put(lg.base, SHIFT | kc, 1, dead("base"));
    } else {
      put(lg.base, kc, 0, dead("base"));
      put(lg.shift, SHIFT | kc, 1, dead("shift"));
    }
    put(lg.altgr, ALTGR | kc, 2, dead("altgr"));
  }
  return { direct, dead: deadKeys };
}

export type TypedText = { ok: true; keycodes: number[] } | { ok: false; missing: string[] };

/**
 * The keys to tap, in order, so that Windows types `text` with these legends' layout (the one
 * chosen under Key labels by default). A dead key's own character is the dead key then Space; an
 * accented letter without a key of its own is its dead key then the letter, which is how Windows
 * layouts compose them (it is assumed, not asked: an unusual pair would type both characters).
 * `missing` lists the characters the layout has no key for.
 */
export function typeText(text: string, legends: ReadonlyMap<number, Legend> = currentLegends()): TypedText {
  const keys = strokes(legends);
  const keycodes: number[] = [];
  const missing = new Set<string>();

  const one = (ch: string): number[] | null => {
    if (ch === " ") return [KC_SPC];
    if (ch === "\n") return [KC_ENT];
    if (ch === "\t") return [KC_TAB];
    const key = keys.direct.get(ch);
    if (key) return [key.keycode];
    const alone = keys.dead.get(ch);
    if (alone) return [alone.keycode, KC_SPC];
    const parts = [...ch.normalize("NFD")];
    if (parts.length !== 2) return null;
    const accent = keys.dead.get(ACCENTS[parts[1]] ?? "");
    const letter = keys.direct.get(parts[0]);
    return accent && letter ? [accent.keycode, letter.keycode] : null;
  };

  for (const ch of text.replace(/\r\n?/g, "\n").normalize("NFC")) {
    const taps = one(ch);
    if (taps) keycodes.push(...taps);
    else missing.add(ch);
  }
  return missing.size ? { ok: false, missing: [...missing] } : { ok: true, keycodes };
}
