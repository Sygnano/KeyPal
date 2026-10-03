import { useState } from "react";
import { api, isMock } from "../lib/api";
import { BOARD } from "../lib/layout";
import { clampGap, MAX_MACRO_GAP, moduleStatus } from "../lib/limits";
import type { Theme } from "../lib/types";
import { type KeyLabels, useStore } from "../state/store";
import { BoardPicker } from "./BoardPicker";
import { Dialog } from "./Dialog";

const THEMES: Array<[Theme, string]> = [
  ["system", "Like Windows"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** App settings for this PC: everything that isn't part of a profile. Applied at once. */
export function SettingsDialog() {
  const [picking, setPicking] = useState(false);
  // Redrawn when another keyboard is shown (its name comes from the layout module).
  useStore((s) => s.boardVersion);
  const settings = useStore((s) => s.settings);
  const layerNames = settings.layerNames;
  const autostart = useStore((s) => s.autostart);
  const keyLabels = useStore((s) => s.keyLabels);
  const appInfo = useStore((s) => s.appInfo);
  const engine = useStore((s) => s.engine);
  const moduleState = moduleStatus(engine);
  const base = useStore((s) => s.base);
  const profiles = useStore((s) => s.draft.profiles.length);
  const {
    openSettings,
    updateSettings,
    setAutostart,
    setKeyLabels,
    exportAll,
    importProfiles,
    refreshBase,
  } = useStore.getState();
  const close = () => openSettings(false);

  return (
    <Dialog title="Settings" onClose={close}>
      <section className="settings-section">
        <button
          className="link-btn"
          onClick={() => {
            close();
            useStore.getState().openGuide(true);
          }}
        >
          Getting started: the keyboard, its firmware, how profiles work
        </button>
      </section>

      <section className="settings-section">
        <h3>Appearance</h3>
        <div
          className="segmented theme-choice"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEMES.map(([theme, label]) => (
            <button
              key={theme}
              role="radio"
              aria-checked={settings.theme === theme}
              onClick={() => updateSettings({ theme })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3>Start-up and window</h3>
        {autostart !== null && (
          <label className="check">
            <input
              type="checkbox"
              checked={autostart}
              onChange={(e) => setAutostart(e.target.checked)}
            />
            Start with Windows (in the tray)
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={settings.closeToTray}
            onChange={(e) => updateSettings({ closeToTray: e.target.checked })}
          />
          Closing the window keeps the app running in the tray
        </label>
        <p className="option-text small">
          {settings.closeToTray
            ? "Profiles keep switching while the window is closed. Quit from the tray icon."
            : "Closing the window quits: profiles stop switching and the keyboard keeps the last one until it's unplugged."}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.notifyOnSwitch}
            onChange={(e) =>
              updateSettings({ notifyOnSwitch: e.target.checked })
            }
          />
          Show a notification when the profile changes
        </label>
        <p className="option-text small">
          Not while this window is in front. Windows hides them during
          full-screen games.
        </p>
      </section>

      <section className="settings-section">
        <h3>Keyboard</h3>
        <KeyLabelsSelect labels={keyLabels} onChange={setKeyLabels} />
        <p className="option-text small">
          Layer names: double-click a layer tab on the Keys tab to rename it
          (saved on this PC).
          {Object.keys(layerNames).length > 0 && (
            <button
              className="link-btn"
              onClick={() => updateSettings({ layerNames: {} })}
            >
              Back to "Layer 0, 1…"
            </button>
          )}
        </p>
        <dl className="facts small">
          <dt>Keyboard</dt>
          <dd>
            {engine.connected
              ? `${BOARD.name}, ${
                  moduleState === "current"
                    ? "with the profile switcher"
                    : moduleState === "old"
                      ? "with the profile switcher, and an update available"
                      : "no profile switcher in its firmware"
                }`
              : `${BOARD.name || "None yet"} (not plugged in)`}
            {!engine.connected && (
              <button className="link-btn" onClick={() => setPicking(!picking)}>
                {picking ? "Close" : "Another one…"}
              </button>
            )}
          </dd>
          <dt>Keymap</dt>
          <dd>
            {base.source === "keyboard"
              ? `Read from the keyboard (layer ${base.layer})`
              : base.source === "cache"
                ? "Last read from the keyboard"
                : "Keychron's default"}
            {engine.connected && (
              <button className="link-btn" onClick={refreshBase}>
                Read again
              </button>
            )}
          </dd>
          {picking && !engine.connected && (
            <dd className="facts-wide">
              <BoardPicker onPicked={() => setPicking(false)} />
            </dd>
          )}
          <dt>Mix RGB</dt>
          <dd>
            {engine.connected
              ? engine.mixRgb
                ? "Available"
                : "Not on this keyboard"
              : "—"}
          </dd>
        </dl>
        <div className="option-actions">
          <button
            className="btn btn-ghost"
            onClick={() => {
              close();
              useStore.getState().openBackups(true);
            }}
          >
            Firmware backups…
          </button>
        </div>
        {/* Three states, and no version numbers anywhere. */}
        {moduleState === "current" ? (
          <p className="option-text small ok-text">
            ✓ Profile switcher installed
          </p>
        ) : (
          <>
            {moduleState === "old" && (
              <p className="option-text small">
                Profile switcher installed —{" "}
                <strong>an update is available</strong>. What is on the keyboard
                works; the newer one adds what this version of the app can do
                with it.
              </p>
            )}
            <div className="option-actions">
              <button
                className="btn btn-ghost"
                disabled={!BOARD.name}
                onClick={() => {
                  close();
                  useStore.getState().openInstall(true);
                }}
              >
                {moduleState === "old"
                  ? "Update the profile switcher firmware…"
                  : "Install the profile switcher firmware…"}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="settings-section">
        <h3>Profiles</h3>
        <div className="option-actions">
          <button className="btn btn-ghost" onClick={exportAll}>
            Export all {profiles} profiles…
          </button>
          <button className="btn btn-ghost" onClick={importProfiles}>
            Import profiles…
          </button>
        </div>
        <p className="option-text small">
          An export is one file you can back up or share. Importing adds the
          profiles next to yours (nothing is replaced); apply to keep them.
        </p>
        <label className="gap-field">
          Gap between macro keys
          <input
            type="number"
            min={0}
            max={MAX_MACRO_GAP}
            value={settings.macroGap}
            aria-label="Gap between macro keys, in milliseconds"
            onChange={(e) => updateSettings({ macroGap: clampGap(e.target.value) ?? 0 })}
          />
          ms
        </label>
        <p className="option-text small">
          How long a macro waits after each key press or release, for macros
          without a gap of their own. A delay step replaces it where there is
          one. Games that read the keyboard once per frame can miss keys sent
          closer together.
        </p>
      </section>

      <section className="settings-section">
        <h3>Files and logs</h3>
        <dl className="facts small">
          <dt>Settings</dt>
          <dd className="mono path" title={appInfo?.configDir}>
            {appInfo?.configDir ?? "…"}
          </dd>
          <dt>Logs</dt>
          <dd className="mono path" title={appInfo?.logDir}>
            {appInfo?.logDir ?? "…"}
          </dd>
        </dl>
        <div className="option-actions">
          <button
            className="btn btn-ghost"
            disabled={isMock}
            onClick={() => api.openFolder("config")}
          >
            Open settings folder
          </button>
          <button
            className="btn btn-ghost"
            disabled={isMock}
            onClick={() => api.openFolder("logs")}
          >
            Open logs folder
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.verboseLog}
            onChange={(e) => updateSettings({ verboseLog: e.target.checked })}
          />
          Detailed logs (every focus change), to report a problem
        </label>
        <p className="option-text small">
          profiles.json holds your profiles, settings.json these settings,
          base_keymap.json the last keymap read from the keyboard. The log
          (v6ps.log) keeps the last few megabytes.
        </p>
      </section>

      <UpdatesSection />

      <footer className="settings-foot">
        <span className="muted">
          KBoard Companion {appInfo?.version ?? ""} · GPL-3.0
        </span>
      </footer>
    </Dialog>
  );
}

/** Which keyboard layout the key legends show (the keyboard itself only knows key positions). */
function KeyLabelsSelect({
  labels,
  onChange,
}: {
  labels: KeyLabels;
  onChange: (choice: string) => void;
}) {
  const { choice, layouts, current } = labels;
  const name = (id: string | null) =>
    layouts.find((l) => l.id === id)?.name ?? id;
  const installed = layouts.filter((l) => l.installed);
  const others = layouts.filter((l) => !l.installed);
  // A saved choice Windows no longer lists still shows, rather than a blank select.
  const missing = choice !== "auto" && !layouts.some((l) => l.id === choice);
  return (
    <label
      className="field"
      title="Only changes what the keys show here. Your keyboard types with the layout chosen in Windows."
    >
      <span>Key labels</span>
      <select value={choice} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">
          {current ? `Automatic (Windows: ${name(current)})` : "Automatic"}
        </option>
        {missing && <option value={choice}>{choice}</option>}
        {installed.length > 0 && (
          <optgroup label="On this PC">
            {installed.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="All layouts">
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** New versions come from the project's GitHub releases, signed; installing restarts the app. */
function UpdatesSection() {
  const update = useStore((s) => s.update);
  const version = useStore((s) => s.appInfo?.version);
  const settings = useStore((s) => s.settings);
  const { checkForUpdate, installUpdate, updateSettings } = useStore.getState();
  const busy = update.state === "checking" || update.state === "installing";
  return (
    <section className="settings-section">
      <h3>Updates</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.checkUpdatesOnStart}
          onChange={(e) =>
            updateSettings({ checkUpdatesOnStart: e.target.checked })
          }
        />
        Check for a newer version when the app starts
      </label>
      <p className="option-text small">
        {isMock
          ? "The browser preview doesn't update."
          : update.state === "available" && update.info
            ? `Version ${update.info.version} is available (this is ${version ?? "?"}).`
            : update.state === "installing"
              ? "Downloading and installing… the app restarts by itself."
              : update.state === "none"
                ? `This is the latest version (${version ?? "?"}).`
                : update.state === "error"
                  ? `Couldn't check: ${update.error}`
                  : `Version ${version ?? "?"}.`}
      </p>
      {update.info?.notes && update.state === "available" && (
        <p className="option-text small update-notes">{update.info.notes}</p>
      )}
      <div className="option-actions">
        <button
          className="btn btn-ghost btn-small"
          disabled={busy || isMock}
          onClick={() => checkForUpdate()}
        >
          {update.state === "checking" ? "Checking…" : "Check now"}
        </button>
        {update.state === "available" && (
          <button
            className="btn btn-primary btn-small"
            disabled={busy}
            onClick={installUpdate}
          >
            Install and restart
          </button>
        )}
      </div>
    </section>
  );
}
