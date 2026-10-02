import { useState, type ReactNode } from "react";
import { isMock } from "../lib/api";
import { BOARD } from "../lib/layout";
import { useStore } from "../state/store";
import { BoardPicker } from "./BoardPicker";
import { Dialog } from "./Dialog";

type Tone = "ok" | "warn" | "todo";

/**
 * The getting-started guide: opens by itself until closed once (Settings reopens it). Three steps,
 * each showing where things stand now: the keyboard, the firmware module, how profiles work.
 */
export function GettingStarted() {
  const engine = useStore((s) => s.engine);
  const boardId = useStore((s) => s.boardId);
  useStore((s) => s.boardVersion); // the board's name comes from the layout module
  const { openGuide, setMode } = useStore.getState();
  const [picking, setPicking] = useState(false);
  const close = () => openGuide(false);

  const keyboard: [Tone, ReactNode] = engine.connected
    ? ["ok", <>Found: <strong>{BOARD.name}</strong>.</>]
    : isMock
      ? ["todo", "This is the browser preview: no keyboard can be reached from here. The installed app finds it."]
      : [
          "todo",
          <>
            Plug in your Keychron keyboard with its USB cable (a wireless connection doesn't carry the app's commands).
            {engine.lastError ? ` ${engine.lastError}` : ""}
            {boardId ? ` Until then the app shows the ${BOARD.name}.` : ""}
          </>,
        ];

  const firmware: [Tone, ReactNode] = !engine.connected
    ? [
        "todo",
        "Once the keyboard is found, this says whether its firmware has the profile switcher module. Without it only the lighting effects can change per program.",
      ]
    : engine.firmware !== "ok"
      ? [
          "warn",
          "Its firmware doesn't have the profile switcher module yet: remaps, macros and per-key colours need it (only lighting effects change without it). The app can install Keychron's firmware with it in a minute; the Firmware tab builds your own.",
        ]
      : ["ok", "Profile switcher installed: everything the app does works."];

  const goFirmware = () => {
    close();
    setMode("firmware");
  };

  return (
    <Dialog title="Getting started" onClose={close}>
      <ol className="guide">
        <Step n={1} tone={keyboard[0]} title="Your keyboard">
          <p className="option-text">{keyboard[1]}</p>
          {!engine.connected && (
            <>
              <button className="link-btn" onClick={() => setPicking(!picking)}>
                {picking ? "Close the list" : "Pick it to set profiles up now"}
              </button>
              {picking && <BoardPicker onPicked={() => setPicking(false)} />}
            </>
          )}
        </Step>
        <Step n={2} tone={firmware[0]} title="The firmware module">
          <p className="option-text">{firmware[1]}</p>
          {(firmware[0] === "warn" || (!engine.connected && !isMock && !!boardId)) && (
            <div className="option-actions">
              <button
                className="btn btn-ghost btn-small"
                onClick={() => {
                  close();
                  useStore.getState().openInstall(true);
                }}
              >
                Install it…
              </button>
              <button className="link-btn" onClick={goFirmware}>
                Open the Firmware tab
              </button>
            </div>
          )}
        </Step>
        <Step n={3} tone="ok" title="Profiles">
          <p className="option-text">
            <strong>Default</strong> is what the keyboard does when no other profile matches the program in front. <strong>+ New</strong>{" "}
            makes a profile from Default; add the programs it's for (from open windows, an .exe, a folder or a window title),
            then change keys, macros and lighting. Edits reach the keyboard when you press <strong>Apply</strong>. The play
            button forces a profile whatever program is in front; press it again (✕) to go back to automatic.
          </p>
        </Step>
      </ol>
      <div className="dialog-actions">
        <span className="muted small">Settings → Getting started shows this again.</span>
        <button className="btn btn-primary" onClick={close}>
          Got it
        </button>
      </div>
    </Dialog>
  );
}

function Step(props: { n: number; tone: Tone; title: string; children: ReactNode }) {
  return (
    <li className="guide-step">
      <span className={`check-dot tone-${props.tone === "todo" ? "idle" : props.tone}`} aria-hidden>
        {props.tone === "ok" ? "✓" : props.tone === "warn" ? "!" : props.n}
      </span>
      <div>
        <h3 className="guide-title">{props.title}</h3>
        {props.children}
      </div>
    </li>
  );
}
