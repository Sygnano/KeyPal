import { useMemo, useState } from "react";
import { BOARDS, type BoardInfo } from "../lib/boards";
import { useStore } from "../state/store";

/** Search and pick a keyboard among every Keychron board the app knows. */
export function BoardPicker({ onPicked }: { onPicked?(board: BoardInfo): void }) {
  const current = useStore((s) => s.boardId);
  const showBoard = useStore((s) => s.showBoard);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return BOARDS.filter((b) => words.every((w) => b.name.toLowerCase().includes(w) || b.id.includes(w)));
  }, [query]);

  return (
    <div className="board-picker">
      <input
        className="picker-search"
        autoFocus
        value={query}
        placeholder={`Search ${BOARDS.length} keyboards: q1 max, v6 iso, k8 pro…`}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="board-list" role="listbox" aria-label="Keychron keyboards">
        {shown.map((b) => (
          <li key={b.id}>
            <button
              role="option"
              aria-selected={b.id === current}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await showBoard(b.id).catch((e) => useStore.setState({ error: String(e) }));
                setBusy(false);
                onPicked?.(b);
              }}
            >
              <span className="board-name">{b.name}</span>
              <span className="muted small">
                {b.lighting === "rgb" ? "RGB" : b.lighting === "white" ? "White backlight" : "No backlight"}
                {b.encoders ? ` · ${b.encoders === 1 ? "knob" : `${b.encoders} knobs`}` : ""}
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">No keyboard matches "{query}".</li>}
      </ul>
    </div>
  );
}

/** The main area before any keyboard is known: plug one in, or pick it to set profiles up now. */
export function FirstRun() {
  const lastError = useStore((s) => s.engine.lastError);
  return (
    <section className="panel first-run">
      <h2 className="panel-title">Plug in your Keychron keyboard</h2>
      <p className="option-text">
        With its USB cable (wireless connections don't carry the app's commands). The app finds it and shows it here.
        {lastError ? ` ${lastError}` : ""}
      </p>
      <p className="option-text">Or pick it to set up profiles now:</p>
      <BoardPicker />
    </section>
  );
}
