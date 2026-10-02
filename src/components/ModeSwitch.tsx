import { useStore } from "../state/store";

/** Top of the sidebar: the app's two sides. */
export function ModeSwitch() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      <button role="tab" aria-selected={mode === "profiles"} onClick={() => setMode("profiles")} title="Remaps, macros and lighting per program">
        Profiles
      </button>
      <button role="tab" aria-selected={mode === "firmware"} onClick={() => setMode("firmware")} title="Build and flash your keyboard's firmware">
        Firmware
      </button>
    </div>
  );
}
