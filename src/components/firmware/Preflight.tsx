import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { boardByUsb, boardInfo, type BoardInfo } from "../../lib/boards";
import { describeDevice, flashTarget, type FlashBoard, type FlashTarget } from "../../lib/flashTarget";
import type { FirmwareStatus, JobKind } from "../../lib/firmwareTypes";
import type { FwMode } from "../../lib/types";
import { pickFwMode, useFirmware, type JobView } from "../../state/firmwareStore";
import { useStore } from "../../state/store";
import { ChevronIcon } from "../ProfileList";

type Tone = "ok" | "warn" | "bad" | "idle";

export { describeDevice };

/** Can a project be built and flashed (the Advanced path), and if not what's missing. */
export function preflightReady(s: FirmwareStatus | null): { build: boolean; flash: boolean } {
  const build = !!s && s.toolchain.state !== "missing" && s.source.state !== "missing";
  const bootloader = s?.devices.find((d) => d.kind === "bootloader");
  return { build, flash: build && !!bootloader?.driver };
}

/**
 * The keyboard the ready-made path is about: the one the app is talking to, else the one it can
 * see but can't talk to, else the one chosen in the app, else whatever Keychron keyboard the USB
 * scan found (firmware without Raw HID still shows up there, and that's exactly who needs this).
 */
export function useTargetBoard(): BoardInfo | undefined {
  const engine = useStore((s) => s.engine);
  const selected = useStore((s) => s.boardId);
  const devices = useFirmware((s) => s.status?.devices);
  const scanned = devices?.find((d) => d.kind === "keyboard");
  return (
    boardInfo(engine.board ?? engine.unreachable) ??
    boardInfo(selected) ??
    (scanned ? boardByUsb(scanned.vid, scanned.pid) : undefined)
  );
}

/** `flashTarget` over what the USB scan sees now. */
export function useFlashTarget(board: FlashBoard | undefined, pick: string | null): FlashTarget {
  const devices = useFirmware((s) => s.status?.devices);
  return flashTarget(board, devices ?? [], pick);
}

/**
 * Which device in bootloader mode is the keyboard, when the app couldn't see for itself (it was
 * already in its bootloader when the app first looked). It opens on the device with this board's
 * bootloader id; "None of these" is the way out when that one isn't the keyboard.
 */
export function DevicePicker({ target, name, onChange }: { target: FlashTarget; name: string; onChange: (instance: string) => void }) {
  const one = target.candidates.length === 1;
  return (
    <label className="field device-picker">
      <span>Device to flash</span>
      <select value={target.chosen ?? ""} onChange={(e) => onChange(e.target.value)}>
        {target.candidates.map((d) => (
          <option key={d.instance} value={d.instance}>
            {describeDevice(d)}
            {d.driver ? "" : " — no driver yet"}
          </option>
        ))}
        <option value="">{one ? "Not this one" : "None chosen"}</option>
      </select>
      <span className={`check-detail ${target.blocked && target.chosen ? "warn" : ""}`}>
        {target.blocked ??
          `The ${name} was already in its bootloader when the app looked, so the app can't check the model itself. Other devices use this USB id too: if this isn't your keyboard, choose "Not this one".`}
      </span>
    </label>
  );
}

/**
 * "Restart into bootloader", with the reason it can't be used written next to it. A `title` is no
 * use here: WebView2 shows no tooltip on a disabled element, so the reason was invisible — and it
 * was also wrong, claiming an outdated module whenever no keyboard was connected at all.
 */
export function BootloaderButton() {
  const engine = useStore((s) => s.engine);
  const { enterBootloader } = useFirmware.getState();
  const why = !engine.connected
    ? "The app isn't talking to the keyboard, so it can't ask it to restart. Unplug it, hold Esc and plug it back in instead."
    : engine.firmware !== "ok"
      ? "The keyboard's firmware has no profile switcher (or one this app can't talk to), so it can't be asked to restart. Unplug it, hold Esc and plug it back in."
      : null;
  return (
    <>
      <button className="btn btn-ghost btn-small" disabled={!!why} onClick={enterBootloader}>
        Restart into bootloader
      </button>
      {why && <span className="check-detail why-disabled">{why}</span>}
    </>
  );
}

/** The path the Firmware tab is on, as the store's `pickFwMode` decides it. */
export function useFwMode(): FwMode {
  const chosen = useStore((s) => s.settings.fwMode);
  const toolchain = useFirmware((s) => s.status?.toolchain.state);
  const projects = useFirmware((s) => s.projects.length);
  return pickFwMode(chosen, toolchain, projects);
}

/**
 * The two ways to get firmware onto the keyboard, at the bottom of the Firmware sidebar: Basic
 * installs the app's ready-made build, Advanced writes and compiles one here.
 */
export function FwModeSwitch() {
  const mode = useFwMode();
  const updateSettings = useStore((s) => s.updateSettings);
  const set = (fwMode: FwMode) => void updateSettings({ fwMode });
  return (
    <div className="segmented fw-mode" role="tablist" aria-label="How to get firmware onto the keyboard">
      <button
        role="tab"
        aria-selected={mode === "basic"}
        onClick={() => set("basic")}
        title="Install the app's ready-made firmware: nothing to set up beyond about 0.5 MB of flashing tools"
      >
        Basic mode
      </button>
      <button
        role="tab"
        aria-selected={mode === "advanced"}
        onClick={() => set("advanced")}
        title="Write and build your own firmware: needs QMK MSYS and Keychron's source (about 5 GB)"
      >
        Advanced mode
      </button>
    </div>
  );
}

/**
 * What each path needs, each row with its state and what to do about it.
 *
 * Basic: the small flashing tools, the app's ready-made firmware for this keyboard, the bootloader
 * driver, the keyboard. Advanced: QMK MSYS, Keychron's firmware, then the same last two rows.
 */
export function Preflight({ mode, compact }: { mode: FwMode; compact?: boolean }) {
  const status = useFirmware((s) => s.status);
  const [open, setOpen] = useState<boolean | null>(null);

  const board = useTargetBoard();
  const { checkUpdates, loadPrebuilt } = useFirmware.getState();

  // Basic shows what the app has ready-made for this keyboard, so it follows the keyboard.
  useEffect(() => {
    if (mode === "basic" && board) void loadPrebuilt(board.id);
  }, [mode, board, loadPrebuilt]);

  // The other path's rows are a different checklist: show it rather than keep the old fold state.
  // (Above the early return: every hook must run on every render.)
  useEffect(() => setOpen(null), [mode]);

  if (!status) return <section className={`panel preflight ${compact ? "is-compact" : ""}`}>Checking the firmware tools…</section>;
  const bootloader = status.devices.find((d) => d.kind === "bootloader");
  const allGood = mode === "basic" ? basicGood(status) : status.toolchain.state === "ok" && status.source.state === "ok" && status.driver.state !== "missing";
  // In the sidebar (Basic) it is the whole list, always: there is room for it and nothing to hide.
  const expanded = compact || (open ?? !allGood);
  const Head = compact ? "div" : "button";

  return (
    <section className={`panel preflight ${expanded ? "" : "is-folded"} ${compact ? "is-compact" : ""}`}>
      <div className="preflight-top">
        <Head className="preflight-head" {...(compact ? {} : { onClick: () => setOpen(!expanded), "aria-expanded": expanded })}>
          {/* The tick is for the whole list: the tools can all be there with the keyboard still
              running its firmware, and then nothing can be written yet. */}
          <span className={`check-dot tone-${!allGood ? "warn" : bootloader ? "ok" : "idle"}`} aria-hidden>
            {!allGood ? "!" : bootloader ? "✓" : "•"}
          </span>
          <span className="panel-title">Preflight</span>
          <span className="muted">
            {compact
              ? allGood
                ? bootloader
                  ? "All set"
                  : "Keyboard not in bootloader"
                : "Incomplete"
              : allGood
                ? mode === "basic"
                  ? "Everything needed to install the ready-made firmware is here."
                  : "Everything needed to build is here."
                : mode === "basic"
                  ? "Missing components to flash the keyboard."
                  : "Some things are missing before you can build."}
            {compact ? "" : bootloader ? " The keyboard is ready to flash." : allGood ? " To flash, the keyboard still has to be in its bootloader." : ""}
          </span>
          {!compact && (
            <span className={`icon-btn chevron ${expanded ? "is-open" : ""}`} aria-hidden>
              <ChevronIcon />
            </span>
          )}
        </Head>
      </div>

      {expanded && (
        <ul className="checklist">
          {mode === "basic" ? <BasicChecks /> : <AdvancedChecks />}
          <DriverCheck />
          <KeyboardCheck />
          <li className="check-foot">
            <button className="link-btn" onClick={() => (mode === "basic" ? board && loadPrebuilt(board.id, true) : checkUpdates(true))}>
              Check for updates
            </button>
            {status.updateError && <span className="muted">Couldn't check online: {status.updateError}</span>}
            <button className="link-btn" onClick={() => api.fwOpenFolder(null)}>
              Open the downloads folder
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}

/** Basic needs nothing installed beyond the flashing tools; the driver row speaks for itself. */
function basicGood(s: FirmwareStatus): boolean {
  return s.flashTools.state === "ok" && s.driver.state !== "missing";
}

/** The Basic path: the small flashing tools, and what the app has ready-made for this keyboard. */
function BasicChecks() {
  const status = useFirmware((s) => s.status)!;
  const job = useFirmware((s) => s.job);
  const prebuilt = useFirmware((s) => s.prebuilt);
  const error = useFirmware((s) => s.prebuiltError);
  const loading = useFirmware((s) => s.prebuiltLoading);
  const { downloadTools, cancelJob, loadPrebuilt } = useFirmware.getState();
  const running = job?.state === "running" ? job : null;
  const board = useTargetBoard();
  const tools = status.flashTools;

  return (
    <>
      <Check
        tone={tools.state === "ok" ? "ok" : "idle"}
        title="Flashing tools"
        detail={
          tools.state === "ok"
            ? `dfu-util and the rest are in ${tools.path}.`
            : "QMK flashing tools (0.5 MB) download required to flash the firmware."
        }
        job={jobFor(running, "tools")}
        onCancel={cancelJob}
        actions={
          tools.state !== "ok" && (
            <button className="btn btn-ghost btn-small" disabled={!!running} onClick={downloadTools}>
              Download now
            </button>
          )
        }
      />
      <Check
        tone={loading ? "idle" : error ? "warn" : prebuilt?.entry ? "ok" : prebuilt ? "bad" : "idle"}
        title="Firmware with integrated profile switch feature"
        detail={
          !board
            ? "Plug your keyboard in, or choose it in Settings → Keyboard, and the app will find the firmware for it."
            : loading
              ? `Looking for the firmware for the ${board.name}…`
              : error
                ? `Couldn't get the list of ready-made firmware: ${error}`
                : prebuilt?.entry
                  ? `Keychron's "${prebuilt.entry.keymap}" keymap for the ${board.name} with the profile switcher added, from release ${prebuilt.tag} (${Math.round(prebuilt.entry.size / 1024)} KB, built from Keychron ${prebuilt.branch}). Downloaded when you flash.`
                  : prebuilt
                    ? `Release ${prebuilt.tag} has no ready-made firmware for the ${board.name}. Build one yourself in Advanced mode.`
                    : "Checked when a keyboard is known."
        }
        actions={
          board && !loading && <button className="link-btn" onClick={() => loadPrebuilt(board.id, true)}>Look again</button>
        }
      />
    </>
  );
}

/** The Advanced path: QMK MSYS and Keychron's firmware source, the two big downloads. */
function AdvancedChecks() {
  const status = useFirmware((s) => s.status)!;
  const job = useFirmware((s) => s.job);
  const updateSettings = useStore((s) => s.updateSettings);
  const { installToolchain, downloadSource, cancelJob } = useFirmware.getState();
  const { toolchain, source } = status;
  const running = job?.state === "running" ? job : null;
  const busy = !!running;
  const short = (sha: string | null) => sha?.slice(0, 7) ?? "";

  const pick = async (key: "fwMsysPath" | "fwSourcePath") => {
    const folder = await api.pickFolder();
    if (folder) {
      await updateSettings({ [key]: folder });
      useFirmware.getState().refreshStatus();
      useFirmware.getState().loadKeyboards();
    }
  };
  const reset = async (key: "fwMsysPath" | "fwSourcePath") => {
    await updateSettings({ [key]: null });
    useFirmware.getState().refreshStatus();
    useFirmware.getState().loadKeyboards();
  };

  return (
    <>
      <Check
        tone={toolchain.state === "ok" ? "ok" : toolchain.state === "outdated" ? "warn" : "bad"}
        title="Build tools (QMK MSYS)"
        detail={
          toolchain.state === "missing"
            ? "Needed to build and flash: the compiler, make, git and the flashing tools. About 600 MB to download, 4.7 GB installed; Windows asks for permission once."
            : `QMK MSYS ${toolchain.version ?? ""} in ${toolchain.path}${toolchain.state === "outdated" ? `. Version ${toolchain.latest} is out.` : ""}`
        }
        job={jobFor(running, "toolchain")}
        onCancel={cancelJob}
        actions={
          <>
            {toolchain.state !== "ok" && (
              <button className="btn btn-primary btn-small" disabled={busy} onClick={installToolchain}>
                {toolchain.state === "missing" ? "Download and install" : "Update"}
              </button>
            )}
            <button className="link-btn" onClick={() => pick("fwMsysPath")}>
              Use another install…
            </button>
          </>
        }
      />
      <Check
        tone={source.state === "ok" ? "ok" : source.state === "outdated" ? "warn" : "bad"}
        title="Keychron's firmware"
        detail={
          source.state === "missing"
            ? toolchain.state === "missing"
              ? "Keychron's QMK firmware, with only their keyboards (about 510 MB). Needs the build tools first."
              : "Keychron's QMK firmware, with only their keyboards (about 510 MB)."
            : `${source.branch} at ${short(source.commit)}${
                source.state === "outdated"
                  ? `: Keychron has ${source.latestBranch !== source.branch ? `moved to ${source.latestBranch}` : `newer changes (${short(source.latestCommit)})`}`
                  : " (the latest)"
              }. ${source.managed ? "" : `Your folder: ${source.path}`}`
        }
        job={jobFor(running, "source")}
        onCancel={cancelJob}
        actions={
          <>
            {source.state !== "ok" && source.managed && (
              <button className="btn btn-primary btn-small" disabled={busy || toolchain.state === "missing"} onClick={downloadSource}>
                {source.state === "missing" ? "Download" : "Update"}
              </button>
            )}
            {source.managed ? (
              <button className="link-btn" onClick={() => pick("fwSourcePath")}>
                Use a folder you already have…
              </button>
            ) : (
              <button className="link-btn" onClick={() => reset("fwSourcePath")}>
                Use the app's own copy
              </button>
            )}
          </>
        }
      />
    </>
  );
}

/** Both paths need Windows to have a driver for the bootloader before anything can be written. */
function DriverCheck() {
  const status = useFirmware((s) => s.status)!;
  const job = useFirmware((s) => s.job);
  const { installDrivers, cancelJob } = useFirmware.getState();
  const { driver } = status;
  const bootloader = status.devices.find((d) => d.kind === "bootloader");
  const running = job?.state === "running" ? job : null;
  const done = driver.state === "ok" || driver.state === "installed";

  return (
    <Check
      tone={done ? "ok" : driver.state === "missing" ? "bad" : "idle"}
      title="Bootloader driver"
      detail={
        driver.state === "ok"
          ? `The bootloader uses ${bootloader?.driver}.`
          : driver.state === "missing"
            ? "The keyboard is in its bootloader, but Windows has no driver for it: flashing can't reach it."
            : driver.state === "installed"
              ? "Installed by the app. Checked again when the keyboard is in its bootloader."
              : "Checked when the keyboard is in its bootloader. Installing ahead of time is fine (Windows asks for permission)."
      }
      job={jobFor(running, "drivers")}
      onCancel={cancelJob}
      actions={
        // The app installs these with QMK MSYS's installer when it has one, and QMK Toolbox's
        // (downloaded) when it doesn't: neither path needs the build tools first.
        done ? (
          <button className="link-btn" disabled={!!running} onClick={installDrivers}>
            Reinstall driver
          </button>
        ) : (
          <button className={`btn btn-small ${driver.state === "missing" ? "btn-primary" : "btn-ghost"}`} disabled={!!running} onClick={installDrivers}>
            Install drivers
          </button>
        )
      }
    />
  );
}

function KeyboardCheck() {
  const status = useFirmware((s) => s.status)!;
  const keyboard = status.devices.find((d) => d.kind === "keyboard");
  const bootloader = status.devices.find((d) => d.kind === "bootloader");

  return (
    <Check
      tone={bootloader ? (bootloader.driver ? "ok" : "warn") : "idle"}
      title="Keyboard"
      detail={
        bootloader
          ? `${describeDevice(bootloader)} is in bootloader mode: ready to flash.`
          : keyboard
            ? `A Keychron keyboard is plugged in (USB id ${hex(keyboard.pid)}), running its firmware. To flash, restart it into its bootloader: with the button, or unplug it, hold Esc and plug it back in.`
            : "No Keychron keyboard plugged in."
      }
      actions={keyboard && !bootloader && <BootloaderButton />}
    />
  );
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
const jobFor = (job: JobView | null, kind: JobKind) => (job?.kind === kind ? job : null);

function Check(props: { tone: Tone; title: string; detail: string; actions?: ReactNode; job?: JobView | null; onCancel?(): void }) {
  const { tone, title, detail, actions, job, onCancel } = props;
  return (
    <li className="check-row">
      <span className={`check-dot tone-${job ? "busy" : tone}`} aria-hidden>
        {job ? "" : tone === "ok" ? "✓" : tone === "idle" ? "•" : "!"}
      </span>
      <div className="check-text">
        <span className="check-title">{title}</span>
        <span className="check-detail">{detail}</span>
        {job && <JobProgress job={job} onCancel={onCancel} />}
      </div>
      <div className="check-actions">{!job && actions}</div>
    </li>
  );
}

export function JobProgress({ job, onCancel }: { job: JobView; onCancel?(): void }) {
  return (
    <div className="job-progress">
      <div className={`progress-bar ${job.progress === null ? "is-indeterminate" : ""}`}>
        <span style={job.progress !== null ? { width: `${Math.round(job.progress * 100)}%` } : undefined} />
      </div>
      <span className="job-step">
        {job.step ?? "Working…"}
        {job.progress !== null ? ` ${Math.round(job.progress * 100)}%` : ""}
      </span>
      {onCancel && job.cancellable && (
        <button className="link-btn danger" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
