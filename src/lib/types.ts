/**
 * Data model shared with the Rust side (src-tauri/src/model.rs). Keep both in sync:
 * the JSON on disk is exactly this shape.
 */

/**
 * "row,col" for matrix keys, "e0:cw" / "e0:ccw" for the knob rotation. In `Profile.binds` they
 * carry their keyboard layer: "L2:3,1" (see `lib/keyIds.ts`).
 */
export type KeyId = string;

export type MacroStep =
  | { op: "tap" | "down" | "up"; keycode: number }
  | { op: "delay"; ms: number };

export type Bind =
  | { kind: "key"; keycode: number }
  | { kind: "qmk"; source: string; keycode: number }
  | {
      kind: "macro";
      name: string;
      steps: MacroStep[];
      /** Ms to wait after each key step (an explicit delay replaces it there). Absent: the PC's
       * default, `AppSettings.macroGap`. */
      gap?: number;
      /** The macro bank entry this key plays (`AppConfig.macros`). The bind keeps its own copy of
       * `name`/`steps`/`gap`, always equal to the entry's, so sending, export and the protocol
       * don't need the bank. Absent only in files from before the bank (given one on load). */
      macroId?: string;
    };

/** A macro in the bank: reusable on any key, in any profile. Kept until deleted, even unused. */
export interface BankMacro {
  id: string;
  name: string;
  steps: MacroStep[];
  gap?: number;
}

/** 0–255 each, like QMK. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export interface Lighting {
  /** VIA effect id, 0 = off (see rgbEffects in the generated layout). */
  effect: number;
  speed: number;
  brightness: number;
  hue: number;
  sat: number;
  /**
   * Per-key colours drawn over the effect (the profile switcher). With effect 0 only these keys
   * light up. Omitted when empty. Knob ids have no LED and are never set.
   */
  keys?: Record<KeyId, Hsv>;
  /**
   * Colour layers over the effect, bottom to top; where they overlap the higher one wins. The app
   * saves these instead of `keys` (older files are converted on load). Omitted when empty.
   */
  layers?: ColorLayer[];
  /** Keychron's "Mix RGB" effect (24): regions of keys, each playing its own effects. */
  mix?: MixLighting;
}

/** How a colour layer's keys move (drawn by the profile switcher). Absent = static. */
export type Anim = "static" | "breathe" | "cycle" | "reactive";

/** One colour on a set of keys, still or animated. */
export interface ColorLayer {
  id: string;
  name: string;
  color: Hsv;
  keys: KeyId[];
  /** Kept in the stack but not drawn. */
  hidden?: boolean;
  anim?: Anim;
  /** Animation speed, 0–255. */
  speed?: number;
}

/** Keychron's Mix RGB: every key belongs to one region; each region plays its effects in turn. */
export interface MixLighting {
  /** The first region holds every key that isn't in another one (its `keys` stay empty). */
  regions: MixRegion[];
}

export interface MixRegion {
  keys: KeyId[];
  effects: MixEffect[];
}

export interface MixEffect {
  effect: number;
  hue: number;
  sat: number;
  speed: number;
  /** How long it plays before the next one, in ms (only matters with several). */
  time: number;
}

/** name: this file name in any folder; path: only this exact file; folder: any program in it. */
export type ProgramMatch = "name" | "path" | "folder";

/** A program (and optionally a window title) that turns a profile on. */
export interface ProgramRule {
  /** Full path as picked; the folder for "folder". Empty: any program (then `title` is needed). */
  path: string;
  /** Default "name". */
  match?: ProgramMatch;
  /** Only while the window title contains this (case-insensitive). */
  title?: string;
}

export interface Profile {
  id: string;
  name: string;
  /** Programs that turn this profile on; the most specific match wins (see lib/programs.ts). */
  programs: ProgramRule[];
  binds: Record<KeyId, Bind>;
  /** null → default profile: leave the keyboard's lighting alone; custom profile: same as default. */
  lighting: Lighting | null;
}

export interface AppConfig {
  /** 2: `programs`. Version 1 files had `exes` (file names only); they're converted on load. */
  version: number;
  /** profiles[0] is always the default profile (id "default"). */
  profiles: Profile[];
  /** The macro bank, shared by every profile on this PC. Omitted from the file while empty. */
  macros?: BankMacro[];
}

export interface BaseKeymap {
  source: "keyboard" | "cache" | "fallback";
  /** The keyboard's default layer (the Mac/Win switch picks it), as it reported. */
  layer: number;
  /** Every layer of its keymap, as stored: transparent keys stay KC_TRNS (1). */
  layers: Array<Record<KeyId, number>>;
  /** The keyboard it was read from (a board id, see src/lib/boards.ts). */
  board?: string | null;
}

export interface EngineState {
  connected: boolean;
  /** "ok" once the firmware answered the status query, "missing" if it replied "unhandled". */
  firmware: "ok" | "missing" | "unknown";
  /** Profile switcher protocol the keyboard speaks: 2 colours, 3 steady lighting, 4 Fn + animations. */
  firmwareVersion: number;
  /** Which firmware project the keyboard's build came from (the app stamps it into its builds; 0 unknown). */
  buildId: number;
  /** The keyboard answered Keychron's Mix RGB command. */
  mixRgb: boolean;
  /** How many Mix RGB regions the keyboard has (0: none, or not connected). */
  mixRegions: number;
  /** The keyboard plugged in (a board id), when the app knows it. */
  board: string | null;
  /** A keyboard plugged in whose firmware has no Raw HID (a board id): only reflashing helps. */
  unreachable: string | null;
  mode: "auto" | "manual";
  activeProfileId: string;
  lastError: string | null;
}

/**
 * The focused window, sent on its own (`focus-state`) so a title change (up to four times a
 * second) doesn't re-render every `EngineState` subscriber.
 */
export interface FocusState {
  /** File name of the focused program. */
  exe: string | null;
  path: string | null;
  title: string | null;
}

/** This PC's settings (settings.json), applied at once. */
export interface AppSettings {
  /** Key legends: "auto" (Windows' layout) or a Windows layout id. */
  keyLabels: string;
  /** A Windows notification when the profile changes while the window isn't in front. */
  notifyOnSwitch: boolean;
  /** Closing the window keeps the app in the tray (else it quits). */
  closeToTray: boolean;
  /** More detail in the log file. */
  verboseLog: boolean;
  /** The user's names for the keyboard's layers ("2" → "Windows"), shown on the layer tabs. */
  layerNames: Record<string, string>;
  /** Firmware tab: a QMK MSYS install to use instead of the one found (null: find it). */
  fwMsysPath: string | null;
  /** Firmware tab: a qmk_firmware folder to use instead of the app's download (null: the app's). */
  fwSourcePath: string | null;
  /** Firmware tab: the ready-made firmware, or building your own. Null until the user picks one:
   * the tab then opens on whichever suits what's installed. */
  fwMode: FwMode | null;
  /** Firmware: read what is on the keyboard into a backup before every flash. */
  fwBackup: boolean;
  /** Light or dark, or follow Windows. */
  theme: Theme;
  /** Colours saved in the colour picker, to reuse in any profile. */
  savedColors: Hsv[];
  /** The last keyboard plugged in (a board id): shown while none is. */
  lastBoard: string | null;
  /** The getting-started guide was closed (it opens by itself until then). */
  guideSeen: boolean;
  /** Quietly check for a newer app release a little after start. */
  checkUpdatesOnStart: boolean;
  /** Ms a macro waits after each key step, for macros without a gap of their own. */
  macroGap: number;
}

export type Theme = "system" | "light" | "dark";

/** The two ways to get firmware onto the keyboard (Firmware tab). */
export type FwMode = "basic" | "advanced";

export const DEFAULT_SETTINGS: AppSettings = {
  keyLabels: "auto",
  notifyOnSwitch: true,
  closeToTray: true,
  verboseLog: false,
  layerNames: {},
  fwMsysPath: null,
  fwSourcePath: null,
  fwMode: null,
  fwBackup: true,
  theme: "system",
  savedColors: [],
  lastBoard: null,
  guideSeen: false,
  checkUpdatesOnStart: true,
  /** Must match protocol::DEFAULT_MACRO_GAP. */
  macroGap: 10,
};

export interface AppInfo {
  version: string;
  configDir: string;
  logDir: string;
}

/** A newer release of the app (GitHub Releases, via the Tauri updater). */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

/** A program with a window open (program picker). */
export interface RunningProgram {
  path: string;
  name: string;
  title: string;
}

export const DEFAULT_PROFILE_ID = "default";

/** A Windows keyboard layout, for the key legends. */
export interface LayoutInfo {
  /** Windows layout id (KLID), e.g. "0000040C" for French. */
  id: string;
  name: string;
  /** In the user's own list of input layouts. */
  installed: boolean;
}

export interface LayoutList {
  /** The layout Windows uses by default, when known. */
  current: string | null;
  /** Installed layouts first, then all the others. */
  layouts: LayoutInfo[];
}
