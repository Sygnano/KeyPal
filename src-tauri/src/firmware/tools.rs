//! What building and flashing Keychron firmware needs, and getting it:
//! - QMK MSYS (make, the ARM compiler, git, dfu-util…): found on the PC, or installed by the app;
//! - Keychron's qmk_firmware: a sparse, shallow clone with only their keyboards (~510 MB);
//! - the WinUSB driver for the bootloaders (QMK's list lacks the AT32 one some Keychron boards use).

use super::http;
use super::jobs::JobCtx;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MSYS_RELEASES: &str = "https://api.github.com/repos/qmk/qmk_distro_msys/releases/latest";
const KEYCHRON_REPO: &str = "https://api.github.com/repos/Keychron/qmk_firmware";
const KEYCHRON_GIT: &str = "https://github.com/Keychron/qmk_firmware.git";
/// QMK MSYS's installer (Inno Setup) id, for its uninstall registry key.
const MSYS_APP_ID: &str = "{52DB9201-A172-4A79-82C3-83B2E8B85FD8}_is1";
/// The submodules an ARM (ChibiOS) or AVR Keychron build needs, of the 8 QMK has.
const SUBMODULES: &str = "lib/chibios lib/chibios-contrib lib/lufa lib/printf";
/// The AT32 bootloader of boards like the V6 8K, missing from QMK MSYS's drivers.txt.
const AT32_DRIVER: &str = "winusb,AT32 Bootloader,2E3C,DF11,3b0e5a2a-6c63-4e0d-9f27-2d7d1a9b8e41";

/// Where the Firmware tab keeps things. Big downloads go in the local (not roaming) app data.
#[derive(Clone, Debug)]
pub struct Paths {
    /// `%LOCALAPPDATA%\<app>\qmk`
    pub qmk: PathBuf,
    /// `%APPDATA%\<app>\firmware`: the user's firmware projects.
    pub projects: PathBuf,
}

impl Paths {
    pub fn own_msys(&self) -> PathBuf {
        self.qmk.join("QMK_MSYS")
    }
    pub fn own_source(&self) -> PathBuf {
        self.qmk.join("qmk_firmware")
    }
    pub fn downloads(&self) -> PathBuf {
        self.qmk.join("downloads")
    }
    fn drivers_file(&self) -> PathBuf {
        self.qmk.join("drivers.txt")
    }
    fn drivers_marker(&self) -> PathBuf {
        self.qmk.join("drivers-installed.txt")
    }
}

// ------------------------------------------------------------------ QMK MSYS

/// A usable QMK MSYS install.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Msys {
    pub root: PathBuf,
    pub version: Option<String>,
    /// Installed by the app, in its data folder.
    pub managed: bool,
}

impl Msys {
    fn usable(root: &Path) -> bool {
        ["usr/bin/bash.exe", "usr/bin/make.exe", "usr/bin/git.exe", "opt/qmk/bin/arm-none-eabi-gcc.exe"]
            .iter()
            .all(|p| root.join(p).exists())
    }

    /// Runs `script` in QMK MSYS's bash from `cwd`, without its login profile (which checks the
    /// internet for QMK CLI updates on every start). The environment is what that profile sets up.
    pub fn command(&self, script: &str, cwd: &Path) -> Command {
        let r = &self.root;
        let path = [r.join("opt/qmk/bin"), r.join("opt/uv/tools/bin"), r.join("mingw64/bin"), r.join("usr/bin")]
            .iter()
            .map(|p| p.display().to_string())
            .chain(std::env::var("SystemRoot").ok().map(|w| format!("{w}\\System32;{w}")))
            .collect::<Vec<_>>()
            .join(";");
        let mut cmd = Command::new(r.join("usr/bin/bash.exe"));
        cmd.args(["--noprofile", "--norc", "-c", script])
            .current_dir(cwd)
            .env("PATH", path)
            .env("MSYSTEM", "MINGW64")
            // The qmk CLI runs its commands through $SHELL (milc's cli.run); a Windows process
            // started from Explorer has none, and every build stopped with KeyError: 'SHELL'.
            .env("SHELL", "/usr/bin/bash")
            .env("CHERE_INVOKING", "1")
            .env("QMK_DISTRIB_DIR", "/opt/qmk")
            // English messages, so the app can read them; UTF-8 for file names.
            .env("LANG", "C.UTF-8")
            .env("LC_ALL", "C.UTF-8");
        // Python (the qmk CLI) needs these to find a home folder.
        for var in ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
            if let Ok(v) = std::env::var(var) {
                cmd.env(var, v);
            }
        }
        cmd
    }
}

/// QMK's makefiles break on a path with a space (a Windows user name like "Jean Dupont" puts one
/// in every AppData folder). Windows gives such folders a short name without spaces
/// (`C:\Users\JEANDU~1\...`): the folder is created if needed and that name returned. The path as
/// is when it has no space, or when short names are turned off on the drive.
pub fn without_spaces(path: &Path) -> PathBuf {
    if !path.to_string_lossy().contains(' ') {
        return path.to_path_buf();
    }
    let _ = std::fs::create_dir_all(path);
    match short_path(path) {
        Some(s) if !s.to_string_lossy().contains(' ') => s,
        _ => path.to_path_buf(),
    }
}

#[cfg(windows)]
fn short_path(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: `wide` is NUL-terminated and `buf` is a writable buffer of the length passed.
    let n = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buf)) } as usize;
    (n > 0 && n < buf.len()).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
}

#[cfg(not(windows))]
fn short_path(_: &Path) -> Option<PathBuf> {
    None
}

/// Where the build tools and Keychron's firmware go: `local_qmk` (`%LOCALAPPDATA%\<app>\qmk`), by
/// its short name if it has a space, else `%ProgramData%\KBoardCompanion\qmk` (no space: that is the point) when short names
/// are off (Windows 11 often has them off). Any user may create folders in ProgramData.
pub fn qmk_home(local_qmk: &Path) -> PathBuf {
    let p = without_spaces(local_qmk);
    if !p.to_string_lossy().contains(' ') {
        return p;
    }
    if let Some(alt) = std::env::var_os("ProgramData").map(|d| PathBuf::from(d).join("KBoardCompanion").join("qmk")) {
        if !alt.to_string_lossy().contains(' ') && std::fs::create_dir_all(&alt).is_ok() {
            log::info!("QMK folder: {} (the app data folder has a space: {})", alt.display(), local_qmk.display());
            return alt;
        }
    }
    p
}

/// The error for a folder QMK can't build in.
pub fn space_error(path: &Path) -> String {
    format!(
        "QMK can't build in a folder whose path has a space ({}), and Windows has no short name for it. Under \"Keychron's firmware\" in the checklist, pick a folder without spaces with \"Use a folder you already have…\" (for example C:\\qmk_firmware), or go back to the app's own copy.",
        path.display()
    )
}

/// The first `n` characters of a string from the network (a commit sha, a tag). Slicing by byte
/// offset would panic on a multi-byte character straddling the cut, and these strings come from
/// GitHub's JSON, not from us.
pub fn short(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// "C:\\Users\\x\\qmk" → "/c/Users/x/qmk", for MSYS scripts.
pub fn posix(path: &Path) -> String {
    let s = path.display().to_string().replace('\\', "/");
    match s.split_once(":/") {
        Some((drive, rest)) if drive.len() == 1 => format!("/{}/{rest}", drive.to_ascii_lowercase()),
        _ => s,
    }
}

/// Single-quoted for bash.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Finds QMK MSYS: the folder chosen in settings, the app's own install, the one QMK's installer
/// registered, or its default folder.
pub fn find_msys(paths: &Paths, chosen: Option<&str>) -> Option<Msys> {
    let registered = registry::msys_install();
    let mut candidates: Vec<(PathBuf, bool)> = vec![];
    if let Some(c) = chosen.filter(|c| !c.trim().is_empty()) {
        candidates.push((PathBuf::from(c), false));
    }
    candidates.push((paths.own_msys(), true));
    if let Some((loc, _)) = &registered {
        candidates.push((PathBuf::from(loc), false));
    }
    candidates.push((PathBuf::from("C:\\QMK_MSYS"), false));
    let (root, managed) = candidates.into_iter().find(|(p, _)| Msys::usable(p))?;
    let same = |a: &Path, b: &str| a.display().to_string().trim_end_matches('\\').eq_ignore_ascii_case(b.trim_end_matches('\\'));
    let version = registered.filter(|(loc, _)| same(&root, loc)).map(|(_, v)| v);
    Some(Msys { root, version, managed })
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Missing,
    Outdated,
    Ok,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    pub state: CheckState,
    pub path: Option<String>,
    pub version: Option<String>,
    pub latest: Option<String>,
    pub managed: bool,
}

pub fn toolchain_status(msys: Option<&Msys>, latest: Option<&str>) -> ToolchainStatus {
    let Some(m) = msys else {
        return ToolchainStatus { state: CheckState::Missing, path: None, version: None, latest: latest.map(Into::into), managed: false };
    };
    let outdated = matches!((m.version.as_deref(), latest), (Some(v), Some(l)) if version_less(v, l));
    ToolchainStatus {
        state: if outdated { CheckState::Outdated } else { CheckState::Ok },
        path: Some(m.root.display().to_string()),
        version: m.version.clone(),
        latest: latest.map(Into::into),
        managed: m.managed,
    }
}

/// "1.9.0" < "1.12.0", numerically.
pub fn version_less(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.trim_start_matches('v').split('.').map(|p| p.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) < parse(b)
}

/// Downloads QMK MSYS's installer, checks it, and runs it silently (Windows asks for permission).
/// An existing install is updated where it is; otherwise it goes in the app's data folder.
pub fn install_toolchain(ctx: &JobCtx, paths: &Paths, existing: Option<&Msys>) -> Result<String, String> {
    ctx.step("Looking for the latest QMK MSYS", None);
    let release = http::get_json(MSYS_RELEASES)?;
    let tag = release["tag_name"].as_str().unwrap_or("latest").to_string();
    let asset = |name: &str| {
        release["assets"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["name"] == name))
            .and_then(|x| x["browser_download_url"].as_str())
            .map(String::from)
    };
    let exe_url = asset("QMK_MSYS.exe").ok_or("The QMK MSYS release has no installer.")?;
    let expected = asset("QMK_MSYS.exe.sha256").and_then(|u| http::get_text(&u).ok()).and_then(|t| http::parse_sha256_file(&t));
    let dest = paths.downloads().join(format!("QMK_MSYS-{tag}.exe"));
    ctx.log(format!("Downloading QMK MSYS {tag} from {exe_url}"));
    let hash = http::download(&exe_url, &dest, ctx.cancel_flag(), |done, total| {
        let step = format!("Downloading QMK MSYS {tag} ({} MB)", done >> 20);
        ctx.step(&step, total.map(|t| done as f64 / t as f64));
    })?;
    match expected {
        Some(e) if e != hash => {
            let _ = std::fs::remove_file(&dest);
            return Err("The downloaded installer doesn't match its published checksum. Try again.".into());
        }
        Some(_) => ctx.log("Checksum verified."),
        None => {
            // Running an unverified 600 MB installer as administrator is not something to fall
            // back to silently because one small file failed to download.
            let _ = std::fs::remove_file(&dest);
            return Err(format!(
                "QMK MSYS {tag} has no published checksum the app could fetch, so it can't check the installer it just downloaded \u{2014} and it won't run an unchecked installer as administrator. Try again in a moment, or install QMK MSYS yourself from qmk.fm and point the app at it under \"Build tools\"."
            ));
        }
    }
    let dir = existing.map(|m| m.root.clone()).unwrap_or_else(|| paths.own_msys());
    ctx.step("Installing QMK MSYS (Windows asks for permission)", None);
    ctx.log(format!("Installing into {}", dir.display()));
    let args =
        format!("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /TASKS=installdrivers /DIR={}", elevate::param(&dir.display().to_string())?);
    let code = elevate::run_elevated(&dest, &args)?;
    if code != 0 {
        return Err(format!("The QMK MSYS installer stopped with code {code}."));
    }
    let _ = std::fs::remove_file(&dest);
    if !Msys::usable(&dir) {
        return Err(format!("QMK MSYS was installed, but {} doesn't have the build tools.", dir.display()));
    }
    Ok(format!("QMK MSYS {tag} installed in {}.", dir.display()))
}

// ------------------------------------------------------------------ Keychron's qmk_firmware

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub state: CheckState,
    pub path: String,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub latest_branch: Option<String>,
    pub latest_commit: Option<String>,
    /// Downloaded by the app (it can update it); else a folder the user chose.
    pub managed: bool,
}

/// The branch and commit a checkout is on, read from `.git` (no git needed).
pub fn git_head(repo: &Path) -> Option<(String, String)> {
    let git = repo.join(".git");
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    let Some(r) = head.strip_prefix("ref: ") else { return Some(("(detached)".into(), head.to_string())) };
    let branch = r.trim_start_matches("refs/heads/").to_string();
    let sha = std::fs::read_to_string(git.join(r)).ok().map(|s| s.trim().to_string()).or_else(|| {
        std::fs::read_to_string(git.join("packed-refs")).ok()?.lines().find_map(|l| l.strip_suffix(r).map(|s| s.trim().to_string()))
    })?;
    Some((branch, sha))
}

/// Complete enough to build: QMK's Makefile, Keychron's keyboards and ChibiOS.
pub fn source_usable(root: &Path) -> bool {
    root.join("Makefile").exists() && root.join("keyboards/keychron").is_dir() && root.join("lib/chibios/os").is_dir()
}

pub fn source_status(root: &Path, managed: bool, latest: Option<&(String, String)>) -> SourceStatus {
    let head = source_usable(root).then(|| git_head(root)).flatten();
    let (branch, commit) = match &head {
        Some((b, c)) => (Some(b.clone()), Some(c.clone())),
        None => (None, None),
    };
    let state = match (&head, latest) {
        _ if !source_usable(root) => CheckState::Missing,
        (Some((b, c)), Some((lb, lc))) if b != lb || c != lc => CheckState::Outdated,
        _ => CheckState::Ok,
    };
    SourceStatus {
        state,
        path: root.display().to_string(),
        branch,
        commit,
        latest_branch: latest.map(|l| l.0.clone()),
        latest_commit: latest.map(|l| l.1.clone()),
        managed,
    }
}

/// Keychron's current branch (their default one) and its latest commit.
pub fn latest_source() -> Result<(String, String), String> {
    let repo = http::get_json(KEYCHRON_REPO)?;
    let branch = repo["default_branch"].as_str().ok_or("GitHub didn't say Keychron's default branch.")?.to_string();
    let b = http::get_json(&format!("{KEYCHRON_REPO}/branches/{branch}"))?;
    let sha = b["commit"]["sha"].as_str().ok_or("GitHub didn't say the branch's latest commit.")?.to_string();
    Ok((branch, sha))
}

pub fn latest_toolchain() -> Result<String, String> {
    let r = http::get_json(MSYS_RELEASES)?;
    r["tag_name"].as_str().map(String::from).ok_or("GitHub didn't say QMK MSYS's latest version.".into())
}

/// The shell script that downloads (or updates) Keychron's firmware into `dest`: a shallow,
/// sparse clone (only QMK's own folders and Keychron's keyboards), then the submodules the builds
/// need. Keymaps the app put in the tree aren't tracked and survive updates.
pub fn source_script(dest: &Path, branch: &str) -> String {
    let d = sh_quote(&posix(dest));
    let b = sh_quote(branch);
    format!(
        r#"set -e
D={d}; B={b}
if [ ! -d "$D/.git" ]; then
  rm -rf "$D.tmp"
  git clone --progress --depth 1 --filter=blob:none --sparse --branch "$B" --single-branch {url} "$D.tmp"
  mv "$D.tmp" "$D"
  cd "$D"
else
  cd "$D"
  git remote set-branches origin "$B"
  git fetch --progress --depth 1 --filter=blob:none origin "$B"
  git checkout --progress -f -B "$B" FETCH_HEAD
fi
DIRS=$(git ls-tree -d --name-only HEAD | grep -vE '^(keyboards|tests|\.github|\.vscode)$' | tr '\n' ' ')
echo "Checking out: $DIRS keyboards/keychron"
git sparse-checkout set $DIRS keyboards/keychron
git submodule update --init --progress --depth 1 --recommend-shallow {subs}
echo "Keychron firmware at $(git rev-parse --short HEAD) ($B)"
"#,
        url = KEYCHRON_GIT,
        subs = SUBMODULES
    )
}

pub fn download_source(ctx: &JobCtx, msys: &Msys, dest: &Path) -> Result<String, String> {
    ctx.step("Finding Keychron's current firmware", None);
    let (branch, sha) = latest_source()?;
    let parent = dest.parent().ok_or("bad folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if parent.display().to_string().contains(' ') {
        return Err(space_error(parent));
    }
    ctx.log(format!("Keychron's firmware: branch {branch}, commit {}", short(&sha, 10)));
    ctx.step("Downloading Keychron's firmware", None);
    let code = ctx.run(msys.command(&source_script(dest, &branch), parent))?;
    if code != 0 {
        return Err(format!("Downloading the firmware failed (git exited with {code}). See the log."));
    }
    if !source_usable(dest) {
        return Err("The download finished, but the firmware folder is incomplete.".into());
    }
    Ok(format!("Keychron's firmware ({branch}) is ready."))
}

// ------------------------------------------------------------------ drivers

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DriverState {
    /// The plugged-in bootloader has a driver.
    Ok,
    /// It has none.
    Missing,
    /// The app installed the drivers earlier (none plugged in to check).
    Installed,
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub state: DriverState,
    pub installed_at: Option<String>,
}

pub fn driver_status(paths: &Paths, bootloader_driver: Option<Option<&str>>) -> DriverStatus {
    let installed_at = std::fs::read_to_string(paths.drivers_marker()).ok().map(|s| s.trim().to_string());
    let state = match bootloader_driver {
        Some(Some(d)) if !d.is_empty() => DriverState::Ok,
        Some(_) => DriverState::Missing,
        None if installed_at.is_some() => DriverState::Installed,
        None => DriverState::Unknown,
    };
    DriverStatus { state, installed_at }
}

/// QMK MSYS's driver list plus the AT32 bootloader.
pub fn drivers_list(qmk_list: &str) -> String {
    let mut out = qmk_list.trim_end().to_string();
    if !out.to_ascii_uppercase().contains("2E3C,DF11") {
        out.push('\n');
        out.push_str(AT32_DRIVER);
    }
    out.push('\n');
    out
}

/// Installs WinUSB for every bootloader QMK knows, and the AT32 one, with QMK's own driver
/// installer (Windows asks for permission). `from`: a folder with `qmk_driver_installer.exe` and
/// QMK's `drivers.txt` (QMK MSYS's, or the app's flash tools).
pub fn install_drivers(ctx: &JobCtx, paths: &Paths, from: &Path) -> Result<String, String> {
    // QMK's installer reads this list; without it only the AT32 line would be installed, and the
    // app would report success while every other bootloader is left without a driver.
    let list_path = from.join("drivers.txt");
    let qmk_list = std::fs::read_to_string(&list_path).map_err(|e| format!("{} could not be read ({e}).", list_path.display()))?;
    std::fs::create_dir_all(&paths.qmk).map_err(|e| e.to_string())?;
    std::fs::write(paths.drivers_file(), drivers_list(&qmk_list)).map_err(|e| e.to_string())?;
    let installer = from.join("qmk_driver_installer.exe");
    if !installer.exists() {
        return Err(format!("{} is missing.", installer.display()));
    }
    ctx.step("Installing the bootloader drivers (Windows asks for permission)", None);
    let args = format!("--all --force {}", elevate::param(&paths.drivers_file().display().to_string())?);
    let code = elevate::run_elevated(&installer, &args)?;
    if code != 0 {
        return Err(format!("The driver installer stopped with code {code}."));
    }
    let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(paths.drivers_marker(), when.to_string());
    Ok("Bootloader drivers installed.".into())
}

// ------------------------------------------------------------------ update checks, cached

/// GitHub's answers, kept a while: its API allows 60 requests an hour without an account.
#[derive(Default)]
pub struct UpdateCache {
    at: Option<Instant>,
    pub toolchain: Option<String>,
    pub source: Option<(String, String)>,
    pub error: Option<String>,
}

const CACHE_FOR: Duration = Duration::from_secs(30 * 60);

pub fn check_updates(cache: &Mutex<UpdateCache>, force: bool) {
    {
        let c = cache.lock().unwrap_or_else(|p| p.into_inner());
        if !force && c.at.is_some_and(|t| t.elapsed() < CACHE_FOR) {
            return;
        }
    }
    let toolchain = latest_toolchain();
    let source = latest_source();
    let mut c = cache.lock().unwrap_or_else(|p| p.into_inner());
    c.at = Some(Instant::now());
    c.error = toolchain.as_ref().err().or(source.as_ref().err()).cloned();
    if let Ok(t) = toolchain {
        c.toolchain = Some(t);
    }
    if let Ok(s) = source {
        c.source = Some(s);
    }
}

// ------------------------------------------------------------------ Windows specifics

mod registry {
    /// QMK MSYS's install folder and version, as its installer registered them.
    #[cfg(windows)]
    pub fn msys_install() -> Option<(String, String)> {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::ERROR_SUCCESS;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
        fn get(root: HKEY, key: &str, value: &str) -> Option<String> {
            let mut buf = [0u16; 520];
            let mut len = (buf.len() * 2) as u32;
            // SAFETY: `buf` is a writable buffer of `len` bytes and the key/value are NUL-terminated
            // HSTRINGs; `len` is updated by the call to the bytes actually written.
            let err = unsafe {
                RegGetValueW(
                    root,
                    &HSTRING::from(key),
                    &HSTRING::from(value),
                    RRF_RT_REG_SZ,
                    None,
                    Some(buf.as_mut_ptr().cast()),
                    Some(&mut len),
                )
            };
            (err == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
        }
        let key = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{}", super::MSYS_APP_ID);
        [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER].into_iter().find_map(|root| {
            let loc = get(root, &key, "InstallLocation")?;
            Some((loc, get(root, &key, "DisplayVersion").unwrap_or_default()))
        })
    }

    #[cfg(not(windows))]
    pub fn msys_install() -> Option<(String, String)> {
        None
    }
}

pub mod elevate {
    use std::path::Path;

    /// One value on the command line of a process that will run as administrator. `ShellExecuteExW`
    /// takes a single parameter string, so every value has to be quoted by hand \u{2014} and a value with a
    /// `"` in it would close the quote and hand whatever follows to the installer as extra
    /// parameters. The paths here can come from a setting the webview writes (`fwMsysPath`), so
    /// such a value is refused rather than passed on.
    pub fn param(value: &str) -> Result<String, String> {
        if value.contains('"') || value.chars().any(char::is_control) {
            return Err(format!(
                "\"{value}\" can't be used as a folder: a quotation mark or a control character in a path would change what the installer is told to do."
            ));
        }
        // A trailing backslash inside quotes escapes the closing quote (CommandLineToArgvW).
        let value = value.trim_end_matches('\\');
        Ok(if value.contains(' ') { format!("\"{value}\"") } else { value.to_string() })
    }

    /// Runs a program as administrator (Windows shows its permission prompt) and waits for it.
    #[cfg(windows)]
    pub fn run_elevated(exe: &Path, args: &str) -> Result<i32, String> {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED};
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
        let verb = HSTRING::from("runas");
        let file = HSTRING::from(exe.as_os_str());
        let params = HSTRING::from(args);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        // SAFETY: `info` is a fully initialised SHELLEXECUTEINFOW with its `cbSize` set; the
        // HSTRINGs it points at outlive the call, and the returned process handle is closed here.
        unsafe {
            if let Err(e) = ShellExecuteExW(&mut info) {
                if e.code() == ERROR_CANCELLED.to_hresult() {
                    return Err("Windows asked for permission and it was refused.".into());
                }
                return Err(format!("Could not start {}: {e}", exe.display()));
            }
            if info.hProcess.is_invalid() {
                return Ok(0);
            }
            WaitForSingleObject(info.hProcess, INFINITE);
            let mut code = 0u32;
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            Ok(code as i32)
        }
    }

    #[cfg(not(windows))]
    pub fn run_elevated(exe: &Path, _args: &str) -> Result<i32, String> {
        Err(format!("{} can only be installed on Windows.", exe.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevated_parameters_cannot_smuggle_in_extra_ones() {
        assert_eq!(elevate::param(r"C:\qmk").unwrap(), r"C:\qmk");
        assert_eq!(elevate::param(r"C:\Program Files\qmk").unwrap(), "\"C:\\Program Files\\qmk\"");
        assert_eq!(elevate::param(r"C:\qmk\").unwrap(), r"C:\qmk", "a trailing backslash would escape the closing quote");
        assert!(elevate::param(r#"C:\x" /TASKS=all /DIR="C:\Windows"#).is_err(), "a quote is refused, not passed on");
        assert!(elevate::param("C:\\x\u{0}y").is_err());
    }

    #[test]
    fn folders_with_a_space_get_their_short_name() {
        let plain = std::env::temp_dir().join("v6ps_nospace");
        assert_eq!(without_spaces(&plain), plain);
        let spaced = std::env::temp_dir().join(format!("v6ps space {}", std::process::id())).join("qmk");
        let short = without_spaces(&spaced);
        assert!(spaced.is_dir(), "created");
        if short != spaced {
            // Short names on (Windows' default on the system drive): the same folder, no space.
            assert!(!short.to_string_lossy().contains(' '), "{}", short.display());
            assert!(short.is_dir());
            std::fs::write(short.join("probe"), "x").unwrap();
            assert!(spaced.join("probe").exists());
        }
        std::fs::remove_dir_all(spaced.parent().unwrap()).unwrap();
    }

    #[test]
    fn paths_for_msys() {
        assert_eq!(posix(Path::new("C:\\Users\\x\\AppData\\Local\\app\\qmk")), "/c/Users/x/AppData/Local/app/qmk");
        assert_eq!(posix(Path::new("D:/Games")), "/d/Games");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn versions() {
        assert!(version_less("1.9.0", "1.12.0"));
        assert!(!version_less("1.12.0", "1.12.0"));
        assert!(version_less("v1.2", "1.2.1"));
        let m = Msys { root: "C:\\QMK_MSYS".into(), version: Some("1.11.0".into()), managed: false };
        assert_eq!(toolchain_status(Some(&m), Some("1.12.0")).state, CheckState::Outdated);
        assert_eq!(toolchain_status(Some(&m), None).state, CheckState::Ok, "can't tell: fine");
        assert_eq!(toolchain_status(None, Some("1.12.0")).state, CheckState::Missing);
    }

    #[test]
    fn reads_git_heads() {
        let dir = std::env::temp_dir().join(format!("v6ps-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git/refs/heads")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/2025q3\n").unwrap();
        std::fs::write(dir.join(".git/packed-refs"), "# pack\nabc123 refs/heads/2025q3\n").unwrap();
        assert_eq!(git_head(&dir), Some(("2025q3".into(), "abc123".into())));
        std::fs::write(dir.join(".git/refs/heads/2025q3"), "def456\n").unwrap();
        assert_eq!(git_head(&dir), Some(("2025q3".into(), "def456".into())), "a loose ref wins");

        let latest = ("2025q3".to_string(), "def456".to_string());
        assert_eq!(source_status(&dir, true, Some(&latest)).state, CheckState::Missing, "no Makefile: not usable");
        std::fs::write(dir.join("Makefile"), "").unwrap();
        std::fs::create_dir_all(dir.join("keyboards/keychron")).unwrap();
        std::fs::create_dir_all(dir.join("lib/chibios/os")).unwrap();
        assert_eq!(source_status(&dir, true, Some(&latest)).state, CheckState::Ok);
        let newer = ("2025q3".to_string(), "fff".to_string());
        assert_eq!(source_status(&dir, true, Some(&newer)).state, CheckState::Outdated);
        let moved = ("2026q1".to_string(), "def456".to_string());
        assert_eq!(source_status(&dir, true, Some(&moved)).state, CheckState::Outdated, "Keychron moved to a new branch");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn driver_list_gets_the_at32_bootloader() {
        let qmk = "# comment\nwinusb,STM32 Bootloader,0483,DF11,6d98a87f-4ecf-464d-89ed-8c684d857a75\n";
        let out = drivers_list(qmk);
        assert!(out.contains("0483,DF11") && out.contains("2E3C,DF11"));
        assert_eq!(drivers_list(&out).matches("2E3C,DF11").count(), 1, "only once");
        let paths = Paths { qmk: std::env::temp_dir().join("v6ps-none"), projects: std::env::temp_dir() };
        assert_eq!(driver_status(&paths, Some(Some("WinUSB"))).state, DriverState::Ok);
        assert_eq!(driver_status(&paths, Some(None)).state, DriverState::Missing);
        assert_eq!(driver_status(&paths, None).state, DriverState::Unknown);
    }

    #[test]
    fn source_script_is_sparse_and_shallow() {
        let s = source_script(Path::new("C:\\data\\qmk\\qmk_firmware"), "2025q3");
        assert!(s.contains("D='/c/data/qmk/qmk_firmware'; B='2025q3'"));
        assert!(s.contains("--depth 1 --filter=blob:none --sparse"));
        assert!(s.contains("git sparse-checkout set $DIRS keyboards/keychron"));
        assert!(s.contains("lib/chibios lib/chibios-contrib lib/lufa lib/printf"));
    }

    #[cfg(windows)]
    #[test]
    fn finds_the_installed_msys() {
        let paths = Paths { qmk: std::env::temp_dir().join("v6ps-no-msys"), projects: std::env::temp_dir() };
        if let Some(m) = find_msys(&paths, None) {
            assert!(!m.managed);
            let out = m.command("command -v make arm-none-eabi-gcc git; echo \"SHELL=$SHELL\"", Path::new("C:\\")).output().unwrap();
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(text.contains("/usr/bin/make") && text.contains("arm-none-eabi-gcc"), "{text}");
            assert!(text.contains("SHELL=/usr/bin/bash"), "the qmk CLI needs $SHELL: {text}");
        }
    }
}
