import * as DM from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import {
  dropClass,
  useDragReorder,
  type DragReorder,
} from "../lib/dragReorder";
import { MATCH_LABELS, ruleLabel } from "../lib/programs";
import {
  DEFAULT_PROFILE_ID,
  type Profile,
  type ProgramMatch,
  type ProgramRule,
} from "../lib/types";
import { useDirty, useStore } from "../state/store";
import { ModeSwitch } from "./ModeSwitch";
import { ProgramIcon } from "./ProgramIcon";
import { ProgramPicker } from "./ProgramPicker";

export function ProfileList() {
  const profiles = useStore((s) => s.draft.profiles);
  const addProfile = useStore((s) => s.addProfile);
  const importProfiles = useStore((s) => s.importProfiles);
  const dirty = useDirty();
  const busy = useStore((s) => s.busy);
  const canUndo = useStore((s) => s.history.past.length > 0);
  const canRedo = useStore((s) => s.history.future.length > 0);
  const { apply, discard, undo, redo } = useStore.getState();
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const ids = profiles.map((p) => p.id);
  // Default stays first: it's the fallback, not one of the ranked profiles.
  const drag = useDragReorder(ids, useStore.getState().moveProfile, 1);

  return (
    <aside className="sidebar">
      <ModeSwitch />
      <div className="sidebar-head">
        <h1 className="app-title">Profiles</h1>
        <div className="sidebar-tools">
          <button
            className="icon-btn"
            onClick={importProfiles}
            title="Import profiles from a file"
            aria-label="Import profiles"
          >
            <ImportIcon />
          </button>
          <button
            className="add-btn"
            onClick={addProfile}
            title="New profile (copies the default profile)"
          >
            <span aria-hidden>+</span> New
          </button>
        </div>
      </div>

      <ul className="profile-list">
        {profiles.map((p, i) => (
          <ProfileRow
            key={p.id}
            profile={p}
            index={i}
            count={profiles.length}
            drag={drag}
            dropAt={dropClass(drag, ids, p.id)}
            onPickRunning={() => setPickerFor(p.id)}
          />
        ))}
      </ul>

      <div className="commit-bar">
        <div className="commit-top">
          <span className="commit-hint">
            {dirty ? "Unapplied changes" : "Everything applied"}
          </span>
          <span className="undo-tools">
            <button
              className="icon-btn"
              disabled={!canUndo}
              onClick={undo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <UndoIcon />
            </button>
            <button
              className="icon-btn"
              disabled={!canRedo}
              onClick={redo}
              title="Redo (Ctrl+Y)"
              aria-label="Redo"
            >
              <UndoIcon redo />
            </button>
          </span>
        </div>
        <div className="commit-actions">
          <button
            className="btn btn-apply"
            disabled={!dirty || busy}
            onClick={apply}
            title="Save and send to the keyboard"
          >
            <CheckIcon /> Apply
          </button>
          <button
            className="btn btn-discard"
            disabled={!dirty || busy}
            onClick={discard}
            title="Discard changes"
          >
            <CrossIcon /> Discard
          </button>
        </div>
      </div>

      {pickerFor && (
        <ProgramPicker
          profileId={pickerFor}
          onClose={() => setPickerFor(null)}
        />
      )}
    </aside>
  );
}

function ProfileRow(props: {
  profile: Profile;
  index: number;
  count: number;
  drag: DragReorder;
  dropAt: string;
  onPickRunning(): void;
}) {
  const { profile, index, count: total, drag, dropAt, onPickRunning } = props;
  const isDefault = profile.id === DEFAULT_PROFILE_ID;
  const selected = useStore((s) => s.selectedProfileId === profile.id);
  // Only these two fields, not the whole `engine`: it carries the focused window's title, which
  // changes up to four times a second and would re-render every row with it.
  const active = useStore((s) => s.engine.activeProfileId === profile.id);
  const manual = useStore((s) => s.engine.mode === "manual");
  const collapsed = useStore((s) => !!s.collapsed[profile.id]);
  const existsSaved = useStore((s) =>
    s.saved.profiles.some((p) => p.id === profile.id),
  );
  // The whole config's `dirty` flag is cheap to check first: skip the per-profile compare
  // entirely while nothing at all has changed yet, which is the common resting state.
  const dirty = useStore(
    (s) => s.dirty && s.dirtyProfiles.includes(profile.id),
  );
  const { selectProfile, renameProfile, toggleCollapsed, play, release } =
    useStore.getState();

  const pinned = active && manual;
  // The button's name is what it *does*. The reason it is off ("Apply to use this profile") is
  // visible text under the name instead: a disabled button shows no tooltip in WebView2, and a
  // screen reader announcing "Apply changes before using this profile" as the button's name made
  // it sound like a button that applies changes.
  const playTitle = pinned
    ? "Stop forcing this profile and switch by program again"
    : isDefault
      ? "Force Default, even when a program has its own profile"
      : "Force this profile, whatever program is focused";
  const count = profile.programs.length;

  return (
    <li
      className={`profile ${selected ? "is-selected" : ""} ${active ? "is-active" : ""} ${dropAt}`}
      {...drag.rowProps(profile.id)}
    >
      <div className="profile-row" onClick={() => selectProfile(profile.id)}>
        <button
          className={`play-btn ${active ? "is-on" : ""} ${pinned ? "is-pinned" : ""}`}
          aria-label={playTitle}
          title={existsSaved || pinned ? playTitle : undefined}
          disabled={!existsSaved && !pinned}
          onClick={(e) => {
            e.stopPropagation();
            if (pinned) release();
            else play(profile.id);
          }}
        >
          {pinned ? <CrossIcon /> : <PlayIcon filled={active} />}
        </button>

        <div className="profile-name-wrap">
          {isDefault ? (
            <span className="profile-name">Default</span>
          ) : (
            <input
              className="profile-name profile-name-input"
              data-drag-ok
              value={profile.name}
              aria-label="Profile name"
              spellCheck={false}
              onFocus={() => selectProfile(profile.id)}
              onChange={(e) => renameProfile(profile.id, e.target.value)}
              onBlur={(e) =>
                !e.target.value.trim() && renameProfile(profile.id, "Untitled")
              }
            />
          )}
          <span className="profile-sub">
            {/* The play button is off until the profile has been applied. WebView2 shows no
                tooltip on a disabled button, so the reason has to be readable here. */}
            {!existsSaved && !pinned
              ? "Apply to use this profile"
              : active
                ? pinned
                  ? "Forced"
                  : "Active"
                : isDefault
                  ? "When nothing else matches"
                  : `${count} program${count === 1 ? "" : "s"}`}
            {dirty && <span className="dirty-dot" title="Unapplied changes" />}
          </span>
        </div>

        <div className="row-tools" onClick={(e) => e.stopPropagation()}>
          {!isDefault && (
            <button
              className={`icon-btn chevron ${collapsed ? "" : "is-open"}`}
              aria-label={collapsed ? "Show programs" : "Hide programs"}
              aria-expanded={!collapsed}
              onClick={() => toggleCollapsed(profile.id)}
            >
              <ChevronIcon />
            </button>
          )}
          <ProfileMenu profile={profile} index={index} total={total} />
        </div>
      </div>

      {!isDefault && !collapsed && (
        <ul className="exe-list">
          {profile.programs.map((rule, i) => (
            <ProgramRow
              key={`${i}:${rule.path}`}
              profileId={profile.id}
              index={i}
              rule={rule}
            />
          ))}
          <li className="exe exe-add">
            <span className="exe-branch" aria-hidden />
            <AddProgramMenu
              profileId={profile.id}
              onPickRunning={onPickRunning}
            />
          </li>
        </ul>
      )}
    </li>
  );
}

/** ⋯ on each profile: move, duplicate, export, delete. */
function ProfileMenu({
  profile,
  index,
  total,
}: {
  profile: Profile;
  index: number;
  total: number;
}) {
  const { duplicateProfile, exportProfile, removeProfile, moveProfile } =
    useStore.getState();
  const isDefault = profile.id === DEFAULT_PROFILE_ID;
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button
          className="icon-btn"
          aria-label={`More for ${profile.name}`}
          title="More"
        >
          <DotsIcon />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          className="ctx"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {!isDefault && (
            <>
              <DM.Item
                className="ctx-item"
                disabled={index <= 1}
                onSelect={() => moveProfile(profile.id, index - 1)}
              >
                Move up
              </DM.Item>
              <DM.Item
                className="ctx-item"
                disabled={index >= total - 1}
                onSelect={() => moveProfile(profile.id, index + 1)}
              >
                Move down
              </DM.Item>
              <DM.Separator className="ctx-sep" />
            </>
          )}
          <DM.Item
            className="ctx-item"
            onSelect={() => duplicateProfile(profile.id)}
          >
            Duplicate
          </DM.Item>
          <DM.Item
            className="ctx-item"
            onSelect={() => exportProfile(profile.id)}
          >
            Export to a file…
          </DM.Item>
          {!isDefault && (
            <>
              <DM.Separator className="ctx-sep" />
              <DM.Item
                className="ctx-item danger"
                onSelect={() => removeProfile(profile.id)}
              >
                Delete profile
              </DM.Item>
            </>
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function AddProgramMenu({
  profileId,
  onPickRunning,
}: {
  profileId: string;
  onPickRunning(): void;
}) {
  const { browseProgram, addProgram } = useStore.getState();
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button className="link-btn">Add program…</button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          className="ctx"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <DM.Item className="ctx-item" onSelect={onPickRunning}>
            From open windows…
          </DM.Item>
          <DM.Item
            className="ctx-item"
            onSelect={() => browseProgram(profileId)}
          >
            Browse for a program…
          </DM.Item>
          <DM.Item
            className="ctx-item"
            onSelect={() => browseProgram(profileId, "folder")}
          >
            Every program in a folder…
          </DM.Item>
          <DM.Item
            className="ctx-item"
            onSelect={() => {
              addProgram(profileId, { path: "", title: "" });
              // Open straight on the new rule's title field.
              setTimeout(() => {
                const inputs = document.querySelectorAll<HTMLInputElement>(
                  `[data-rule-title="${profileId}"]`,
                );
                inputs[inputs.length - 1]?.focus();
              }, 30);
            }}
          >
            Any program with a window title…
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** One program rule: its name, and an editor for how it matches. */
function ProgramRow({
  profileId,
  index,
  rule,
}: {
  profileId: string;
  index: number;
  rule: ProgramRule;
}) {
  const { updateProgram, removeProgram } = useStore.getState();
  // A new title-only rule opens with its editor, to fill in the title.
  const [open, setOpen] = useState(!rule.path && !rule.title);
  const { name, detail } = ruleLabel(rule);
  const update = (patch: Partial<ProgramRule>) =>
    updateProgram(profileId, index, { ...rule, ...patch });

  return (
    <li className={`exe-rule ${open ? "is-open" : ""}`}>
      <div className="exe" title={rule.path || undefined}>
        <span className="exe-branch" aria-hidden />
        <button
          className="exe-name-btn"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title="How this program is recognised"
        >
          <ProgramIcon path={rule.path} />
          <span className="exe-name">{name}</span>
          {detail && <span className="exe-detail">{detail}</span>}
        </button>
        <button
          className="icon-btn danger small"
          aria-label={`Remove ${name}`}
          onClick={() => removeProgram(profileId, index)}
        >
          <CrossIcon />
        </button>
      </div>
      {open && (
        <div className="rule-editor">
          {rule.path && (
            <label className="field">
              <span>Match</span>
              <select
                value={rule.match ?? "name"}
                // A folder rule has no program to go back to: browse for one instead.
                disabled={rule.match === "folder"}
                onChange={(e) => {
                  const match = e.target.value as ProgramMatch;
                  update(
                    match === "folder"
                      ? { match, path: folderOf(rule.path) }
                      : { match },
                  );
                }}
              >
                {(["name", "path", "folder"] as const).map((m) => (
                  <option key={m} value={m}>
                    {MATCH_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {rule.path && <p className="rule-path mono">{rule.path}</p>}
          <label className="field">
            <span>
              {rule.path
                ? "Only when the window title contains"
                : "Window title contains"}
            </span>
            <input
              data-rule-title={profileId}
              value={rule.title ?? ""}
              placeholder={rule.path ? "(any title)" : "e.g. Figma"}
              spellCheck={false}
              onChange={(e) => update({ title: e.target.value })}
            />
          </label>
        </div>
      )}
    </li>
  );
}

/** "C:\\Games\\Foo\\foo.exe" → "C:\\Games\\Foo" */
function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

export function PlayIcon({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M4 2.8v10.4L12 8z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UndoRedo({
  canUndo,
  canRedo,
  undo,
  redo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
}) {
  return (
    <span className="undo-tools">
      <button
        className="icon-btn"
        disabled={!canUndo}
        onClick={undo}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        <UndoIcon />
      </button>
      <button
        className="icon-btn"
        disabled={!canRedo}
        onClick={redo}
        title="Redo (Ctrl+Y)"
        aria-label="Redo"
      >
        <UndoIcon redo />
      </button>
    </span>
  );
}

export function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path
        d="M3 8.5l3.2 3L13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function ImportIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        d="M8 2v8M4.8 7L8 10.2 11.2 7M3 12.5h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UndoIcon({ redo }: { redo?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden
      style={redo ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M5.5 3.5L2.5 6.5l3 3M2.8 6.5H10a3.5 3.5 0 010 7H7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        d="M8 5.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zm5.3 3.3l1.2.9-1.3 2.3-1.4-.5a5 5 0 01-1.4.8L10.2 14H7.6l-.2-1.6a5 5 0 01-1.4-.8l-1.4.5-1.3-2.3 1.2-.9a5 5 0 010-1.7l-1.2-.9 1.3-2.3 1.4.5a5 5 0 011.4-.8L7.6 2h2.6l.2 1.6a5 5 0 011.4.8l1.4-.5 1.3 2.3-1.2.9a5 5 0 010 1.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
