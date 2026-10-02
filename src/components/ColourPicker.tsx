import { useEffect, useState } from "react";
import { HsvColorPicker } from "react-colorful";
import { PRESETS, fromPicker, hsvToCss, sameHsv, toPicker, type PickerHsv } from "../lib/color";
import type { Hsv } from "../lib/types";
import { useStore } from "../state/store";
import { ChevronIcon, CrossIcon } from "./ProfileList";

/** Saved colours kept (the oldest go first). */
const SAVED_MAX = 18;

/**
 * The one colour picker: ready-made and saved colours on top, the wheel (saturation × brightness,
 * then hue), and number fields for the exact values the keyboard gets (0–255 each; no separate
 * slider bars, to avoid fighting the wheel's own dragging). Saved colours are this PC's
 * (settings.json), so they can be reused in any profile. `noBrightness`: the colour's brightness
 * isn't this picker's (Mix RGB effects: the keyboard's brightness applies).
 */
export function ColourPicker(props: { value: Hsv; disabled?: boolean; noBrightness?: boolean; onChange(c: Hsv): void }) {
  const { value, disabled, noBrightness, onChange } = props;
  const saved = useStore((s) => s.settings.savedColors);
  const updateSettings = useStore((s) => s.updateSettings);
  const [showValues, setShowValues] = useState(false);
  // Kept locally so the wheel doesn't jump while dragging (QMK's 0–255 steps are coarser).
  const [colour, setColour] = useState<PickerHsv>(toPicker(value));
  const valueJson = JSON.stringify(value);
  // Only on a real change of the prop: `colour` is what the effect is *comparing against*, so
  // depending on it would run this on every drag tick and fight the wheel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on `valueJson` alone, see above
  useEffect(() => {
    if (JSON.stringify(fromPicker(colour)) !== valueJson) setColour(toPicker(value));
  }, [valueJson]);

  const pick = (c: Hsv) => {
    const next = noBrightness ? { ...c, v: value.v } : c;
    setColour(toPicker(next));
    onChange(next);
  };
  const isSaved = saved.some((c) => sameHsv(c, value));
  const save = () => !isSaved && updateSettings({ savedColors: [...saved, value].slice(-SAVED_MAX) });
  const unsave = (c: Hsv) => updateSettings({ savedColors: saved.filter((x) => !sameHsv(x, c)) });

  return (
    <div id="key-colour-picker" className={`colour-picker ${disabled ? "is-idle" : ""}`}>
      <div className="swatch-row" role="group" aria-label="Ready-made colours">
        {PRESETS.map(([name, hsv]) => (
          <button
            key={name}
            className={`preset ${sameHsv(hsv, value) ? "is-current" : ""}`}
            title={name}
            aria-label={name}
            style={{ background: hsvToCss(hsv) }}
            onClick={() => pick(hsv)}
          />
        ))}
      </div>
      <div className="swatch-row saved-colours" role="group" aria-label="Saved colours">
        {saved.map((c) => (
          <span key={`${c.h},${c.s},${c.v}`} className="saved-colour">
            <button
              className={`preset ${sameHsv(c, value) ? "is-current" : ""}`}
              title={`Saved colour (H ${c.h} S ${c.s} B ${c.v}). Right-click to remove it.`}
              aria-label={`Saved colour H ${c.h} S ${c.s} B ${c.v}`}
              style={{ background: hsvToCss(c) }}
              onClick={() => pick(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                unsave(c);
              }}
            />
            <button className="saved-x" aria-label="Remove this saved colour" title="Remove" onClick={() => unsave(c)}>
              <CrossIcon />
            </button>
          </span>
        ))}
        <button
          className="preset save-colour"
          disabled={isSaved}
          title={isSaved ? "This colour is saved" : "Save this colour, to reuse it in any profile"}
          aria-label="Save this colour"
          onClick={save}
        >
          +
        </button>
        {saved.length === 0 && <span className="muted small">Save colours to reuse them in any profile</span>}
      </div>

      <HsvColorPicker
        color={colour}
        onChange={(c) => {
          const next = fromPicker(c);
          setColour(c);
          onChange(noBrightness ? { ...next, v: value.v } : next);
        }}
      />

      <button
        type="button"
        className="hsv-toggle"
        aria-expanded={showValues}
        onClick={() => setShowValues((v) => !v)}
      >
        <span className={`chevron ${showValues ? "is-open" : ""}`} aria-hidden>
          <ChevronIcon />
        </span>
        Exact values
      </button>
      {showValues && (
        <div className="hsv-fields">
          <HsvField label="Hue" value={value.h} onChange={(h) => pick({ ...value, h })} />
          <HsvField label="Saturation" value={value.s} onChange={(s) => pick({ ...value, s })} />
          {!noBrightness && <HsvField label="Brightness" value={value.v} onChange={(v) => pick({ ...value, v })} />}
        </div>
      )}
    </div>
  );
}

/** One channel's exact number (0–255, what the keyboard gets). The wheel above already drags it. */
function HsvField(props: { label: string; value: number; onChange(v: number): void }) {
  const { label, value, onChange } = props;
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (raw.trim() !== "" && Number.isFinite(n)) onChange(Math.max(0, Math.min(255, n)));
    else setText(String(value));
  };
  return (
    <label className="hsv-field">
      <span className="hsv-label">{label}</span>
      <input
        className="hsv-number"
        type="number"
        min={0}
        max={255}
        value={text}
        aria-label={`${label} (0 to 255)`}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 255) onChange(n);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)}
      />
    </label>
  );
}
