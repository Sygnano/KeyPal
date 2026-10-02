import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { ProjectTemplate } from "../../lib/firmwareTypes";
import { useFirmware } from "../../state/firmwareStore";
import { Dialog } from "../Dialog";

const IMPORT = "__import__";

/** What a new firmware is: a keymap with the app's module, the keymap as it is, or empty files. */
type Kind = "tweak" | "default" | "empty";
const KINDS: Array<[Kind, string, string]> = [
  ["tweak", "Profile Tweak", "The keymap plus this app's profile switcher module: per-program remaps, macros and lighting."],
  ["default", "Default", "The keymap as it is, without the module: the app's profiles won't reach the keyboard."],
  ["empty", "Empty", "Empty keymap.c, config.h and rules.mk, to write your own from scratch."],
];

/** A new firmware project: its name, keyboard, what kind, and what it starts from. */
export function NewFirmwareDialog({ onClose }: { onClose(): void }) {
  const keyboards = useFirmware((s) => s.keyboards);
  const devices = useFirmware((s) => s.status?.devices ?? []);
  const sourceReady = useFirmware((s) => s.status?.source.state !== "missing");
  const createProject = useFirmware((s) => s.createProject);

  // The keyboard plugged in, if it's one of Keychron's (same USB id).
  const plugged = devices.find((d) => d.kind === "keyboard");
  const guess = keyboards.find((k) => plugged && k.pid === plugged.pid)?.path ?? keyboards[0]?.path ?? "";
  const [name, setName] = useState("");
  const [keyboard, setKeyboard] = useState(guess);
  const [templates, setTemplates] = useState<string[]>([]);
  const [template, setTemplate] = useState<string>(IMPORT);
  const [folder, setFolder] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("tweak");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!keyboard && guess) setKeyboard(guess);
  }, [guess, keyboard]);

  useEffect(() => {
    if (!keyboard || !sourceReady) return setTemplates([]);
    api.fwTemplates(keyboard).then((t) => {
      setTemplates(t);
      setTemplate((cur) => (cur === IMPORT || t.includes(cur) ? (cur === IMPORT && t.length ? t[0] : cur) : (t[0] ?? IMPORT)));
    }, () => setTemplates([]));
  }, [keyboard, sourceReady]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return keyboards.filter((k) => !q || k.path.includes(q) || k.name.toLowerCase().includes(q) || k.path === keyboard);
  }, [keyboards, filter, keyboard]);

  const chosen: ProjectTemplate | null =
    kind === "empty" ? { kind: "empty" } : template === IMPORT ? (folder ? { kind: "folder", path: folder } : null) : { kind: "keymap", name: template };
  const canCreate = !!name.trim() && !!keyboard.trim() && !!chosen && !busy;

  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    const ok = await createProject(name, keyboard.trim(), chosen, kind === "tweak");
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog title="New firmware" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} placeholder="e.g. My V6 for games" onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>Keyboard {plugged && keyboards.some((k) => k.pid === plugged.pid) ? "(the one plugged in is picked)" : ""}</span>
        {keyboards.length ? (
          <>
            <input className="fw-filter" value={filter} placeholder="Filter: v6, q1, k8…" onChange={(e) => setFilter(e.target.value)} />
            <select value={keyboard} size={6} onChange={(e) => setKeyboard(e.target.value)}>
              {shown.map((k) => (
                <option key={k.path} value={k.path}>
                  {k.name} · {k.path}
                </option>
              ))}
            </select>
          </>
        ) : (
          <input value={keyboard} placeholder="keychron/v6_8k/iso_encoder" onChange={(e) => setKeyboard(e.target.value)} />
        )}
      </label>
      {!sourceReady && (
        <p className="option-text small">
          Download Keychron's firmware first (preflight) to pick from their keyboards and keymaps. Importing a folder works
          already.
        </p>
      )}

      <div className="field">
        <span>Kind</span>
        <div className="segmented fw-kind" role="radiogroup" aria-label="Kind of firmware">
          {KINDS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <p className="option-text small">{KINDS.find(([k]) => k === kind)?.[2]}</p>
      </div>

      <label className="field">
        <span>Start from</span>
        <select disabled={kind === "empty"} value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((t) => (
            <option key={t} value={t}>
              Keychron's "{t}" keymap{t === "keychron" ? " (what Keychron ships, with VIA)" : t === "default" ? " (QMK's basic one)" : ""}
            </option>
          ))}
          <option value={IMPORT}>A keymap folder on this PC…</option>
        </select>
      </label>
      <div className={`fw-folder${kind !== "empty" && template === IMPORT ? "" : " is-hidden"}`}>
        <button
          className="btn btn-ghost btn-small"
          disabled={kind === "empty" || template !== IMPORT}
          onClick={async () => {
            const f = await api.pickFolder();
            if (f) setFolder(f);
          }}
        >
          Choose a folder…
        </button>
        <span className="mono small">{folder ?? "e.g. C:\\qmk_firmware\\keyboards\\…\\keymaps\\mine"}</span>
      </div>

      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!canCreate} onClick={create}>
          Create
        </button>
      </div>
    </Dialog>
  );
}
