import * as DM from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { boardInfo } from "../../lib/boards";
import { dropClass, useDragReorder, type DragReorder } from "../../lib/dragReorder";
import type { FirmwareProject } from "../../lib/firmwareTypes";
import { fileKey, useFirmware } from "../../state/firmwareStore";
import { useStore } from "../../state/store";
import { Dialog } from "../Dialog";
import { ModeSwitch } from "../ModeSwitch";
import { CrossIcon, DotsIcon, UndoRedo } from "../ProfileList";
import { NewFirmwareDialog } from "./NewFirmwareDialog";
import { FwModeSwitch, Preflight } from "./Preflight";

/** Firmware mode's sidebar: the user's firmware projects and their files. */
export function FirmwareSidebar() {
  const projects = useFirmware((s) => s.projects);
  const canUndo = useFirmware((s) => s.past.length > 0);
  const canRedo = useFirmware((s) => s.future.length > 0);
  const keyboards = useFirmware((s) => s.keyboards);
  const { undo, redo } = useFirmware.getState();
  const [creating, setCreating] = useState(false);
  const ids = projects.map((p) => p.id);
  const drag = useDragReorder(ids, (id, to) => void useFirmware.getState().moveProject(id, to));
  // What the keyboard says it runs beats any mark the user made.
  const said = useStore((s) => (s.engine.connected ? s.engine.buildId : 0));
  useEffect(() => {
    void useFirmware.getState().matchKeyboard(said);
  }, [said, projects.length]);

  return (
    <aside className="sidebar">
      <ModeSwitch />
      <div className="sidebar-head">
        <h1 className="app-title">Firmware</h1>
        <button className="add-btn" onClick={() => setCreating(true)} title="New firmware project">
          <span aria-hidden>+</span> New
        </button>
      </div>

      <ul className="profile-list fw-projects">
        {projects.map((p, i) => (
          <ProjectRow
            key={p.id}
            project={p}
            index={i}
            total={projects.length}
            drag={drag}
            dropAt={dropClass(drag, ids, p.id)}
            keyboardName={keyboards.find((k) => k.path === p.keyboard)?.name}
          />
        ))}
        {projects.length === 0 && (
          <li className="empty fw-empty">
            No firmware yet. <button className="link-btn" onClick={() => setCreating(true)}>Create one</button> from one of Keychron's
            keymaps, or import a keymap folder you already have.
          </li>
        )}
      </ul>

      <div className="commit-bar">
        <div className="commit-top">
          <span className="commit-hint">Files are saved with Ctrl+S, and before each build.</span>
          <UndoRedo canUndo={canUndo} canRedo={canRedo} undo={undo} redo={redo} />
        </div>
      </div>

      <FwModeSwitch />

      {creating && <NewFirmwareDialog onClose={() => setCreating(false)} />}
    </aside>
  );
}

/**
 * Basic mode's sidebar: there are no projects and nothing to write, so the list is replaced by a
 * line saying so. Profiles | Firmware stays at the top and Basic | Advanced at the bottom, as in
 * the Advanced sidebar.
 */
export function BasicSidebar() {
  return (
    <aside className="sidebar">
      <ModeSwitch />
      <div className="sidebar-head">
        <h1 className="app-title">Firmware</h1>
      </div>

      <div className="fw-basic-aside">
        <Preflight mode="basic" compact />
      </div>

      <FwModeSwitch />
    </aside>
  );
}

function ProjectRow(props: { project: FirmwareProject; index: number; total: number; drag: DragReorder; dropAt: string; keyboardName?: string }) {
  const { project: p, index, total, drag, dropAt, keyboardName } = props;
  const selected = useFirmware((s) => s.selectedId === p.id);
  const bundled = useFirmware((s) => s.status?.moduleVersion ?? null);
  const hasModule = p.files.includes("profile_switcher.c");
  const outdated = p.moduleVersion !== null && bundled !== null && p.moduleVersion < bundled;
  const activeKey = useFirmware((s) => s.activeKey);
  const buffers = useFirmware((s) => s.buffers);
  const { selectProject, openFile, renameProject, deleteProject, createFile, deleteFile, renameFile, moveProject, setFlashed } =
    useFirmware.getState();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingModule, setAddingModule] = useState(false);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  // The keyboard itself says which of the app's firmware it runs; for
  // firmware flashed outside the app, all we have is what the user told us (`flashed`).
  const said = useStore((s) => (s.engine.connected ? s.engine.buildId : 0));
  const onKeyboard = said ? said === p.buildId : p.flashed;
  const sure = said !== 0 && said === p.buildId;
  // The module the keyboard runs, when the keyboard plugged in uses this project's firmware folder.
  const kbModule = useStore((s) =>
    s.engine.connected && s.engine.firmware === "ok" && boardInfo(s.engine.board)?.firmware === p.keyboard
      ? s.engine.firmwareVersion
      : null,
  );
  // On the keyboard, but not as it is now: its files changed since, or the keyboard says it runs
  // another module than the project has (e.g. right after "Update the module").
  const otherModuleOnKeyboard = kbModule !== null && p.moduleVersion !== null && kbModule !== p.moduleVersion;
  const notFlashed = onKeyboard && (p.unflashedChanges || otherModuleOnKeyboard);

  return (
    <li className={`profile ${selected ? "is-selected" : ""} ${dropAt}`} {...drag.rowProps(p.id)}>
      <div className="profile-row" onClick={() => selectProject(p.id)}>
        <span className={`fw-chip ${onKeyboard ? "is-on-keyboard" : ""}`} aria-hidden>
          <ChipIcon />
        </span>
        <div className="profile-name-wrap">
          {renaming ? (
            <NameInput
              initial={p.name}
              label="Firmware name"
              onDone={(name) => {
                setRenaming(false);
                if (name !== null) renameProject(p.id, name);
              }}
            />
          ) : (
            <span className="profile-name" onDoubleClick={() => setRenaming(true)}>
              {p.name}
            </span>
          )}
          <span className="profile-sub" title={p.keyboard}>
            {keyboardName ?? p.keyboard}
            {onKeyboard ? (
              <span
                className="fw-built is-on-keyboard"
                title={sure ? "The keyboard says it is running this firmware" : "Marked as the firmware on this keyboard (it can't say so itself)"}
              >
                on the keyboard
              </span>
            ) : (
              p.lastBuild && (
                <span className="fw-built" title={`Last build: ${p.lastBuild.file}`}>
                  built
                </span>
              )
            )}
            {notFlashed && (
              <span
                className="fw-built is-old"
                title={
                  otherModuleOnKeyboard
                    ? "The keyboard runs another profile switcher than this project has: build and flash it to update the keyboard"
                    : "Changed since it was put on the keyboard: build and flash it to update the keyboard"
                }
              >
                not flashed yet
              </span>
            )}
            {outdated && (
              <span className="fw-built is-old" title="Its profile switcher module is older than the one bundled with the app">
                update available
              </span>
            )}
          </span>
        </div>
        <div className="row-tools" onClick={(e) => e.stopPropagation()}>
          <DM.Root>
            <DM.Trigger asChild>
              <button className="icon-btn" aria-label={`More for ${p.name}`} title="More">
                <DotsIcon />
              </button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content className="ctx" align="end" sideOffset={4} collisionPadding={8}>
                <DM.Item className="ctx-item" disabled={index === 0} onSelect={() => moveProject(p.id, index - 1)}>
                  Move up
                </DM.Item>
                <DM.Item className="ctx-item" disabled={index >= total - 1} onSelect={() => moveProject(p.id, index + 1)}>
                  Move down
                </DM.Item>
                <DM.Separator className="ctx-sep" />
                <DM.Item className="ctx-item" onSelect={() => setAdding(true)}>
                  New file…
                </DM.Item>
                <DM.Item className="ctx-item" onSelect={() => setRenaming(true)}>
                  Rename
                </DM.Item>
                {hasModule && !outdated ? (
                  <DM.Item className="ctx-item is-done" disabled>
                    <TickIcon /> Profile switcher installed
                  </DM.Item>
                ) : (
                  <DM.Item className="ctx-item" onSelect={() => setAddingModule(true)}>
                    {outdated ? "Update the profile switcher module" : "Add the profile switcher module"}
                  </DM.Item>
                )}
                {onKeyboard && !p.unflashedChanges ? (
                  <DM.Item className="ctx-item is-done" disabled>
                    <TickIcon /> This is on my keyboard
                  </DM.Item>
                ) : (
                  <DM.Item className="ctx-item" onSelect={() => setFlashed(p.id, true)}>
                    {onKeyboard ? "This version is on my keyboard" : "This one is on my keyboard"}
                  </DM.Item>
                )}
                <DM.Item className="ctx-item" onSelect={() => api.fwOpenFolder(p.id)}>
                  Open its folder
                </DM.Item>
                <DM.Separator className="ctx-sep" />
                <DM.Item className="ctx-item danger" onSelect={() => deleteProject(p.id)}>
                  Delete (Ctrl+Z brings it back)
                </DM.Item>
              </DM.Content>
            </DM.Portal>
          </DM.Root>
        </div>
      </div>

      {selected && (
        <ul className="exe-list fw-files">
          {p.files.map((f) => {
            const key = fileKey(p.id, f);
            const dirty = buffers[key] && buffers[key].text !== buffers[key].saved;
            return (
              <li key={f} className={`exe fw-file ${activeKey === key ? "is-active" : ""}`}>
                <span className="exe-branch" aria-hidden />
                {renamingFile === f ? (
                  <NameInput
                    initial={f}
                    label="File name"
                    onDone={(name) => {
                      setRenamingFile(null);
                      if (name !== null) renameFile(p.id, f, name);
                    }}
                  />
                ) : (
                  <button className="exe-name-btn" onClick={() => openFile(p.id, f)} onDoubleClick={() => setRenamingFile(f)} title={`${f} (double-click to rename)`}>
                    <FileGlyph path={f} />
                    <span className="exe-name">{f}</span>
                    {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                  </button>
                )}
                <button className="icon-btn danger small" aria-label={`Delete ${f}`} title="Delete (Ctrl+Z brings it back)" onClick={() => deleteFile(p.id, f)}>
                  <CrossIcon />
                </button>
              </li>
            );
          })}
          <li className="exe exe-add">
            <span className="exe-branch" aria-hidden />
            {adding ? (
              <NameInput
                initial=""
                placeholder="config.h"
                label="New file name"
                onDone={(name) => {
                  setAdding(false);
                  if (name !== null) createFile(p.id, name, starter(name));
                }}
              />
            ) : (
              <button className="link-btn" onClick={() => setAdding(true)}>
                New file…
              </button>
            )}
          </li>
        </ul>
      )}

      {addingModule && <AddModuleDialog project={p} update={outdated} onClose={() => setAddingModule(false)} />}
    </li>
  );
}

/**
 * Adding (or updating) the profile switcher module changes the firmware itself, so it asks first.
 * "Duplicate" puts the module in a copy, leaving this firmware as it is.
 */
function AddModuleDialog(props: { project: FirmwareProject; update: boolean; onClose(): void }) {
  const { project: p, update, onClose } = props;
  const [busy, setBusy] = useState(false);
  const run = async (duplicate: boolean) => {
    setBusy(true);
    const { addModule, duplicateProject } = useFirmware.getState();
    const target = duplicate ? await duplicateProject(p.id) : p.id;
    if (target) await addModule(target);
    onClose();
  };
  return (
    <Dialog title={update ? "Update the profile switcher module" : "Add the profile switcher module"} onClose={onClose}>
      <p className="option-text">
        {update ? (
          <>
            This replaces <code>profile_switcher.c</code> in <b>{p.name}</b> with the version bundled with the app. Anything you changed in that
            file is lost.
          </>
        ) : (
          <>
            This adds <code>profile_switcher.c</code> to <b>{p.name}</b>, and the lines it needs to <code>rules.mk</code>. The firmware itself
            changes: it only reaches the keyboard once you build and flash it.
          </>
        )}
      </p>
      <p className="option-text muted">Ctrl+Z undoes it. Duplicate keeps this firmware as it is and puts the module in a copy instead.</p>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn" onClick={() => void run(true)} disabled={busy}>
          Duplicate
        </button>
        <button className="btn primary" onClick={() => void run(false)} disabled={busy} autoFocus>
          OK
        </button>
      </div>
    </Dialog>
  );
}

/** What a new file starts with, by kind. */
function starter(name: string): string {
  const n = name.toLowerCase();
  if (n === "config.h" || n.endsWith(".h")) return "#pragma once\n\n";
  if (n.endsWith(".c")) return "#include QMK_KEYBOARD_H\n\n";
  if (n === "rules.mk") return "VIA_ENABLE = yes\n";
  return "";
}

/** A small inline name field: Enter or leaving it keeps the name, Esc cancels (null). */
function NameInput(props: { initial: string; label: string; placeholder?: string; onDone(name: string | null): void }) {
  const { initial, label, placeholder, onDone } = props;
  let finished = false;
  const finish = (v: string | null) => {
    if (finished) return;
    finished = true;
    onDone(v === null || !v.trim() ? null : v.trim());
  };
  return (
    <input
      className="fw-name-input"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

export function FileGlyph({ path }: { path: string }) {
  const ext = path.split(".").pop()?.toLowerCase();
  const label = ext === "c" ? "C" : ext === "h" ? "H" : ext === "mk" ? "MK" : ext === "json" ? "{}" : "·";
  return (
    <span className={`file-glyph ext-${ext}`} aria-hidden>
      {label}
    </span>
  );
}

function TickIcon() {
  return (
    <svg className="ctx-tick" viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
