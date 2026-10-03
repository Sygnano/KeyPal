import { create } from "zustand";
import { api } from "../lib/api";
import type { FwMode } from "../lib/types";
import type {
  CheckState,
  FirmwareBackup,
  FirmwareProject,
  FirmwareStatus,
  JobEvent,
  JobKind,
  KeyboardInfo,
  PrebuiltInfo,
  ProjectSnapshot,
  ProjectTemplate,
} from "../lib/firmwareTypes";

/** An open file: "<project id>/<path in the project>". */
export type FileKey = string;
export const fileKey = (projectId: string, path: string): FileKey =>
  `${projectId}/${path}`;
export function splitKey(key: FileKey): { projectId: string; path: string } {
  const i = key.indexOf("/");
  return { projectId: key.slice(0, i), path: key.slice(i + 1) };
}

export interface Buffer {
  text: string;
  /** What's on disk. */
  saved: string;
}

/** The task running or last run, and how it went. */
export interface JobView {
  id: number;
  kind: JobKind;
  state: JobEvent["state"];
  step: string | null;
  progress: number | null;
  message: string | null;
  /** False while the firmware is being written: no Cancel then. */
  cancellable: boolean;
}

/** A compiler or make message about a project file. */
export interface Problem {
  projectId: string;
  path: string;
  line: number;
  col: number | null;
  severity: "error" | "warning";
  message: string;
}

/** A file operation that can be undone (text edits have the editor's own undo). */
interface Step {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

const LOG_LIMIT = 3000;
const HISTORY_LIMIT = 50;

/**
 * gcc ("…/keymaps/v6ps_x/keymap.c:12:5: error: …") and make ("…/keymaps/v6ps_x/rules.mk:3: *** …")
 * messages about a project's files: they're built as keymap `v6ps_<project id>`.
 */
export function parseProblem(line: string): Problem | null {
  const gcc =
    /keymaps\/v6ps_([a-z0-9_]+)\/(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.*)$/.exec(
      line,
    );
  if (gcc) {
    return {
      projectId: gcc[1],
      path: gcc[2],
      line: Number(gcc[3]),
      col: gcc[4] ? Number(gcc[4]) : null,
      severity: gcc[5] === "warning" ? "warning" : "error",
      message: gcc[6].trim(),
    };
  }
  const mk = /keymaps\/v6ps_([a-z0-9_]+)\/(.+?):(\d+):\s*\*\*\*\s*(.*)$/.exec(
    line,
  );
  if (mk)
    return {
      projectId: mk[1],
      path: mk[2],
      line: Number(mk[3]),
      col: null,
      severity: "error",
      message: mk[4].trim(),
    };
  return null;
}

/**
 * Which path the Firmware tab opens on. The user's choice (settings `fwMode`) always wins; until
 * they make one, Advanced when they already have the build tools or a project of their own, else
 * Basic: someone who has never installed QMK MSYS shouldn't be met by a 4.7 GB checklist just to
 * put the app's ready-made firmware on their keyboard.
 */
export function pickFwMode(
  chosen: FwMode | null,
  toolchain: CheckState | undefined,
  projects: number,
): FwMode {
  if (chosen) return chosen;
  if (toolchain && toolchain !== "missing") return "advanced";
  return projects > 0 ? "advanced" : "basic";
}

export interface FirmwareState {
  ready: boolean;
  status: FirmwareStatus | null;
  projects: FirmwareProject[];
  keyboards: KeyboardInfo[];
  selectedId: string | null;
  /** Open tabs, of every project; the editor shows the selected project's. */
  openFiles: FileKey[];
  /** The tab in front: one of the selected project's, or null. */
  activeKey: FileKey | null;
  /** Each project's tab in front when it was last selected, to come back to it. */
  lastActive: Record<string, FileKey>;
  buffers: Record<FileKey, Buffer>;
  job: JobView | null;
  log: string[];
  problems: Problem[];
  past: Step[];
  future: Step[];
  error: string | null;
  notice: string | null;
  /** Asks the editor to show a line (a click on a problem). `n` changes on every request. */
  reveal: { key: FileKey; line: number; n: number } | null;
  /** The ready-made firmware for the board the Basic path is looking at (null: not asked yet, or
   * the list couldn't be fetched — `prebuiltError` says which). */
  prebuilt: PrebuiltInfo | null;
  prebuiltError: string | null;
  /** The board `prebuilt` is about, and whether the request is still out. */
  prebuiltBoard: string | null;
  prebuiltLoading: boolean;
  /** What was on the keyboard before the app wrote to it, newest first. */
  backups: FirmwareBackup[];

  init(): Promise<void>;
  refreshStatus(): Promise<void>;
  checkUpdates(force?: boolean): Promise<void>;
  refreshProjects(): Promise<void>;
  loadKeyboards(): Promise<void>;
  installToolchain(): Promise<void>;
  downloadSource(): Promise<void>;
  installDrivers(): Promise<void>;
  /** Downloads the Basic path's flashing tools ahead of time. */
  downloadTools(): Promise<void>;
  /** What the app has ready-made for a board (`board.rs` id); cached per board until `force`. */
  loadPrebuilt(board: string, force?: boolean): Promise<void>;
  cancelJob(): Promise<void>;
  enterBootloader(): Promise<void>;
  selectProject(id: string | null): void;
  /** Moves a project to `to` (its index in the list once moved). */
  moveProject(id: string, to: number): Promise<void>;
  createProject(
    name: string,
    keyboard: string,
    template: ProjectTemplate,
    withModule: boolean,
  ): Promise<boolean>;
  renameProject(id: string, name: string): Promise<void>;
  /** A copy of a project, right after it; its id (null if it couldn't be made). */
  duplicateProject(id: string): Promise<string | null>;
  /** Says a project is (or is no longer) the firmware on its keyboard. Undoable. */
  setFlashed(id: string, flashed: boolean): Promise<void>;
  /** What the keyboard says it runs (`EngineState.buildId`, 0 when it can't say): marks that
   * project and unmarks the others, so the sidebar shows the truth rather than a guess. */
  matchKeyboard(buildId: number): Promise<void>;
  deleteProject(id: string): Promise<void>;
  openFile(projectId: string, path: string): Promise<void>;
  closeFile(key: FileKey): void;
  setActive(key: FileKey): void;
  edit(key: FileKey, text: string): void;
  save(key: FileKey): Promise<boolean>;
  /** Saves every changed file (of one project, or all). */
  saveAll(projectId?: string): Promise<boolean>;
  createFile(projectId: string, path: string, text?: string): Promise<boolean>;
  deleteFile(projectId: string, path: string): Promise<void>;
  renameFile(projectId: string, from: string, to: string): Promise<boolean>;
  addModule(projectId: string): Promise<void>;
  build(projectId: string): Promise<void>;
  /** Flashes a project's last build. `device`: the instance id the user picked in the dialog. */
  flash(projectId: string, device?: string | null): Promise<void>;
  /** The app's ready-made firmware for a keyboard (`board.rs` id), no QMK MSYS needed. */
  /** `device`: the instance id of a device already in bootloader mode that the user picked as
   * their keyboard. Without it the backend refuses one it can't attribute (`quick::pick_bootloader`). */
  flashPrebuilt(board: string, device?: string | null): Promise<void>;
  refreshBackups(): Promise<void>;
  /** Reads the firmware on a board's keyboard (`board.rs` id) into a backup, writing nothing.
   * `device` as for `flashPrebuilt`. */
  backUp(board: string, device?: string | null): Promise<void>;
  /** Writes a backup back to the keyboard it came from (a flash task). */
  restoreBackup(id: string, device?: string | null): Promise<void>;
  /** Deletes a backup for good (the UI asks first). */
  deleteBackup(id: string): Promise<void>;
  openBackups(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  showProblem(p: Problem): Promise<void>;
  clearError(): void;
  clearNotice(): void;
}

/** A project's open tabs, in order. */
export const tabsOf = (openFiles: FileKey[], projectId: string | null) =>
  projectId === null
    ? []
    : openFiles.filter((k) => splitKey(k).projectId === projectId);

/** The tab to show for a project: the one last in front, else its last open one. */
function frontTab(
  openFiles: FileKey[],
  lastActive: Record<string, FileKey>,
  projectId: string | null,
): FileKey | null {
  const tabs = tabsOf(openFiles, projectId);
  const last = projectId === null ? undefined : lastActive[projectId];
  return last && tabs.includes(last) ? last : (tabs.at(-1) ?? null);
}

/**
 * `current` without the lines an operation added: the non-empty lines of `after` that `before`
 * didn't have, each taken out once (the last copy). Everything else stays, lines written since
 * included; an added line that was edited since is no longer the same line, so it stays too.
 */
export function withoutAddedLines(current: string, before: string | null, after: string): string {
  const had = new Map<string, number>();
  for (const l of (before ?? "").split("\n")) had.set(l, (had.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after.split("\n")) {
    const n = had.get(l) ?? 0;
    if (n > 0) had.set(l, n - 1);
    else if (l.trim()) added.push(l);
  }
  const lines = current.split("\n");
  for (const l of added) {
    const i = lines.lastIndexOf(l);
    if (i >= 0) lines.splice(i, 1);
  }
  return lines.join("\n");
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
let listening: Array<Promise<() => void>> = [];
const FAIL = Symbol("failed");
let revealCount = 0;

export const useFirmware = create<FirmwareState>((set, get) => {
  /** Runs an action, showing its error instead of throwing: FAIL then. */
  async function attempt<T>(
    what: string,
    fn: () => Promise<T>,
  ): Promise<T | typeof FAIL> {
    try {
      return await fn();
    } catch (e) {
      set({ error: `${what}: ${describe(e)}` });
      return FAIL;
    }
  }

  /** Records a done file operation, so it can be undone. */
  function done(step: Step) {
    set((s) => ({ past: [...s.past, step].slice(-HISTORY_LIMIT), future: [] }));
  }

  /** Keeps tabs and buffers in step with a project's files after an operation. */
  function forget(projectId: string, path?: string) {
    set((s) => {
      const gone = (k: FileKey) => {
        const f = splitKey(k);
        return (
          f.projectId === projectId && (path === undefined || f.path === path)
        );
      };
      const openFiles = s.openFiles.filter((k) => !gone(k));
      const buffers = Object.fromEntries(
        Object.entries(s.buffers).filter(([k]) => !gone(k)),
      );
      const activeKey =
        s.activeKey && gone(s.activeKey)
          ? frontTab(openFiles, s.lastActive, s.selectedId)
          : s.activeKey;
      return { openFiles, buffers, activeKey };
    });
  }

  function moveKey(from: FileKey, to: FileKey) {
    set((s) => {
      const buffers = { ...s.buffers };
      if (buffers[from]) {
        buffers[to] = buffers[from];
        delete buffers[from];
      }
      const { projectId } = splitKey(to);
      return {
        buffers,
        openFiles: s.openFiles.map((k) => (k === from ? to : k)),
        activeKey: s.activeKey === from ? to : s.activeKey,
        lastActive:
          s.lastActive[projectId] === from
            ? { ...s.lastActive, [projectId]: to }
            : s.lastActive,
      };
    });
  }

  async function startJob(kind: string, fn: () => Promise<number>) {
    const id = await attempt(`Could not start (${kind})`, fn);
    if (id !== FAIL) set({ log: [], problems: [] });
  }

  function onJob(e: JobEvent) {
    const s = get();
    const fresh = s.job?.id !== e.id;
    set({
      job: {
        id: e.id,
        kind: e.kind,
        state: e.state,
        // Kept when the task ends, so the flash tracker can say where it stopped.
        step: e.step ?? (fresh ? null : (s.job?.step ?? null)),
        progress:
          e.progress ??
          (e.state === "running" && !fresh ? (s.job?.progress ?? null) : null),
        message: e.message,
        cancellable: e.cancellable,
      },
      ...(fresh ? { log: [], problems: [] } : {}),
    });
    if (e.state === "running") return;
    if (e.state === "ok") set({ notice: e.message });
    get().refreshStatus();
    if (e.kind === "build" || e.kind === "flash") get().refreshProjects();
    if (e.kind === "flash" || e.kind === "backup") get().refreshBackups();
    if (e.kind === "source") get().loadKeyboards();
  }

  return {
    ready: false,
    status: null,
    projects: [],
    keyboards: [],
    selectedId: null,
    openFiles: [],
    activeKey: null,
    lastActive: {},
    buffers: {},
    job: null,
    log: [],
    problems: [],
    past: [],
    future: [],
    error: null,
    notice: null,
    reveal: null,
    prebuilt: null,
    prebuiltError: null,
    prebuiltBoard: null,
    prebuiltLoading: false,
    backups: [],

    async init() {
      // Subscribe afresh (the previous subscriptions go), so a second init never doubles events.
      // Swapped synchronously: two inits in a row (React runs effects twice in development) can't
      // both stay subscribed.
      listening.forEach((sub) => sub.then((stop) => stop()));
      listening = [
        api.onFwJob((e) => onJob(e)),
        api.onFwLog(({ id, line }) => {
          const job = get().job;
          if (job && job.id !== id) return;
          const problem = parseProblem(line);
          set((s) => ({
            log: [...s.log, line].slice(-LOG_LIMIT),
            problems: problem ? [...s.problems, problem] : s.problems,
          }));
        }),
      ];
      await Promise.all([
        get().refreshProjects(),
        get().refreshStatus(),
        get().refreshBackups(),
      ]);
      const running = get().status?.job;
      if (running && !get().job)
        set({
          job: {
            ...running,
            state: "running",
            step: null,
            progress: null,
            message: null,
            cancellable: true,
          },
        });
      set({
        ready: true,
        selectedId: get().selectedId ?? get().projects[0]?.id ?? null,
      });
      get().loadKeyboards();
      get().checkUpdates(false);
    },

    async refreshStatus() {
      const status = await attempt("Could not check the firmware tools", () =>
        api.fwStatus(),
      );
      if (status !== FAIL) set({ status });
    },

    async checkUpdates(force = false) {
      const status = await attempt("Could not check for updates", () =>
        api.fwCheckUpdates(force),
      );
      if (status !== FAIL) set({ status });
    },

    async refreshProjects() {
      const projects = await attempt(
        "Could not list the firmware projects",
        () => api.fwProjects(),
      );
      if (projects === FAIL) return;
      const s = get();
      if (s.selectedId && projects.some((p) => p.id === s.selectedId))
        set({ projects });
      else {
        const selectedId = projects[0]?.id ?? null;
        set({
          projects,
          selectedId,
          activeKey: frontTab(s.openFiles, s.lastActive, selectedId),
        });
      }
    },

    async loadKeyboards() {
      const keyboards = await attempt("Could not list the keyboards", () =>
        api.fwKeyboards(),
      );
      if (keyboards !== FAIL) set({ keyboards });
    },

    installToolchain: () =>
      startJob("QMK MSYS", () => api.fwInstallToolchain()),
    downloadSource: () => startJob("download", () => api.fwDownloadSource()),
    installDrivers: () => startJob("drivers", () => api.fwInstallDrivers()),
    downloadTools: () => startJob("tools", () => api.fwGetTools()),

    async loadPrebuilt(board, force = false) {
      if (
        !force &&
        get().prebuiltBoard === board &&
        (get().prebuilt || get().prebuiltError)
      )
        return;
      set({
        prebuiltBoard: board,
        prebuiltLoading: true,
        prebuilt: null,
        prebuiltError: null,
      });
      try {
        const info = await api.fwPrebuiltInfo(board, force);
        // Another board was asked for while this was out: that answer wins.
        if (get().prebuiltBoard === board)
          set({ prebuilt: info, prebuiltLoading: false });
      } catch (e) {
        if (get().prebuiltBoard === board)
          set({ prebuiltError: describe(e), prebuiltLoading: false });
      }
    },

    async cancelJob() {
      await attempt("Could not cancel", () => api.fwCancel());
    },

    async enterBootloader() {
      const ok = await attempt("Could not restart the keyboard", () =>
        api.fwEnterBootloader(),
      );
      if (ok !== FAIL)
        set({ notice: "The keyboard is restarting into its bootloader." });
      setTimeout(() => get().refreshStatus(), 1500);
    },

    selectProject(id) {
      set((s) =>
        s.selectedId === id
          ? {}
          : {
              selectedId: id,
              activeKey: frontTab(s.openFiles, s.lastActive, id),
            },
      );
    },

    async moveProject(id, to) {
      const before = get().projects.map((p) => p.id);
      const from = before.indexOf(id);
      if (from < 0 || to < 0 || to >= before.length || to === from) return;
      const after = [...before];
      after.splice(from, 1);
      after.splice(to, 0, id);
      const put = async (ids: string[]) => {
        await api.fwReorderProjects(ids);
        // Shown in the new order at once.
        set((s) => ({
          projects: [...s.projects].sort(
            (a, b) => ids.indexOf(a.id) - ids.indexOf(b.id),
          ),
        }));
      };
      const ok = await attempt("Could not move it", () => put(after));
      if (ok === FAIL) return;
      const name = get().projects.find((p) => p.id === id)?.name ?? id;
      done({
        label: `move ${name}`,
        undo: () => put(before),
        redo: () => put(after),
      });
    },

    async createProject(name, keyboard, template, withModule) {
      const p = await attempt("Could not create the firmware", () =>
        api.fwCreateProject(name, keyboard, template, withModule),
      );
      if (p === FAIL) return false;
      let id = p.id;
      let snapshot: ProjectSnapshot | null = null;
      done({
        label: `create ${p.name}`,
        undo: async () => {
          snapshot = await api.fwDeleteProject(id);
          forget(id);
        },
        redo: async () => {
          id = (await api.fwRestoreProject(snapshot!)).id;
        },
      });
      await get().refreshProjects();
      get().selectProject(p.id);
      const first = p.files.find((f) => f === "keymap.c") ?? p.files[0];
      if (first) await get().openFile(p.id, first);
      return true;
    },

    async renameProject(id, name) {
      const before = get().projects.find((p) => p.id === id)?.name;
      if (!before || before === name.trim()) return;
      const ok = await attempt("Could not rename", () =>
        api.fwRenameProject(id, name),
      );
      if (ok === FAIL) return;
      done({
        label: `rename ${before}`,
        undo: async () => void (await api.fwRenameProject(id, before)),
        redo: async () => void (await api.fwRenameProject(id, name)),
      });
      await get().refreshProjects();
    },

    async duplicateProject(id) {
      const copy = await attempt("Could not duplicate", () =>
        api.fwDuplicateProject(id),
      );
      if (copy === FAIL) return null;
      let current = copy.id;
      let snapshot: ProjectSnapshot | null = null;
      done({
        label: `duplicate ${copy.name}`,
        undo: async () => {
          snapshot = await api.fwDeleteProject(current);
          forget(current);
        },
        redo: async () => {
          current = (await api.fwRestoreProject(snapshot!)).id;
        },
      });
      await get().refreshProjects();
      get().selectProject(copy.id);
      return copy.id;
    },

    async matchKeyboard(buildId) {
      if (!buildId) return; // Older firmware, or built by hand: keep whatever the user told us.
      const projects = get().projects;
      const on = projects.find((p) => p.buildId === buildId);
      if (!on) return; // Firmware the app didn't build, or a project since deleted: say nothing.
      if (on.flashed) return;
      // Not an undo step: it's what the keyboard reports, not something the user did.
      await attempt("Could not note which firmware is on the keyboard", () =>
        api.fwSetFlashed(on.id, true),
      );
      await get().refreshProjects();
    },

    async setFlashed(id, flashed) {
      const before = get().projects.find((p) => p.id === id);
      if (!before) return;
      // Marked again while its changes weren't on the keyboard: "this version is on it now" (flashed
      // outside the app). Not an undo step: the earlier fingerprint can't be put back.
      if (flashed && before.flashed && before.unflashedChanges) {
        await attempt("Could not change which firmware is on the keyboard", () =>
          api.fwSetFlashed(id, true),
        );
        await get().refreshProjects();
        return;
      }
      if (before.flashed === flashed) return;
      // The project that had the mark, so undo puts it back where it was.
      const had =
        get().projects.find((p) => p.keyboard === before.keyboard && p.flashed)
          ?.id ?? null;
      const ok = await attempt(
        "Could not change which firmware is on the keyboard",
        () => api.fwSetFlashed(id, flashed),
      );
      if (ok === FAIL) return;
      done({
        label: flashed
          ? `mark ${before.name} as the one on the keyboard`
          : `unmark ${before.name}`,
        undo: async () => {
          await api.fwSetFlashed(id, !flashed);
          if (had && had !== id) await api.fwSetFlashed(had, true);
        },
        redo: () => api.fwSetFlashed(id, flashed),
      });
      await get().refreshProjects();
    },

    async deleteProject(id) {
      const snap = await attempt("Could not delete", () =>
        api.fwDeleteProject(id),
      );
      if (snap === FAIL) return;
      forget(id);
      let current = id;
      done({
        label: `delete ${snap.name}`,
        undo: async () => {
          current = (await api.fwRestoreProject(snap)).id;
        },
        redo: async () => {
          await api.fwDeleteProject(current);
          forget(current);
        },
      });
      await get().refreshProjects();
    },

    async openFile(projectId, path) {
      const key = fileKey(projectId, path);
      if (!get().buffers[key]) {
        const text = await attempt(`Could not open ${path}`, () =>
          api.fwReadFile(projectId, path),
        );
        if (text === FAIL) return;
        set((s) => ({
          buffers: { ...s.buffers, [key]: { text, saved: text } },
        }));
      }
      set((s) => ({
        openFiles: s.openFiles.includes(key)
          ? s.openFiles
          : [...s.openFiles, key],
        activeKey: key,
        selectedId: projectId,
        lastActive: { ...s.lastActive, [projectId]: key },
      }));
    },

    closeFile(key) {
      set((s) => {
        // The next tab in front is a neighbour among the same project's tabs.
        const { projectId } = splitKey(key);
        const tabs = tabsOf(s.openFiles, projectId);
        const i = tabs.indexOf(key);
        const rest = tabs.filter((k) => k !== key);
        const openFiles = s.openFiles.filter((k) => k !== key);
        const buffers = { ...s.buffers };
        delete buffers[key];
        const next = rest[i] ?? rest[i - 1] ?? null;
        const lastActive = { ...s.lastActive };
        if (lastActive[projectId] === key) {
          if (next) lastActive[projectId] = next;
          else delete lastActive[projectId];
        }
        return {
          openFiles,
          buffers,
          lastActive,
          activeKey: s.activeKey === key ? next : s.activeKey,
        };
      });
    },

    setActive(key) {
      const { projectId } = splitKey(key);
      set((s) => ({
        activeKey: key,
        selectedId: projectId,
        lastActive: { ...s.lastActive, [projectId]: key },
      }));
    },

    edit(key, text) {
      set((s) =>
        s.buffers[key]
          ? { buffers: { ...s.buffers, [key]: { ...s.buffers[key], text } } }
          : {},
      );
    },

    async save(key) {
      const b = get().buffers[key];
      if (!b || b.text === b.saved) return true;
      const { projectId, path } = splitKey(key);
      const text = b.text;
      const ok = await attempt(`Could not save ${path}`, () =>
        api.fwWriteFile(projectId, path, text),
      );
      if (ok === FAIL) return false;
      set((s) =>
        s.buffers[key]
          ? {
              buffers: {
                ...s.buffers,
                [key]: { ...s.buffers[key], saved: text },
              },
            }
          : {},
      );
      // The file changed on disk: the project on the keyboard may no longer be what's on it.
      if (get().projects.find((p) => p.id === projectId)?.flashed) await get().refreshProjects();
      return true;
    },

    async saveAll(projectId) {
      const keys = Object.keys(get().buffers).filter(
        (k) => projectId === undefined || splitKey(k).projectId === projectId,
      );
      for (const k of keys) if (!(await get().save(k))) return false;
      return true;
    },

    async createFile(projectId, path, text = "") {
      const name = path.trim();
      const ok = await attempt(`Could not create ${name}`, () =>
        api.fwCreateFile(projectId, name, text),
      );
      if (ok === FAIL) return false;
      done({
        label: `create ${name}`,
        undo: async () => {
          await api.fwDeleteFile(projectId, name);
          forget(projectId, name);
        },
        redo: () => api.fwCreateFile(projectId, name, text),
      });
      await get().refreshProjects();
      await get().openFile(projectId, name);
      return true;
    },

    async deleteFile(projectId, path) {
      // Unsaved edits go with it: keep what's on screen, so undo brings it all back.
      const onScreen = get().buffers[fileKey(projectId, path)]?.text;
      const text = await attempt(`Could not delete ${path}`, () =>
        api.fwDeleteFile(projectId, path),
      );
      if (text === FAIL) return;
      const keep = onScreen ?? text;
      forget(projectId, path);
      done({
        label: `delete ${path}`,
        undo: () => api.fwCreateFile(projectId, path, keep),
        redo: async () => {
          await api.fwDeleteFile(projectId, path);
          forget(projectId, path);
        },
      });
      await get().refreshProjects();
    },

    async renameFile(projectId, from, to) {
      const name = to.trim();
      if (!name || name === from) return false;
      const ok = await attempt(`Could not rename ${from}`, () =>
        api.fwRenameFile(projectId, from, name),
      );
      if (ok === FAIL) return false;
      moveKey(fileKey(projectId, from), fileKey(projectId, name));
      done({
        label: `rename ${from}`,
        undo: async () => {
          await api.fwRenameFile(projectId, name, from);
          moveKey(fileKey(projectId, name), fileKey(projectId, from));
        },
        redo: async () => {
          await api.fwRenameFile(projectId, from, name);
          moveKey(fileKey(projectId, from), fileKey(projectId, name));
        },
      });
      await get().refreshProjects();
      return true;
    },

    async addModule(projectId) {
      const p = get().projects.find((x) => x.id === projectId);
      if (!p) return;
      if (!(await get().saveAll(projectId))) return;
      const hadModule = p.files.includes("profile_switcher.c");
      const outdated =
        hadModule && p.moduleVersion !== get().status?.moduleVersion;
      const read = (path: string) => api.fwReadFile(projectId, path).catch(() => null);
      const before = await attempt("Could not add the module", async () => ({
        rules: p.files.includes("rules.mk") ? await api.fwReadFile(projectId, "rules.mk") : null,
        module: hadModule ? await api.fwReadFile(projectId, "profile_switcher.c") : null,
      }));
      if (before === FAIL) return;
      // What the operation wrote: undo takes out only that.
      const after = await attempt("Could not add the module", async () => {
        await api.fwAddModule(projectId);
        return {
          rules: await api.fwReadFile(projectId, "rules.mk"),
          module: await api.fwReadFile(projectId, "profile_switcher.c"),
        };
      });
      if (after === FAIL) return;
      /** Open tabs of these files show what is on disk now. */
      const refresh = (path: string, text: string | null) => {
        const key = fileKey(projectId, path);
        if (text === null) forget(projectId, path);
        else if (get().buffers[key])
          set((s) => ({
            buffers: { ...s.buffers, [key]: { text, saved: text } },
          }));
      };
      const noUnsavedEdits = () => {
        for (const path of ["rules.mk", "profile_switcher.c"]) {
          const b = get().buffers[fileKey(projectId, path)];
          if (b && b.text !== b.saved) throw new Error(`save ${path} first: this changes it.`);
        }
      };
      refresh("rules.mk", after.rules);
      refresh("profile_switcher.c", after.module);
      done({
        label: outdated
          ? "update the profile switcher module"
          : "add the profile switcher module",
        // Only what the operation did: the module's lines out of rules.mk (whatever else was
        // written there since stays), and the module file back as it was, unless it was edited
        // since (then nothing is changed, and the step stays to undo).
        undo: async () => {
          noUnsavedEdits();
          const module = await read("profile_switcher.c");
          if (module !== null && module !== after.module)
            throw new Error(
              "profile_switcher.c was edited after the module was added, and undoing would lose that. Change it by hand.",
            );
          const rules = await read("rules.mk");
          if (rules !== null) {
            const kept = withoutAddedLines(rules, before.rules, after.rules);
            if (before.rules === null && !kept.trim()) {
              await api.fwDeleteFile(projectId, "rules.mk");
              refresh("rules.mk", null);
            } else if (kept !== rules) {
              await api.fwWriteFile(projectId, "rules.mk", kept);
              refresh("rules.mk", kept);
            }
          }
          if (before.module === null) {
            if (module !== null) await api.fwDeleteFile(projectId, "profile_switcher.c");
            refresh("profile_switcher.c", null);
          } else {
            await api.fwWriteFile(projectId, "profile_switcher.c", before.module);
            refresh("profile_switcher.c", before.module);
          }
        },
        // Adding the module again (not writing back the files as they were then), so edits made
        // in between survive this way too.
        redo: async () => {
          noUnsavedEdits();
          await api.fwAddModule(projectId);
          refresh("rules.mk", await read("rules.mk"));
          refresh("profile_switcher.c", await read("profile_switcher.c"));
        },
      });
      await get().refreshProjects();
      set({
        notice: outdated
          ? "Profile switcher module updated. Flash to put it on the keyboard (it is built first)."
          : "Profile switcher module added (profile_switcher.c and rules.mk).",
      });
    },

    async build(projectId) {
      if (!(await get().saveAll(projectId))) return;
      await startJob("build", () => api.fwBuild(projectId));
    },

    async flash(projectId, device) {
      if (!(await get().saveAll(projectId))) return;
      await startJob("flash", () => api.fwFlash(projectId, device ?? null));
    },

    flashPrebuilt: (board, device) =>
      startJob("flash", () => api.fwFlashPrebuilt(board, device ?? null)),

    async refreshBackups() {
      const backups = await attempt("Could not list the firmware backups", () =>
        api.fwBackups(),
      );
      if (backups !== FAIL) set({ backups });
    },

    backUp: (board, device) =>
      startJob("backup", () => api.fwBackUp(board, device ?? null)),

    restoreBackup: (id, device) =>
      startJob("restore", () => api.fwRestoreBackup(id, device ?? null)),

    async deleteBackup(id) {
      const ok = await attempt("Could not delete the backup", () =>
        api.fwDeleteBackup(id),
      );
      if (ok !== FAIL) await get().refreshBackups();
    },

    async openBackups() {
      await attempt("Could not open the backups folder", () =>
        api.fwOpenBackups(),
      );
    },

    async undo() {
      const step = get().past.at(-1);
      if (!step) return;
      const ok = await attempt(`Could not undo (${step.label})`, () =>
        step.undo(),
      );
      if (ok === FAIL) return;
      set((s) => ({ past: s.past.slice(0, -1), future: [step, ...s.future] }));
      await get().refreshProjects();
    },

    async redo() {
      const step = get().future[0];
      if (!step) return;
      const ok = await attempt(`Could not redo (${step.label})`, () =>
        step.redo(),
      );
      if (ok === FAIL) return;
      set((s) => ({ future: s.future.slice(1), past: [...s.past, step] }));
      await get().refreshProjects();
    },

    async showProblem(p) {
      await get().openFile(p.projectId, p.path);
      set({
        reveal: {
          key: fileKey(p.projectId, p.path),
          line: p.line,
          n: ++revealCount,
        },
      });
    },

    clearError() {
      set({ error: null });
    },

    clearNotice() {
      set({ notice: null });
    },
  };
});

/** Unsaved edits anywhere (the window's close guard asks about them). */
export const firmwareDirty = () =>
  Object.values(useFirmware.getState().buffers).some((b) => b.text !== b.saved);
