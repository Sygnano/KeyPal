import type {
  FirmwareBackup,
  FirmwareProject,
  FirmwareStatus,
  JobEvent,
  JobKind,
  KeyboardInfo,
  LogLine,
  PrebuiltInfo,
  ProjectSnapshot,
  ProjectTemplate,
} from "./firmwareTypes";
import { MODULE_VERSION as REAL_MODULE_VERSION } from "./limits";

/**
 * The Firmware tab without the Rust side (`pnpm dev:ui`, tests): projects in memory, tasks that
 * pretend. A build fails when a file has an `#error`, reporting it like gcc does.
 */
export interface FirmwareBackend {
  fwStatus(): Promise<FirmwareStatus>;
  fwCheckUpdates(force: boolean): Promise<FirmwareStatus>;
  fwInstallToolchain(): Promise<number>;
  fwDownloadSource(): Promise<number>;
  fwInstallDrivers(): Promise<number>;
  /** Downloads the small flashing tools ahead of time (the Basic path's only install). */
  fwGetTools(): Promise<number>;
  /** What ready-made firmware the app has for a board (`board.rs` id). */
  fwPrebuiltInfo(board: string, force: boolean): Promise<PrebuiltInfo>;
  fwCancel(): Promise<void>;
  fwBuild(id: string): Promise<number>;
  /** Flashes a project's last build. `device`: the instance id the user picked in the dialog. */
  fwFlash(id: string, device: string | null): Promise<number>;
  /** Writes the app's ready-made firmware for a board (`board.rs` id), without QMK MSYS.
   * `device`: the instance id of a device already in bootloader mode that the user picked. */
  fwFlashPrebuilt(board: string, device: string | null): Promise<number>;
  fwEnterBootloader(): Promise<void>;
  /** The firmware backups, newest first. */
  fwBackups(): Promise<FirmwareBackup[]>;
  /** Reads the firmware on a board's keyboard into a backup, writing nothing. */
  fwBackUp(board: string, device: string | null): Promise<number>;
  /** Writes a backup back to the keyboard it was read from (a flash task). */
  fwRestoreBackup(id: string, device: string | null): Promise<number>;
  fwDeleteBackup(id: string): Promise<void>;
  fwOpenBackups(): Promise<void>;
  fwProjects(): Promise<FirmwareProject[]>;
  /** The sidebar's order (ids, first to last). */
  fwReorderProjects(ids: string[]): Promise<void>;
  fwGetProject(id: string): Promise<FirmwareProject>;
  fwKeyboards(): Promise<KeyboardInfo[]>;
  fwTemplates(keyboard: string): Promise<string[]>;
  fwCreateProject(
    name: string,
    keyboard: string,
    template: ProjectTemplate,
    withModule: boolean,
  ): Promise<FirmwareProject>;
  fwRenameProject(id: string, name: string): Promise<FirmwareProject>;
  fwDuplicateProject(id: string): Promise<FirmwareProject>;
  /** Says this project is (or is no longer) the firmware on its keyboard. */
  fwSetFlashed(id: string, flashed: boolean): Promise<void>;
  fwDeleteProject(id: string): Promise<ProjectSnapshot>;
  fwRestoreProject(snapshot: ProjectSnapshot): Promise<FirmwareProject>;
  fwReadFile(id: string, path: string): Promise<string>;
  fwWriteFile(id: string, path: string, text: string): Promise<void>;
  fwCreateFile(id: string, path: string, text: string): Promise<void>;
  fwDeleteFile(id: string, path: string): Promise<string>;
  fwRenameFile(id: string, from: string, to: string): Promise<void>;
  fwAddModule(id: string): Promise<void>;
  fwOpenFolder(id: string | null): Promise<void>;
  onFwJob(cb: (e: JobEvent) => void): Promise<() => void>;
  onFwLog(cb: (l: LogLine) => void): Promise<() => void>;
}

const KEYBOARDS: KeyboardInfo[] = [
  {
    path: "keychron/q1v2/iso_encoder",
    name: "Keychron Q1",
    pid: 0x0111,
    bootloader: "stm32-dfu",
  },
  {
    path: "keychron/v6_8k/ansi_encoder",
    name: "Keychron V6 8K",
    pid: 0x0f60,
    bootloader: "at32-dfu",
  },
  {
    path: "keychron/v6_8k/iso_encoder",
    name: "Keychron V6 8K",
    pid: 0x0f61,
    bootloader: "at32-dfu",
  },
];

const KEYMAP_C = `#include QMK_KEYBOARD_H

enum layers { MAC_BASE, MAC_FN, WIN_BASE, WIN_FN };

const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {
    [WIN_BASE] = LAYOUT_iso_110(
        KC_ESC, KC_F1, KC_F2 /* … */
    ),
};
`;

/** The module the mock "bundles". */
/** The mock's pretend module, kept equal to the real bundled one (the self-test checks it): a
 * mock a version behind makes the browser preview show notices the app would never show. */
export const MODULE_VERSION = REAL_MODULE_VERSION;
const MODULE_C = `/* Profile switcher for the Keychron V6 8K */\n#define PS_PROTO_VERSION ${MODULE_VERSION}\n`;

export function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "firmware";
}

/** The id a build stamps into its firmware, as Rust's `protocol::build_id` computes it (FNV-1a). */
export function buildId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++)
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h || 1;
}

/** `backupFirst`: the setting that backs up the keyboard's firmware before a flash (`fwBackup`). */
export function createFirmwareMock(
  backupFirst: () => boolean = () => true,
): FirmwareBackend {
  const projects = new Map<
    string,
    {
      name: string;
      keyboard: string;
      files: Map<string, string>;
      lastBuild: FirmwareProject["lastBuild"];
    }
  >();
  /** Which project is on each keyboard (its qmk path), and its files as they were put there, like
   * the app's flashed.json. */
  const flashed = new Map<string, { id: string; sources: string }>();
  /** The mock's file fingerprint: the files themselves. */
  const sources = (p: { files: Map<string, string> }) => JSON.stringify([...p.files].sort());
  /** Deleted projects, kept so undo can put them back (like the app's trash folder). */
  const trash = new Map<
    string,
    {
      name: string;
      keyboard: string;
      files: Map<string, string>;
      lastBuild: FirmwareProject["lastBuild"];
    }
  >();
  /** The sidebar's order; like the app's order.json, a deleted project keeps its place. */
  let order: string[] = [];
  /** Like the app's firmware-backups folder. */
  const backups: FirmwareBackup[] = [];
  const BACKUP_STEP: [string, null] = [
    "Backing up the firmware on the keyboard",
    null,
  ];
  /** A pretend backup of the V6 8K ISO (the mock's keyboard). */
  function addBackup() {
    const at = Math.max(
      Math.floor(Date.now() / 1000),
      (backups[0]?.at ?? 0) + 1,
    );
    backups.unshift({
      id: `v6_8k_iso_encoder-${at}`,
      board: "v6_8k_iso_encoder",
      name: "Keychron V6 8K ISO Knob",
      at,
      size: 262_144,
      sha256: "0".repeat(64),
    });
  }
  /** The steps of a flash once the bootloader is there, with the backup when it is on. */
  const writeSteps = (): Array<[string, number | null]> => [
    ...(backupFirst() ? [BACKUP_STEP] : []),
    ["Flashing", 0.5],
    ["Waiting for the keyboard to restart", null],
  ];
  const jobListeners = new Set<(e: JobEvent) => void>();
  const logListeners = new Set<(l: LogLine) => void>();
  let sourceReady = false;
  let toolsReady = false;
  let nextJob = 1;
  let running: {
    id: number;
    kind: JobKind;
    timers: ReturnType<typeof setTimeout>[];
    /** In the "Flashing" step, which Cancel can't interrupt (like the real backend). */
    locked: boolean;
  } | null = null;

  /** Like the backend: the firmware write ("Flashing…") can't be cancelled. */
  const job = (e: Omit<JobEvent, "cancellable">) => {
    const locked = e.state === "running" && !!e.step?.startsWith("Flashing");
    if (running?.id === e.id) running.locked = locked;
    const full: JobEvent = { ...e, cancellable: !locked };
    jobListeners.forEach((l) => l(full));
  };
  const log = (id: number, line: string) =>
    logListeners.forEach((l) => l({ id, line }));
  const view = (id: string): FirmwareProject => {
    const p = projects.get(id);
    if (!p) throw new Error(`No project "${id}".`);
    const version = /#define PS_PROTO_VERSION (\d+)/.exec(
      p.files.get("profile_switcher.c") ?? "",
    );
    return {
      id,
      name: p.name,
      keyboard: p.keyboard,
      keymap: `v6ps_${id}`,
      files: [...p.files.keys()].sort(),
      lastBuild: p.lastBuild,
      moduleVersion: version ? Number(version[1]) : null,
      buildId: buildId(id),
      flashed: flashed.get(p.keyboard)?.id === id,
      unflashedChanges: flashed.get(p.keyboard)?.id === id && flashed.get(p.keyboard)?.sources !== sources(p),
      buildOutdated: p.lastBuild?.sources !== sources(p),
    };
  };
  const place = (id: string) => {
    if (!order.includes(id)) order.push(id);
  };
  // `?bootloader` in the preview's address: the V6 8K was already in its bootloader when the app
  // looked, the one case where the user has to say which device it is.
  const inBootloader =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("bootloader");
  const status = (): FirmwareStatus => ({
    toolchain: {
      state: "ok",
      path: "C:\\QMK_MSYS",
      version: "1.12.0",
      latest: "1.12.0",
      managed: false,
    },
    source: {
      state: sourceReady ? "ok" : "missing",
      path: "%LOCALAPPDATA%\\app\\qmk\\qmk_firmware",
      branch: sourceReady ? "2025q3" : null,
      commit: sourceReady ? "9ada9b7bae" : null,
      latestBranch: "2025q3",
      latestCommit: "9ada9b7bae",
      managed: true,
    },
    driver: { state: "unknown", installedAt: null },
    flashTools: {
      state: toolsReady ? "ok" : "missing",
      path: "%LOCALAPPDATA%\\app\\qmk\\flash-tools",
      missing: toolsReady ? [] : ["dfu-util.exe"],
    },
    devices: [
      inBootloader
        ? {
            vid: 0x2e3c,
            pid: 0xdf11,
            kind: "bootloader",
            bootloader: "AT32 DFU",
            driver: "WinUSB",
            description: "DFU in FS Mode",
            instance: "USB\\VID_2E3C&PID_DF11\\MOCK",
          }
        : {
            vid: 0x3434,
            pid: 0x0f61,
            kind: "keyboard",
            bootloader: null,
            driver: "usbccgp",
            description: "Keychron V6 8K",
            instance: "USB\\VID_3434&PID_0F61\\MOCK",
          },
    ],
    job: running ? { id: running.id, kind: running.kind } : null,
    updateError: null,
    projectsDir: "%APPDATA%\\app\\firmware",
    dataDir: "%LOCALAPPDATA%\\app\\qmk",
    moduleVersion: MODULE_VERSION,
  });
  const freeId = (name: string) => {
    let id = slug(name);
    for (let n = 2; projects.has(id); n++) id = `${slug(name)}_${n}`;
    return id;
  };
  const file = (id: string, _path: string) => {
    const p = projects.get(id);
    if (!p) throw new Error(`No project "${id}".`);
    return p;
  };

  /** A pretend task: its steps, one every `ms`, then `finish` decides how it ends. */
  function start(
    kind: JobKind,
    steps: Array<[string, number | null, string?]>,
    finish: (id: number) => string,
    ms = 60,
  ): Promise<number> {
    if (running)
      return Promise.reject(
        new Error(
          `Wait for the current task (${running.kind}) to finish, or cancel it.`,
        ),
      );
    const id = nextJob++;
    const timers: ReturnType<typeof setTimeout>[] = [];
    running = { id, kind, timers, locked: false };
    job({
      id,
      kind,
      state: "running",
      message: null,
      progress: null,
      step: null,
    });
    steps.forEach(([step, progress, line], i) =>
      timers.push(
        setTimeout(
          () => {
            job({ id, kind, state: "running", message: null, progress, step });
            if (line) log(id, line);
          },
          ms * (i + 1),
        ),
      ),
    );
    timers.push(
      setTimeout(
        () => {
          running = null;
          try {
            job({
              id,
              kind,
              state: "ok",
              message: finish(id),
              progress: null,
              step: null,
            });
          } catch (e) {
            job({
              id,
              kind,
              state: "failed",
              message: e instanceof Error ? e.message : String(e),
              progress: null,
              step: null,
            });
          }
        },
        ms * (steps.length + 1),
      ),
    );
    return Promise.resolve(id);
  }

  return {
    fwStatus: async () => status(),
    fwCheckUpdates: async () => status(),
    fwInstallToolchain: () =>
      start(
        "toolchain",
        [["Installing QMK MSYS", null]],
        () => "QMK MSYS is installed.",
      ),
    fwDownloadSource: () =>
      start(
        "source",
        [
          ["Receiving objects", 0.3, "Cloning into 'qmk_firmware'..."],
          ["Receiving objects", 0.8],
          ["Resolving deltas", 1, "Submodule path 'lib/chibios': checked out"],
        ],
        () => {
          sourceReady = true;
          return "Keychron's firmware (2025q3) is ready.";
        },
      ),
    fwInstallDrivers: () =>
      start(
        "drivers",
        [["Installing the bootloader drivers", null]],
        () => "Bootloader drivers installed.",
      ),
    fwGetTools: () =>
      start(
        "tools",
        [
          ["Downloading dfu-util.exe", null],
          ["Downloading libusb-1.0.dll", null],
        ],
        () => {
          toolsReady = true;
          return "The flashing tools are ready.";
        },
      ),
    fwPrebuiltInfo: async (board) => ({
      tag: "v0.2.0",
      module: MODULE_VERSION,
      branch: "2025q3",
      commit: "9ada9b7bae2f0c3d",
      // The board asked for, not always the V6: the real one answers per keyboard.
      keyboard: `keychron/${board}`,
      // One board with nothing ready-made, so the UI's "not in this release" path shows in the preview.
      entry:
        board === "q0_max"
          ? null
          : {
              file: `${board}_companion.bin`,
              sha256: "00",
              size: 74 * 1024,
              keymap: "keychron",
            },
      ownRelease: true,
    }),
    async fwCancel() {
      if (!running) return;
      if (running.locked)
        throw new Error("The firmware is being written: stopping now would leave the keyboard without any. It takes a few seconds.");
      running.timers.forEach(clearTimeout);
      job({
        id: running.id,
        kind: running.kind,
        state: "cancelled",
        message: "Cancelled.",
        progress: null,
        step: null,
      });
      running = null;
    },
    fwBuild: (id) => build(id),
    fwFlash: (id) => flashProject(id),
    fwFlashPrebuilt: () =>
      start(
        "flash",
        [
          ["Finding the ready-made firmware", null],
          ["Downloading the firmware (74 KB)", null],
          [
            "Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in",
            null,
          ],
          ...writeSteps(),
        ],
        () => {
          if (backupFirst()) addBackup();
          return "Pretend: the keyboard has the profile switcher now.";
        },
      ),
    fwEnterBootloader: async () => {
      throw new Error("No keyboard in the browser preview.");
    },
    fwBackups: async () => backups.map((b) => ({ ...b })),
    fwBackUp: () =>
      start(
        "backup",
        [
          [
            "Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in",
            null,
          ],
          BACKUP_STEP,
        ],
        () => {
          addBackup();
          return "Pretend: the V6 8K's firmware is backed up (256 KB).";
        },
      ),
    fwRestoreBackup(id) {
      const b = backups.find((x) => x.id === id);
      if (!b) return Promise.reject(new Error("That backup is gone."));
      return start(
        "flash",
        [
          [
            "Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in",
            null,
          ],
          ...writeSteps(),
        ],
        () => {
          if (backupFirst()) addBackup();
          flashed.clear();
          return "Pretend: the V6 8K restarted with the backup.";
        },
      );
    },
    async fwDeleteBackup(id) {
      const i = backups.findIndex((b) => b.id === id);
      if (i >= 0) backups.splice(i, 1);
    },
    fwOpenBackups: async () => {},
    fwProjects: async () => {
      const rank = (id: string) =>
        order.includes(id) ? order.indexOf(id) : Infinity;
      return [...projects.keys()].sort((a, b) => rank(a) - rank(b)).map(view);
    },
    async fwReorderProjects(ids) {
      order = ids.filter((id) => projects.has(id));
    },
    fwGetProject: async (id) => view(id),
    fwKeyboards: async () => (sourceReady ? KEYBOARDS : []),
    fwTemplates: async () =>
      sourceReady ? ["keychron", "via", "default"] : [],
    async fwCreateProject(name, keyboard, template, withModule) {
      if (!name.trim()) throw new Error("Give the firmware a name.");
      if (!keyboard) throw new Error("Choose a keyboard.");
      const id = freeId(name);
      const files = new Map<string, string>();
      if (template.kind === "keymap") {
        if (!sourceReady)
          throw new Error(
            "Download Keychron's firmware first: the keymaps come from it.",
          );
        files.set(
          "keymap.c",
          KEYMAP_C.replace("[WIN_BASE]", `/* ${template.name} */ [WIN_BASE]`),
        );
        files.set("rules.mk", "VIA_ENABLE = yes\n");
      } else if (template.kind === "folder") {
        files.set("keymap.c", `// imported from ${template.path}\n`);
      } else {
        for (const f of ["keymap.c", "config.h", "rules.mk"]) files.set(f, "");
      }
      if (withModule) {
        files.set("profile_switcher.c", MODULE_C);
        const rules = files.get("rules.mk") ?? "";
        const add = [
          "VIA_ENABLE = yes",
          "DEFERRED_EXEC_ENABLE = yes",
          "SRC += profile_switcher.c",
        ].filter((l) => !rules.includes(l.split(" ")[0]));
        files.set(
          "rules.mk",
          `${rules}${add.length ? `# Profile switcher (KBoard Companion)\n${add.join("\n")}\n` : ""}`,
        );
      }
      projects.set(id, { name: name.trim(), keyboard, files, lastBuild: null });
      place(id);
      return view(id);
    },
    async fwDuplicateProject(id) {
      const p = file(id, "");
      const name = `${p.name} (copy)`;
      const copy = freeId(name);
      projects.set(copy, {
        name,
        keyboard: p.keyboard,
        files: new Map(p.files),
        lastBuild: null,
      });
      order = order.filter((x) => x !== copy);
      order.splice(order.indexOf(id) + 1 || order.length, 0, copy);
      return view(copy);
    },
    async fwSetFlashed(id, on) {
      const p = file(id, "");
      if (on) flashed.set(p.keyboard, { id, sources: sources(p) });
      else if (flashed.get(p.keyboard)?.id === id) flashed.delete(p.keyboard);
    },
    async fwRenameProject(id, name) {
      if (!name.trim()) throw new Error("Give the firmware a name.");
      file(id, "").name = name.trim();
      return view(id);
    },
    async fwDeleteProject(id) {
      const p = file(id, "");
      trash.set(id, p);
      projects.delete(id);
      return { id, name: p.name, keyboard: p.keyboard };
    },
    async fwRestoreProject(s) {
      const id = projects.has(s.id) ? freeId(s.name) : s.id;
      const p = trash.get(s.id);
      if (!p)
        throw new Error(`The deleted "${s.name}" is no longer in the trash.`);
      trash.delete(s.id);
      projects.set(id, p);
      place(id);
      return view(id);
    },
    async fwReadFile(id, path) {
      const text = file(id, path).files.get(path);
      if (text === undefined) throw new Error(`${path} doesn't exist.`);
      return text;
    },
    async fwWriteFile(id, path, text) {
      file(id, path).files.set(path, text);
    },
    async fwCreateFile(id, path, text) {
      const p = file(id, path);
      if (!path.trim() || path.includes(".."))
        throw new Error(`"${path}" isn't a file name inside the project.`);
      if (p.files.has(path)) throw new Error(`${path} already exists.`);
      p.files.set(path, text);
    },
    async fwDeleteFile(id, path) {
      const p = file(id, path);
      const text = p.files.get(path);
      if (text === undefined) throw new Error(`${path} doesn't exist.`);
      p.files.delete(path);
      return text;
    },
    async fwRenameFile(id, from, to) {
      const p = file(id, from);
      const text = p.files.get(from);
      if (text === undefined) throw new Error(`${from} doesn't exist.`);
      if (p.files.has(to) && to.toLowerCase() !== from.toLowerCase())
        throw new Error(`${to} already exists.`);
      p.files.delete(from);
      p.files.set(to, text);
    },
    async fwAddModule(id) {
      const p = file(id, "");
      p.files.set("profile_switcher.c", MODULE_C);
      const rules = p.files.get("rules.mk") ?? "";
      if (!rules.includes("profile_switcher.c"))
        p.files.set("rules.mk", `${rules}SRC += profile_switcher.c\n`);
    },
    fwOpenFolder: async () => {},
    async onFwJob(cb) {
      jobListeners.add(cb);
      return () => jobListeners.delete(cb);
    },
    async onFwLog(cb) {
      logListeners.add(cb);
      return () => logListeners.delete(cb);
    },
  };

  function build(id: string): Promise<number> {
    const p = view(id);
    const dir = `keyboards/${p.keyboard}/keymaps/${p.keymap}`;
    return start(
      "build",
      [
        ["Building", null, `$ make ${p.keyboard}:${p.keymap}`],
        ["Building", null, `Compiling: ${dir}/keymap.c`],
      ],
      (jobId) => {
        for (const f of p.files) {
          const text = projects.get(id)!.files.get(f)!;
          const line = text.split("\n").findIndex((l) => l.includes("#error"));
          if (line >= 0) {
            log(
              jobId,
              `${dir}/${f}:${line + 1}:2: error: #error ${text.split("\n")[line].replace(/.*#error\s*/, "")}`,
            );
            throw new Error("The build failed: see the errors.");
          }
        }
        const file = keepBuild(id);
        return `${p.name} builds: ${file} (71 KB).`;
      },
    );
  }

  /** Like the app's `keep_build`: the build's file, and the files it was made from. */
  function keepBuild(id: string): string {
    const rec = projects.get(id)!;
    const p = view(id);
    const file = `${p.keyboard.replace(/\//g, "_")}_${p.keymap}.bin`;
    rec.lastBuild = { file, size: 73_076, at: Math.floor(Date.now() / 1000), sources: sources(rec) };
    return file;
  }

  /** Flashing a project: the same guarded path as the ready-made firmware, built first when its
   * last build isn't of the files as they are. */
  function flashProject(id: string): Promise<number> {
    const p = view(id);
    const rebuild = p.buildOutdated;
    return start(
      "flash",
      [
        ...(rebuild
          ? [["Building", null, "The files changed since the last build (or it was never built): building it first."] as [string, null, string]]
          : []),
        [
          "Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in",
          null,
        ],
        ...writeSteps(),
      ],
      () => {
        if (backupFirst()) addBackup();
        if (rebuild) keepBuild(id);
        flashed.set(p.keyboard, { id, sources: projects.get(id)!.lastBuild!.sources! });
        return `${p.name} flashed (71 KB). The keyboard restarts with it.`;
      },
    );
  }
}
