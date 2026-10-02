import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as autostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { FirmwareBackend } from "./firmwareMock";
import type {
  FirmwareProject,
  FirmwareStatus,
  JobEvent,
  KeyboardInfo,
  LogLine,
  PrebuiltInfo,
  ProjectSnapshot,
} from "./firmwareTypes";
import { BOARD, fallbackBaseKeymap } from "./layout";
import type { Legend } from "../qmk/labels";
import type {
  AppConfig,
  AppInfo,
  UpdateInfo,
  AppSettings,
  BaseKeymap,
  EngineState,
  FocusState,
  KeyId,
  LayoutList,
  Lighting,
  Profile,
  RunningProgram,
} from "./types";

/** Everything the app asks of its Rust side. The Firmware tab's calls are `fw…` (FirmwareBackend). */
export interface Backend extends FirmwareBackend {
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  getEngineState(): Promise<EngineState>;
  /** The focused window, on its own so a title change doesn't re-render every state subscriber. */
  getFocusState(): Promise<FocusState>;
  /** profileId forces that profile (Default included); null returns to automatic switching. */
  setOverride(profileId: string | null): Promise<void>;
  getBaseKeymap(): Promise<BaseKeymap>;
  refreshBaseKeymap(): Promise<BaseKeymap>;
  previewLighting(lighting: Lighting | null): Promise<void>;
  /** The keyboard's own lighting, read when it connected; null before that. */
  getKeyboardLighting(): Promise<Lighting | null>;
  pickExe(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Programs with a window open right now. */
  listRunningPrograms(): Promise<RunningProgram[]>;
  /** A program's (or folder's) icon as a PNG data URL, null when there's none. */
  getProgramIcon(path: string): Promise<string | null>;
  /** "Start with Windows (in the tray)". App-level, applied immediately. */
  getAutostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  /** This PC's settings (settings.json). */
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  /** A newer release, or null; throws when it can't tell (offline, no release yet). */
  checkUpdate(): Promise<UpdateInfo | null>;
  /** Installs the release `checkUpdate` found; the app restarts. */
  installUpdate(): Promise<void>;
  openFolder(which: "config" | "logs"): Promise<void>;
  /** Asks where to save, then writes the profiles there. false if the user cancelled. */
  exportProfiles(profiles: Profile[], suggestedName: string): Promise<boolean>;
  /** Asks for a file, then reads profiles from it. null if the user cancelled. */
  importProfiles(): Promise<Profile[] | null>;
  /** A line in the app's log file. */
  log(level: "info" | "warn" | "error", message: string): Promise<void>;
  /** Keyboard layouts Windows knows, for the key legends. */
  listKeyboardLayouts(): Promise<LayoutList>;
  /** What each key types in a layout, asked from Windows: keycode (decimal) → legend. */
  getLayoutLegends(id: string): Promise<Record<string, Legend>>;
  onEngineState(cb: (s: EngineState) => void): Promise<UnlistenFn>;
  onBaseKeymap(cb: (b: BaseKeymap) => void): Promise<UnlistenFn>;
  /** The saved profiles changed on the backend's side (Default adopted the keyboard's lighting). */
  onConfigChanged(cb: (c: AppConfig) => void): Promise<UnlistenFn>;
  /** The keyboard's own lighting was read on connect (no polling needed). */
  onKeyboardLighting(cb: (l: Lighting) => void): Promise<UnlistenFn>;
  /** The focused window changed (its title changes up to four times a second). */
  onFocusState(cb: (f: FocusState) => void): Promise<UnlistenFn>;
  /** The keyboard tester: `true` asks the keyboard to report every key event, and must
   * be repeated every 2 s (it stops 5 s after the last one); `false` stops it. Resolves to whether
   * the keyboard is reporting (it can't start without a free slot for the task that sends them). */
  setKeyReport(on: boolean): Promise<boolean>;
  /** A key went down or up on the keyboard, while key reports are on. */
  onKeyEvent(cb: (e: KeyEvent) => void): Promise<UnlistenFn>;
}

/** A key the keyboard reported: "3,1", or a knob turn "e0:cw" (down, then up). */
export interface KeyEvent {
  key: KeyId;
  down: boolean;
}

/**
 * Before the keyboard was ever read (source "fallback", or a cache from an older version without
 * layers), the Rust side has no layers: use Keychron's stock keymap then.
 */
/** A keymap to draw: the keyboard's (or its cache), unless it's empty or another keyboard's. */
function withFallback(base: BaseKeymap): BaseKeymap {
  const other = !!base.board && !!BOARD.id && base.board !== BOARD.id;
  return base.layers?.length && !other
    ? base
    : { ...fallbackBaseKeymap(), source: other ? "fallback" : base.source };
}

const PROFILE_FILTER = { name: "Keyboard profiles", extensions: ["json"] };
/** File names Windows accepts. */
export const safeFileName = (name: string) =>
  name.replace(/[<>:"/\\|?*]+/g, "_").trim() || "profiles";

const tauriBackend: Backend = {
  loadConfig: () => invoke("load_config"),
  saveConfig: (config) => invoke("save_config", { config }),
  getEngineState: () => invoke("get_engine_state"),
  getFocusState: () => invoke("get_focus_state"),
  setOverride: (profileId) => invoke("set_override", { profileId }),
  getBaseKeymap: async () =>
    withFallback(await invoke<BaseKeymap>("get_base_keymap")),
  refreshBaseKeymap: async () =>
    withFallback(await invoke<BaseKeymap>("refresh_base_keymap")),
  previewLighting: (lighting) => invoke("preview_lighting", { lighting }),
  getKeyboardLighting: () => invoke("get_keyboard_lighting"),
  async pickExe() {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose a program",
      filters: [{ name: "Programs", extensions: ["exe"] }],
    });
    return typeof picked === "string" ? picked : null;
  },
  async pickFolder() {
    const picked = await open({
      multiple: false,
      directory: true,
      title: "Choose a folder",
    });
    return typeof picked === "string" ? picked : null;
  },
  listRunningPrograms: () => invoke("list_running_programs"),
  getProgramIcon: (path) => invoke("get_program_icon", { path }),
  getAutostart: () => autostartEnabled(),
  setAutostart: (enabled) => (enabled ? enableAutostart() : disableAutostart()),
  getSettings: () => invoke("get_settings"),
  saveSettings: (settings) => invoke("save_settings", { new: settings }),
  getAppInfo: () => invoke("get_app_info"),
  checkUpdate: () => invoke("check_update"),
  installUpdate: () => invoke("install_update"),
  openFolder: (which) => invoke("open_folder", { which }),
  async exportProfiles(profiles, suggestedName) {
    const path = await save({
      title: profiles.length === 1 ? "Export profile" : "Export profiles",
      defaultPath: `${safeFileName(suggestedName)}.json`,
      filters: [PROFILE_FILTER],
    });
    if (!path) return false;
    await invoke("export_profiles", {
      path,
      profiles,
      keyboard: BOARD.id || null,
    });
    return true;
  },
  async importProfiles() {
    const path = await open({
      multiple: false,
      directory: false,
      title: "Import profiles",
      filters: [PROFILE_FILTER],
    });
    if (typeof path !== "string") return null;
    return invoke<Profile[]>("import_profiles", { path });
  },
  log: (level, message) => invoke("log_message", { level, message }),
  fwStatus: () => invoke<FirmwareStatus>("fw_status"),
  fwCheckUpdates: (force) =>
    invoke<FirmwareStatus>("fw_check_updates", { force }),
  fwInstallToolchain: () => invoke<number>("fw_install_toolchain"),
  fwDownloadSource: () => invoke<number>("fw_download_source"),
  fwInstallDrivers: () => invoke<number>("fw_install_drivers"),
  fwGetTools: () => invoke<number>("fw_get_tools"),
  fwPrebuiltInfo: (board, force) =>
    invoke<PrebuiltInfo>("fw_prebuilt_info", { board, force }),
  fwCancel: () => invoke("fw_cancel"),
  fwBuild: (id) => invoke<number>("fw_build", { id }),
  fwFlash: (id, device) => invoke<number>("fw_flash", { id, device }),
  fwFlashPrebuilt: (board, device) =>
    invoke<number>("fw_flash_prebuilt", { board, device }),
  fwEnterBootloader: () => invoke("fw_enter_bootloader"),
  fwProjects: () => invoke<FirmwareProject[]>("fw_projects"),
  fwReorderProjects: (ids) => invoke("fw_reorder_projects", { ids }),
  fwGetProject: (id) => invoke<FirmwareProject>("fw_get_project", { id }),
  fwKeyboards: () => invoke<KeyboardInfo[]>("fw_keyboards"),
  fwTemplates: (keyboard) => invoke<string[]>("fw_templates", { keyboard }),
  fwCreateProject: (name, keyboard, template, withModule) =>
    invoke<FirmwareProject>("fw_create_project", {
      name,
      keyboard,
      template,
      withModule,
    }),
  fwRenameProject: (id, name) =>
    invoke<FirmwareProject>("fw_rename_project", { id, name }),
  fwDuplicateProject: (id) =>
    invoke<FirmwareProject>("fw_duplicate_project", { id }),
  fwSetFlashed: (id, flashed) => invoke("fw_set_flashed", { id, flashed }),
  fwDeleteProject: (id) => invoke<ProjectSnapshot>("fw_delete_project", { id }),
  fwRestoreProject: (snapshot) =>
    invoke<FirmwareProject>("fw_restore_project", { snapshot }),
  fwReadFile: (id, path) => invoke<string>("fw_read_file", { id, path }),
  fwWriteFile: (id, path, text) => invoke("fw_write_file", { id, path, text }),
  fwCreateFile: (id, path, text) =>
    invoke("fw_create_file", { id, path, text }),
  fwDeleteFile: (id, path) => invoke<string>("fw_delete_file", { id, path }),
  fwRenameFile: (id, from, to) => invoke("fw_rename_file", { id, from, to }),
  fwAddModule: (id) => invoke("fw_add_module", { id }),
  fwOpenFolder: (id) => invoke("fw_open_folder", { id }),
  onFwJob: (cb) => listen<JobEvent>("fw-job", (e) => cb(e.payload)),
  onFwLog: (cb) => listen<LogLine>("fw-log", (e) => cb(e.payload)),
  listKeyboardLayouts: () => invoke("list_keyboard_layouts"),
  getLayoutLegends: (id) => invoke("get_layout_legends", { id }),
  onEngineState: (cb) =>
    listen<EngineState>("engine-state", (e) => cb(e.payload)),
  onBaseKeymap: (cb) =>
    listen<BaseKeymap>("base-keymap", (e) => cb(withFallback(e.payload))),
  onConfigChanged: (cb) =>
    listen<AppConfig>("config-changed", (e) => cb(e.payload)),
  onKeyboardLighting: (cb) =>
    listen<Lighting>("keyboard-lighting", (e) => cb(e.payload)),
  onFocusState: (cb) => listen<FocusState>("focus-state", (e) => cb(e.payload)),
  setKeyReport: (on) => invoke<boolean>("set_key_report", { on }),
  onKeyEvent: (cb) => listen<KeyEvent>("key-event", (e) => cb(e.payload)),
};

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The backend the app talks to. In the browser (dev:ui, tests) it is the mock, loaded lazily so it
 * never ends up in the production bundle. */
export let api: Backend = tauriBackend;
export let isMock = false;

/** Swap in the browser mock when there is no Tauri. Called once from `main.tsx` before the app
 * renders; the tests call it too. */
export async function initApi(): Promise<void> {
  if (inTauri) return;
  const { createMockBackend } = await import("./mockBackend");
  api = createMockBackend();
  isMock = true;
}
