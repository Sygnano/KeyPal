//! Installing the profile switcher firmware without QMK MSYS: every release of the app carries a
//! ready-made firmware per Keychron keyboard (Keychron's own keymap plus the module, built by the
//! release workflow, listed in `firmware.json`), and the app writes it with the few small tools QMK
//! Toolbox ships: dfu-util (STM32 and AT32 bootloaders) or wb32-dfu-updater (WB32), ~0.5 MB with
//! their DLLs, plus its driver installer (6.5 MB) when the bootloader has no driver yet. They're
//! downloaded from a fixed commit of QMK Toolbox and checked against the hashes below.

use super::http;
use super::jobs::JobCtx;
use super::tools::{short, Paths};
use super::usb;
use crate::board::Board;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// The app's releases: the firmware of a release matches its module. `firmware.json` is on the app's
/// release (`releases/download/v<version>`), the `.bin` files on a pre-release of their own beside
/// it (`firmware_release`), so the app's release page shows the installer rather than ~270 files.
const RELEASES: &str = "https://github.com/Sygnano/kboard-companion/releases";
pub const MANIFEST: &str = "firmware.json";

/// The release holding the `.bin` files listed by the manifest of release `tag` ("v1.0.0" →
/// "firmware-v1.0.0"). The release workflow makes it under this name.
fn firmware_release(tag: &str) -> String {
    format!("firmware-{tag}")
}

/// QMK Toolbox (MIT), `windows/QMK Toolbox/Resources` at this commit.
const TOOLBOX: &str =
    "https://raw.githubusercontent.com/qmk/qmk_toolbox/cde76bfd99ce8cb107fbb0f182230eaba0e5206b/windows/QMK%20Toolbox/Resources";
/// The flashing tools and what they need, with their SHA-256.
pub const FLASH_TOOLS: &[(&str, &str)] = &[
    ("dfu-util.exe", "322fe732c47293b8b0fdeca510f2188f9d7a5136ef1a7900770deb747fd9dd70"),
    ("wb32-dfu-updater_cli.exe", "6b47592a770607143ffb640f41e90aa0b16e9d2623d92857f8c4a53919c91f5b"),
    ("libusb-1.0.dll", "d439b7b6bf3bcf1defd3651e6d062513886cf13d25a2a4731e7654eb44419f35"),
    ("libwinpthread-1.dll", "c944ee510721a1d30d42227cc3061dfdcbc144c952381afcfe4f6e82c5435ffc"),
];
/// The driver installer and its list (the app adds the AT32 bootloader to the list).
pub const DRIVER_TOOLS: &[(&str, &str)] = &[
    ("qmk_driver_installer.exe", "ccd78a40e3db74a189f42e3eab93463ef6c214c4f928b586992d70863b094431"),
    ("drivers.txt", "54b1cbfcbc2fd4afa198dc75a9ca9f8810875730f6fa6c97787b4511150e74d4"),
];

/// How often to look for the bootloader while waiting for it (QMK's makefiles: 0.5 s).
const BOOTLOADER_POLL: Duration = Duration::from_millis(500);
/// A line per flash, in the projects folder: what was written, to what, and how it went.
pub const FLASH_LOG: &str = "flashes.jsonl";

/// `firmware.json`: the ready-made firmware of a release.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// The release it belongs to ("v0.2.0"): the files are its assets.
    pub tag: String,
    /// The module's protocol version in these builds.
    pub module: u8,
    /// Keychron's firmware they were built from: branch and commit.
    pub keychron: (String, String),
    /// By QMK keyboard path ("keychron/v6_8k/iso_encoder").
    pub boards: HashMap<String, Prebuilt>,
    /// False when this list came from the latest *published* release rather than from this build's
    /// own: between tagging and publishing, and in development builds. Not part of the file.
    #[serde(skip, default = "yes")]
    pub own_release: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Prebuilt {
    /// The asset's name ("keychron_v6_8k_iso_encoder_companion.bin").
    pub file: String,
    pub sha256: String,
    pub size: u64,
    /// Keychron's keymap it was made from ("keychron", "via"…).
    pub keymap: String,
}

/// How a bootloader is written to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// dfu-util with the bootloader's USB id (QMK's `DFU_ARGS`).
    DfuUtil {
        vid: u16,
        pid: u16,
    },
    Wb32,
}

impl Method {
    /// From QMK's bootloader name (keyboard.json `bootloader`). None: not handled here (the
    /// Firmware tab's build and flash still is).
    pub fn for_bootloader(name: &str) -> Option<Method> {
        match name {
            "stm32-dfu" => Some(Method::DfuUtil { vid: 0x0483, pid: 0xDF11 }),
            "at32-dfu" => Some(Method::DfuUtil { vid: 0x2E3C, pid: 0xDF11 }),
            "apm32-dfu" => Some(Method::DfuUtil { vid: 0x314B, pid: 0x0106 }),
            "wb32-dfu" => Some(Method::Wb32),
            _ => None,
        }
    }

    /// The bootloader's USB id, as `usb::scan` sees it.
    pub fn usb_id(self) -> (u16, u16) {
        match self {
            Method::DfuUtil { vid, pid } => (vid, pid),
            Method::Wb32 => (0x342D, 0xDFA0),
        }
    }

    /// The commands that write `bin` (QMK's platforms/chibios: flash.mk and bootloader.mk).
    pub fn commands(self, tools: &Path, bin: &Path) -> Vec<Command> {
        match self {
            Method::DfuUtil { vid, pid } => {
                let mut c = Command::new(tools.join("dfu-util.exe"));
                c.args(["-d", &format!("{vid:04X}:{pid:04X}"), "-a", "0", "-s", "0x08000000:leave", "-D"]).arg(bin);
                vec![c]
            }
            Method::Wb32 => {
                let mut write = Command::new(tools.join("wb32-dfu-updater_cli.exe"));
                write.arg("-D").arg(bin);
                let mut reset = Command::new(tools.join("wb32-dfu-updater_cli.exe"));
                reset.arg("-R");
                vec![write, reset]
            }
        }
    }
}

/// Whether the small flashing tools are downloaded already (the Basic path's only "install").
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub state: super::tools::CheckState,
    pub path: String,
    /// The ones still missing, by file name.
    pub missing: Vec<String>,
}

/// Existence only, not the hashes: `ensure_tools` checks those before every use, and this runs on
/// every status refresh (every 2 s while the Firmware tab is open).
pub fn tools_status(paths: &Paths) -> ToolsStatus {
    let dir = tools_dir(paths);
    let missing: Vec<String> = FLASH_TOOLS.iter().filter(|(n, _)| !dir.join(n).exists()).map(|(n, _)| (*n).to_string()).collect();
    let state = if missing.is_empty() { super::tools::CheckState::Ok } else { super::tools::CheckState::Missing };
    ToolsStatus { state, path: dir.display().to_string(), missing }
}

/// What the app has ready-made for one keyboard, for the Basic path to show before flashing.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrebuiltInfo {
    /// The release the firmware comes from ("v0.2.0").
    pub tag: String,
    /// The module's protocol version in it.
    pub module: u8,
    /// Keychron's branch and commit it was built from.
    pub branch: String,
    pub commit: String,
    /// The QMK keyboard folder it's for ("keychron/v6_8k/iso_encoder").
    pub keyboard: String,
    /// None when that release has no firmware for this keyboard (its keymap didn't build).
    pub entry: Option<Prebuilt>,
    /// False when the firmware comes from a different release than this build of the app, so the
    /// UI can say which release it is offering.
    pub own_release: bool,
}

/// Reads `manifest` for `board`. The caller holds the manifest (it comes from the network).
pub fn prebuilt_info(manifest: &Manifest, board: &Board) -> Result<PrebuiltInfo, String> {
    let kb = board.firmware.as_deref().ok_or(format!("The app doesn't know where the {}'s firmware is.", board.short_name()))?;
    Ok(PrebuiltInfo {
        tag: manifest.tag.clone(),
        module: manifest.module,
        branch: manifest.keychron.0.clone(),
        commit: manifest.keychron.1.clone(),
        keyboard: kb.to_string(),
        entry: manifest.boards.get(kb).cloned(),
        own_release: manifest.own_release,
    })
}

pub fn tools_dir(paths: &Paths) -> PathBuf {
    paths.qmk.join("flash-tools")
}

fn prebuilt_dir(paths: &Paths) -> PathBuf {
    paths.qmk.join("prebuilt")
}

/// The file is there and matches its hash.
fn verified(path: &Path, sha256: &str) -> bool {
    use sha2::{Digest, Sha256};
    std::fs::read(path).is_ok_and(|b| http::hex(&Sha256::digest(&b)) == sha256)
}

/// Downloads what's missing (or damaged) of `files` from QMK Toolbox into the tools folder.
pub fn ensure_tools(ctx: &JobCtx, paths: &Paths, files: &[(&str, &str)]) -> Result<PathBuf, String> {
    let dir = tools_dir(paths);
    for (name, sha) in files {
        let dest = dir.join(name);
        if verified(&dest, sha) {
            continue;
        }
        ctx.step(&format!("Downloading {name}"), None);
        let got = http::download(&format!("{TOOLBOX}/{name}"), &dest, ctx.cancel_flag(), |_, _| {})?;
        if got != *sha {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("{name} doesn't match its expected checksum. Try again later."));
        }
        ctx.log(format!("{name}: downloaded and checked."));
    }
    Ok(dir)
}

/// This release's `firmware.json`, else the latest release's (a build between releases).
///
/// The fallback matters: releases are published as drafts, so between tagging and publishing
/// `/latest/` still points at the *previous* release, and a development build has no release of
/// its own at all. Either way the firmware may carry a module this app doesn't speak, so the
/// manifest says which release it came from and is refused when its module is too new.
pub fn fetch_manifest() -> Result<Manifest, String> {
    let own = format!("{RELEASES}/download/v{}/{MANIFEST}", env!("CARGO_PKG_VERSION"));
    let latest = format!("{RELEASES}/latest/download/{MANIFEST}");
    let mut from_latest = false;
    let text = http::get_text(&own)
        .or_else(|_| {
            from_latest = true;
            http::get_text(&latest)
        })
        .map_err(|e| {
            log::warn!("ready-made firmware list: {e}");
            "Couldn't get the list of ready-made firmware (offline?). Try again, or build one in the Firmware tab.".to_string()
        })?;
    let mut manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("The list of ready-made firmware is unreadable: {e}"))?;
    if from_latest {
        log::info!("ready-made firmware: no list for v{}, using release {}", env!("CARGO_PKG_VERSION"), manifest.tag);
    }
    manifest.own_release = !from_latest;
    check_module(&manifest)?;
    check_files(&manifest)?;
    Ok(manifest)
}

/// Refuses a manifest whose asset names aren't plain file names. `entry.file` is joined into a
/// path under the app's data folder, so a compromised manifest could otherwise write any file on
/// the PC (not just bad firmware). The manifest is unsigned, so this is the only guard.
fn check_files(m: &Manifest) -> Result<(), String> {
    for (keyboard, entry) in &m.boards {
        let name = &entry.file;
        let plain = !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains(['/', '\\'])
            && !name.contains(':')
            && !name.chars().any(char::is_control)
            && std::path::Path::new(name).file_name().is_some_and(|n| n == name.as_str());
        if !plain {
            return Err(format!("The list of ready-made firmware names a file that isn't a plain file name ({keyboard}: {name:?})."));
        }
    }
    Ok(())
}

/// Refuses firmware built with another module than the one this app talks to. Without this the app
/// would install a protocol it cannot speak and then report the keyboard as having no module.
/// (The list can come from another release than the app's own: see `fetch_manifest`.)
fn check_module(m: &Manifest) -> Result<(), String> {
    if m.module != crate::protocol::PS_PROTO_VERSION {
        return Err(format!(
            "The ready-made firmware in release {} has a profile switcher this version of the app can't talk to. Update the app, then install it.",
            m.tag
        ));
    }
    Ok(())
}

/// What the app can do for a keyboard: `Ok(method)` or why not.
pub fn method_for(board: &Board) -> Result<Method, String> {
    let bl = board.bootloader.as_deref().unwrap_or("unknown");
    Method::for_bootloader(bl).ok_or(format!(
        "The {} uses a bootloader ({bl}) the app can't write to without QMK MSYS: use the Firmware tab.",
        board.short_name()
    ))
}

/// How long the app waits for the keyboard to appear in its bootloader before giving up.
const BOOTLOADER_WAIT: Duration = Duration::from_secs(120);
/// How long it then waits for the keyboard to come back after the firmware was written.
const REAPPEAR_WAIT: Duration = Duration::from_secs(25);

/// What was plugged in when a flash started, so that the bootloader that turns up can be told
/// apart from one that was already there. `0x0483:0xDF11` is the *generic* ST DFU id: dev boards,
/// 3D-printer mainboards and flight controllers all present it, and writing keyboard firmware to
/// one of those can destroy it.
#[derive(Clone, Debug, Default)]
pub struct Bus {
    /// Device instance ids of the matching bootloaders that were already there.
    pub bootloaders: Vec<String>,
}

impl Bus {
    pub fn now(method: Method) -> Bus {
        Bus::of(&usb::scan(), method)
    }

    pub fn of(devices: &[usb::UsbDevice], method: Method) -> Bus {
        let (vid, pid) = method.usb_id();
        Bus {
            bootloaders: devices
                .iter()
                .filter(|d| d.kind == usb::DeviceKind::Bootloader && d.vid == vid && d.pid == pid)
                .map(|d| d.instance.clone())
                .collect(),
        }
    }
}

/// What to do about the bootloaders visible now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    /// None yet: keep waiting.
    Wait,
    /// Write to this one.
    Flash(Box<usb::UsbDevice>),
    /// Don't write to anything, and say why.
    Refuse(String),
}

/// Which device to flash, given what was on the bus when the job started and what is on it now.
/// `chosen`: the instance id of a device that was already in bootloader mode, which the user picked
/// as their keyboard.
pub fn pick_bootloader(before: &Bus, now: &[usb::UsbDevice], method: Method, chosen: Option<&str>) -> Pick {
    let (vid, pid) = method.usb_id();
    let matching: Vec<&usb::UsbDevice> =
        now.iter().filter(|d| d.kind == usb::DeviceKind::Bootloader && d.vid == vid && d.pid == pid).collect();
    let Some(&device) = matching.first() else { return Pick::Wait };
    if matching.len() > 1 {
        let names: Vec<String> = matching.iter().map(|d| describe_device(d)).collect();
        return Pick::Refuse(format!(
            "{} devices are in bootloader mode at once ({}), and they share one USB id, so the app can't tell which is your keyboard. Unplug the ones you are not flashing.",
            matching.len(),
            names.join(", ")
        ));
    }
    // It appeared while we were waiting: that is the keyboard restarting into its bootloader.
    if !before.bootloaders.contains(&device.instance) {
        return Pick::Flash(Box::new(device.clone()));
    }
    // It was already there before the flash started. A device that was in bootloader mode while
    // the keyboard was still running cannot be that keyboard, so it is only accepted when the user
    // picks this very device as theirs. (A keyboard that restarts into a bootloader that was
    // already present is indistinguishable from a foreign device on the same USB id, so it is
    // refused too: the user picks it in the dropdown.)
    if chosen == Some(device.instance.as_str()) {
        return Pick::Flash(Box::new(device.clone()));
    }
    Pick::Refuse(format!(
        "{} was already in bootloader mode before you asked to flash. That USB id is shared by many devices that are not keyboards, and writing keyboard firmware to one of them can ruin it. Unplug it and put your keyboard into its bootloader, or choose this device as your keyboard.",
        describe_device(device)
    ))
}

/// A device as the user can recognise it: what Windows calls it, and its USB id.
pub fn describe_device(d: &usb::UsbDevice) -> String {
    let name =
        if d.description.is_empty() { d.bootloader.clone().unwrap_or_else(|| "an unnamed device".into()) } else { d.description.clone() };
    format!("\"{name}\" ({:04X}:{:04X})", d.vid, d.pid)
}

/// Whether the keyboard itself is plugged in now (running its firmware, whether or not the app can
/// talk to it). A flash is refused when it isn't: 221 of the app's 269 boards share one bootloader
/// id, so once a keyboard is in DFU nothing can tell the app which model it is.
pub fn board_present(board: &Board) -> bool {
    usb::scan().iter().any(|d| d.kind == usb::DeviceKind::Keyboard && crate::board::by_usb(d.vid, d.pid).is_some_and(|b| b.id == board.id))
}

/// Downloads the keyboard's ready-made firmware and the tools, waits for the bootloader, flashes.
/// `chosen`: the instance id of a device already in bootloader mode that the user picked as their
/// keyboard (see `pick_bootloader`); without it the app refuses to write to a bootloader it can't
/// attribute.
pub fn flash_prebuilt(ctx: &JobCtx, paths: &Paths, board: &Board, chosen: Option<&str>) -> Result<String, String> {
    let kb = board.firmware.as_deref().ok_or(format!("The app doesn't know where the {}'s firmware is.", board.short_name()))?;
    ctx.step("Finding the ready-made firmware", None);
    let manifest = fetch_manifest()?;
    let entry = manifest.boards.get(kb).ok_or(format!(
        "Release {} has no ready-made firmware for the {} (Keychron's keymap for it didn't build). Build one in the Firmware tab.",
        manifest.tag,
        board.short_name()
    ))?;
    ctx.log(format!(
        // No module number: the UI never shows protocol versions (they restart at 1 for 1.0).
        "{}: Keychron's \"{}\" keymap with the profile switcher (Keychron {} at {}), {} KB",
        entry.file,
        entry.keymap,
        manifest.keychron.0,
        short(&manifest.keychron.1, 10),
        entry.size / 1024
    ));
    let bin = prebuilt_dir(paths).join(&entry.file);
    if !verified(&bin, &entry.sha256) {
        ctx.step(&format!("Downloading the firmware ({} KB)", entry.size / 1024), None);
        let url = format!("{RELEASES}/download/{}/{}", firmware_release(&manifest.tag), entry.file);
        let got = http::download(&url, &bin, ctx.cancel_flag(), |_, _| {})?;
        if got != entry.sha256 {
            let _ = std::fs::remove_file(&bin);
            return Err("The downloaded firmware doesn't match its checksum. Try again.".into());
        }
    }
    flash_bin(ctx, paths, board, &bin, chosen, "ready-made", Some(&manifest))
}

/// Writes `bin` to `board`, with the same checks the ready-made path uses: the keyboard must be
/// plugged in (or the user must have picked the bootloader), the bootloader must have appeared
/// while waiting (or be the picked one), and the keyboard must come back afterwards. This is the
/// one flash path: the Advanced tab builds a `.bin` and calls this too, so `make …:flash` (which
/// writes to whatever has the bootloader's USB id) is never used.
pub fn flash_bin(
    ctx: &JobCtx,
    paths: &Paths,
    board: &Board,
    bin: &Path,
    chosen: Option<&str>,
    source: &str,
    release: Option<&Manifest>,
) -> Result<String, String> {
    let method = method_for(board)?;
    // What the bus looks like before anything happens, to tell the keyboard's bootloader from one
    // that was already plugged in.
    let before = Bus::now(method);
    if chosen.is_none() && !board_present(board) {
        return Err(format!(
            "The app can't see a {} plugged in, and won't write its firmware to a keyboard it hasn't found. Almost every Keychron board shares one bootloader id, so once a keyboard is in bootloader mode the app cannot check the model. Plug the keyboard in (its firmware doesn't have to work), or, if it is already in its bootloader, choose the device the app can see as your keyboard.",
            board.short_name()
        ));
    }
    let tools = ensure_tools(ctx, paths, FLASH_TOOLS)?;

    ctx.step("Waiting for the keyboard's bootloader: unplug it, hold Esc, plug it back in", None);
    ctx.log("Waiting for the bootloader (Restart into bootloader, or unplug the keyboard, hold Esc and plug it back in)…");
    let deadline = std::time::Instant::now() + BOOTLOADER_WAIT;
    let device = loop {
        if ctx.cancelled() {
            return Err("Cancelled.".into());
        }
        match pick_bootloader(&before, &usb::scan(), method, chosen) {
            Pick::Flash(d) => break *d,
            Pick::Refuse(why) => return Err(why),
            Pick::Wait => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "The {} never appeared in its bootloader ({} minutes). There are two ways in: \"Restart into bootloader\" in the app (which needs firmware that already has the profile switcher), or unplug the keyboard, hold Esc, and plug it back in while holding it.",
                        board.short_name(),
                        BOOTLOADER_WAIT.as_secs() / 60
                    ));
                }
                std::thread::sleep(BOOTLOADER_POLL);
            }
        }
    };
    if !device.driver.as_deref().is_some_and(|s| !s.is_empty()) {
        return Err(format!(
            "{} is in bootloader mode, but Windows has no driver for it yet: install the driver, then flash again.",
            describe_device(&device)
        ));
    }
    // Windows may still be setting the device up.
    std::thread::sleep(Duration::from_millis(500));
    ctx.log(format!("Bootloader found: {}.", describe_device(&device)));
    let file = bin.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    // No Cancel from here: the tool erases before it writes, so stopping it part-way leaves the
    // keyboard with no firmware, and the Esc way back into the bootloader is part of that firmware.
    ctx.uninterruptible(|| -> Result<(), String> {
        ctx.step("Flashing: don't unplug the keyboard", Some(0.0));
        for cmd in method.commands(&tools, bin) {
            ctx.log(format!(
                "$ {} {}",
                cmd.get_program().to_string_lossy(),
                cmd.get_args().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ")
            ));
            let code = ctx.run(cmd)?;
            if code != 0 {
                // dfu-util's ":leave" can fail on its very last request as the chip restarts.
                journal(paths, board, source, release, &file, &format!("the tool exited with {code}"));
                return Err(format!(
                    "Flashing stopped with code {code}. If the log says \"File downloaded successfully\", the firmware is in: unplug the keyboard and plug it back in. Otherwise flash again."
                ));
            }
        }
        Ok(())
    })?;
    // A zero exit code says the write went out, not that the keyboard came back with it.
    ctx.step("Waiting for the keyboard to restart", None);
    let came_back = wait_for_board(ctx, board, REAPPEAR_WAIT);
    journal(paths, board, source, release, &file, if came_back { "flashed" } else { "flashed, did not come back" });
    if !came_back {
        return Ok(format!(
            "The firmware was written, but the {} hasn't come back in {} seconds. Unplug it and plug it back in; if the app still doesn't find it, flash it again.",
            board.short_name(),
            REAPPEAR_WAIT.as_secs()
        ));
    }
    ctx.log(format!("The {} is back.", board.short_name()));
    Ok(format!("The {} restarted with the new firmware.", board.short_name()))
}

/// Waits for the keyboard to enumerate again after a flash. False if it didn't within `wait`.
fn wait_for_board(ctx: &JobCtx, board: &Board, wait: Duration) -> bool {
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        if ctx.cancelled() {
            return false;
        }
        if board_present(board) {
            return true;
        }
        std::thread::sleep(BOOTLOADER_POLL);
    }
    false
}

/// One line per flash, next to the projects, so there is a record of what was written and how it
/// went. Never fails a flash: a missing record is not worth an error.
fn journal(paths: &Paths, board: &Board, source: &str, release: Option<&Manifest>, file: &str, result: &str) {
    use std::io::Write;
    let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let line = serde_json::json!({
        "when": when,
        "board": board.id,
        "source": source,
        "release": release.map(|m| m.tag.clone()),
        "module": release.map(|m| m.module),
        "file": file,
        "result": result,
    });
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&paths.projects)?;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(paths.projects.join(FLASH_LOG))?;
        writeln!(f, "{line}")
    };
    if let Err(e) = write() {
        log::warn!("could not record the flash in {FLASH_LOG}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootloaders_and_their_commands() {
        let at32 = Method::for_bootloader("at32-dfu").unwrap();
        assert_eq!(at32.usb_id(), (0x2E3C, 0xDF11));
        let cmds = at32.commands(Path::new("T"), Path::new("fw.bin"));
        let args: Vec<_> = cmds[0].get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, ["-d", "2E3C:DF11", "-a", "0", "-s", "0x08000000:leave", "-D", "fw.bin"]);
        assert_eq!(Method::for_bootloader("stm32-dfu").unwrap().usb_id(), (0x0483, 0xDF11));
        let wb = Method::for_bootloader("wb32-dfu").unwrap();
        assert_eq!(wb.commands(Path::new("T"), Path::new("fw.bin")).len(), 2, "write, then reset");
        assert_eq!(Method::for_bootloader("atmel-dfu"), None);
        // Every Keychron keyboard the app knows can be flashed this way.
        for b in crate::board::all() {
            assert!(method_for(b).is_ok(), "{}: {:?}", b.id, b.bootloader);
            assert!(usb::BOOTLOADERS.iter().any(|(v, p, _)| (*v, *p) == method_for(b).unwrap().usb_id()));
        }
    }

    #[test]
    fn tools_and_prebuilt_for_the_basic_path() {
        let dir = std::env::temp_dir().join(format!("v6ps_quick_{}", std::process::id()));
        let paths = Paths { qmk: dir.clone(), projects: dir.join("p") };
        let status = tools_status(&paths);
        assert_eq!(status.state, crate::firmware::tools::CheckState::Missing, "nothing downloaded yet");
        assert_eq!(status.missing.len(), FLASH_TOOLS.len());
        std::fs::create_dir_all(tools_dir(&paths)).unwrap();
        for (name, _) in FLASH_TOOLS {
            std::fs::write(tools_dir(&paths).join(name), b"x").unwrap();
        }
        assert_eq!(tools_status(&paths).state, crate::firmware::tools::CheckState::Ok);
        std::fs::remove_dir_all(&dir).unwrap();

        let manifest: Manifest = serde_json::from_str(
            r#"{"tag":"v0.2.0","module":7,"keychron":["2025q3","abc1234567"],
                "boards":{"keychron/v6_8k/iso_encoder":{"file":"v6.bin","sha256":"00","size":75000,"keymap":"keychron"}}}"#,
        )
        .unwrap();
        let v6 = crate::board::by_id("v6_8k_iso_encoder").expect("the V6 8K ISO is a known board");
        let info = prebuilt_info(&manifest, v6).unwrap();
        assert_eq!(info.tag, "v0.2.0");
        assert_eq!(info.entry.as_ref().unwrap().keymap, "keychron");
        // The files are on the firmware pre-release the release workflow makes beside the app's.
        assert_eq!(firmware_release(&manifest.tag), "firmware-v0.2.0");
        // A board this release didn't build: the app says so rather than failing.
        let other = crate::board::all().iter().find(|b| b.firmware.as_deref() != Some("keychron/v6_8k/iso_encoder")).unwrap();
        assert!(prebuilt_info(&manifest, other).unwrap().entry.is_none());
    }

    fn dfu(instance: &str, description: &str, driver: Option<&str>) -> usb::UsbDevice {
        usb::UsbDevice {
            vid: 0x0483,
            pid: 0xDF11,
            kind: usb::DeviceKind::Bootloader,
            bootloader: Some("STM32 DFU".into()),
            driver: driver.map(String::from),
            description: description.into(),
            instance: instance.into(),
        }
    }

    fn keyboard(instance: &str) -> usb::UsbDevice {
        usb::UsbDevice {
            vid: 0x3434,
            pid: 0x0F61,
            kind: usb::DeviceKind::Keyboard,
            bootloader: None,
            driver: Some("usbccgp".into()),
            description: "Keychron V6".into(),
            instance: instance.into(),
        }
    }

    #[test]
    fn only_a_bootloader_that_is_the_keyboard_gets_written_to() {
        let method = Method::for_bootloader("stm32-dfu").unwrap();
        let kb = keyboard("KB1");
        let before = Bus::of(std::slice::from_ref(&kb), method);
        assert!(before.bootloaders.is_empty());

        // Nothing there yet: wait.
        assert_eq!(pick_bootloader(&before, std::slice::from_ref(&kb), method, None), Pick::Wait);

        // The keyboard restarted into its bootloader: that one is ours.
        let ours = dfu("DFU1", "STM32 BOOTLOADER", Some("WinUSB"));
        assert_eq!(pick_bootloader(&before, std::slice::from_ref(&ours), method, None), Pick::Flash(Box::new(ours.clone())));

        // A 3D printer board that was already in DFU before we started, keyboard still plugged in:
        // the app must not write keyboard firmware to it.
        let printer = dfu("DFU9", "STM32 BOOTLOADER", Some("WinUSB"));
        let before = Bus::of(&[kb.clone(), printer.clone()], method);
        let refused = pick_bootloader(&before, &[kb.clone(), printer.clone()], method, None);
        match &refused {
            Pick::Refuse(why) => assert!(why.contains("already in bootloader mode") && why.contains("0483:DF11"), "{why}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        // Unless the user picks it as their keyboard…
        assert_eq!(pick_bootloader(&before, &[kb.clone(), printer.clone()], method, Some("DFU9")), Pick::Flash(Box::new(printer.clone())));
        // …and only that device: a pick of some other one doesn't vouch for this one.
        assert!(matches!(pick_bootloader(&before, &[kb.clone(), printer.clone()], method, Some("DFU1")), Pick::Refuse(_)));
        // The keyboard disappearing while a foreign bootloader was already there is NOT enough:
        // a device that was in DFU while the keyboard ran cannot be that keyboard, and the app
        // must not flash it (the user picks it in the dropdown instead).
        assert!(matches!(pick_bootloader(&before, std::slice::from_ref(&printer), method, None), Pick::Refuse(_)));

        // Two at once: dfu-util targets by USB id, so it would pick one at random.
        let before = Bus::of(std::slice::from_ref(&kb), method);
        let two = pick_bootloader(&before, &[ours.clone(), printer.clone()], method, None);
        match two {
            Pick::Refuse(why) => assert!(why.contains("2 devices are in bootloader mode"), "{why}"),
            other => panic!("expected a refusal, got {other:?}"),
        }

        // A bootloader of another kind isn't ours either.
        let wb32 = Method::for_bootloader("wb32-dfu").unwrap();
        assert_eq!(pick_bootloader(&Bus::of(std::slice::from_ref(&kb), wb32), &[ours], wb32, None), Pick::Wait);
    }

    #[test]
    fn firmware_with_another_module_is_refused() {
        let mut m: Manifest = serde_json::from_str(r#"{"tag":"v9.9.9","module":99,"keychron":["2025q3","abc"],"boards":{}}"#).unwrap();
        assert!(m.own_release, "a file without the field is treated as this build's own");
        let err = check_module(&m).unwrap_err();
        assert!(err.contains("can't talk to"), "{err}");
        m.module = 4; // a development build's, from before 1.0
        assert!(check_module(&m).is_err());
        m.module = crate::protocol::PS_PROTO_VERSION;
        assert!(check_module(&m).is_ok());
    }

    #[test]
    fn manifest_format() {
        let json = r#"{"tag":"v0.2.0","module":6,"keychron":["2025q3","abc123"],
            "boards":{"keychron/v6_8k/iso_encoder":{"file":"keychron_v6_8k_iso_encoder_companion.bin","sha256":"00","size":75000,"keymap":"keychron"}}}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.boards["keychron/v6_8k/iso_encoder"].keymap, "keychron");
        assert_eq!(serde_json::from_str::<Manifest>(&serde_json::to_string(&m).unwrap()).unwrap(), m);
    }
}
