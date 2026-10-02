import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { isMock } from "../../lib/api";
import { BOARDS, boardByUsb, boardInfo } from "../../lib/boards";
import type { FwMode } from "../../lib/types";
import {
  splitKey,
  tabsOf,
  useFirmware,
  type FileKey,
} from "../../state/firmwareStore";
import { useStore } from "../../state/store";
import { Dialog } from "../Dialog";
import { CrossIcon, GearIcon } from "../ProfileList";
import { StatusLine } from "../StatusLine";
import { CodeEditor, forgetEditorState } from "./CodeEditor";
import { FileGlyph } from "./FirmwareSidebar";
import { BasicFirmware } from "./BasicFirmware";
import { FlashSteps } from "./FlashSteps";
import type { FlashBoard } from "../../lib/flashTarget";
import {
  BootloaderButton,
  DevicePicker,
  Preflight,
  describeDevice,
  preflightReady,
  useFlashTarget,
} from "./Preflight";

async function confirmAsk(message: string, okLabel: string): Promise<boolean> {
  if (isMock) return window.confirm(message);
  return ask(message, {
    title: "KBoard Companion",
    kind: "warning",
    okLabel,
    cancelLabel: "Cancel",
  });
}

/** Firmware mode's main area: preflight, then either the ready-made firmware (Basic) or the
 * editor and building and flashing (Advanced). */
export function FirmwareMain({ mode }: { mode: FwMode }) {
  const ready = useFirmware((s) => s.ready);
  const status = useFirmware((s) => s.status);
  const project = useFirmware(
    (s) => s.projects.find((p) => p.id === s.selectedId) ?? null,
  );
  const keyboards = useFirmware((s) => s.keyboards);
  const job = useFirmware((s) => s.job);
  const error = useFirmware((s) => s.error);
  const notice = useFirmware((s) => s.notice);
  const openSettings = useStore((s) => s.openSettings);
  const bundled = useFirmware((s) => s.status?.moduleVersion ?? null);
  const openFiles = useFirmware((s) => s.openFiles);
  const buffers = useFirmware((s) => s.buffers);
  const { build, clearError, clearNotice, addModule, saveAll } =
    useFirmware.getState();
  const [flashing, setFlashing] = useState(false);
  const dirty = project
    ? tabsOf(openFiles, project.id).some(
        (k) => buffers[k] && buffers[k].text !== buffers[k].saved,
      )
    : false;

  useEffect(() => {
    useFirmware.getState().init();
    // The keyboard can be plugged, unplugged, or restarted into its bootloader at any time.
    const t = setInterval(() => useFirmware.getState().refreshStatus(), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 5000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  const running = job?.state === "running";
  const { build: canBuild } = preflightReady(status);

  return (
    <main className={`main fw-main ${mode === "basic" ? "is-basic" : ""}`}>
      <header className="main-header">
        <div className="header-left">
          <h2 className="fw-title">
            {mode === "advanced" && project ? project.name : "Firmware"}
          </h2>
          {mode === "advanced" && project && (
            <span className="muted fw-target" title={project.keyboard}>
              {keyboards.find((k) => k.path === project.keyboard)?.name ??
                project.keyboard}{" "}
              · keymap {project.keymap}
            </span>
          )}
        </div>
        <div className="header-right">
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

      {mode === "advanced" && <Preflight mode={mode} />}

      {mode === "basic" ? (
        <BasicFirmware />
      ) : (
        <section className="panel fw-workspace">
          {!ready ? (
            <p className="empty">Loading…</p>
          ) : !project ? (
            <p className="empty">
              Create a firmware project in the sidebar (+ New) to start.
            </p>
          ) : (
            <>
              {/* Any other version, not just an older one: firmware made before the protocol
                  restarted at 1 for 1.0 carries a higher number this app can't talk to. */}
              {project.moduleVersion !== null &&
                bundled !== null &&
                project.moduleVersion !== bundled && (
                  <div className="notice fw-module-notice">
                    <p className="option-text">
                      This firmware has a different profile switcher module from
                      the one bundled with the app, and the app can only talk to
                      its own. Update the module before flashing.
                    </p>
                    <button
                      className="btn btn-ghost btn-small"
                      disabled={running}
                      onClick={() => addModule(project.id)}
                    >
                      Update the module
                    </button>
                  </div>
                )}
              <EditorArea projectId={project.id} />
              <div className="fw-actions">
                <button
                  className="btn btn-ghost"
                  disabled={running || !dirty}
                  onClick={() => saveAll(project.id)}
                  title="Save the open files (Ctrl+S saves one)"
                >
                  Save
                </button>
                <span className="fw-actions-sep" />
                <button
                  className="btn"
                  disabled={running || !canBuild}
                  onClick={() => build(project.id)}
                  title="Compile it, to check it builds (the keyboard isn't touched)"
                >
                  Test build
                </button>
                <button
                  className="btn btn-primary"
                  disabled={running || !canBuild}
                  onClick={() => setFlashing(true)}
                >
                  Flash…
                </button>
                {project.lastBuild && (
                  <span className="muted small">
                    Last build: {project.lastBuild.file} ·{" "}
                    {Math.round(project.lastBuild.size / 1024)} KB ·{" "}
                    {new Date(project.lastBuild.at * 1000).toLocaleString()}
                  </span>
                )}
                {!canBuild && (
                  <span className="warn small">
                    The preflight above isn't done yet.
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <div className="fw-bottom">
        <OutputPanel />
        <FlashSteps builds={mode === "advanced"} />
      </div>

      {flashing && project && mode === "advanced" && (
        <FlashDialog
          projectId={project.id}
          onClose={() => setFlashing(false)}
        />
      )}

      {error ? (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            className="icon-btn"
            aria-label="Dismiss"
            onClick={clearError}
          >
            ×
          </button>
        </div>
      ) : (
        notice && (
          <div className="toast is-notice" role="status">
            <span>{notice}</span>
            <button
              className="icon-btn"
              aria-label="Dismiss"
              onClick={clearNotice}
            >
              ×
            </button>
          </div>
        )
      )}
    </main>
  );
}

/** The selected project's open files, in tabs; each project keeps its own. */
function EditorArea({ projectId }: { projectId: string }) {
  const allOpen = useFirmware((s) => s.openFiles);
  const openFiles = tabsOf(allOpen, projectId);
  const activeKey = useFirmware((s) => s.activeKey);
  const buffers = useFirmware((s) => s.buffers);
  const reveal = useFirmware((s) => s.reveal);
  const { setActive, closeFile, edit, save } = useFirmware.getState();

  const close = async (key: FileKey) => {
    const b = buffers[key];
    if (
      b &&
      b.text !== b.saved &&
      !(await confirmAsk(
        `${splitKey(key).path} has unsaved changes. Close it and lose them?`,
        "Close",
      ))
    )
      return;
    forgetEditorState(key);
    closeFile(key);
  };

  if (!openFiles.length || !activeKey || !buffers[activeKey]) {
    return (
      <p className="empty fw-noedit">
        Open a file from the sidebar. keymap.c holds the layers, rules.mk the
        features, config.h the settings.
      </p>
    );
  }
  const { path } = splitKey(activeKey);
  return (
    <div className="fw-editor">
      <div className="fw-tabs" role="tablist">
        {openFiles.map((key) => {
          const b = buffers[key];
          const dirty = b && b.text !== b.saved;
          const { path: p } = splitKey(key);
          return (
            <div
              key={key}
              className={`fw-tab ${key === activeKey ? "is-active" : ""}`}
              role="tab"
              aria-selected={key === activeKey}
            >
              <button
                className="fw-tab-main"
                onClick={() => setActive(key)}
                onAuxClick={(e) => e.button === 1 && close(key)}
                title={key}
              >
                <FileGlyph path={p} />
                {p}
                {dirty && (
                  <span
                    className="dirty-dot"
                    title="Unsaved changes (Ctrl+S)"
                  />
                )}
              </button>
              <button
                className="icon-btn small"
                aria-label={`Close ${p}`}
                onClick={() => close(key)}
              >
                <CrossIcon />
              </button>
            </div>
          );
        })}
      </div>
      <CodeEditor
        key={activeKey}
        fileKey={activeKey}
        path={path}
        text={buffers[activeKey].text}
        onChange={(text) => edit(activeKey, text)}
        onSave={() => save(activeKey)}
        reveal={reveal?.key === activeKey ? reveal : null}
      />
    </div>
  );
}

function OutputPanel() {
  const log = useFirmware((s) => s.log);
  const problems = useFirmware((s) => s.problems);
  const job = useFirmware((s) => s.job);
  const showProblem = useFirmware((s) => s.showProblem);
  const { cancelJob } = useFirmware.getState();
  const [tab, setTab] = useState<"problems" | "output">("output");
  // The preflight's own tasks (downloads, installs) have their Cancel in their row.
  // Not while the firmware is being written: stopping the tool then leaves the keyboard with none.
  const cancellable =
    job?.state === "running" &&
    job.cancellable &&
    (job.kind === "build" || job.kind === "flash");
  const end = useRef<HTMLDivElement>(null);

  // A failed build opens on its errors.
  useEffect(() => {
    if (job?.state === "failed" && problems.length) setTab("problems");
    if (job?.state === "running") setTab("output");
  }, [job?.state, job?.id, problems.length]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [log.length, tab]);

  return (
    <section className="panel fw-output">
      <div className="fw-output-head">
        <div className="segmented fw-output-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "output"}
            onClick={() => setTab("output")}
          >
            Output
          </button>
          <button
            role="tab"
            aria-selected={tab === "problems"}
            onClick={() => setTab("problems")}
          >
            Problems{" "}
            {problems.length > 0 && (
              <span className="count">{problems.length}</span>
            )}
          </button>
        </div>
        {job && job.state !== "running" && (
          <span className={`fw-result is-${job.state}`}>
            {job.state === "ok" ? "✓" : job.state === "cancelled" ? "–" : "✕"}{" "}
            {job.message}
          </span>
        )}
        {cancellable && (
          <>
            {/* A test build isn't a step of the keyboard status beside it: say it here. */}
            {job.kind === "build" && (
              <span className="fw-result is-cancelled">
                {job.step ?? "Building"}…
              </span>
            )}
            <button
              className="link-btn danger fw-output-cancel"
              onClick={cancelJob}
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {tab === "output" ? (
        <div className="fw-log mono">
          {log.length ? (
            log.map((l, i) => (
              <div key={i} className={lineClass(l)}>
                {l}
              </div>
            ))
          ) : (
            <div className="muted">
              Builds, downloads and flashing show their output here.
            </div>
          )}
          <div ref={end} />
        </div>
      ) : (
        <ul className="fw-problems">
          {problems.map((p, i) => (
            <li key={i}>
              <button
                className={`fw-problem is-${p.severity}`}
                onClick={() => showProblem(p)}
              >
                <span className="fw-problem-sev">
                  {p.severity === "error" ? "✕" : "!"}
                </span>
                <span className="mono">
                  {p.path}:{p.line}
                </span>
                <span>{p.message}</span>
              </button>
            </li>
          ))}
          {problems.length === 0 && (
            <li className="muted">No problems in the last build.</li>
          )}
        </ul>
      )}
    </section>
  );
}

const lineClass = (l: string) =>
  /\berror\b|\*\*\*|fatal/i.test(l)
    ? "is-error"
    : /\bwarning\b/i.test(l)
      ? "is-warning"
      : /\[OK\]|done\.|flashed|Download done/i.test(l)
        ? "is-ok"
        : "";

/** Flashing replaces the keyboard's firmware: say what happens, check it's in its bootloader. */
function FlashDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose(): void;
}) {
  const project = useFirmware((s) =>
    s.projects.find((p) => p.id === projectId),
  );
  const status = useFirmware((s) => s.status);
  // Built first when the last build isn't of its files: changed on disk, or about to be (flashing
  // saves the open files first).
  const unsaved = useFirmware((s) =>
    Object.entries(s.buffers).some(([k, b]) => k.startsWith(`${projectId}/`) && b.text !== b.saved),
  );
  const rebuild = !!project?.buildOutdated || unsaved;
  const engine = useStore((s) => s.engine);
  const { flash } = useFirmware.getState();
  const keyboard = status?.devices.find((d) => d.kind === "keyboard");
  const connected = boardInfo(engine.board);
  const otherBoard =
    engine.connected &&
    connected?.firmware &&
    connected.firmware !== project?.keyboard
      ? connected
      : null;
  // The board this project is for: the plugged-in one when it uses this firmware folder (two
  // variants can share one), else the first that does.
  const scanned = keyboard ? boardByUsb(keyboard.vid, keyboard.pid) : undefined;
  const info = useFirmware((s) =>
    s.keyboards.find((k) => k.path === project?.keyboard),
  );
  const board: FlashBoard | undefined =
    (scanned?.firmware === project?.keyboard
      ? scanned
      : BOARDS.find((b) => b.firmware === project?.keyboard)) ??
    (info && {
      name: info.name,
      bootloader: info.bootloader,
      firmware: info.path,
    });
  const [pick, setPick] = useState<string | null>(null);
  const target = useFlashTarget(board, pick);
  // A device in another kind of bootloader than this keyboard's isn't it.
  const bootloader = board
    ? target.candidates[0]
    : status?.devices.find((d) => d.kind === "bootloader");
  if (!project) return null;
  // `make …:flash` writes to whatever has the bootloader's USB id, so when the app never saw the
  // keyboard itself the user says which device it is, as on the ready-made path.
  const picking = target.needsPick;
  const name = board?.name.replace(/^Keychron\s+/, "") ?? "keyboard";

  return (
    <Dialog title={`Flash ${project.name}`} onClose={onClose}>
      <p className="option-text">
        {rebuild ? (
          <>
            This builds {project.name} for{" "}
            <span className="mono">{project.keyboard}</span>
            {project.lastBuild ? " (it changed since its last build)" : ""} and
            writes it to the keyboard, replacing its firmware.
          </>
        ) : (
          <>
            This writes {project.name}'s last build, of its files as they are,
            to the <span className="mono">{project.keyboard}</span>, replacing
            its firmware.
          </>
        )}{" "}
        Keep it plugged in until the log says it's done: it restarts with the
        new firmware by itself.
      </p>
      {otherBoard && (
        <p className="warn">
          The keyboard connected now is a {otherBoard.name} (
          <span className="mono">{otherBoard.firmware}</span>), not the keyboard
          this firmware is for. Firmware for another model can leave keys dead
          or the lighting wrong: flash it only on a{" "}
          <span className="mono">{project.keyboard}</span>.
        </p>
      )}
      <ul className="option-text small flash-notes">
        <li>
          Your profiles are kept (they live on this PC). The keyboard's own
          saved keymap and lighting may reset to the firmware's defaults.
        </li>
        <li>
          Nothing here can break the bootloader: it's in the chip's read-only
          memory. If the keyboard misbehaves afterwards, unplug it, hold Esc
          while plugging it back in (if Esc doesn't respond: the reset button
          under the space bar keycap), and flash another firmware. Keychron's
          own, from their website, puts it back as it came.
        </li>
      </ul>
      {picking ? (
        <>
          <DevicePicker target={target} name={name} onChange={setPick} />
          {target.bootloader && !target.bootloader.driver && (
            <p className="warn">
              Windows has no driver for it: install the drivers first
              (preflight).
            </p>
          )}
        </>
      ) : bootloader ? (
        bootloader.driver ? (
          <>
            <p className="fw-ready">
              ✓ {describeDevice(bootloader)} is in bootloader mode.
            </p>
            {!keyboard && (
              <p className="warn">
                The app can't see your keyboard itself, only this device. Many
                things that are not keyboards use the same bootloader USB id —
                check that this is the one you mean before flashing.
              </p>
            )}
          </>
        ) : (
          <p className="warn">
            {describeDevice(bootloader)} is in bootloader mode, but Windows has
            no driver for it: install the drivers first (preflight).
          </p>
        )
      ) : (
        <div className="notice">
          <p className="option-text">
            The keyboard isn't in its bootloader yet.{" "}
            {keyboard ? "Restart it into the bootloader, or" : ""} unplug it,
            hold Esc, and plug it back in. Flashing can start now: it waits for
            the bootloader.
          </p>
          {keyboard && <BootloaderButton />}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={
            picking
              ? !!target.blocked || !target.bootloader?.driver
              : !!bootloader && !bootloader.driver
          }
          onClick={() => {
            onClose();
            flash(projectId, target.chosen);
          }}
        >
          {bootloader ? "Flash" : "Flash when it's ready"}
        </button>
      </div>
    </Dialog>
  );
}
