import { BOOTLOADER_USB, boardByUsb, type BoardInfo } from "./boards";
import type { UsbDevice } from "./firmwareTypes";

/** A device as the user can recognise it: what Windows calls it, and its USB id. */
export function describeDevice(d: UsbDevice): string {
  const name = d.description || d.bootloader || "an unnamed device";
  const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  return `"${name}" (${hex4(d.vid)}:${hex4(d.pid)})`;
}

/** The keyboard a firmware is for: one of the app's boards, or (a project for a keyboard the app
 * has no data for) just its name, bootloader and firmware folder. */
export type FlashBoard = Pick<BoardInfo, "name"> & { id?: string; bootloader?: string | null; firmware?: string | null };

/** What the app knows about the keyboard it is being asked to write firmware to. */
export interface FlashTarget {
  /** The keyboard itself is plugged in, running its firmware (working or not). */
  observed: boolean;
  /** The device in bootloader mode a flash would write to, if any. */
  bootloader: UsbDevice | undefined;
  /** Every device in bootloader mode that could be this keyboard (its bootloader's USB id). */
  candidates: UsbDevice[];
  /** The app can't tell whether a device in bootloader mode is this keyboard: the user picks it. */
  needsPick: boolean;
  /** The picked device's instance id, to hand to `flashPrebuilt` (null: nothing to vouch for). */
  chosen: string | null;
  /** Why the app won't flash, as text to show next to the button (null: it will). */
  blocked: string | null;
}

/**
 * Whether the app may write `board`'s firmware to what it can see.
 *
 * 221 of the 269 boards share the `0483:DF11` bootloader, which is also the generic STM32 DFU id
 * that dev boards, printer mainboards and flight controllers present. So once a keyboard is in
 * bootloader mode nothing can tell the app which model — or even which *kind* of device — it is.
 * The app therefore wants to have seen the keyboard itself; failing that, the user picks the
 * device in bootloader mode that is theirs (`DevicePicker`). The same checks run in Rust
 * (`quick::flash_prebuilt` and `quick::pick_bootloader`), so this only explains them.
 *
 * `pick`: what the user chose in the picker — an instance id, "" for "none of these", or null
 * while they haven't touched it: then the only candidate is taken, so the picker opens on it.
 */
export function flashTarget(board: FlashBoard | undefined, devices: UsbDevice[], pick: string | null): FlashTarget {
  const usb = board?.bootloader ? BOOTLOADER_USB[board.bootloader] : undefined;
  const candidates = devices.filter((d) => d.kind === "bootloader" && (!usb || (d.vid === usb[0] && d.pid === usb[1])));
  const isIt = (b: BoardInfo | undefined) => !!b && (board?.id ? b.id === board.id : !!board?.firmware && b.firmware === board.firmware);
  const observed = !!board && devices.some((d) => d.kind === "keyboard" && isIt(boardByUsb(d.vid, d.pid)));
  const name = board?.name.replace(/^Keychron\s+/, "") ?? "keyboard";
  if (!board || observed) return { observed, bootloader: candidates[0], candidates, needsPick: false, chosen: null, blocked: null };

  if (!candidates.length) {
    const other = devices.find((d) => d.kind === "keyboard");
    const blocked = other
      ? `The keyboard plugged in isn't a ${name}. The app won't write the ${name}'s firmware to a different keyboard.`
      : `Plug the ${name} in first. Its firmware doesn't have to be working — the app just won't write firmware to a keyboard it has never seen.`;
    return { observed, bootloader: undefined, candidates, needsPick: false, chosen: null, blocked };
  }
  const wanted = pick ?? (candidates.length === 1 ? candidates[0].instance : "");
  const bootloader = candidates.find((d) => d.instance === wanted);
  const blocked = !bootloader
    ? `Choose the device that is your ${name}, or plug the ${name} in normally so the app can recognise it.`
    : candidates.length > 1
      ? `${candidates.length} devices are in bootloader mode and share one USB id, so the flashing tool can't aim at just one: unplug the ones that aren't your ${name}.`
      : null;
  return { observed, bootloader, candidates, needsPick: true, chosen: bootloader?.instance ?? null, blocked };
}
