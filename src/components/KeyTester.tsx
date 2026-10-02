import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { resolveKey } from "../lib/keyIds";
import { firmwareKeySource, isTurn, playKeySound, primeKeySound, testerOwns, windowKeySource } from "../lib/keyTester";
import { KEYS } from "../lib/layout";
import { hasModule } from "../lib/limits";
import type { KeyId } from "../lib/types";
import { useStore, type State } from "../state/store";
import { keyDisplayName } from "./KeyMenu";

/** How long a knob turn flashes the knob. */
const TURN_MS = 160;

/** The keyboard reports its keys itself (with the profile switcher): every physical key. Without it
 * (Keychron's own firmware) the tester sees what Windows sees. */
const fromKeyboard = (s: State) => hasModule(s.engine);

/**
 * "Test keyboard" and, while it's on, the key sound: in the header, next to the status line.
 */
export function TesterControls() {
  const testing = useStore((s) => s.testing);
  const sound = useStore((s) => s.testerSound);
  const { setTesting, setTesterSound } = useStore.getState();
  return (
    <div className="tester-controls">
      {testing && (
        <button
          className="icon-btn"
          aria-pressed={sound}
          aria-label="Key sound"
          title={sound ? "Turn the key sound off" : "Play a key sound on each keypress"}
          onClick={() => {
            if (!sound) primeKeySound(); // inside the click: browsers start audio only on a gesture
            setTesterSound(!sound);
          }}
        >
          <SpeakerIcon on={sound} />
        </button>
      )}
      <button
        className={`btn btn-small tester-toggle ${testing ? "is-on" : ""}`}
        aria-pressed={testing}
        title={testing ? "Back to editing the keyboard" : "Press keys to see them on the keyboard"}
        onClick={() => setTesting(!testing)}
      >
        <TesterIcon /> Test keyboard
      </button>
    </div>
  );
}

/**
 * "Test keyboard": every key going down and up on the drawn keyboard, and which ones have been
 * pressed at least once. The keys come from the keyboard itself when its profile switcher can
 * report them, else from Windows. The keys' states are written straight to the DOM (`.cap-slot`
 * classes `is-down` / `is-tested`, a knob turn's `is-turning`), so a keypress re-renders this
 * readout and nothing else.
 */
export function KeyTester({ board }: { board: RefObject<HTMLElement> }) {
  const base = useStore((s) => s.base);
  // The keyboard could report keys but said it couldn't start: Windows' keys, and the note says why.
  const [refused, setRefused] = useState(false);
  const firmware = useStore(fromKeyboard) && !refused;
  const connected = useStore((s) => s.engine.connected);
  const { openInstall } = useStore.getState();
  const [tested, setTested] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const testedRef = useRef(new Set<KeyId>());
  // Windows never sees the knob: it isn't counted unless the keyboard reports keys itself.
  const countable = useMemo(() => KEYS.filter((k) => firmware || k.encoder === undefined), [firmware]);
  const total = countable.length;

  // Windows' keys: the key typing a keycode on the default layer (the legends shown), knob left out.
  const keyOfKc = useMemo(() => {
    const m = new Map<number, KeyId>();
    for (const k of KEYS) {
      if (k.encoder !== undefined) continue;
      const kc = resolveKey(base, base.layer, k.id, {}).kc;
      if (!m.has(kc)) m.set(kc, k.id);
    }
    return m;
  }, [base]);

  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const counts = new Set(countable.map((k) => k.id));
    const wide = new Set(KEYS.filter((k) => k.w >= 2 || k.h >= 2).map((k) => k.id));
    const slotOf = (id: KeyId) => el.querySelector<HTMLElement>(`.cap[data-key="${id}"]`)?.parentElement ?? null;
    const down = new Set<KeyId>();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    // A turn isn't a cap: its knob (and, on the Keys tab, the turn's own button) flash.
    const flashTurn = (id: KeyId) => {
      const knob = Number(/^e(\d+):/.exec(id)![1]);
      const cap = KEYS.find((k) => k.encoder === knob);
      const targets = [cap && slotOf(cap.id), el.querySelector<HTMLElement>(`.knob-turn[data-key="${id}"]`)];
      for (const t of targets) {
        if (!t) continue;
        t.classList.add("is-turning");
        const timer = setTimeout(() => {
          t.classList.remove("is-turning");
          timers.delete(timer);
        }, TURN_MS);
        timers.add(timer);
      }
    };

    const releaseAll = () => {
      for (const id of down) slotOf(id)?.classList.remove("is-down");
      down.clear();
    };

    const onKey = (id: KeyId, isDown: boolean) => {
      const turn = isTurn(id);
      if (!turn && !counts.has(id)) return; // not a key of this board's drawing
      if (isDown && useStore.getState().testerSound) playKeySound(wide.has(id));
      const name = keyDisplayName(id, resolveKey(base, base.layer, id, {}).kc);
      if (turn) {
        if (!isDown) return;
        flashTurn(id);
        setLast(name);
        return;
      }
      const slot = slotOf(id);
      if (!isDown) {
        down.delete(id);
        slot?.classList.remove("is-down");
        return;
      }
      down.add(id);
      slot?.classList.add("is-down", "is-tested");
      setLast(name);
      if (!testedRef.current.has(id)) {
        testedRef.current.add(id);
        setTested(testedRef.current.size);
      }
    };

    // Every key is the tester's while it's on, mapped or not: nothing reaches the app's shortcuts.
    const swallow = (e: KeyboardEvent) => {
      if (testerOwns(e)) e.preventDefault();
    };
    window.addEventListener("keydown", swallow, true);
    window.addEventListener("keyup", swallow, true);
    // Alt+Tab away: the keyup goes to another window, so nothing would ever come back up.
    window.addEventListener("blur", releaseAll);
    const source = firmware ? firmwareKeySource(() => setRefused(true)) : windowKeySource((kc) => keyOfKc.get(kc));
    const stop = source(onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", swallow, true);
      window.removeEventListener("keyup", swallow, true);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
      timers.forEach(clearTimeout);
      el.querySelectorAll(".is-turning").forEach((t) => t.classList.remove("is-turning"));
    };
  }, [board, base, keyOfKc, firmware, countable]);

  // Leaving the tester takes the marks off the keys.
  useEffect(() => {
    const el = board.current;
    return () => el?.querySelectorAll(".cap-slot.is-tested").forEach((s) => s.classList.remove("is-tested"));
  }, [board]);

  const reset = () => {
    testedRef.current.clear();
    board.current?.querySelectorAll(".cap-slot.is-tested").forEach((s) => s.classList.remove("is-tested"));
    setTested(0);
    setLast(null);
  };

  return (
    <div className="tester-bar" role="status">
      <span className="tester-count">
        <strong>{tested}</strong> of {total} keys tested
      </span>
      {last && (
        <span className="tester-last">
          Last: <kbd>{last}</kbd>
        </span>
      )}
      <button type="button" className="btn btn-small" onClick={reset} disabled={!tested && !last}>
        Reset
      </button>
      {!firmware && (
        <span className="tester-note muted">
          Fn, the knob and keys the keyboard handles itself don't reach Windows; a remapped key shows the key it types.
          {refused ? (
            <> The keyboard couldn't start reporting its keys (its firmware is busy with too many timers).</>
          ) : connected && (
            <>
              {" "}
              <button type="button" className="link-btn" onClick={() => openInstall(true)}>
                Update the profile switcher
              </button>{" "}
              to see every physical key.
            </>
          )}
        </span>
      )}
    </div>
  );
}

function TesterIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 6.5h1M7.5 6.5h1M11 6.5h1M5 9.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" />
      <path
        d={on ? "M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.8a6 6 0 0 1 0 8.4" : "M10.5 6l4 4M14.5 6l-4 4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
