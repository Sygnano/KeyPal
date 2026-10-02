import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { RunningProgram } from "../lib/types";
import { useStore } from "../state/store";
import { Dialog } from "./Dialog";
import { ProgramIcon } from "./ProgramIcon";

/** Pick a program from the windows open right now, optionally only while its title matches. */
export function ProgramPicker({ profileId, onClose }: { profileId: string; onClose(): void }) {
  const profile = useStore((s) => s.draft.profiles.find((p) => p.id === profileId));
  const addProgram = useStore((s) => s.addProgram);
  const [list, setList] = useState<RunningProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = () => {
    setList(null);
    api.listRunningPrograms().then(setList, (e) => setError(String(e)));
  };
  useEffect(load, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
  }, [list, query]);

  const pick = (p: RunningProgram, withTitle: boolean) => {
    addProgram(profileId, withTitle ? { path: p.path, title: p.title } : { path: p.path });
    onClose();
  };

  return (
    <Dialog title={`Add a program to ${profile?.name ?? "this profile"}`} onClose={onClose} wide>
      <div className="picker-top">
        <input
          className="picker-search"
          autoFocus
          placeholder="Search by program or window title"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-ghost" onClick={load} title="List the open windows again">
          Refresh
        </button>
      </div>
      <p className="option-text small">
        Start the game or program first, then pick it here. "Only this title" also checks the window title, for
        programs like browsers or launchers that show many things.
      </p>
      {error && <p className="warn">Could not list the open windows: {error}</p>}
      {!list && !error && <p className="empty">Looking at the open windows…</p>}
      {list && (
        <ul className="running-list">
          {shown.map((p) => (
            <li key={`${p.path}|${p.title}`} className="running">
              <button className="running-main" onClick={() => pick(p, false)} title={p.path}>
                <span className="running-name mono">
                  <ProgramIcon path={p.path} />
                  {p.name}
                </span>
                <span className="running-title">{p.title}</span>
              </button>
              <button className="btn btn-ghost btn-small" onClick={() => pick(p, true)} title={`Only while the title contains “${p.title}”`}>
                Only this title
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="empty">No open window matches.</li>}
        </ul>
      )}
    </Dialog>
  );
}
