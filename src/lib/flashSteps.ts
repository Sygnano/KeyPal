import type { JobEvent, JobKind } from "./firmwareTypes";

export type StepState = "pending" | "active" | "done" | "failed";

/**
 * What the app knows of the keyboard: it answers with the current profile switcher, with an older
 * one, it is plugged in but says nothing of a module (none in its firmware, or no Raw HID at all),
 * or it isn't there.
 */
export type KeyboardState = "ready" | "old" | "back" | "away";

/** The way from "nothing on the keyboard" to "ready". The first step depends on the path: the
 * ready-made firmware is downloaded, a project is built. */
export const FLASH_STEPS = [
  "Getting the firmware",
  "Waiting for the bootloader",
  "Flashing",
  "Keyboard restarting",
  "Keyboard ready",
] as const;
const BUILD_STEP = "Building the firmware";
/** `backup::read`'s step: the firmware on the keyboard is read before it is written over. */
const BACKUP_STEP = "Backing up the firmware on the keyboard";

const LAST = FLASH_STEPS.length - 1;

/** Which step a flash task is on: `quick::flash_bin`'s step texts (the one flash path, used for
 * the ready-made firmware and for a project's build alike). */
function stepIndex(step: string | null): number {
  if (!step) return 0;
  if (step.startsWith("Waiting for the keyboard's bootloader")) return 1;
  // Part of the write step: the keyboard is in its bootloader, nothing written yet.
  if (step.startsWith(BACKUP_STEP)) return 2;
  if (step.startsWith("Flashing")) return 2;
  if (step.startsWith("Waiting for the keyboard to restart")) return 3;
  return 0;
}

export interface FlashProgress {
  /** The steps' names, in order. */
  labels: string[];
  states: StepState[];
  /** The step it is on, counted from 1 (0: not started). */
  count: number;
  /** What to say next to the count. */
  label: string;
  tone: "ok" | "busy" | "bad" | "idle";
}

export interface FlashInput {
  job: { kind: JobKind; state: JobEvent["state"]; step: string | null } | null;
  keyboard: KeyboardState;
  /** The firmware is built here (Advanced mode) rather than downloaded. */
  builds?: boolean;
}

/**
 * Where the keyboard is on the way to having the profile switcher: from the flash task when there
 * is one, else from what the keyboard itself says (a keyboard that already has it is at the end).
 */
export function flashProgress({
  job,
  keyboard,
  builds = false,
}: FlashInput): FlashProgress {
  const flash = job?.kind === "flash" ? job : null;
  const labels: string[] = [...FLASH_STEPS];
  if (builds) labels[0] = BUILD_STEP;
  const upTo = (n: number, at?: StepState): StepState[] =>
    labels.map((_, i) => (i < n ? "done" : i === n && at ? at : "pending"));
  const all = { labels, states: upTo(LAST + 1), count: labels.length };

  if (flash?.state === "running") {
    const at = stepIndex(flash.step);
    return {
      labels,
      states: upTo(at, "active"),
      count: at + 1,
      label: flash.step?.startsWith(BACKUP_STEP) ? "Backing up the firmware" : labels[at],
      tone: "busy",
    };
  }
  if (flash && flash.state !== "ok") {
    const at = stepIndex(flash.step);
    const label = `${flash.state === "cancelled" ? "Cancelled" : "Stopped"}: ${labels[at].toLowerCase()}`;
    return {
      labels,
      states: upTo(at, "failed"),
      count: at + 1,
      label,
      tone: "bad",
    };
  }
  if (keyboard === "ready")
    return { ...all, label: "Keyboard ready", tone: "ok" };
  if (flash) {
    // Written. It is back on USB (a project may have no profile switcher to answer with), or the
    // app is still waiting to see it.
    if (keyboard === "away")
      return {
        labels,
        states: upTo(LAST, "active"),
        count: labels.length,
        label: "Connecting to the keyboard",
        tone: "busy",
      };
    return { ...all, label: "Keyboard restarted", tone: "ok" };
  }
  return {
    labels,
    states: upTo(0),
    count: 0,
    label: keyboard === "old" ? "An update is available" : "Not installed yet",
    tone: "idle",
  };
}
