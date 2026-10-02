import { isMock } from "../lib/api";
import { BOARD } from "../lib/layout";
import { moduleStatus } from "../lib/limits";
import { useStore } from "../state/store";

/** "V6 8K ISO Knob" from "Keychron V6 8K ISO Knob". */
const shortName = () => BOARD.name.replace(/^Keychron\s+/, "") || "Keyboard";

export function StatusLine() {
  const engine = useStore((s) => s.engine);
  // The keyboard holds the *saved* profile, so that is the name to show. But a profile renamed
  // and not yet applied would otherwise look like the app ignoring the rename, so say so.
  const active = useStore((s) => s.saved.profiles.find((p) => p.id === s.engine.activeProfileId));
  const draftName = useStore((s) => s.draft.profiles.find((p) => p.id === s.engine.activeProfileId)?.name);
  const renamed = !!active && !!draftName && draftName !== active.name;
  // The profile switcher missing, or older than this app would like. No version number either
  // way (see `moduleStatus`).
  const state = moduleStatus(engine);

  let text: string;
  let tone: "ok" | "warn" | "off";
  if (isMock) {
    text = "Preview mode: no keyboard access in the browser";
    tone = "off";
  } else if (!engine.connected) {
    text = engine.lastError ?? `Keyboard not found. Plug in ${BOARD.name ? `the ${shortName()}` : "your Keychron keyboard"} with its cable.`;
    tone = engine.lastError ? "warn" : "off";
  } else if (engine.firmware === "missing") {
    text = "Connected, but the firmware has no profile switcher. Only lighting will change.";
    tone = "warn";
  } else if (engine.lastError) {
    text = engine.lastError;
    tone = "warn";
  } else {
    const pinned = engine.mode === "manual" ? " (pinned)" : "";
    const module = state === "old" ? " · a firmware update is available" : "";
    const unapplied = renamed ? ` — renamed to "${draftName}", not applied yet` : "";
    text = `${shortName()}: ${active?.name ?? "Default"}${pinned}${unapplied}${module}`;
    tone = "ok";
  }

  const install = !isMock && (engine.connected ? state !== "current" : !!engine.unreachable);
  const updating = !isMock && engine.connected && state === "old";

  return (
    <div className={`status status-${tone}`} role="status">
      <span className="status-led" aria-hidden />
      <span>{text}</span>
      {install && (
        <button className="link-btn" onClick={() => useStore.getState().openInstall(true)}>
          {updating ? "Update it…" : "Install it…"}
        </button>
      )}
    </div>
  );
}
