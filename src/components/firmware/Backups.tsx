import { useEffect, useState } from "react";
import { isMock } from "../../lib/api";
import { boardInfo } from "../../lib/boards";
import type { FirmwareBackup } from "../../lib/firmwareTypes";
import { hasModule } from "../../lib/limits";
import { useFirmware } from "../../state/firmwareStore";
import { useStore } from "../../state/store";
import { Dialog } from "../Dialog";
import { BootloaderHint, FlashTargetState } from "./FlashBody";
import { JobProgress, useFlashTarget, useTargetBoard } from "./Preflight";

/** How often the dialog looks at what's plugged in (keyboard, bootloader). */
const SCAN_MS = 1500;

/**
 * The setting every flash honours (`fwBackup`): read what is on the keyboard into a backup before
 * writing over it. Shown wherever a flash starts. `onList`: a link to the backups.
 */
export function BackupOption({ onList }: { onList?: () => void }) {
  const on = useStore((s) => s.settings.fwBackup);
  const updateSettings = useStore((s) => s.updateSettings);
  return (
    <p className="option-text small backup-option">
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => void updateSettings({ fwBackup: e.target.checked })}
        />
        Back up the keyboard's firmware first
      </label>{" "}
      {onList && (
        <button className="link-btn" onClick={onList}>
          Backups…
        </button>
      )}
    </p>
  );
}

const when = (at: number) =>
  new Date(at * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/**
 * The firmware backups: what was on the keyboard before the app wrote to it (`firmware::backup`),
 * a backup on demand, and the way back (Restore writes one through the same guarded path as any
 * flash, and only to the model it was read from).
 */
export function BackupsDialog() {
  const engine = useStore((s) => s.engine);
  const { openBackups } = useStore.getState();
  const backups = useFirmware((s) => s.backups);
  const job = useFirmware((s) => s.job);
  const log = useFirmware((s) => s.log);
  const ready = useFirmware((s) => s.ready);
  const {
    init,
    refreshStatus,
    refreshBackups,
    backUp,
    restoreBackup,
    deleteBackup,
    openBackups: openFolder,
    installDrivers,
    enterBootloader,
    cancelJob,
  } = useFirmware.getState();

  const board = useTargetBoard();
  const [pick, setPick] = useState<string | null>(null);
  // A click on Restore or Delete asks again on the same button.
  const [confirm, setConfirm] = useState<string | null>(null);
  const name = board?.name.replace(/^Keychron\s+/, "") ?? "keyboard";
  const target = useFlashTarget(board, pick);
  const bootloader = target.bootloader;
  const running = job?.state === "running" ? job : null;
  const done =
    job && (job.kind === "backup" || job.kind === "flash") && job.state !== "running"
      ? job
      : null;
  const moduleIn = hasModule(engine);
  const blocked =
    !board || !!running || !!target.blocked || (!!bootloader && !bootloader.driver);
  const close = () => openBackups(false);

  // Once, when the dialog opens: the store actions are stable (`useFirmware.getState()`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open, see above
  useEffect(() => {
    if (!ready) void init();
    else void refreshBackups();
    const t = setInterval(() => void refreshStatus(), SCAN_MS);
    return () => clearInterval(t);
  }, []);

  const twice = (key: string, act: () => void) => {
    if (confirm === key) {
      setConfirm(null);
      act();
    } else setConfirm(key);
  };

  const row = (b: FirmwareBackup) => {
    // Written back only to the model it came from: the backend checks that it is plugged in.
    const mine = b.board === board?.id;
    const info = boardInfo(b.board);
    return (
      <li key={b.id} className="backup-row">
        <span className="backup-what">
          <strong>{when(b.at)}</strong>
          <span className="muted small">
            {b.name.replace(/^Keychron\s+/, "")} · {Math.round(b.size / 1024)} KB
          </span>
        </span>
        <button
          className="btn btn-ghost btn-small"
          disabled={!mine || !info || blocked}
          title={
            mine
              ? "Write this firmware back to the keyboard"
              : `For a ${b.name}, not the keyboard plugged in`
          }
          onClick={() =>
            twice(`restore:${b.id}`, () => void restoreBackup(b.id, target.chosen))
          }
        >
          {confirm === `restore:${b.id}` ? "Write it back?" : "Restore"}
        </button>
        <button
          className="btn btn-ghost btn-small danger"
          disabled={!!running}
          onClick={() => twice(`delete:${b.id}`, () => void deleteBackup(b.id))}
        >
          {confirm === `delete:${b.id}` ? "Delete for good?" : "Delete"}
        </button>
      </li>
    );
  };

  return (
    <Dialog title="Firmware backups" onClose={close} wide>
      <p className="option-text">
        A backup is what was on the keyboard before the app wrote to it: its
        firmware and, on most Keychron boards, its own saved keymap and
        lighting. The app makes one before every flash while "Back up the
        keyboard's firmware first" is on. Restore writes it back, the same way
        a flash does, only to the model it was read from.
      </p>

      {running ? (
        <div className="notice">
          <JobProgress job={running} onCancel={cancelJob} />
          {running.step?.startsWith("Waiting for the keyboard's bootloader") && (
            <BootloaderHint connected={engine.connected} moduleIn={moduleIn} />
          )}
          {log.length > 0 && (
            <pre className="install-log">{log.slice(-6).join("\n")}</pre>
          )}
        </div>
      ) : (
        <>
          {done && (
            <p className={done.state === "ok" ? "fw-ready" : "warn"}>
              {done.message}
            </p>
          )}
          {!board ? (
            <p className="warn">
              Plug your keyboard in, or choose it in Settings → Keyboard.
            </p>
          ) : target.needsPick || target.blocked || bootloader ? (
            <FlashTargetState
              target={target}
              name={name}
              bootloader={bootloader}
              connected={engine.connected}
              moduleIn={moduleIn}
              onPick={setPick}
              onInstallDrivers={installDrivers}
            />
          ) : (
            <p className="option-text small">
              Back up now waits for the {name}'s bootloader (unplug it, hold
              Esc, and plug it back in
              {engine.connected && moduleIn
                ? ", or use Restart into bootloader"
                : ""}
              ), reads its firmware, and restarts it. Nothing is written to it.
            </p>
          )}
        </>
      )}

      {backups.length > 0 ? (
        <ul className="backup-list">{backups.map(row)}</ul>
      ) : (
        <p className="option-text small muted">No backups yet.</p>
      )}
      <BackupOption />
      {isMock && (
        <p className="option-text small">
          Browser preview: backing up and restoring are pretended.
        </p>
      )}

      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={() => void openFolder()}>
          Open the folder
        </button>
        {moduleIn && !bootloader && (
          <button
            className="btn btn-ghost"
            disabled={!!running}
            onClick={enterBootloader}
          >
            Restart into bootloader
          </button>
        )}
        <button className="btn btn-ghost" onClick={close}>
          Close
        </button>
        <button
          className="btn btn-primary"
          disabled={blocked}
          onClick={() => board && void backUp(board.id, target.chosen)}
        >
          {bootloader ? "Back up now" : "Back up when it's ready"}
        </button>
      </div>
    </Dialog>
  );
}
