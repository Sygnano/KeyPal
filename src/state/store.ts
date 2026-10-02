import { create } from "zustand";
import { api, isMock } from "../lib/api";
import { allIds } from "../lib/board";
import { boardId, putBindsOnLayers } from "../lib/keyIds";
import { validateConfig } from "../lib/limits";
import { boardInfo, loadBoard } from "../lib/boards";
import { fallbackBaseKeymap, setBoard } from "../lib/layout";
import {
  MIX_PREFIX,
  REGION_HUES,
  activeKeys,
  layersOf,
  lightingMode,
  mixRegionLimit,
  mixRegionOf,
  restOfMix,
  setRegionKeys,
  shownLighting,
  startingLighting,
  withMixMode,
  type LightingMode,
} from "../lib/lighting";
import { builtinLegends, setLegends } from "../qmk/labels";
import {
  clearKeys,
  layerName,
  lightable,
  migrateConfig,
  newLayerId,
  paintKeys,
} from "../lib/layers";
import { cleanRule, sameRule } from "../lib/programs";
import {
  copyMacro as copyMacroTo,
  createMacro as createMacroOn,
  deleteMacro,
  linkMacro,
  mergeImported,
  migrateMacroBank,
  putMacro,
  unlinkMacro as unlinkMacroAt,
} from "../lib/macroBank";
import {
  createProfileFrom,
  duplicateProfile,
  importedProfiles,
  newDefaultConfig,
  sameJson,
} from "../lib/profiles";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_SETTINGS,
  type AppConfig,
  type AppInfo,
  type UpdateInfo,
  type AppSettings,
  type BaseKeymap,
  type ColorLayer,
  type Bind,
  type EngineState,
  type FocusState,
  type Hsv,
  type KeyId,
  type LayoutInfo,
  type Lighting,
  type MixLighting,
  type Profile,
  type ProgramRule,
} from "../lib/types";
import {
  emptyHistory,
  record,
  redo as redoStep,
  undo as undoStep,
  type History,
} from "./history";

export type Tab = "keys" | "lighting";
/** The app's two sides: the profiles (remaps, lighting) or building and flashing firmware. */
export type Mode = "profiles" | "firmware";

/** Which layout the key legends follow: "auto" (Windows' own) or a Windows layout id. */
export interface KeyLabels {
  choice: string;
  layouts: LayoutInfo[];
  /** Windows' default layout, when known. */
  current: string | null;
  /** The layout the legends show now. */
  active: string | null;
  /** Bumped when the legends change, so the views redraw. */
  version: number;
}

/** Where the key labels choice lived before settings.json (read once to carry it over). */
const OLD_KEY_LABELS_KEY = "v6ps-key-labels";
/** Used when Windows can't say (browser mock without a choice, another OS). */
const FALLBACK_LAYOUT = "00000409";

function oldKeyLabelsChoice(): string | null {
  try {
    const v = localStorage.getItem(OLD_KEY_LABELS_KEY);
    localStorage.removeItem(OLD_KEY_LABELS_KEY);
    return v;
  } catch {
    return null;
  }
}

export type MenuTab = "key" | "macro" | "qmk";

// The Lighting tab's pure logic lives in `lib/lighting.ts`; re-exported here so the components
// that already import it from the store keep working.
export {
  MIX_PREFIX,
  mixRegionOf,
  lightingMode,
  mixRegionLimit,
  restOfMix,
  setRegionKeys,
  type LightingMode,
};

export interface State {
  ready: boolean;
  saved: AppConfig;
  draft: AppConfig;
  /**
   * `draft` differs from `saved`. Maintained incrementally at the few points that replace
   * `draft` or `saved` wholesale (load, apply, discard, undo/redo, the keyboard's lighting
   * adopted) instead of deep-comparing the whole config on every edit: that comparison ran on
   * every keystroke (any component reading it, e.g. the commit bar, re-evaluates on every store
   * update), which was heavy enough on a config with real data to visibly lag things like
   * dragging the colour wheel.
   */
  dirty: boolean;
  /**
   * Ids of the profiles whose draft differs from `saved`. Derived in the same debounced check as
   * `dirty` (see `checkDirtyNow`), so the profile rows don't each deep-compare on every store
   * update while the config is dirty.
   */
  dirtyProfiles: string[];
  /** Undo/redo of the draft. */
  history: History;
  base: BaseKeymap;
  engine: EngineState;
  /** The focused window, kept apart from `engine` so a title change doesn't re-render everything. */
  focus: FocusState;
  selectedProfileId: string;
  /** Bind ids ("L2:3,1": key 3,1 on layer 2). */
  selectedKeyId: KeyId | null;
  menuKeyId: KeyId | null;
  /** Tab the remap menu opens on (null: from the key's current bind). */
  menuTab: MenuTab | null;
  /** Which keyboard layer the Keys tab shows and remaps. Starts on the default layer. */
  keyLayer: number;
  /** Keys picked on the board (board ids: click, Ctrl+click, drag a box), for bulk actions and colours. */
  picked: KeyId[];
  /**
   * Colour layer (or "mix:N" Mix RGB region) being edited on the Lighting tab (null: the effect).
   * While set, the picked keys *are* its keys: picking on the board edits it.
   */
  activeLayerId: string | null;
  /** The keyboard's own lighting, as read when it connected. */
  keyboardLighting: Lighting | null;
  tab: Tab;
  mode: Mode;
  /** "Test keyboard" on the board: keys show going down and up; editing the board is off. Not saved. */
  testing: boolean;
  /** The tester plays a key sound (off by default; this PC's browser storage, `v6ps-tester-sound`). */
  testerSound: boolean;
  collapsed: Record<string, boolean>;
  busy: boolean;
  error: string | null;
  /** A passing confirmation ("Exported 2 profiles"). */
  notice: string | null;
  /** null until known (or if the autostart plugin is unavailable). */
  autostart: boolean | null;
  settings: AppSettings;
  appInfo: AppInfo | null;
  /** Updates: what the last check found (idle before any). */
  update: {
    state: "idle" | "checking" | "none" | "available" | "installing" | "error";
    info: UpdateInfo | null;
    error: string | null;
  };
  settingsOpen: boolean;
  /** The getting-started guide is open (by itself until it's been closed once). */
  guideOpen: boolean;
  /** The "Install the profile switcher" dialog (ready-made firmware, no QMK MSYS). */
  installOpen: boolean;
  keyLabels: KeyLabels;
  /** The keyboard shown (a board id): the one plugged in, else the last one; null before any. */
  boardId: string | null;
  /** Bumped when the board changes: the main area remounts (the layout lives outside React). */
  boardVersion: number;

  /** Loads everything and subscribes to the backend. Returns a function that drops those
   * subscriptions: React's StrictMode mounts the effect twice, and without it every event was
   * then handled twice. */
  init(): Promise<() => void>;
  /** Shows a keyboard (its layout, LEDs, effects, stock keymap); remembered for next time. */
  showBoard(id: string): Promise<void>;
  selectProfile(id: string): void;
  addProfile(): void;
  duplicateProfile(id: string): void;
  removeProfile(id: string): void;
  /** Moves a profile to `to` (its index once moved). Default stays first. */
  moveProfile(id: string, to: number): void;
  renameProfile(id: string, name: string): void;
  /** Browse for a program (or a folder, for a folder rule) and add it. */
  browseProgram(id: string, kind?: "file" | "folder"): Promise<void>;
  addProgram(id: string, rule: ProgramRule): void;
  updateProgram(id: string, index: number, rule: ProgramRule): void;
  removeProgram(id: string, index: number): void;
  exportProfile(id: string): Promise<void>;
  exportAll(): Promise<void>;
  importProfiles(): Promise<void>;
  toggleCollapsed(id: string): void;
  openMenu(keyId: KeyId | null, tab?: MenuTab): void;
  setKeyLayer(layer: number): void;
  /** The user's name for a layer tab, saved on this PC ("" goes back to "Layer N"). */
  renameLayer(layer: number, name: string): Promise<void>;
  setPicked(ids: KeyId[]): void;
  togglePicked(id: KeyId): void;
  /** Same bind on several keys (e.g. disable them all). Bind ids. */
  setBindMany(ids: KeyId[], bind: Bind): void;
  removeBinds(ids: KeyId[]): void;
  /**
   * Quick colour: these keys leave their layers and join one of that colour (made if needed),
   * which becomes the active layer. null takes them out of every layer.
   */
  setKeyColors(ids: KeyId[], color: Hsv | null): void;
  setActiveLayer(id: string | null): void;
  /** New layer on top, made active: with `keys` (default: the picked keys when no layer is
   * active, else none), in `color` (default: white). */
  addLayer(keys?: KeyId[], color?: Hsv): void;
  updateLayer(id: string, patch: Partial<Omit<ColorLayer, "id">>): void;
  removeLayer(id: string): void;
  /** +1 = up (drawn over more), -1 = down. */
  moveLayer(id: string, by: 1 | -1): void;
  /** Mix RGB regions of the selected profile (effect 24). `group`: quick successive edits of the
   * same thing (a slider drag) merge into one undo step; leave it out for structural changes. */
  setMix(mix: MixLighting, group?: string): void;
  /** Mix RGB on (its regions replace the colour layers) or off (back to the effect it had). */
  setMixMode(on: boolean): void;
  /** The Lighting tab's choice: follow Default, an effect with colour layers, or Mix RGB. */
  setLightingMode(mode: LightingMode): void;
  /** A new Mix RGB region on top (up to the keyboard's count), made active: with `keys`
   * (default: the picked keys when none is active). */
  addRegion(keys?: KeyId[]): void;
  /** Removes a Mix RGB region (not the first): its keys go back to the first. */
  removeRegion(region: number): void;
  /** Moves keys into a Mix RGB region (0: the rest). */
  moveToRegion(keys: KeyId[], region: number): void;
  selectKey(keyId: KeyId | null): void;
  /** A macro bind goes through the bank: its entry takes the content, and every key linked to
   * that entry, in every profile, follows (one undo step). */
  setBind(keyId: KeyId, bind: Bind): void;
  /** A new bank entry named `name` (made unique), and this key linked to it. */
  createMacro(keyId: KeyId, name: string): void;
  /** This key plays a bank macro, linked: editing it later changes every key using it. */
  useMacro(keyId: KeyId, macroId: string): void;
  /** This key gets its own copy of a bank macro ("<name> (copy)"). */
  copyMacro(keyId: KeyId, macroId: string): void;
  /** This key's macro becomes an entry of its own; the other keys keep the shared one. */
  unlinkMacro(keyId: KeyId): void;
  /** Removes a bank entry no key uses (one in use stays). */
  deleteBankMacro(macroId: string): void;
  removeBind(keyId: KeyId): void;
  setLighting(lighting: Lighting | null): void;
  setTab(tab: Tab): void;
  setMode(mode: Mode): void;
  /** Turns the keyboard tester on or off (on closes the remap menu). */
  setTesting(on: boolean): void;
  setTesterSound(on: boolean): void;
  apply(): Promise<void>;
  discard(): void;
  undo(): void;
  redo(): void;
  /** Force a profile (Default included) regardless of the focused program. */
  play(profileId: string): Promise<void>;
  /** Stop forcing: back to automatic switching by program. */
  release(): Promise<void>;
  refreshBase(): Promise<void>;
  setAutostart(enabled: boolean): Promise<void>;
  /** Saved on this PC and applied at once. */
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  openSettings(open: boolean): void;
  /** Asks for a newer release; `quiet`: no error shown (the check at start). */
  checkForUpdate(quiet?: boolean): Promise<void>;
  /** Installs the release found; the app restarts. */
  installUpdate(): Promise<void>;
  /** Opens or closes the guide; closing it remembers it was seen. */
  openGuide(open: boolean): void;
  openInstall(open: boolean): void;
  /** "auto" or a Windows layout id; saved on this PC, applied immediately. */
  setKeyLabels(choice: string): Promise<void>;
  clearError(): void;
  clearNotice(): void;
}

const initialEngine: EngineState = {
  connected: false,
  firmware: "unknown",
  firmwareVersion: 0,
  buildId: 0,
  mixRgb: false,
  mixRegions: 0,
  board: null,
  unreachable: null,
  mode: "auto",
  activeProfileId: DEFAULT_PROFILE_ID,
  lastError: null,
};

const initialFocus: FocusState = { exe: null, path: null, title: null };

// ------------------------------------------------------------------ history plumbing

/** Draft changes that aren't user edits (undo/redo themselves, loading). */
let recording = true;
/** Set around Discard's draft change: it's recordable (like any edit) but lands back on `saved`. */
let discarding = false;
/** `settings.json` could not be read at start: the app holds the defaults, so it must not save
 * them over the user's file. Cleared only by a restart that reads it. */
let settingsUnreadable = false;
/** Serialises settings saves: each sends the whole object, so two in flight at once could land
 * out of order and leave the older one on disk. */
let settingsSave: Promise<void> = Promise.resolve();
/** Counts `showBoard` calls, so an older one that resolves late can't put its board back. */
let boardCall = 0;
/** Counts `init` calls, so a replay from an earlier one can't land on a later store. */
let initCall = 0;

/**
 * Set the draft as one undo step, optionally merging with the last change in the same group.
 *
 * The group travels *with* the change, not through a module global that any other `set()` in
 * between would silently clear (the subscriber used to reset it whenever the draft didn't move,
 * so `grouped(x); set({picked}); set({draft})` lost the group). `extra` is set in the same update,
 * so a change that also moves `picked` stays one render.
 */
function edit(nextDraft: AppConfig, group?: string, extra?: Partial<State>) {
  const s = useStore.getState();
  if (s.draft === nextDraft) return;
  const history = record(s.history, s.draft, group ?? null, Date.now());
  const dirty = !discarding;
  // Kept here (per draft change, not per store update) so the row indicator is immediate; the
  // debounced `checkDirtyNow` re-derives it exactly, catching an edit that was undone by hand.
  const dirtyProfiles = dirty
    ? nextDraft.profiles
        .filter((p) => profileDirty(s.saved, nextDraft, p.id))
        .map((p) => p.id)
    : [];
  recording = false;
  useStore.setState({
    ...extra,
    draft: nextDraft,
    history,
    dirty,
    dirtyProfiles,
  });
  recording = true;
  scheduleDirtyCheck();
}

// ------------------------------------------------------------------ helpers

/** The selected profile's layers, edited through `fn`. A profile following Default gets its own
 * copy of Default's lighting first. */
function withLayers(
  s: State,
  fn: (layers: ColorLayer[]) => ColorLayer[],
): AppConfig {
  return mutateProfile(s.draft, s.selectedProfileId, (p) => {
    const lighting = startingLighting(s, p);
    const layers = fn(lighting.layers ?? []);
    delete lighting.keys; // replaced by the layers (see migrateLighting)
    if (layers.length) lighting.layers = layers;
    else delete lighting.layers;
    return { ...p, lighting };
  });
}

/** Keep `activeLayerId` / `picked` in step after the layers changed. */
function syncActive(s: State, activeLayerId: string | null): Partial<State> {
  const keys = activeKeys(s, activeLayerId);
  return keys ? { activeLayerId, picked: [...keys] } : { activeLayerId: null };
}

function mutateProfile(
  draft: AppConfig,
  id: string,
  fn: (p: Profile) => Profile,
): AppConfig {
  return {
    ...draft,
    profiles: draft.profiles.map((p) => (p.id === id ? fn(p) : p)),
  };
}

const TESTER_SOUND_KEY = "v6ps-tester-sound";
function initialTesterSound(): boolean {
  try {
    return localStorage.getItem(TESTER_SOUND_KEY) === "on";
  } catch {
    return false; // no storage (node tests, blocked): off
  }
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useStore = create<State>((set, get) => ({
  ready: false,
  saved: newDefaultConfig(),
  draft: newDefaultConfig(),
  dirty: false,
  dirtyProfiles: [],
  history: emptyHistory(),
  base: fallbackBaseKeymap(),
  engine: initialEngine,
  focus: initialFocus,
  selectedProfileId: DEFAULT_PROFILE_ID,
  selectedKeyId: null,
  menuKeyId: null,
  menuTab: null,
  keyLayer: 2,
  picked: [],
  activeLayerId: null,
  keyboardLighting: null,
  tab: "keys",
  mode: "profiles",
  testing: false,
  testerSound: initialTesterSound(),
  collapsed: {},
  busy: false,
  error: null,
  notice: null,
  autostart: null,
  settings: DEFAULT_SETTINGS,
  appInfo: null,
  update: { state: "idle", info: null, error: null },
  settingsOpen: false,
  guideOpen: false,
  installOpen: false,
  keyLabels: {
    choice: "auto",
    layouts: [],
    current: null,
    active: null,
    version: 0,
  },
  boardId: null,
  boardVersion: 0,

  async init() {
    const mine = ++initCall;
    const [config, engine, read] = await Promise.all([
      api.loadConfig(),
      api.getEngineState(),
      api.getSettings().then(
        (s) => ({ settings: s, error: null as string | null }),
        (e) => ({ settings: DEFAULT_SETTINGS, error: describe(e) }),
      ),
    ]);
    const settings = read.settings;
    // Reading settings.json failed: these are the defaults, not the user's. Writing them back
    // would overwrite whatever is really in the file, so nothing is saved until the app is
    // restarted successfully.
    if (read.error) {
      settingsUnreadable = true;
      set({
        error: `Your settings could not be read (${read.error}). The app is using the default settings and will not save over settings.json until it can read it again.`,
      });
    }
    // The keyboard plugged in, else the last one: its layout first, everything else is drawn on it.
    // The getting-started guide opens by itself until it's been closed once.
    set({ settings, guideOpen: !settings.guideSeen });
    const boardId =
      [engine.board, settings.lastBoard].find((id) => !!boardInfo(id)) ?? null;
    if (boardId)
      await get()
        .showBoard(boardId)
        .catch((e) =>
          set({ error: `Could not load the keyboard: ${describe(e)}` }),
        );
    const base = await api.getBaseKeymap();
    // The Rust side already did this; the browser mock and older data need it too.
    const migrated = migrateMacroBank(putBindsOnLayers(migrateConfig(config), base.layer));
    recording = false;
    set({
      saved: migrated,
      draft: structuredClone(migrated),
      dirty: false,
      dirtyProfiles: [],
      engine,
      base,
      // Not `settings`: it was set above, and `showBoard` may have written `lastBoard` into it
      // since. Putting the captured copy back would make the next save write the old value.
      keyLayer: base.layer,
      ready: true,
      history: emptyHistory(),
    });
    recording = true;
    const loadKeyboardLighting = () =>
      api.getKeyboardLighting().then(
        (keyboardLighting) => set({ keyboardLighting }),
        () => {},
      );
    loadKeyboardLighting();
    const gotEngine = (engine: EngineState) => {
      if (sameJson(engine, get().engine)) return;
      set({ engine });
      // Another keyboard plugged in (reachable or not): show it.
      const plugged = engine.board ?? engine.unreachable;
      if (plugged && plugged !== get().boardId && boardInfo(plugged)) {
        get()
          .showBoard(plugged)
          .catch((e) =>
            set({ error: `Could not load the keyboard: ${describe(e)}` }),
          );
      }
    };
    const gotBase = (base: BaseKeymap) =>
      // A keyboard with fewer layers than the one before: back to its default layer.
      set((s) => ({
        base,
        ...(s.keyLayer >= base.layers.length
          ? { keyLayer: base.layer, picked: [], menuKeyId: null }
          : {}),
      }));
    // The keyboard's own lighting, read on connect: the backend says when it's ready, so there is
    // no guessing delay (a fixed wait used to hope the read had finished).
    const gotKeyboardLighting = (keyboardLighting: Lighting) =>
      set({ keyboardLighting });
    // The focused window, on its own: its title changes up to four times a second, and every
    // `engine` subscriber would re-render with it.
    const gotFocus = (focus: FocusState) => {
      if (sameJson(focus, get().focus)) return;
      set({ focus });
    };
    // Default adopted the keyboard's own lighting: take it without losing unapplied edits.
    const gotConfig = (changed: AppConfig) => {
      const config = migrateMacroBank(putBindsOnLayers(migrateConfig(changed), get().base.layer));
      const { saved, draft } = get();
      if (sameJson(saved, config)) return;
      const clean = sameJson(saved, draft);
      const adopted = config.profiles[0].lighting;
      const nextDraft = clean
        ? structuredClone(config)
        : mutateProfile(draft, DEFAULT_PROFILE_ID, (p) =>
            p.lighting ? p : { ...p, lighting: structuredClone(adopted) },
          );
      recording = false;
      set({
        saved: config,
        draft: nextDraft,
        dirty: !clean,
        dirtyProfiles: clean
          ? []
          : nextDraft.profiles
              .filter((p) => profileDirty(config, nextDraft, p.id))
              .map((p) => p.id),
        // Undoing past this would bring back a Default without lighting.
        history: emptyHistory(),
      });
      recording = true;
    };
    const subscriptions = [
      api.onEngineState(gotEngine),
      api.onBaseKeymap(gotBase),
      api.onConfigChanged(gotConfig),
      api.onKeyboardLighting(gotKeyboardLighting),
      api.onFocusState(gotFocus),
    ];
    const unsubscribe = () =>
      subscriptions.forEach(
        (p) =>
          void p.then(
            (off) => off(),
            () => {},
          ),
      );
    // The backend only emits on *change*, so a keyboard plugged in (or unplugged) while the app
    // was loading was announced before there was anyone listening, and the UI would have sat on
    // "Keyboard not found". Now that the listeners are in place, ask for the current state.
    void Promise.all([
      api.getEngineState(),
      api.getBaseKeymap(),
      api.loadConfig(),
      api.getFocusState(),
    ]).then(
      ([engine, base, config, focus]) => {
        if (mine !== initCall) return;
        gotEngine(engine);
        gotBase(base);
        gotConfig(config);
        gotFocus(focus);
      },
      () => {},
    );
    api.getAutostart().then(
      (autostart) => set({ autostart }),
      () => set({ autostart: null }),
    );
    api.getAppInfo().then(
      (appInfo) => set({ appInfo }),
      () => {},
    );
    // A newer release? Quietly, a little after start (not in the browser preview), unless turned off.
    if (!isMock && settings.checkUpdatesOnStart)
      setTimeout(() => void get().checkForUpdate(true), 8000);
    try {
      const { current, layouts } = await api.listKeyboardLayouts();
      set((s) => ({ keyLabels: { ...s.keyLabels, current, layouts } }));
    } catch {
      // No list (not on Windows): the built-in legends stay.
    }
    // The choice used to live in the webview's storage; carry it over once.
    const old = oldKeyLabelsChoice();
    const choice =
      settings.keyLabels === "auto" && old ? old : settings.keyLabels;
    await get().setKeyLabels(choice);
    return unsubscribe;
  },

  selectProfile(id) {
    set({
      selectedProfileId: id,
      selectedKeyId: null,
      menuKeyId: null,
      picked: [],
      activeLayerId: null,
    });
  },

  addProfile() {
    const { draft } = get();
    const profile = createProfileFrom(draft.profiles[0], draft.profiles);
    set({
      draft: { ...draft, profiles: [...draft.profiles, profile] },
      selectedProfileId: profile.id,
      selectedKeyId: null,
      menuKeyId: null,
      picked: [],
      activeLayerId: null,
    });
  },

  duplicateProfile(id) {
    const { draft } = get();
    const source = draft.profiles.find((p) => p.id === id);
    if (!source) return;
    const copy = duplicateProfile(source, draft.profiles);
    // Right under the original (or at the end for Default, which must stay first).
    const at =
      id === DEFAULT_PROFILE_ID
        ? draft.profiles.length
        : draft.profiles.indexOf(source) + 1;
    const profiles = [...draft.profiles];
    profiles.splice(at, 0, copy);
    set({
      draft: { ...draft, profiles },
      selectedProfileId: copy.id,
      selectedKeyId: null,
      menuKeyId: null,
      picked: [],
      activeLayerId: null,
    });
  },

  removeProfile(id) {
    if (id === DEFAULT_PROFILE_ID) return;
    const { draft, selectedProfileId } = get();
    set({
      draft: { ...draft, profiles: draft.profiles.filter((p) => p.id !== id) },
      selectedProfileId:
        selectedProfileId === id ? DEFAULT_PROFILE_ID : selectedProfileId,
    });
  },

  moveProfile(id, to) {
    const { draft } = get();
    const from = draft.profiles.findIndex((p) => p.id === id);
    if (
      id === DEFAULT_PROFILE_ID ||
      from < 0 ||
      to < 1 ||
      to >= draft.profiles.length ||
      to === from
    )
      return;
    const profiles = [...draft.profiles];
    const [moved] = profiles.splice(from, 1);
    profiles.splice(to, 0, moved);
    set({ draft: { ...draft, profiles } });
  },

  renameProfile(id, name) {
    edit(
      mutateProfile(get().draft, id, (p) => ({ ...p, name })),
      `rename:${id}`,
    );
  },

  async browseProgram(id, kind = "file") {
    const path =
      kind === "folder" ? await api.pickFolder() : await api.pickExe();
    if (path)
      get().addProgram(
        id,
        kind === "folder" ? { path, match: "folder" } : { path },
      );
  },

  addProgram(id, rule) {
    const clean = cleanRule(rule);
    set({
      draft: mutateProfile(get().draft, id, (p) =>
        p.programs.some((r) => sameRule(r, clean))
          ? p
          : { ...p, programs: [...p.programs, clean] },
      ),
      collapsed: { ...get().collapsed, [id]: false },
    });
  },

  updateProgram(id, index, rule) {
    edit(
      mutateProfile(get().draft, id, (p) => ({
        ...p,
        programs: p.programs.map((r, i) => (i === index ? cleanRule(rule) : r)),
      })),
      `program:${id}:${index}`,
    );
  },

  removeProgram(id, index) {
    set({
      draft: mutateProfile(get().draft, id, (p) => ({
        ...p,
        programs: p.programs.filter((_, i) => i !== index),
      })),
    });
  },

  async exportProfile(id) {
    const p = get().draft.profiles.find((x) => x.id === id);
    if (!p) return;
    try {
      if (await api.exportProfiles([p], p.name))
        set({ notice: `Exported ${p.name}.` });
    } catch (e) {
      set({ error: `Could not export: ${describe(e)}` });
    }
  },

  async exportAll() {
    const { profiles } = get().draft;
    try {
      if (await api.exportProfiles(profiles, "Keyboard profiles"))
        set({ notice: `Exported ${profiles.length} profiles.` });
    } catch (e) {
      set({ error: `Could not export: ${describe(e)}` });
    }
  },

  async importProfiles() {
    let incoming: Profile[] | null;
    try {
      incoming = await api.importProfiles();
    } catch (e) {
      set({ error: `Could not import: ${describe(e)}` });
      return;
    }
    if (!incoming?.length) return;
    const { draft } = get();
    const migrated = putBindsOnLayers(
      migrateConfig({ version: 2, profiles: incoming }),
      get().base.layer,
    ).profiles;
    // Their macros join the bank: kept linked where the bank already has the same macro.
    const { macros, profiles: added } = mergeImported(draft, importedProfiles(migrated, draft.profiles));
    set({
      draft: { ...draft, profiles: [...draft.profiles, ...added], ...(macros.length ? { macros } : {}) },
      selectedProfileId: added[0].id,
      selectedKeyId: null,
      menuKeyId: null,
      picked: [],
      activeLayerId: null,
      notice:
        added.length === 1
          ? `Imported ${added[0].name}. Apply to keep it.`
          : `Imported ${added.length} profiles. Apply to keep them.`,
    });
  },

  toggleCollapsed(id) {
    set({ collapsed: { ...get().collapsed, [id]: !get().collapsed[id] } });
  },

  openMenu(keyId, tab) {
    set({
      menuKeyId: keyId,
      menuTab: tab ?? null,
      selectedKeyId: keyId ?? get().selectedKeyId,
    });
  },

  setKeyLayer(keyLayer) {
    if (keyLayer === get().keyLayer) return;
    set({ keyLayer, menuKeyId: null, selectedKeyId: null, picked: [] });
  },

  async renameLayer(layer, name) {
    const layerNames = { ...get().settings.layerNames };
    if (name.trim()) layerNames[String(layer)] = name.trim();
    else delete layerNames[String(layer)];
    await get().updateSettings({ layerNames });
  },

  setPicked(ids) {
    const picked = [...new Set(ids.map(boardId))];
    const s = get();
    const region = mixRegionOf(s.activeLayerId);
    if (s.activeLayerId && s.tab === "lighting" && region !== null) {
      const keys = lightable(picked);
      const mix = shownLighting(s)?.mix;
      if (!mix) return set({ picked });
      // The first region is "the rest": with two regions, taking a key out of it puts it in the other.
      const next =
        region === 0 && mix.regions.length === 2
          ? setRegionKeys(
              mix,
              1,
              allIds("lighting").filter((k) => !keys.includes(k)),
            )
          : setRegionKeys(mix, region, keys);
      edit(
        mutateProfile(s.draft, s.selectedProfileId, (p) => ({
          ...p,
          lighting: { ...startingLighting(s, p), mix: next },
        })),
        `paint:${s.activeLayerId}`,
        { picked: keys },
      );
    } else if (s.activeLayerId && s.tab === "lighting") {
      const keys = lightable(picked);
      const id = s.activeLayerId;
      edit(
        withLayers(s, (ls) =>
          ls.map((l) => (l.id === id ? { ...l, keys } : l)),
        ),
        `paint:${id}`,
        { picked: keys },
      );
    } else set({ picked });
  },

  togglePicked(id) {
    const { picked } = get();
    const key = boardId(id);
    get().setPicked(
      picked.includes(key) ? picked.filter((p) => p !== key) : [...picked, key],
    );
  },

  setBindMany(ids, bind) {
    const { draft, selectedProfileId } = get();
    set({
      draft: mutateProfile(draft, selectedProfileId, (p) => {
        const binds = { ...p.binds };
        for (const id of ids) binds[id] = structuredClone(bind);
        return { ...p, binds };
      }),
      menuKeyId: null,
    });
  },

  removeBinds(ids) {
    const { draft, selectedProfileId, selectedKeyId } = get();
    set({
      draft: mutateProfile(draft, selectedProfileId, (p) => {
        const binds = { ...p.binds };
        for (const id of ids) delete binds[id];
        return { ...p, binds };
      }),
      selectedKeyId:
        selectedKeyId && ids.includes(selectedKeyId) ? null : selectedKeyId,
      menuKeyId: null,
    });
  },

  setKeyColors(ids, color) {
    const s = get();
    const keys = ids.map(boardId);
    if (color) {
      let target = "";
      const draft = withLayers(s, (ls) => {
        const [layers, id] = paintKeys(ls, keys, color);
        target = id;
        return layers;
      });
      set({ draft });
      set(syncActive(get(), target));
    } else {
      set({
        draft: withLayers(s, (ls) =>
          clearKeys(ls, lightable(keys), s.activeLayerId ?? undefined),
        ),
      });
      set(syncActive(get(), s.activeLayerId));
    }
  },

  setActiveLayer(id) {
    const keys = activeKeys(get(), id);
    set(
      keys
        ? { activeLayerId: id, picked: [...keys] }
        : { activeLayerId: null, picked: [] },
    );
  },

  addLayer(ids, color = { h: 0, s: 0, v: 255 }) {
    const s = get();
    const keys = lightable(
      (ids ?? (s.activeLayerId ? [] : s.picked)).map(boardId),
    );
    const layer: ColorLayer = {
      id: newLayerId(),
      name: layerName(color, layersOf(s)),
      color,
      keys,
    };
    set({ draft: withLayers(s, (ls) => [...ls, layer]) });
    set(syncActive(get(), layer.id));
  },

  updateLayer(id, patch) {
    edit(
      withLayers(get(), (ls) =>
        ls.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      ),
      `layer:${id}:${Object.keys(patch).sort().join(",")}`,
    );
  },

  removeLayer(id) {
    const s = get();
    set({ draft: withLayers(s, (ls) => ls.filter((l) => l.id !== id)) });
    if (s.activeLayerId === id) set({ activeLayerId: null, picked: [] });
  },

  moveLayer(id, by) {
    set({
      draft: withLayers(get(), (ls) => {
        const i = ls.findIndex((l) => l.id === id);
        const j = i + by;
        if (i < 0 || j < 0 || j >= ls.length) return ls;
        const out = [...ls];
        [out[i], out[j]] = [out[j], out[i]];
        return out;
      }),
    });
  },

  setMix(mix, group) {
    const s = get();
    // Dragging the speed slider or the colour wheel is one undo step, like every other slider
    // (without this, one drag pushed a hundred whole-config snapshots and emptied the history).
    edit(
      mutateProfile(s.draft, s.selectedProfileId, (p) => ({
        ...p,
        lighting: { ...startingLighting(s, p), mix },
      })),
      group ? `mix:${s.selectedProfileId}:${group}` : undefined,
    );
  },

  setMixMode(on) {
    const s = get();
    const p = s.draft.profiles.find((x) => x.id === s.selectedProfileId);
    if (!p) return;
    const current = startingLighting(s, p);
    const next = withMixMode(s, p, current, on);
    if (next === current) return;
    set({
      draft: mutateProfile(s.draft, p.id, (x) => ({ ...x, lighting: next })),
      activeLayerId: null,
      picked: [],
    });
  },

  setLightingMode(mode) {
    const s = get();
    const p = s.draft.profiles.find((x) => x.id === s.selectedProfileId);
    if (!p || lightingMode(p) === mode) return;
    if (mode === "default") {
      if (p.id === DEFAULT_PROFILE_ID) return;
      set({
        draft: mutateProfile(s.draft, p.id, (x) => ({ ...x, lighting: null })),
        activeLayerId: null,
        picked: [],
      });
      return;
    }
    // Leaving "Like Default" starts from a copy of Default's lighting.
    const next = withMixMode(s, p, startingLighting(s, p), mode === "mix");
    set({
      draft: mutateProfile(s.draft, p.id, (x) => ({ ...x, lighting: next })),
      activeLayerId: null,
      picked: [],
    });
  },

  addRegion(ids) {
    const s = get();
    const mix = shownLighting(s)?.mix;
    if (!mix || mix.regions.length >= mixRegionLimit(s)) return;
    const keys = lightable(
      (ids ?? (s.activeLayerId ? [] : s.picked)).map(boardId),
    );
    const taken = new Set(keys);
    const hue = REGION_HUES[(mix.regions.length - 1) % REGION_HUES.length];
    const region = {
      keys,
      effects: [{ effect: 1, hue, sat: 255, speed: 128, time: 5000 }],
    };
    get().setMix({
      regions: [
        ...mix.regions.map((r, i) =>
          i === 0 ? r : { ...r, keys: r.keys.filter((k) => !taken.has(k)) },
        ),
        region,
      ],
    });
    get().setActiveLayer(`${MIX_PREFIX}${mix.regions.length}`);
  },

  removeRegion(region) {
    const s = get();
    const mix = shownLighting(s)?.mix;
    if (!mix || region < 1 || !mix.regions[region]) return;
    get().setMix({ regions: mix.regions.filter((_, i) => i !== region) });
    const active = mixRegionOf(s.activeLayerId);
    if (active !== null && active >= region)
      set({ activeLayerId: null, picked: [] });
  },

  moveToRegion(keys, region) {
    const s = get();
    const mix = shownLighting(s)?.mix;
    if (!mix?.regions[region]) return;
    const moved = new Set(lightable(keys.map(boardId)));
    // Region 0 is "the rest": leaving every other region puts a key there.
    get().setMix({
      regions: mix.regions.map((r, i) =>
        i === 0
          ? r
          : {
              ...r,
              keys:
                i === region
                  ? [...new Set([...r.keys, ...moved])]
                  : r.keys.filter((k) => !moved.has(k)),
            },
      ),
    });
    const active = mixRegionOf(get().activeLayerId);
    if (active !== null)
      set({ picked: activeKeys(get(), get().activeLayerId) ?? [] });
  },

  selectKey(keyId) {
    set({ selectedKeyId: keyId });
  },

  setBind(keyId, bind) {
    const { draft, selectedProfileId } = get();
    edit(
      bind.kind === "macro"
        ? putMacro(draft, selectedProfileId, keyId, bind)
        : mutateProfile(draft, selectedProfileId, (p) => ({
            ...p,
            binds: { ...p.binds, [keyId]: bind },
          })),
      // Recording, typing: quick edits of one macro merge, whichever key it is edited from.
      bind.kind === "macro" ? `macro:${bind.macroId ?? keyId}` : undefined,
      { selectedKeyId: keyId },
    );
  },

  createMacro(keyId, name) {
    const { draft, selectedProfileId } = get();
    edit(createMacroOn(draft, selectedProfileId, keyId, { name, steps: [] }), undefined, { selectedKeyId: keyId });
  },

  useMacro(keyId, macroId) {
    const { draft, selectedProfileId } = get();
    edit(linkMacro(draft, selectedProfileId, keyId, macroId), undefined, { selectedKeyId: keyId });
  },

  copyMacro(keyId, macroId) {
    const { draft, selectedProfileId } = get();
    edit(copyMacroTo(draft, selectedProfileId, keyId, macroId), undefined, { selectedKeyId: keyId });
  },

  unlinkMacro(keyId) {
    const { draft, selectedProfileId } = get();
    edit(unlinkMacroAt(draft, selectedProfileId, keyId));
  },

  deleteBankMacro(macroId) {
    const next = deleteMacro(get().draft, macroId);
    if (next) edit(next);
    else set({ error: "That macro is still on a key: remove it from its keys first." });
  },

  removeBind(keyId) {
    const { draft, selectedProfileId, selectedKeyId } = get();
    set({
      draft: mutateProfile(draft, selectedProfileId, (p) => {
        const binds = { ...p.binds };
        delete binds[keyId];
        return { ...p, binds };
      }),
      selectedKeyId: selectedKeyId === keyId ? null : selectedKeyId,
      menuKeyId: null,
    });
  },

  setLighting(lighting) {
    const { draft, selectedProfileId } = get();
    edit(
      mutateProfile(draft, selectedProfileId, (p) => ({ ...p, lighting })),
      `lighting:${selectedProfileId}:${lighting === null}`,
    );
  },

  setMode(mode) {
    if (mode === get().mode) return;
    set({
      mode,
      menuKeyId: null,
      ...(get().activeLayerId ? { activeLayerId: null, picked: [] } : {}),
    });
    api.previewLighting(null).catch(() => {});
  },

  setTesting(testing) {
    set(testing ? { testing, menuKeyId: null } : { testing });
  },

  setTesterSound(testerSound) {
    set({ testerSound });
    try {
      localStorage.setItem(TESTER_SOUND_KEY, testerSound ? "on" : "off");
    } catch {
      // Not remembered: fine.
    }
  },

  setTab(tab) {
    set({
      tab,
      menuKeyId: null,
      ...(get().activeLayerId ? { activeLayerId: null, picked: [] } : {}),
    });
    if (tab !== "lighting") api.previewLighting(null).catch(() => {});
  },

  async apply() {
    checkDirtyNow(); // before anything reads `dirty`: an edit-then-revert must not count as a change
    const { draft } = get();
    const problem = validateConfig(draft);
    if (problem) {
      set({ error: problem });
      return;
    }
    set({ busy: true, error: null });
    try {
      await api.saveConfig(draft);
      // The draft can have moved on while the save was in flight (the user kept editing). What
      // was saved is `draft`; anything after it is still unapplied, so `dirty` must say so.
      set((s) => {
        const saved = structuredClone(draft);
        const dirty = s.draft !== draft;
        const dirtyProfiles = dirty
          ? s.draft.profiles
              .filter((p) => profileDirty(saved, s.draft, p.id))
              .map((p) => p.id)
          : [];
        return { saved, dirty, dirtyProfiles };
      });
    } catch (e) {
      set({ error: `Could not apply changes: ${describe(e)}` });
    } finally {
      set({ busy: false });
    }
  },

  /** Undoable, like any other change to the draft. */
  discard() {
    const { saved, selectedProfileId } = get();
    const stillExists = saved.profiles.some((p) => p.id === selectedProfileId);
    discarding = true;
    set({
      draft: structuredClone(saved),
      dirty: false,
      dirtyProfiles: [],
      selectedProfileId: stillExists ? selectedProfileId : DEFAULT_PROFILE_ID,
      selectedKeyId: null,
      menuKeyId: null,
      activeLayerId: null,
      picked: [],
    });
    discarding = false;
    api.previewLighting(null).catch(() => {});
  },

  undo() {
    const step = undoStep(get().history, get().draft);
    if (step) restore(step[0], step[1]);
  },

  redo() {
    const step = redoStep(get().history, get().draft);
    if (step) restore(step[0], step[1]);
  },

  async play(profileId) {
    try {
      await api.setOverride(profileId);
    } catch (e) {
      set({ error: `Could not switch profile: ${describe(e)}` });
    }
  },

  async release() {
    try {
      await api.setOverride(null);
    } catch (e) {
      set({ error: `Could not return to automatic switching: ${describe(e)}` });
    }
  },

  async showBoard(id) {
    if (id === get().boardId) return;
    // `setBoard` mutates module-level state, so an older call finishing after a newer one would
    // draw one board while `boardId` names another. Abandon a call another has overtaken.
    const mine = ++boardCall;
    const data = await loadBoard(id);
    if (mine !== boardCall) return;
    setBoard(data);
    // Its keymap: the keyboard's when it's this one, else Keychron's stock one for it.
    const base = await api.getBaseKeymap().catch(() => fallbackBaseKeymap());
    if (mine !== boardCall) return;
    set((s) => ({
      boardId: id,
      boardVersion: s.boardVersion + 1,
      base,
      keyLayer: base.layer,
      picked: [],
      menuKeyId: null,
      selectedKeyId: null,
      activeLayerId: null,
    }));
    if (get().settings.lastBoard !== id)
      await get().updateSettings({ lastBoard: id });
  },

  async refreshBase() {
    try {
      set({ base: await api.refreshBaseKeymap() });
    } catch (e) {
      set({ error: `Could not read the keymap: ${describe(e)}` });
    }
  },

  async setAutostart(enabled) {
    try {
      await api.setAutostart(enabled);
      set({ autostart: enabled });
    } catch (e) {
      set({ error: `Could not change the start-up setting: ${describe(e)}` });
    }
  },

  async updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (settingsUnreadable) return; // see init(): these are the defaults, not the user's
    // Chain onto the previous save so the writes reach disk in the order they were made.
    settingsSave = settingsSave.then(
      () => api.saveSettings(settings),
      () => api.saveSettings(settings),
    );
    try {
      await settingsSave;
    } catch (e) {
      set({ error: `Could not save the settings: ${describe(e)}` });
    }
  },

  openGuide(open) {
    set({ guideOpen: open });
    if (!open && !get().settings.guideSeen)
      void get().updateSettings({ guideSeen: true });
  },

  openInstall(open) {
    set({ installOpen: open });
  },

  async checkForUpdate(quiet = false) {
    set({ update: { state: "checking", info: null, error: null } });
    try {
      const info = await api.checkUpdate();
      set({
        update: { state: info ? "available" : "none", info, error: null },
      });
      if (info)
        set({
          notice: `Version ${info.version} is available: Settings → Updates.`,
        });
    } catch (e) {
      set({
        update: {
          state: quiet ? "idle" : "error",
          info: null,
          error: describe(e),
        },
      });
    }
  },

  async installUpdate() {
    const info = get().update.info;
    set({ update: { state: "installing", info, error: null } });
    try {
      await api.installUpdate();
    } catch (e) {
      set({ update: { state: "error", info, error: describe(e) } });
    }
  },

  openSettings(open) {
    set({ settingsOpen: open });
  },

  async setKeyLabels(choice) {
    if (get().settings.keyLabels !== choice)
      get().updateSettings({ keyLabels: choice });
    const { current } = get().keyLabels;
    const id = choice === "auto" ? (current ?? FALLBACK_LAYOUT) : choice;
    set((s) => ({ keyLabels: { ...s.keyLabels, choice } }));
    let legends = builtinLegends(id);
    try {
      legends = await api.getLayoutLegends(id);
    } catch (e) {
      if (!legends) {
        set({ error: `Could not read that keyboard layout: ${describe(e)}` });
        return;
      }
    }
    if (get().keyLabels.choice !== choice || !legends) return; // changed again meanwhile
    setLegends(legends);
    set((s) => ({
      keyLabels: {
        ...s.keyLabels,
        active: id,
        version: s.keyLabels.version + 1,
      },
    }));
  },

  clearError() {
    set({ error: null });
  },

  clearNotice() {
    set({ notice: null });
  },
}));

/** Put back a draft from the history, keeping the selection sensible. */
function restore(draft: AppConfig, history: History) {
  recording = false;
  useStore.setState((s) => {
    const exists = draft.profiles.some((p) => p.id === s.selectedProfileId);
    return {
      draft,
      // Undo/redo happen one at a time, not on every drag tick: an exact compare is cheap here.
      dirty: !sameJson(s.saved, draft),
      history,
      selectedProfileId: exists ? s.selectedProfileId : DEFAULT_PROFILE_ID,
      menuKeyId: null,
    };
  });
  recording = true;
  // The rows' "unapplied" markers too, not just the header's flag: without this a profile whose
  // edit was undone kept its marker until the next edit.
  checkDirtyNow();
  const s = useStore.getState();
  useStore.setState(syncActive(s, s.activeLayerId));
  if (!s.activeLayerId) return;
  if (!activeKeys(useStore.getState(), s.activeLayerId))
    useStore.setState({ activeLayerId: null, picked: [] });
}

// Every change to the draft is an undo step, recorded by `edit()` (which also keeps `dirty` and
// `dirtyProfiles` up to date). This subscriber only catches a draft change made without `edit()`
// — a bug, but one that must not leave the history stale — and re-derives `dirty` for it.
useStore.subscribe((s, prev) => {
  if (s.draft === prev.draft || !recording || !prev.ready) return;
  recording = false;
  const dirty = !discarding;
  const dirtyProfiles = dirty
    ? s.draft.profiles
        .filter((p) => profileDirty(s.saved, s.draft, p.id))
        .map((p) => p.id)
    : [];
  useStore.setState({
    history: record(prev.history, prev.draft, null, Date.now()),
    dirty,
    dirtyProfiles,
  });
  recording = true;
  scheduleDirtyCheck();
});

// ------------------------------------------------------------------ `dirty`, exactly

/**
 * The flag above is optimistic: it says "changed" for an edit that puts the draft back where it
 * was (rename A → B → A, paint then unpaint), which shows a false "Unapplied changes", rewrites
 * the config on Apply and prompts on close for nothing.
 *
 * So it is re-derived with a real comparison — but only when nothing is happening. Comparing the
 * whole config on every keystroke is what made the colour wheel lag (see the note at the top of
 * this file), so the comparison waits for a gap in the edits, and is forced only where a wrong
 * answer costs something: Apply, and the close guard.
 */
const DIRTY_RECHECK_MS = 400;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
/** How many real comparisons have been made; the tests use it to prove drags don't cause any. */
let dirtyChecks = 0;

export const dirtyCheckCount = () => dirtyChecks;

/** Compare the draft against what was saved and set `dirty` to the truth. */
export function checkDirtyNow() {
  if (dirtyTimer) {
    clearTimeout(dirtyTimer);
    dirtyTimer = null;
  }
  const s = useStore.getState();
  if (!s.ready) return;
  dirtyChecks++;
  const dirty = !sameJson(s.saved, s.draft);
  const dirtyProfiles = dirty
    ? s.draft.profiles
        .filter((p) => profileDirty(s.saved, s.draft, p.id))
        .map((p) => p.id)
    : [];
  if (dirty !== s.dirty || !sameJson(dirtyProfiles, s.dirtyProfiles))
    useStore.setState({ dirty, dirtyProfiles });
}

function scheduleDirtyCheck() {
  if (dirtyTimer) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    checkDirtyNow();
  }, DIRTY_RECHECK_MS);
  // Node (the tests) would keep the process alive for a pending timer; browsers ignore this.
  (dirtyTimer as unknown as { unref?: () => void }).unref?.();
}

export const useDirty = () => useStore((s) => s.dirty);

export function useSelectedProfile(): Profile {
  return useStore(
    (s) =>
      s.draft.profiles.find((p) => p.id === s.selectedProfileId) ??
      s.draft.profiles[0],
  );
}

export function profileDirty(
  saved: AppConfig,
  draft: AppConfig,
  id: string,
): boolean {
  const a = saved.profiles.find((p) => p.id === id);
  const b = draft.profiles.find((p) => p.id === id);
  return !sameJson(a, b);
}
