import { useMemo, useState } from "react";
import { catalog } from "../qmk/catalog";
import { QK, basicName, valueOf } from "../qmk/keycodes";
import { DOM_CODE_TO_QMK, keycodeLabel, legendFor } from "../qmk/labels";

interface Props {
  onPick(keycode: number): void;
  autoFocus?: boolean;
}

/** Left-hand modifiers, chosen with a toggle and combined with whichever key is picked next. */
const MOD_BITS: Array<[number, string]> = [[0x01, "Ctrl"], [0x02, "Shift"], [0x04, "Alt"], [0x08, "Win"]];

export function KeyPicker({ onPick, autoFocus }: Props) {
  const [query, setQuery] = useState("");
  const [listening, setListening] = useState(false);
  const [mods, setMods] = useState(0);

  // Only a basic keycode (the low byte of a modded one) can be wrapped this way.
  const withMods = (kc: number) => (mods && kc <= QK.BASIC_MAX ? (mods << 8) | kc : kc);

  // The keyboard shown's groups (the picker remounts with the main area when it changes).
  const groups = useMemo(
    () =>
      catalog().map((g) => ({
        ...g,
        codes: g.names.map((n) => valueOf(n)!),
      })).filter((g) => g.codes.length > 0),
    [],
  );
  const [group, setGroup] = useState(() => groups[0]?.id ?? "");

  const q = query.trim().toLowerCase();
  const results = q
    ? groups
        .flatMap((g) => g.codes)
        .filter((kc, i, all) => all.indexOf(kc) === i)
        .filter((kc) => {
          const label = keycodeLabel(kc).toLowerCase();
          const name = (basicName(kc) ?? "").toLowerCase();
          return label === q || label.includes(q) || name.includes(q);
        })
    : groups.find((g) => g.id === group)?.codes ?? [];

  return (
    <div className="picker">
      <div className="picker-top">
        <input
          className="picker-search"
          autoFocus={autoFocus}
          value={query}
          placeholder="Search: F13, Mouse 5, é, KC_PSCR…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`btn btn-ghost listen ${listening ? "is-listening" : ""}`}
          onClick={() => setListening((l) => !l)}
          onKeyDown={(e) => {
            if (!listening) return;
            e.preventDefault();
            e.stopPropagation();
            const name = DOM_CODE_TO_QMK[e.code];
            const kc = name ? valueOf(name) : undefined;
            if (kc !== undefined) {
              setListening(false);
              onPick(withMods(kc));
            }
          }}
          onBlur={() => setListening(false)}
        >
          {listening ? "Press a key…" : "Press to pick"}
        </button>
      </div>

      <div className="picker-mods" role="group" aria-label="Modifiers">
        {MOD_BITS.map(([bit, label]) => (
          <button
            key={label}
            type="button"
            aria-pressed={(mods & bit) !== 0}
            onClick={() => setMods((m) => m ^ bit)}
          >
            {label}
          </button>
        ))}
      </div>

      {!q && (
        <select
          className="picker-group-select"
          aria-label="Key category"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      )}

      <div className="picker-grid">
        {results.length === 0 && <p className="menu-text">No key matches “{query}”. Try the QMK code tab.</p>}
        {results.map((kc) => {
          const lg = legendFor(kc);
          return (
            <button
              key={kc}
              type="button"
              className="mini-cap"
              title={basicName(kc)}
              onClick={() => onPick(withMods(kc))}
            >
              {lg.shift && <span className="mini-shift">{lg.shift}</span>}
              <span className={`mini-base ${lg.base.length > 2 ? "is-word" : ""}`}>{lg.base}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
