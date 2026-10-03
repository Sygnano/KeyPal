import type { FlashTarget } from "../../lib/flashTarget";
import type { UsbDevice } from "../../lib/firmwareTypes";
import { DevicePicker, describeDevice } from "./Preflight";

/**
 * The parts of the ready-made flash UI that the Basic page and the Install dialog share, so the
 * two can't drift apart in wording or in what they say about the keyboard.
 */

/** What flashing does, and how to go back. `onAdvanced`: a button to the other path (the Basic
 * page has one; the dialog just names it). */
export function FlashNotes({ onAdvanced }: { onAdvanced?: () => void }) {
  return (
    <ul className="option-text small flash-notes">
      <li>
        Your profiles are kept (they live on this PC); the keyboard's own saved
        keymap and lighting go back to Keychron's defaults.
      </li>
      <li>
        Nothing here can break the bootloader: it's in the chip's read-only
        memory. To go back, restore the backup the app makes before flashing
        (Firmware backups), or flash Keychron's own firmware from their website
        the same way (Esc held while plugging in; if Esc doesn't respond, the
        reset button under the space bar keycap).
      </li>
      <li>
        Want your own keymap in it instead?{" "}
        {onAdvanced ? (
          <>
            <button className="link-btn" onClick={onAdvanced}>
              Advanced mode
            </button>{" "}
            writes and compiles firmware here, which needs QMK MSYS (about 5
            GB).
          </>
        ) : (
          <>
            The Firmware tab's "Advanced mode" writes and compiles firmware here
            (that needs QMK MSYS, about 5 GB).
          </>
        )}
      </li>
    </ul>
  );
}

/** The keyboard's state when no flash is running: which device to write to, why not, or that it is
 * ready. `onPick`: the user chose a device in the picker. */
export function FlashTargetState({
  target,
  name,
  bootloader,
  connected,
  moduleIn,
  onPick,
  onInstallDrivers,
}: {
  target: FlashTarget;
  name: string;
  bootloader: UsbDevice | undefined;
  connected: boolean;
  /** The keyboard runs the profile switcher (it can restart into its bootloader). */
  moduleIn: boolean;
  onPick: (instance: string) => void;
  onInstallDrivers?: () => void;
}) {
  if (target.needsPick) {
    return (
      <>
        <DevicePicker target={target} name={name} onChange={onPick} />
        {bootloader && !bootloader.driver && (
          <p className="warn">
            Windows has no driver for it yet: install it, then flash.
          </p>
        )}
      </>
    );
  }
  if (target.blocked) return <p className="warn">{target.blocked}</p>;
  if (bootloader?.driver)
    return (
      <p className="fw-ready">
        ✓ {describeDevice(bootloader)} is in bootloader mode, ready.
      </p>
    );
  if (bootloader && !bootloader.driver) {
    return (
      <div className="notice">
        <p className="warn">
          The keyboard is in its bootloader, but Windows has no driver for it
          yet. Install it (Windows asks for permission once), then flash.
        </p>
        {onInstallDrivers && (
          <button
            className="btn btn-ghost btn-small"
            onClick={onInstallDrivers}
          >
            Install the driver
          </button>
        )}
      </div>
    );
  }
  return (
    <p className="option-text small">
      When you press Flash, the app waits for the keyboard's bootloader: unplug
      it, hold Esc, and plug it back in
      {connected && moduleIn ? ", or use Restart into bootloader" : ""}
      .
    </p>
  );
}

/** The hint shown while the app waits for the bootloader. */
export function BootloaderHint({
  connected,
  moduleIn,
}: {
  connected: boolean;
  /** The keyboard runs the profile switcher (it can restart into its bootloader). */
  moduleIn: boolean;
}) {
  return (
    <p className="option-text small">
      {connected && moduleIn ? "Use Restart into bootloader below, or u" : "U"}
      nplug the keyboard, hold Esc, and plug it back in (keep Esc held for a
      second).
    </p>
  );
}
