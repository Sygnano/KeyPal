//! The Firmware tab: getting what's needed to build and flash Keychron firmware (preflight), the
//! user's firmware projects, and building and flashing them.

pub mod backup;
pub mod http;
pub mod jobs;
pub mod projects;
pub mod quick;
pub mod tools;
pub mod usb;

use jobs::{Emit, Jobs};
use projects::{Project, Store};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tools::{Msys, Paths, UpdateCache};

pub struct Firmware {
    pub paths: Paths,
    pub jobs: Jobs,
    pub updates: Arc<Mutex<UpdateCache>>,
    /// The release's ready-made firmware list, kept for `MANIFEST_CACHE` after it's fetched: the
    /// Basic path asks for it on every keyboard change, and it only moves with a release.
    manifest: Arc<Mutex<Option<(std::time::Instant, quick::Manifest)>>>,
}

/// How long a fetched `firmware.json` is reused (the same 30 minutes as the update checks).
const MANIFEST_CACHE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The app's board for a QMK keyboard path, so a project can be flashed through the guarded path
/// (which needs the board's bootloader). None when the app has no data for that keyboard.
fn board_for(keyboard: &str) -> Option<&'static crate::board::Board> {
    crate::board::by_firmware(keyboard)
}

/// The folders the user chose instead of the app's (settings.json).
#[derive(Clone, Debug, Default)]
pub struct Chosen {
    pub msys: Option<String>,
    pub source: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunningJob {
    pub id: u64,
    pub kind: jobs::JobKind,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareStatus {
    pub toolchain: tools::ToolchainStatus,
    pub source: tools::SourceStatus,
    pub driver: tools::DriverStatus,
    /// The Basic path's flashing tools (dfu-util and friends): downloaded, or not yet.
    pub flash_tools: quick::ToolsStatus,
    /// Keychron keyboards and bootloaders plugged in now.
    pub devices: Vec<usb::UsbDevice>,
    pub job: Option<RunningJob>,
    /// Why the latest versions couldn't be checked (offline…), if so.
    pub update_error: Option<String>,
    pub projects_dir: String,
    pub data_dir: String,
    /// The profile switcher module bundled with the app (its protocol version).
    pub module_version: u8,
}

impl Firmware {
    pub fn new(paths: Paths, emit: Emit) -> Self {
        Firmware {
            paths,
            jobs: Jobs::new(emit),
            updates: Arc::new(Mutex::new(UpdateCache::default())),
            manifest: Arc::new(Mutex::new(None)),
        }
    }

    pub fn store(&self) -> Store {
        Store::new(self.paths.projects.clone())
    }

    pub fn msys(&self, chosen: &Chosen) -> Option<Msys> {
        tools::find_msys(&self.paths, chosen.msys.as_deref())
    }

    /// The firmware tree in use: the folder chosen in settings, else the app's download.
    pub fn source_root(&self, chosen: &Chosen) -> (PathBuf, bool) {
        match chosen.source.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(s) => (tools::without_spaces(Path::new(s)), false),
            None => (self.paths.own_source(), true),
        }
    }

    fn usable_source(&self, chosen: &Chosen) -> Result<PathBuf, String> {
        let (root, _) = self.source_root(chosen);
        if !tools::source_usable(&root) {
            return Err("Download Keychron's firmware first (preflight, above).".into());
        }
        if root.to_string_lossy().contains(' ') {
            return Err(tools::space_error(&root));
        }
        Ok(root)
    }

    /// Everything the preflight checklist shows. Doesn't go online (see `check_updates`).
    pub fn status(&self, chosen: &Chosen) -> FirmwareStatus {
        let devices = usb::scan();
        let updates = self.updates.lock().unwrap_or_else(|p| p.into_inner());
        let msys = self.msys(chosen);
        let (root, managed) = self.source_root(chosen);
        let bootloader_driver = devices.iter().find(|d| d.kind == usb::DeviceKind::Bootloader).map(|d| d.driver.as_deref());
        FirmwareStatus {
            toolchain: tools::toolchain_status(msys.as_ref(), updates.toolchain.as_deref()),
            source: tools::source_status(&root, managed, updates.source.as_ref()),
            driver: tools::driver_status(&self.paths, bootloader_driver),
            flash_tools: quick::tools_status(&self.paths),
            devices,
            job: self.jobs.running().map(|(id, kind)| RunningJob { id, kind }),
            update_error: updates.error.clone(),
            projects_dir: self.paths.projects.display().to_string(),
            data_dir: self.paths.qmk.display().to_string(),
            module_version: projects::bundled_module_version(),
        }
    }

    /// Asks GitHub for the latest QMK MSYS and Keychron firmware (cached for 30 minutes).
    pub fn check_updates(&self, force: bool) {
        tools::check_updates(&self.updates, force);
    }

    pub fn install_toolchain(&self, chosen: &Chosen) -> Result<u64, String> {
        let (paths, existing) = (self.paths.clone(), self.msys(chosen));
        let updates = self.updates.clone();
        self.jobs.start(jobs::JobKind::Toolchain, move |ctx| {
            let r = tools::install_toolchain(ctx, &paths, existing.as_ref());
            tools::check_updates(&updates, true);
            r
        })
    }

    pub fn download_source(&self, chosen: &Chosen) -> Result<u64, String> {
        let msys = self.msys(chosen).ok_or("Install QMK MSYS first: the download uses its git.")?;
        let (root, managed) = self.source_root(chosen);
        if !managed {
            return Err(format!(
                "{} is a folder you chose: update it with git yourself, or go back to the app's own copy.",
                root.display()
            ));
        }
        let updates = self.updates.clone();
        self.jobs.start(jobs::JobKind::Source, move |ctx| {
            let r = tools::download_source(ctx, &msys, &root);
            tools::check_updates(&updates, true);
            r
        })
    }

    /// With QMK MSYS's driver installer, or without it QMK Toolbox's (downloaded, 6.5 MB).
    pub fn install_drivers(&self, chosen: &Chosen) -> Result<u64, String> {
        let msys = self.msys(chosen);
        let paths = self.paths.clone();
        self.jobs.start(jobs::JobKind::Drivers, move |ctx| {
            let from = match msys {
                Some(m) if m.root.join("qmk_driver_installer.exe").exists() => m.root,
                _ => quick::ensure_tools(ctx, &paths, quick::DRIVER_TOOLS)?,
            };
            tools::install_drivers(ctx, &paths, &from)
        })
    }

    /// Downloads the Basic path's flashing tools ahead of time (flashing does it too, if needed).
    pub fn get_tools(&self) -> Result<u64, String> {
        let paths = self.paths.clone();
        self.jobs.start(jobs::JobKind::Tools, move |ctx| {
            quick::ensure_tools(ctx, &paths, quick::FLASH_TOOLS)?;
            Ok("The flashing tools are ready.".to_string())
        })
    }

    /// What ready-made firmware the app has for a keyboard. Goes online the first time.
    pub fn prebuilt_info(&self, board: &crate::board::Board, force: bool) -> Result<quick::PrebuiltInfo, String> {
        let mut cache = self.manifest.lock().unwrap_or_else(|p| p.into_inner());
        let fresh = cache.as_ref().is_some_and(|(at, _)| !force && at.elapsed() < MANIFEST_CACHE);
        if !fresh {
            *cache = Some((std::time::Instant::now(), quick::fetch_manifest()?));
        }
        let (_, manifest) = cache.as_ref().expect("just filled");
        quick::prebuilt_info(manifest, board)
    }

    /// Writes the app's ready-made firmware for `board` (no QMK MSYS needed): see `quick`.
    /// `device`: the instance id of a device already in bootloader mode that the user picked as
    /// their keyboard — the only way past the checks that keep the app from writing to something else.
    /// `backup`: read the firmware on the keyboard into a backup first (`backup::read`).
    pub fn flash_prebuilt(&self, board: &'static crate::board::Board, device: Option<String>, backup: bool) -> Result<u64, String> {
        quick::method_for(board)?;
        let paths = self.paths.clone();
        let store = self.store();
        self.jobs.start(jobs::JobKind::Flash, move |ctx| {
            let out = quick::flash_prebuilt(ctx, &paths, board, device.as_deref(), backup)?;
            // The app's ready-made firmware, not one of the user's projects: none of them is on it.
            if let Some(kb) = &board.firmware {
                store.clear_flashed(kb);
            }
            Ok(out)
        })
    }

    /// Builds a project: copies it into the firmware tree, runs `make <keyboard>:<keymap>`, keeps
    /// the firmware file in the project. Flashing is a separate step (`flash_project`), so the
    /// same guarded flash path is used for a project as for the ready-made firmware.
    pub fn build(&self, chosen: &Chosen, id: &str) -> Result<u64, String> {
        let msys = self.msys(chosen).ok_or("Install QMK MSYS first (preflight, above).")?;
        let source = self.usable_source(chosen)?;
        let store = self.store();
        let project = store.get(id)?;
        let id = id.to_string();
        self.jobs.start(jobs::JobKind::Build, move |ctx| {
            let info = build_steps(ctx, &store, &msys, &source, &id)?;
            Ok(format!("{} builds: {} ({} KB).", project.name, info.file, info.size / 1024))
        })
    }

    /// Flashes a project through the same guarded path as the ready-made firmware
    /// (`quick::flash_bin`): the keyboard must be plugged in (or the user must have picked the
    /// bootloader), and the app waits for it to come back. `device`: the instance id the user
    /// picked in the Flash dialog. When the last build isn't of the files as they are (an update
    /// of the module, an edit, no build yet), it is built first, in the same task: what goes on
    /// the keyboard is always the project as the user sees it.
    pub fn flash_project(&self, chosen: &Chosen, id: &str, device: Option<String>, backup: bool) -> Result<u64, String> {
        let store = self.store();
        let project = store.get(id)?;
        let board = board_for(&project.keyboard)
            .ok_or(format!("The app doesn't know how to flash a {} (it isn't one of the keyboards it knows).", project.keyboard))?;
        let build = if project.build_outdated {
            let msys = self
                .msys(chosen)
                .ok_or("This firmware has to be built before it is flashed: install QMK MSYS first (preflight, above).")?;
            Some((msys, self.usable_source(chosen)?))
        } else {
            None
        };
        let paths = self.paths.clone();
        let id = id.to_string();
        self.jobs.start(jobs::JobKind::Flash, move |ctx| {
            if let Some((msys, source)) = &build {
                ctx.log("The files changed since the last build (or it was never built): building it first.".to_string());
                build_steps(ctx, &store, msys, source, &id)?;
            }
            let built = store.get(&id)?.last_build.ok_or("There is no firmware file to flash: build it first.")?;
            let bin = store.build_dir(&id)?.join(&built.file);
            if !bin.exists() {
                return Err("The built firmware file is gone: build it again.".into());
            }
            let opts = quick::FlashOptions { chosen: device.as_deref(), backup, source: "project", release: None };
            let out = quick::flash_bin(ctx, &paths, board, &bin, &opts)?;
            // It is the firmware on that keyboard now, whatever was marked before.
            let _ = store.set_flashed_build(&id);
            Ok(out)
        })
    }

    /// Reads the firmware on `board` into a backup, without writing anything (`backup::back_up`).
    /// `device`: as for a flash.
    pub fn back_up(&self, board: &'static crate::board::Board, device: Option<String>) -> Result<u64, String> {
        quick::method_for(board)?;
        let paths = self.paths.clone();
        self.jobs.start(jobs::JobKind::Backup, move |ctx| backup::back_up(ctx, &paths, board, device.as_deref()))
    }

    /// Writes a backup back to its keyboard (a flash job: the status tracker follows it).
    /// `backup`: back up what is on the keyboard now first.
    pub fn restore_backup(&self, id: &str, device: Option<String>, backup: bool) -> Result<u64, String> {
        let (record, _) = backup::get(&self.paths, id)?;
        let board = crate::board::by_id(&record.board)
            .ok_or(format!("This backup is of a keyboard the app no longer knows ({}).", record.board))?;
        let paths = self.paths.clone();
        let store = self.store();
        let id = id.to_string();
        self.jobs.start(jobs::JobKind::Flash, move |ctx| {
            let out = backup::restore(ctx, &paths, &id, device.as_deref(), backup)?;
            // Whatever it was, the app can't tell which project (if any) it was built from.
            if let Some(kb) = &board.firmware {
                store.clear_flashed(kb);
            }
            Ok(out)
        })
    }

    pub fn list(&self) -> Vec<Project> {
        self.store().list()
    }
}

/// A project's build, inside a task (a build, or a flash whose last build is outdated): copies it
/// into the firmware tree, runs `make <keyboard>:<keymap>`, keeps the firmware file in the project.
fn build_steps(ctx: &jobs::JobCtx, store: &Store, msys: &Msys, source: &Path, id: &str) -> Result<projects::BuildInfo, String> {
    ctx.step("Copying the project into the firmware", None);
    let (keymap, p) = store.sync_into(id, source)?;
    let target = format!("{}:{keymap}", p.keyboard);
    ctx.log(format!("$ {}", build_command(&target)));
    ctx.step("Building", None);
    let code = ctx.run(msys.command(&build_command(&target), source))?;
    if code != 0 {
        return Err("The build failed: see the errors.".into());
    }
    store.keep_build(id, source)
}

/// `make` for a target. SKIP_GIT: QMK's Makefile would otherwise run `qmk git-submodule --sync`
/// before every build, cloning every submodule QMK has (LVGL, pico-sdk… ~110 MB a Keychron board
/// never uses; the app's download fetches the four it needs) and asking git for the version.
pub fn build_command(target: &str) -> String {
    format!("make SKIP_GIT=yes {}", tools::sh_quote(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole path on a real PC, off by default (downloads ~510 MB, builds for minutes):
    /// `V6PS_FW_E2E=<qmk data folder> cargo test end_to_end -- --nocapture`. Uses the QMK MSYS it
    /// finds, downloads (or updates) Keychron's firmware there, then builds a V6 8K project made
    /// from Keychron's keymap with the profile switcher module, in a temporary projects folder.
    #[test]
    fn end_to_end() {
        let Some(qmk) = std::env::var_os("V6PS_FW_E2E") else { return };
        let projects = std::env::temp_dir().join(format!("v6ps-e2e-{}", std::process::id()));
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let fw = Firmware::new(
            Paths { qmk: PathBuf::from(qmk), projects: projects.clone() },
            Arc::new(move |e| match e {
                jobs::FwEvent::Log(l) => {
                    println!("  | {}", l.line);
                    l2.lock().unwrap().push(l.line);
                }
                jobs::FwEvent::Job(j) if j.state != jobs::JobState::Running => println!("== {:?} {:?}: {:?}", j.kind, j.state, j.message),
                jobs::FwEvent::Job(j) => {
                    if let Some(s) = j.step {
                        println!("-- {s} {:?}", j.progress.map(|p| (p * 100.0) as u32));
                    }
                }
            }),
        );
        let chosen = Chosen::default();
        let wait = |fw: &Firmware| {
            while fw.jobs.running().is_some() {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        };
        fw.check_updates(true);
        println!("status before: {:?}", fw.status(&chosen).source.state);
        fw.download_source(&chosen).unwrap();
        wait(&fw);
        let s = fw.status(&chosen);
        assert_eq!(s.source.state, tools::CheckState::Ok, "{:?}", s.source);

        let kbs = projects::keyboards(&fw.source_root(&chosen).0);
        let v6 = kbs.iter().find(|k| k.pid == Some(0x0F61)).expect("the V6 8K ISO knob is in the tree");
        assert_eq!(v6.path, "keychron/v6_8k/iso_encoder");
        let p = fw
            .store()
            .create("E2E test", &v6.path, &projects::Template::Keymap { name: "keychron".into() }, true, Some(&fw.source_root(&chosen).0))
            .unwrap();
        fw.build(&chosen, &p.id).unwrap();
        wait(&fw);
        let built = fw.store().get(&p.id).unwrap().last_build.expect("a firmware file");
        println!("built {} ({} bytes)", built.file, built.size);
        assert!(built.size > 50_000);
        // The copy in the tree goes; the project too.
        let _ = std::fs::remove_dir_all(fw.source_root(&chosen).0.join("keyboards").join(&v6.path).join("keymaps").join(&p.keymap));
        let _ = std::fs::remove_dir_all(projects);
    }

    #[test]
    fn builds_skip_qmks_submodule_sync() {
        assert_eq!(build_command("keychron/v6_8k/iso_encoder:v6ps_x:flash"), "make SKIP_GIT=yes 'keychron/v6_8k/iso_encoder:v6ps_x:flash'");
    }

    #[test]
    fn status_without_anything() {
        let base = std::env::temp_dir().join(format!("v6ps-fw-{}", std::process::id()));
        let fw = Firmware::new(Paths { qmk: base.join("qmk"), projects: base.join("projects") }, Arc::new(|_| {}));
        let chosen = Chosen { msys: Some(base.join("nowhere").display().to_string()), source: None };
        let s = fw.status(&chosen);
        assert_eq!(s.source.state, tools::CheckState::Missing);
        assert!(s.source.managed);
        assert!(s.job.is_none());
        assert!(fw.build(&chosen, "x").is_err());
        assert!(fw.list().is_empty());
    }
}
