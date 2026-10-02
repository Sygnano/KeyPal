import { useEffect, useState } from "react";
import { isMock } from "../lib/api";
import { boardInfo } from "../lib/boards";
import { BOARD } from "../lib/layout";
import { hasModule } from "../lib/limits";
import { useFirmware } from "../state/firmwareStore";
import { useStore } from "../state/store";
import { Dialog } from "./Dialog";
import {
  BootloaderHint,
  FlashNotes,
  FlashTargetState,
} from "./firmware/FlashBody";
import { JobProgress, useFlashTarget } from "./firmware/Preflight";

/** How often the dialog looks at what's plugged in (keyboard, bootloader). */
const SCAN_MS = 1500;

/**
 * Puts the profile switcher on the keyboard without QMK MSYS: the app's ready-made firmware for
 * this keyboard (Keychron's own keymap + the module, built with each release), written with a few
 * small tools downloaded on first use. The Firmware tab stays the way to build one's own.
 */
export function InstallFirmwareDialog() {
  const engine = useStore((s) => s.engine);
  const selected = useStore((s) => s.boardId);
  const { openInstall, setMode } = useStore.getState();
  const job = useFirmware((s) => s.job);
  const log = useFirmware((s) => s.log);
  const ready = useFirmware((s) => s.ready);
  const {
    init,
    refreshStatus,
    flashPrebuilt,
    installDrivers,
    enterBootloader,
    cancelJob,
  } = useFirmware.getState();

  // The keyboard plugged in, else the one chosen in the app.
  const board =
    boardInfo(engine.board ?? engine.unreachable) ?? boardInfo(selected);
  const [pick, setPick] = useState<string | null>(null);
  const name = (board?.name ?? BOARD.name).replace(/^Keychron\s+/, "");
  const target = useFlashTarget(board, pick);
  const bootloader = target.bootloader;
  const running = job?.state === "running" ? job : null;
  const flashing = running?.kind === "flash";
  const done =
    job && job.kind === "flash" && job.state !== "running" ? job : null;
  const has = engine.connected && engine.firmware === "ok";

  useEffect(() => {
    if (!ready) void init();
    const t = setInterval(() => void refreshStatus(), SCAN_MS);
    return () => clearInterval(t);
    // Once, when the dialog opens: the store actions are stable (`useFirmware.getState()`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => openInstall(false);

  return (
    <Dialog title="Install the profile switcher" onClose={close}>
      <p className="option-text">
        Remaps, macros and per-key lighting need the profile switcher inside the
        keyboard's firmware.
        {has
          ? ` The ${name} already has it installed.`
          : ` The app can put it on the ${name} for you: Keychron's own firmware for it, with the profile switcher added.`}{" "}
        Nothing else to install: the few small flashing tools (about 0.5 MB,
        from QMK Toolbox) are downloaded the first time.
      </p>
      <FlashNotes />

      {!board ? (
        <p className="warn">
          Choose your keyboard first (Settings → Keyboard), or plug it in.
        </p>
      ) : running ? (
        <div className="notice">
          <JobProgress job={running} onCancel={cancelJob} />
          {flashing && running.step?.startsWith("Waiting") && (
            <BootloaderHint
              connected={engine.connected}
              moduleIn={hasModule(engine)}
            />
          )}
          {log.length > 0 && (
            <pre className="install-log">{log.slice(-6).join("\n")}</pre>
          )}
        </div>
      ) : done ? (
        <p className={done.state === "ok" ? "fw-ready" : "warn"}>
          {done.message}
        </p>
      ) : (
        <FlashTargetState
          target={target}
          name={name}
          bootloader={bootloader}
          connected={engine.connected}
          moduleIn={hasModule(engine)}
          onPick={setPick}
          onInstallDrivers={installDrivers}
        />
      )}
      {isMock && (
        <p className="option-text small">
          Browser preview: flashing is pretended.
        </p>
      )}

      <div className="dialog-actions">
        <button
          className="btn btn-ghost"
          onClick={() => {
            close();
            setMode("firmware");
          }}
        >
          Open the Firmware tab
        </button>
        {hasModule(engine) &&
          !bootloader && (
            <button
              className="btn btn-ghost"
              disabled={!!running}
              onClick={enterBootloader}
            >
              Restart into bootloader
            </button>
          )}
        <button className="btn btn-ghost" onClick={close}>
          {done?.state === "ok" ? "Done" : "Close"}
        </button>
        <button
          className="btn btn-primary"
          disabled={
            !board ||
            !!running ||
            !!target.blocked ||
            (!!bootloader && !bootloader.driver)
          }
          onClick={() => board && flashPrebuilt(board.id, target.chosen)}
        >
          {bootloader ? "Flash" : "Flash when it's ready"}
        </button>
      </div>
    </Dialog>
  );
}
