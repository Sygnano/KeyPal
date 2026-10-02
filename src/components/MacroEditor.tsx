import { useMemo, useRef, useState } from "react";
import { boardId, keycodeAt } from "../lib/keyIds";
import { clampGap, MAX_MACRO_GAP } from "../lib/limits";
import { usesOf } from "../lib/macroBank";
import type { Bind, KeyId, MacroStep } from "../lib/types";
import { isMacroSafe, valueOf } from "../qmk/keycodes";
import { DOM_CODE_TO_QMK, keycodeLabel } from "../qmk/labels";
import { parseKeycode } from "../qmk/parse";
import { typeText } from "../qmk/typeText";
import { useStore } from "../state/store";
import { keyDisplayName } from "./KeyMenu";
import { CrossIcon } from "./ProfileList";

type Macro = Extract<Bind, { kind: "macro" }>;

export function MacroEditor({ keyId, from, macro }: { keyId: KeyId; from: string; macro: Macro }) {
  const setBind = useStore((s) => s.setBind);
  const unlinkMacro = useStore((s) => s.unlinkMacro);
  const draft = useStore((s) => s.draft);
  const base = useStore((s) => s.base);
  // Every key playing this bank macro, in every profile: an edit here changes them all.
  const uses = useMemo(() => (macro.macroId ? usesOf(draft, macro.macroId) : []), [draft, macro.macroId]);
  // Renaming (null: not): the name is typed locally and saved with Enter or Save, Escape cancels.
  // The bank keeps names unique, so saving per keystroke would turn "Buy" into "Buy 2" while
  // "Buy menu" is being typed next to an existing "Buy".
  const [name, setName] = useState<string | null>(null);
  const defaultGap = useStore((s) => s.settings.macroGap);
  const [recording, setRecording] = useState(false);
  const [withDelays, setWithDelays] = useState(false);
  const [adding, setAdding] = useState<"text" | "code" | null>(null);
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const lastEvent = useRef<number | null>(null);
  const held = useRef(new Set<number>());

  // The macro's own gap goes along with every edit (absent, it follows the default in Settings),
  // and its bank entry: every key linked to it follows.
  const save = (steps: MacroStep[], name: string, gap: number | undefined) =>
    setBind(keyId, {
      kind: "macro",
      name,
      steps,
      ...(gap === undefined ? {} : { gap }),
      ...(macro.macroId === undefined ? {} : { macroId: macro.macroId }),
    });
  const update = (steps: MacroStep[], name = macro.name) => save(steps, name, macro.gap);

  const push = (step: MacroStep) => {
    const steps = [...currentSteps(keyId)];
    const now = performance.now();
    if (withDelays && lastEvent.current !== null) {
      const gap = Math.round(now - lastEvent.current);
      if (gap >= 15) steps.push({ op: "delay", ms: Math.min(gap, 5000) });
    }
    lastEvent.current = now;
    // A press immediately followed by its release becomes a single tap.
    const prev = steps[steps.length - 1];
    if (step.op === "up" && prev && prev.op === "down" && prev.keycode === step.keycode) {
      steps[steps.length - 1] = { op: "tap", keycode: step.keycode };
    } else {
      steps.push(step);
    }
    update(steps);
  };

  const onKey = (e: React.KeyboardEvent, op: "down" | "up") => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const name = DOM_CODE_TO_QMK[e.code];
    const kc = name ? valueOf(name) : undefined;
    if (kc === undefined) return;
    if (op === "down") held.current.add(kc);
    else if (!held.current.delete(kc)) return; // release of a key pressed before recording
    push({ op, keycode: kc });
  };

  const codeResult = parseKeycode(code);
  const codeError = codeResult.ok && !isMacroSafe(codeResult.value)
    ? "Macros can only press normal keys, optionally with modifiers (e.g. LCTL(KC_C))."
    : !codeResult.ok && code.trim()
      ? codeResult.error
      : null;

  const textResult = typeText(text);
  const textError = textResult.ok
    ? null
    : `This keyboard layout has no key for ${textResult.missing.map((c) => `"${c}"`).join(", ")}.`;

  const heldAtEnd = unreleased(macro.steps);

  return (
    <div className="macro">
      <div className="macro-head">
        <h2 className="panel-title">
          {from} <span className="muted">plays</span>
        </h2>
        {name === null ? (
          <>
            <strong className="macro-title" title={macro.name}>
              {macro.name}
            </strong>
            <button className="btn btn-small" onClick={() => setName(macro.name)}>
              Rename
            </button>
          </>
        ) : (
          <form
            className="macro-rename"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name !== macro.name) update(macro.steps, name);
              setName(null);
            }}
          >
            <input
              autoFocus
              className="macro-name"
              value={name}
              aria-label="Macro name"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setName(null)}
            />
            <button className="btn btn-small btn-primary" type="submit">
              Save
            </button>
          </form>
        )}
      </div>
      {uses.length > 1 && (
        <div className="macro-shared">
          <span
            className="macro-shared-badge"
            title={uses
              .map((u) => `${u.profileName} · ${keyDisplayName(boardId(u.keyId), keycodeAt(base, u.keyId))}`)
              .join("\n")}
          >
            Shared by {uses.length} keys
          </span>
          <span>Editing it here changes it on all of them.</span>
          <button className="link-btn" onClick={() => unlinkMacro(keyId)}>
            Make separate
          </button>
        </div>
      )}

      <div
        id="macro-recorder"
        className={`recorder ${recording ? "is-recording" : ""}`}
        tabIndex={0}
        role="textbox"
        aria-label="Macro steps. Focus and press keys to record."
        onFocus={() => {
          setRecording(true);
          lastEvent.current = null;
          held.current.clear();
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => onKey(e, "down")}
        onKeyUp={(e) => onKey(e, "up")}
      >
        {macro.steps.length === 0 && (
          <span className="recorder-hint">{recording ? "Recording — press keys" : "Click here, then press keys to record"}</span>
        )}
        {macro.steps.map((s, i) => (
          <StepChip
            key={i}
            step={s}
            onRemove={() => update(macro.steps.filter((_, j) => j !== i))}
            onDelay={(ms) => update(macro.steps.map((x, j) => (j === i ? { op: "delay", ms } : x)))}
          />
        ))}
        {recording && <span className="rec-dot" aria-hidden />}
      </div>

      <div className="macro-tools">
        <button className="btn btn-ghost" onClick={() => update([...macro.steps, { op: "delay", ms: 50 }])}>
          Add delay
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setAdding((a) => (a === "text" ? null : "text"))}
          aria-expanded={adding === "text"}
        >
          Add text
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setAdding((a) => (a === "code" ? null : "code"))}
          aria-expanded={adding === "code"}
        >
          Add QMK code
        </button>
        <label className="check">
          <input type="checkbox" checked={withDelays} onChange={(e) => setWithDelays(e.target.checked)} />
          Record timing
        </label>
        <button className="link-btn danger push-right" disabled={!macro.steps.length} onClick={() => update([])}>
          Clear
        </button>
      </div>

      <div className="gap-row">
        <label className="gap-field" title="Waited after each key press or release; a delay step replaces it where there is one.">
          Gap between keys
          <input
            type="number"
            min={0}
            max={MAX_MACRO_GAP}
            value={macro.gap ?? ""}
            placeholder={String(defaultGap)}
            aria-label="Gap between keys, in milliseconds"
            onChange={(e) => save(macro.steps, macro.name, clampGap(e.target.value))}
          />
          ms
        </label>
        {macro.gap === undefined ? (
          <span className="macro-foot">The default, set in Settings</span>
        ) : (
          <button className="link-btn" onClick={() => save(macro.steps, macro.name, undefined)}>
            Use the default ({defaultGap} ms)
          </button>
        )}
      </div>

      {adding === "text" && (
        <form
          className="code-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!textResult.ok || !textResult.keycodes.length) return;
            update([...macro.steps, ...textResult.keycodes.map((keycode): MacroStep => ({ op: "tap", keycode }))]);
            setText("");
          }}
        >
          <input
            autoFocus
            className="macro-text"
            value={text}
            aria-label="Text to type"
            placeholder="Text the key should type"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn btn-primary" disabled={!textResult.ok || !textResult.keycodes.length}>
            Add
          </button>
          {textError ? (
            <p className="parse-result bad">{textError}</p>
          ) : (
            <p className="macro-foot">
              Added as key presses for the layout chosen under Key labels: Windows must be typing with that
              layout, and Caps Lock off, when the macro plays.
            </p>
          )}
        </form>
      )}

      {adding === "code" && (
        <form
          className="code-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!codeResult.ok || codeError) return;
            update([...macro.steps, { op: "tap", keycode: codeResult.value }]);
            setCode("");
          }}
        >
          <input
            autoFocus
            className="mono-input"
            value={code}
            placeholder="LCTL(KC_C), KC_F13…"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn btn-primary" disabled={!codeResult.ok || !!codeError}>
            Add
          </button>
          {codeError && <p className="parse-result bad">{codeError}</p>}
        </form>
      )}

      <p className="macro-foot">
        {heldAtEnd.length > 0
          ? `${heldAtEnd.map(keycodeLabel).join(", ")} still held at the end; the keyboard releases it when the macro finishes.`
          : "The Windows key and shortcuts like Alt+Tab are caught by Windows while recording; add them with QMK code (e.g. KC_LGUI)."}
      </p>
    </div>
  );
}

/** Read the latest steps from the store (keydown/keyup fire faster than React re-renders). */
function currentSteps(keyId: KeyId): MacroStep[] {
  const s = useStore.getState();
  const p = s.draft.profiles.find((x) => x.id === s.selectedProfileId);
  const b = p?.binds[keyId];
  return b?.kind === "macro" ? b.steps : [];
}

function unreleased(steps: MacroStep[]): number[] {
  const down = new Set<number>();
  for (const s of steps) {
    if (s.op === "down") down.add(s.keycode);
    if (s.op === "up") down.delete(s.keycode);
  }
  return [...down];
}

function StepChip({ step, onRemove, onDelay }: { step: MacroStep; onRemove(): void; onDelay(ms: number): void }) {
  if (step.op === "delay") {
    return (
      <span className="step step-delay">
        <input
          type="number"
          min={1}
          max={5000}
          value={step.ms}
          aria-label="Delay in milliseconds"
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
          onChange={(e) => onDelay(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
        />
        ms
        <button className="step-x" aria-label="Remove step" onClick={onRemove}>
          <CrossIcon />
        </button>
      </span>
    );
  }
  const prefix = step.op === "down" ? "↓ " : step.op === "up" ? "↑ " : "";
  return (
    <span className={`step step-${step.op}`}>
      {prefix}
      {keycodeLabel(step.keycode)}
      <button className="step-x" aria-label="Remove step" onClick={onRemove}>
        <CrossIcon />
      </button>
    </span>
  );
}
