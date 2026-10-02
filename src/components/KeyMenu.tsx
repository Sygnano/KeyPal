import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { boardId, keycodeAt, layerName, layerOf } from "../lib/keyIds";
import { BOARD_WIDTH_U, KEY_BY_ID, KEYS, isEncoderId } from "../lib/layout";
import { bankOf, countUses, stepsPreview } from "../lib/macroBank";
import { DISABLED_BIND, bindLabel, isDisabled } from "../lib/profiles";
import type { KeyId } from "../lib/types";
import { keycodeToString, hex } from "../qmk/keycodes";
import { keycodeLabel } from "../qmk/labels";
import { parseKeycode } from "../qmk/parse";
import { useSelectedProfile, useStore } from "../state/store";
import { CrossIcon } from "./ProfileList";
import { KeyPicker } from "./KeyPicker";

type Mode = "key" | "macro" | "qmk" | "disable";
const MENU_W = 360;

/** "A", "Knob ↻", "Knob 2 ↺" (any layer). `baseKc`: what the key does there. */
export function keyDisplayName(id: KeyId, baseKc: number | undefined): string {
  const key = boardId(id);
  const knob = /^e(\d+):(ccw|cw)$/.exec(key);
  if (knob) return `Knob${knob[1] === "0" ? "" : ` ${Number(knob[1]) + 1}`} ${knob[2] === "cw" ? "↻" : "↺"}`;
  return baseKc !== undefined ? keycodeLabel(baseKc) : key;
}

export function KeyMenu({ keyId, unit, topPad }: { keyId: KeyId; unit: number; topPad: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const profile = useSelectedProfile();
  const base = useStore((s) => s.base);
  const { openMenu, setBind, removeBind, selectKey } = useStore.getState();
  const bind = profile.binds[keyId];
  const askedTab = useStore((s) => s.menuTab);
  const [mode, setMode] = useState<Mode>(
    askedTab ??
      (bind?.kind === "macro"
        ? "macro"
        : bind?.kind === "qmk"
          ? "qmk"
          : isDisabled(bind)
            ? "disable"
            : "key"),
  );
  // Anchor below the key (or below the knob for rotation targets).
  const onBoard = boardId(keyId);
  const geom = isEncoderId(onBoard) ? KEYS.find((k) => k.encoder !== undefined)! : KEY_BY_ID.get(onBoard)!;
  const anchorTop = isEncoderId(onBoard) ? 0.7 * unit : (geom.y + topPad + geom.h) * unit;
  const anchorAboveBottom = (geom.y + topPad) * unit;
  const left = Math.max(0, Math.min(geom.x * unit, BOARD_WIDTH_U * unit - MENU_W));
  const [top, setTop] = useState(anchorTop + 6);

  // Re-measured whenever the menu's own content changes size (switching tabs, recording a
  // macro…), not just when it first opens: it starts below the key, or above when that side
  // has more room, then it's nudged up (or down) just enough to stay fully on screen — never
  // scrolled internally, which would clip the header and footer along with it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const recompute = () => {
      const boardRect = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      const boardTop = boardRect?.top ?? 0;
      const height = el.scrollHeight;
      const spaceBelow = window.innerHeight - (boardTop + anchorTop + 6) - margin;
      const spaceAbove = boardTop + anchorAboveBottom - 6 - margin;
      const screenTop =
        spaceBelow >= height || spaceBelow >= spaceAbove
          ? boardTop + anchorTop + 6
          : boardTop + anchorAboveBottom - 6 - height;
      const clampedScreenTop = Math.min(
        Math.max(screenTop, margin),
        Math.max(margin, window.innerHeight - margin - height),
      );
      setTop(clampedScreenTop - boardTop);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    window.addEventListener("resize", recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [keyId, anchorTop, anchorAboveBottom]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest(".cap, .tape, .knob-turn")) return;
      openMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const title = keyDisplayName(keyId, keycodeAt(base, keyId));
  const onLayer = layerName(layerOf(keyId, base.layer), useStore.getState().settings.layerNames);
  const style = { left, top, width: MENU_W };

  return (
    <div className="key-menu" ref={ref} style={style} role="dialog" aria-label={`Remap ${title}`}>
      <div className="key-menu-head">
        <div className="key-menu-head-text">
          <span className="key-menu-title">
            Remap <strong>{title}</strong> <span className="muted">on {onLayer}</span>
          </span>
          {bind && <span className="key-menu-current">now: {bindLabel(bind)}</span>}
        </div>
        <button
          type="button"
          className="icon-btn small key-menu-close"
          aria-label="Close"
          onClick={() => openMenu(null)}
        >
          <CrossIcon />
        </button>
      </div>

      <div className="segmented segmented-4" role="tablist">
        {(["key", "macro", "qmk", "disable"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={m === "disable" ? "is-danger" : undefined}
            onClick={() => setMode(m)}
          >
            {m === "key" ? "Other key" : m === "macro" ? "Macro" : m === "qmk" ? "QMK code" : "Disable"}
          </button>
        ))}
      </div>

      {mode === "key" && (
        <KeyPicker autoFocus onPick={(keycode) => setBind(keyId, { kind: "key", keycode })} />
      )}

      {mode === "macro" && (
        <MacroStart
          keyId={keyId}
          existing={bind?.kind === "macro"}
          // The editor under the keyboard takes over, its recorder focused.
          onDone={() => {
            selectKey(keyId);
            openMenu(null);
            requestAnimationFrame(() => document.getElementById("macro-recorder")?.focus());
          }}
        />
      )}

      {mode === "qmk" && (
        <QmkInput
          initial={bind?.kind === "qmk" ? bind.source : bind?.kind === "key" ? keycodeToString(bind.keycode) : ""}
          onSubmit={(source, keycode) => {
            setBind(keyId, { kind: "qmk", source, keycode });
            openMenu(null);
          }}
        />
      )}

      {mode === "disable" && (
        <DisablePanel disabled={isDisabled(bind)} onDisable={() => setBind(keyId, DISABLED_BIND)} />
      )}

      <div className="key-menu-foot">
        {bind && (
          <button className="link-btn danger" onClick={() => removeBind(keyId)}>
            Reset to {keyDisplayName(boardId(keyId), keycodeAt(base, keyId))}
          </button>
        )}
      </div>
    </div>
  );
}

function DisablePanel({ disabled, onDisable }: { disabled: boolean; onDisable(): void }) {
  return (
    <div className="menu-body">
      <p className="menu-text">
        {disabled
          ? "This key is disabled: it does nothing when pressed in this profile."
          : "The key does nothing when pressed in this profile."}
      </p>
      {!disabled && (
        <button className="btn btn-primary" onClick={onDisable}>
          Disable this key
        </button>
      )}
    </div>
  );
}

/** The Macro tab: edit the key's macro, or give it one: a new one, or one from the bank. */
function MacroStart({ keyId, existing, onDone }: { keyId: KeyId; existing: boolean; onDone(): void }) {
  const [name, setName] = useState("");
  const draft = useStore((s) => s.draft);
  const bank = bankOf(draft);
  const counts = useMemo(() => countUses(draft), [draft]);
  const [source, setSource] = useState<"new" | "bank">("new");
  const [picked, setPicked] = useState<string | null>(null);
  // `useMacro` is a store action, not a hook: named apart so it reads as one.
  const { createMacro, useMacro: linkMacro, copyMacro, deleteBankMacro } = useStore.getState();
  if (existing) {
    return (
      <div className="menu-body">
        <p className="menu-text">This key plays a macro. Edit its steps in the panel under the keyboard.</p>
        <button className="btn btn-primary" onClick={onDone}>
          Edit macro
        </button>
      </div>
    );
  }
  const chosen = bank.find((m) => m.id === picked) ?? bank[0];
  const uses = (id: string) => counts.get(id) ?? 0;
  return (
    <div className="menu-body">
      <div className="segmented segmented-2" role="tablist" aria-label="Macro source">
        <button role="tab" aria-selected={source === "new"} onClick={() => setSource("new")}>
          New
        </button>
        <button
          role="tab"
          aria-selected={source === "bank"}
          disabled={!bank.length}
          title={bank.length ? undefined : "No macros yet: the ones you create are kept here to reuse"}
          onClick={() => setSource("bank")}
        >
          From bank
        </button>
      </div>
      {source === "new" || !chosen ? (
        <form
          className="menu-body"
          onSubmit={(e) => {
            e.preventDefault();
            createMacro(keyId, name.trim() || "Macro");
            onDone();
          }}
        >
          <p className="menu-text">A macro types a sequence of keys. You record the steps under the keyboard.</p>
          <label className="field">
            <span>Name</span>
            <input autoFocus value={name} placeholder="e.g. Buy menu" onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn btn-primary" type="submit">
            Create macro
          </button>
        </form>
      ) : (
        <>
          <label className="field">
            <span>Macro</span>
            <select value={chosen.id} onChange={(e) => setPicked(e.target.value)} aria-label="Macro from the bank">
              {bank.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {uses(m.id) ? `used by ${uses(m.id)} key${uses(m.id) > 1 ? "s" : ""}` : "unused"}
                </option>
              ))}
            </select>
          </label>
          <p className="bank-preview mono" title={stepsPreview(chosen.steps, keycodeLabel, Infinity)}>
            {stepsPreview(chosen.steps, keycodeLabel)}
          </p>
          <p className="menu-text">
            <strong>Use macro</strong> links this key to it: editing it later changes it on every key that uses it.{" "}
            <strong>Use a copy</strong> to edit it on its own.
          </p>
          <div className="bank-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                linkMacro(keyId, chosen.id);
                onDone();
              }}
            >
              Use macro
            </button>
            <button
              className="btn"
              onClick={() => {
                copyMacro(keyId, chosen.id);
                onDone();
              }}
            >
              Use a copy
            </button>
            {!uses(chosen.id) && (
              <button
                className="link-btn danger push-right"
                onClick={() => {
                  deleteBankMacro(chosen.id);
                  setPicked(null);
                  if (bank.length === 1) setSource("new");
                }}
              >
                Delete from bank
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function QmkInput({ initial, onSubmit }: { initial: string; onSubmit(source: string, keycode: number): void }) {
  const [text, setText] = useState(initial);
  const result = parseKeycode(text);
  return (
    <form
      className="menu-body"
      onSubmit={(e) => {
        e.preventDefault();
        if (result.ok) onSubmit(text.trim(), result.value);
      }}
    >
      <label className="field">
        <span>Keycode</span>
        <input
          autoFocus
          className="mono-input"
          value={text}
          spellCheck={false}
          placeholder="MO(1), LCTL(KC_C), KC_F13, 0x5221"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className={`parse-result ${result.ok ? "ok" : "bad"}`} aria-live="polite">
        {result.ok
          ? `${hex(result.value)} · ${keycodeLabel(result.value)}`
          : text.trim()
            ? result.error
            : "Any QMK keycode expression the firmware understands."}
      </p>
      <button className="btn btn-primary" type="submit" disabled={!result.ok}>
        Use this code
      </button>
    </form>
  );
}
