import { useState } from "react";
import { isMock } from "../../lib/api";
import { hasModule } from "../../lib/limits";
import { useFirmware } from "../../state/firmwareStore";
import { useStore } from "../../state/store";
import { BackupOption } from "./Backups";
import { BootloaderHint, FlashNotes, FlashTargetState } from "./FlashBody";
import { useFlashTarget, useTargetBoard } from "./Preflight";

/**
 * The Basic path's main area: install the app's ready-made firmware on the keyboard that's plugged
 * in. Nothing to write and nothing to build, so there is no sidebar, no editor and no project —
 * just what will be written, and the button that writes it. Building your own is the other path.
 */
export function BasicFirmware() {
  const engine = useStore((s) => s.engine);
  const updateSettings = useStore((s) => s.updateSettings);
  const job = useFirmware((s) => s.job);
  const prebuilt = useFirmware((s) => s.prebuilt);
  const { flashPrebuilt, enterBootloader } = useFirmware.getState();

  const board = useTargetBoard();
  const [pick, setPick] = useState<string | null>(null);
  const name = board?.name.replace(/^Keychron\s+/, "") ?? "keyboard";
  const target = useFlashTarget(board, pick);
  const bootloader = target.bootloader;
  const running = job?.state === "running" ? job : null;
  const done =
    job && job.kind === "flash" && job.state !== "running" ? job : null;
  const has = engine.connected && engine.firmware === "ok";
  // No firmware in this release for this board: the only way in is to build one.
  const nothingToFlash = !!prebuilt && !prebuilt.entry;
  const canFlash =
    !!board &&
    !running &&
    !nothingToFlash &&
    !target.blocked &&
    !(bootloader && !bootloader.driver);

  return (
    <section className="panel fw-workspace fw-basic">
      <div className="fw-basic-body">
        <h3 className="fw-basic-title">
          Firmware with integrated profile switch feature
        </h3>
        <p className="option-text">
          Remaps, macros and per-key lighting need the profile switcher inside
          the keyboard's firmware.
          {has
            ? ` The ${name} already has it. Flashing again is harmless: it puts this release's version back on.`
            : ` The app writes Keychron's own firmware for the ${name}, with the profile switcher added — you don't have to build anything.`}
        </p>
        <FlashNotes
          onAdvanced={() => void updateSettings({ fwMode: "advanced" })}
        />
        <BackupOption onList={() => useStore.getState().openBackups(true)} />

        {!board ? (
          <p className="warn">
            Plug your keyboard in, or choose it in Settings → Keyboard.
          </p>
        ) : nothingToFlash ? (
          <p className="warn">
            This release has no ready-made firmware for the {name}: build one in
            Advanced mode.
          </p>
        ) : running ? (
          // Where the task is shows in the keyboard status under this page; Cancel is on the output.
          running.kind === "flash" &&
          running.step?.startsWith("Waiting for the keyboard's bootloader") && (
            <BootloaderHint
              connected={engine.connected}
              moduleIn={hasModule(engine)}
            />
          )
        ) : done && !(target.needsPick && done.state !== "ok") ? (
          <p className={done.state === "ok" ? "fw-ready" : "warn"}>
            {done.message}
          </p>
        ) : (
          <>
            {target.needsPick && done && <p className="warn">{done.message}</p>}
            <FlashTargetState
              target={target}
              name={name}
              bootloader={bootloader}
              connected={engine.connected}
              moduleIn={hasModule(engine)}
              onPick={setPick}
            />
          </>
        )}
        {isMock && (
          <p className="option-text small">
            Browser preview: flashing is pretended.
          </p>
        )}
      </div>

      <div className="fw-actions">
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
        <button
          className="btn btn-primary"
          disabled={!canFlash}
          onClick={() => board && flashPrebuilt(board.id, target.chosen)}
        >
          {bootloader ? "Flash" : "Flash when it's ready"}
        </button>
        {prebuilt?.entry && (
          <span className="muted small">
            {prebuilt.entry.file} · {Math.round(prebuilt.entry.size / 1024)} KB
            · release {prebuilt.tag}
            {!prebuilt.ownRelease &&
              " (this app build has no firmware of its own yet)"}
          </span>
        )}
      </div>
    </section>
  );
}
