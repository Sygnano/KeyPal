import { Suspense, lazy, useEffect } from "react";
import { BindDetail } from "./components/BindDetail";
import { BindList } from "./components/BindList";
import { FirstRun } from "./components/BoardPicker";
import { GettingStarted } from "./components/GettingStarted";
import { InstallFirmwareDialog } from "./components/InstallFirmwareDialog";
import { BackupsDialog } from "./components/firmware/Backups";
import { TesterControls } from "./components/KeyTester";
import { KeyboardView } from "./components/KeyboardView";
import { LayerTabs } from "./components/LayerTabs";
import { LightingPanel } from "./components/LightingPanel";
import { GearIcon, ProfileList } from "./components/ProfileList";
import { ProfileOptions } from "./components/ProfileOptions";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusLine } from "./components/StatusLine";
import { useCloseGuard } from "./lib/closeGuard";
import { isEditable } from "./lib/appFeel";
import { useFirmware } from "./state/firmwareStore";
import { useStore } from "./state/store";

const FirmwareView = lazy(() => import("./components/firmware/FirmwareView"));

export function App() {
  const ready = useStore((s) => s.ready);
  const tab = useStore((s) => s.tab);
  const mode = useStore((s) => s.mode);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const guideOpen = useStore((s) => s.guideOpen);
  const installOpen = useStore((s) => s.installOpen);
  const backupsOpen = useStore((s) => s.backupsOpen);
  const { setTab, clearError, clearNotice, openSettings } = useStore.getState();
  // The key legends live outside React (qmk/labels); remount the views when they change.
  const labelsVersion = useStore((s) => s.keyLabels.version);
  // …and the keyboard's layout, when another keyboard is shown.
  const boardVersion = useStore((s) => s.boardVersion);
  const boardId = useStore((s) => s.boardId);

  useEffect(() => {
    let stopped = false;
    const stop = useStore
      .getState()
      .init()
      .catch((e) => {
        useStore.setState({ error: String(e), ready: true });
        return () => {};
      });
    // StrictMode mounts effects twice in development: without this the second `init` added a
    // second set of backend listeners and every event was handled twice.
    return () => {
      stopped = true;
      void stop.then((off) => stopped && off());
    };
  }, []);
  useCloseGuard();

  // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z): undo and redo, of the profiles or of the firmware files
  // (the side shown). Text fields and the code editor keep their own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isEditable(e.target)) return;
      // The keyboard tester has every key to itself.
      if (useStore.getState().testing && useStore.getState().mode === "profiles") return;
      const k = e.key.toLowerCase();
      const history =
        useStore.getState().mode === "firmware"
          ? useFirmware.getState()
          : useStore.getState();
      if (k === "z" && !e.shiftKey) history.undo();
      else if (k === "y" || (k === "z" && e.shiftKey)) history.redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 4000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  if (!ready) return <div className="loading">Loading profiles…</div>;

  // Both modes get these. Settings can open the guide and the firmware installer from either one,
  // and an error from the profile side (saving a setting, say) has to be visible wherever it is
  // raised — the firmware side's own toast carries only the firmware store's errors.
  const dialogs = (
    <>
      {settingsOpen && <SettingsDialog />}
      {guideOpen && !settingsOpen && <GettingStarted />}
      {installOpen && <InstallFirmwareDialog />}
      {backupsOpen && !installOpen && <BackupsDialog />}
    </>
  );
  const toast = error ? (
    <div className="toast" role="alert">
      <span>{error}</span>
      <button className="icon-btn" aria-label="Dismiss" onClick={clearError}>
        ×
      </button>
    </div>
  ) : (
    notice && (
      <div className="toast is-notice" role="status">
        <span>{notice}</span>
        <button className="icon-btn" aria-label="Dismiss" onClick={clearNotice}>
          ×
        </button>
      </div>
    )
  );

  if (mode === "firmware") {
    return (
      <div className="app">
        <Suspense
          fallback={<div className="loading">Loading the firmware tools…</div>}
        >
          <FirmwareView />
        </Suspense>
        {dialogs}
        {toast}
      </div>
    );
  }

  return (
    <div className="app">
      <ProfileList />
      <main className="main" key={`${labelsVersion}:${boardVersion}`}>
        <header className="main-header">
          <div className="header-left">
            <div className="tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === "keys"}
                className="tab"
                onClick={() => setTab("keys")}
              >
                Keys
              </button>
              <button
                role="tab"
                aria-selected={tab === "lighting"}
                className="tab"
                onClick={() => setTab("lighting")}
              >
                Lighting
              </button>
            </div>
            {tab === "keys" && <LayerTabs />}
          </div>
          <div className="header-right">
            {boardId && <TesterControls />}
            <StatusLine />
            <button
              className="icon-btn"
              aria-label="Settings"
              title="Settings"
              onClick={() => openSettings(true)}
            >
              <GearIcon />
            </button>
          </div>
        </header>

        {!boardId ? <FirstRun /> : <KeyboardView mode={tab} />}

        {!boardId ? null : tab === "keys" ? (
          <section className="panels">
            <BindList />
            <BindDetail />
            <ProfileOptions />
          </section>
        ) : (
          <LightingPanel />
        )}
      </main>
      {dialogs}
      {toast}
    </div>
  );
}
