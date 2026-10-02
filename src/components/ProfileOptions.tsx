import { ruleLabel } from "../lib/programs";
import { DEFAULT_PROFILE_ID } from "../lib/types";
import { useSelectedProfile, useStore } from "../state/store";
import {
  MACRO_BUFFER_BYTES,
  MACRO_SLOTS,
  macroBytes,
} from "../lib/limits";

export function ProfileOptions() {
  const profile = useSelectedProfile();
  const defaultBinds = useStore((s) => s.draft.profiles[0].binds);
  const focus = useStore((s) => s.focus);
  const { duplicateProfile, exportProfile } = useStore.getState();
  const isDefault = profile.id === DEFAULT_PROFILE_ID;

  const macros = Object.values(profile.binds).filter((b) => b.kind === "macro");
  const bytes = macros.reduce(
    (n, b) => n + (b.kind === "macro" ? macroBytes(b.steps) : 0),
    0,
  );
  const over = bytes > MACRO_BUFFER_BYTES || macros.length > MACRO_SLOTS;

  const setBinds = (binds: typeof profile.binds) =>
    useStore.setState((s) => ({
      draft: {
        ...s.draft,
        profiles: s.draft.profiles.map((p) =>
          p.id === profile.id ? { ...p, binds } : p,
        ),
      },
      selectedKeyId: null,
    }));

  const programs = profile.programs.map((r) => ruleLabel(r).name);

  return (
    <section className="panel options">
      <h2 className="panel-title">Profile</h2>

      <p className="option-text">
        {isDefault
          ? "Used whenever the focused program has no profile of its own."
          : programs.length
            ? `Turns on when ${programs.join(", ")} is focused.`
            : "No program attached yet: add one in the list, or use the play button."}
      </p>

      <div className="option-actions">
        {!isDefault && (
          <button
            className="btn btn-ghost"
            onClick={() => setBinds(structuredClone(defaultBinds))}
          >
            Copy remaps from Default
          </button>
        )}
        <button
          className="btn btn-ghost"
          disabled={!Object.keys(profile.binds).length}
          onClick={() => setBinds({})}
        >
          Clear all remaps
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => duplicateProfile(profile.id)}
        >
          Duplicate
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => exportProfile(profile.id)}
        >
          Export…
        </button>
      </div>

      <div className={`meter ${over ? "is-over" : ""}`}>
        <div className="meter-label">
          <span>Macro memory</span>
          <span>
            {bytes} / {MACRO_BUFFER_BYTES} bytes
          </span>
        </div>
        <div className="meter-bar">
          <span
            style={{
              width: `${Math.min(100, (bytes / MACRO_BUFFER_BYTES) * 100)}%`,
            }}
          />
        </div>
        {over && (
          <p className="warn">
            Too many macro steps for the keyboard; shorten a macro before
            applying.
          </p>
        )}
      </div>

      <dl className="facts small">
        <dt>Focused</dt>
        <dd className="mono" title={focus.path ?? undefined}>
          {focus.exe ?? "—"}
        </dd>
        {focus.title && (
          <>
            <dt>Title</dt>
            <dd className="focus-title" title={focus.title}>
              {focus.title}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
