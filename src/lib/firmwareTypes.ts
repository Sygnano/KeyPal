/** The Firmware tab's data, mirroring `src-tauri/src/firmware/`. */

export type CheckState = "missing" | "outdated" | "ok";

export interface ToolchainStatus {
  state: CheckState;
  path: string | null;
  version: string | null;
  latest: string | null;
  /** Installed by the app, in its data folder. */
  managed: boolean;
}

export interface SourceStatus {
  state: CheckState;
  path: string;
  branch: string | null;
  commit: string | null;
  latestBranch: string | null;
  latestCommit: string | null;
  /** The app's own download (it can update it), else a folder the user chose. */
  managed: boolean;
}

export interface DriverStatus {
  /** ok: the plugged-in bootloader has a driver; missing: it has none; installed: the app
   * installed them earlier; unknown: nothing to check against. */
  state: "ok" | "missing" | "installed" | "unknown";
  installedAt: string | null;
}

/** The small flashing tools the Basic path downloads (dfu-util and friends, about 0.5 MB). */
export interface FlashToolsStatus {
  state: "ok" | "missing";
  path: string;
  /** The ones still missing, by file name. */
  missing: string[];
}

/** One release's ready-made firmware for one keyboard. */
export interface Prebuilt {
  file: string;
  sha256: string;
  size: number;
  /** Keychron's keymap it was built from ("keychron", "via"…). */
  keymap: string;
}

export interface PrebuiltInfo {
  /** The release it comes from ("v0.2.0"). */
  tag: string;
  /** The module's protocol version in it. */
  module: number;
  /** Keychron's branch and commit it was built from. */
  branch: string;
  commit: string;
  /** The QMK keyboard folder it's for. */
  keyboard: string;
  /** Null when that release has no firmware for this keyboard. */
  entry: Prebuilt | null;
  /** False when the firmware comes from a published release other than this build of the app
   * (a development build, or a release that is still a draft). */
  ownRelease: boolean;
}

/** What was on a keyboard before the app wrote to it (`firmware::backup`). */
export interface FirmwareBackup {
  /** `<board id>-<seconds since 1970>`. */
  id: string;
  /** The keyboard it was read from (a `board.rs` id): it is only written back to that model. */
  board: string;
  /** The keyboard's name then. */
  name: string;
  /** Seconds since 1970. */
  at: number;
  size: number;
  sha256: string;
}

export interface UsbDevice {
  vid: number;
  pid: number;
  kind: "keyboard" | "bootloader";
  bootloader: string | null;
  driver: string | null;
  description: string;
  /** Windows' device instance id: unique per plugged-in device, so two devices sharing a USB id
   * are told apart. */
  instance: string;
}

export interface RunningJob {
  id: number;
  kind: JobKind;
}

export interface FirmwareStatus {
  toolchain: ToolchainStatus;
  source: SourceStatus;
  driver: DriverStatus;
  flashTools: FlashToolsStatus;
  devices: UsbDevice[];
  job: RunningJob | null;
  updateError: string | null;
  projectsDir: string;
  dataDir: string;
  /** The profile switcher module bundled with the app (its protocol version). */
  moduleVersion: number;
}

export type JobKind =
  | "toolchain"
  | "source"
  | "drivers"
  | "tools"
  | "build"
  | "flash"
  /** Reading the keyboard's firmware into a backup, nothing written. */
  | "backup";

export interface JobEvent {
  id: number;
  kind: JobKind;
  state: "running" | "ok" | "failed" | "cancelled";
  message: string | null;
  progress: number | null;
  step: string | null;
  /** False while the firmware is being written: Cancel is hidden (and refused). */
  cancellable: boolean;
}

export interface LogLine {
  id: number;
  line: string;
}

export interface BuildInfo {
  file: string;
  size: number;
  /** Seconds since 1970. */
  at: number;
  /** Fingerprint of the project's files it was built from (absent: built before it was kept). */
  sources?: string;
}

export interface FirmwareProject {
  id: string;
  name: string;
  /** QMK keyboard path, e.g. "keychron/v6_8k/iso_encoder". */
  keyboard: string;
  /** Built as this keymap in the firmware tree. */
  keymap: string;
  files: string[];
  lastBuild: BuildInfo | null;
  /** The profile switcher module's protocol version, when the project has it. */
  moduleVersion: number | null;
  /** The id a build of this project stamps into its firmware, and the keyboard reports back. */
  buildId: number;
  /** The app last put this one on its keyboard (it flashed it, or the user said so). */
  flashed: boolean;
  /** It is the one on the keyboard, but its files changed since they were put there (false when
   * that isn't known: marks from before the app recorded it). */
  unflashedChanges: boolean;
  /** Its last build isn't of the files as they are on disk (none yet, files changed since, or the
   * firmware file is gone): flashing builds it first. */
  buildOutdated: boolean;
}

/** What's needed to put a deleted project back: its folder is moved to a trash folder and moved
 * back on undo, so a project with a binary or a large file can be deleted too. */
export interface ProjectSnapshot {
  id: string;
  name: string;
  keyboard: string;
}

export interface KeyboardInfo {
  path: string;
  name: string;
  pid: number | null;
  bootloader: string | null;
}

export type ProjectTemplate =
  | { kind: "keymap"; name: string }
  | { kind: "folder"; path: string }
  | { kind: "empty" };
