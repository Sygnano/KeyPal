//! `profiles.json`, `settings.json` and `base_keymap.json` in the app config dir, written
//! atomically. Also exported profile files.

use crate::model::{AppConfig, BaseKeymap, KeymapSource, Profile, Settings};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const PROFILES: &str = "profiles.json";
const SETTINGS: &str = "settings.json";
const BASE_KEYMAP: &str = "base_keymap.json";

/// What an exported file says it is.
const EXPORT_FORMAT: &str = "kboard-companion/profiles";
/// Files exported under the app's earlier names (KeyPal, Keychron Companion App, V6 Profile Switcher).
const OLD_EXPORT_FORMATS: &[&str] = &["keypal/profiles", "keychron-companion/profiles", "v6-profile-switcher/profiles"];
/// The board the key ids refer to, when the app doesn't know which (older files say
/// "keychron/v6_8k/iso_encoder"). Import doesn't check it: keys another keyboard lacks are skipped
/// when sending.
pub const EXPORT_KEYBOARD: &str = "unknown";

/// An exported set of profiles (one, or all of them as a backup).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileFile {
    format: String,
    version: u32,
    keyboard: String,
    profiles: Vec<Profile>,
}

/// The files an import accepts: an export, a copy of `profiles.json`, or a single profile.
#[derive(Deserialize)]
#[serde(untagged)]
enum Importable {
    Export(ProfileFile),
    Config(AppConfig),
    One(Box<Profile>),
}

pub struct Storage {
    dir: PathBuf,
    /// A corrupt `profiles.json` could not be moved out of the way, so it is still sitting where
    /// the next save would destroy it. Saving is refused until the app is restarted.
    unquarantined: AtomicBool,
}

impl Storage {
    pub fn new(dir: PathBuf) -> Self {
        Storage { dir, unquarantined: AtomicBool::new(false) }
    }

    /// Settings of this PC. A missing or unreadable file gives the defaults.
    pub fn load_settings(&self) -> Settings {
        match read_json::<Settings>(&self.dir.join(SETTINGS)) {
            Ok(s) => s.unwrap_or_default(),
            Err(e) => {
                log::warn!("settings.json could not be read ({e}); using the defaults");
                Settings::default()
            }
        }
    }

    pub fn save_settings(&self, s: &Settings) -> Result<(), String> {
        write_json_atomic(&self.dir.join(SETTINGS), s)
    }

    /// A missing file gives the default config. A corrupt one is kept aside as
    /// `profiles.json.<when>.bad` (so the next save can't destroy it, and so a second corruption
    /// doesn't destroy the first copy) and the default config is used. If it can't be moved —
    /// antivirus, an indexer, a read-only folder — saving is refused rather than silently
    /// overwriting whatever the user still has.
    pub fn load_config(&self) -> (AppConfig, Option<String>) {
        match read_json::<AppConfig>(&self.dir.join(PROFILES)) {
            Ok(Some(cfg)) => (cfg.normalize(), None),
            Ok(None) => (AppConfig::default(), None),
            Err(e) => {
                let path = self.dir.join(PROFILES);
                let bad = self.dir.join(format!("{PROFILES}.{}.bad", file_stamp()));
                let note = match fs::rename(&path, &bad) {
                    Ok(()) => {
                        log::warn!("profiles.json could not be read ({e}); kept as {}", bad.display());
                        format!(
                            "profiles.json could not be read ({e}). It was kept as {}, and the app started with the default profile.",
                            bad.file_name().unwrap_or_default().to_string_lossy()
                        )
                    }
                    Err(move_err) => {
                        self.unquarantined.store(true, Ordering::Relaxed);
                        log::error!("profiles.json could not be read ({e}) and could not be moved aside ({move_err})");
                        format!(
                            "profiles.json could not be read ({e}), and the app could not move it out of the way ({move_err}). Nothing will be saved until you move or delete it yourself, so that the file you have is not lost. It is in the settings folder (Settings → open the settings folder)."
                        )
                    }
                };
                (AppConfig::default(), Some(note))
            }
        }
    }

    pub fn save_config(&self, cfg: &AppConfig) -> Result<(), String> {
        if self.unquarantined.load(Ordering::Relaxed) {
            return Err(
                "The app won't save over profiles.json: it couldn't be read and couldn't be moved aside, so saving would destroy it. Move or delete it in the settings folder, then restart the app."
                    .into(),
            );
        }
        write_json_atomic(&self.dir.join(PROFILES), cfg)
    }

    /// The last keymap read from the keyboard, marked as coming from the cache.
    pub fn load_base_keymap(&self) -> Option<BaseKeymap> {
        let mut b: BaseKeymap = read_json(&self.dir.join(BASE_KEYMAP)).ok()??;
        b.source = KeymapSource::Cache;
        Some(b)
    }

    pub fn save_base_keymap(&self, b: &BaseKeymap) -> Result<(), String> {
        write_json_atomic(&self.dir.join(BASE_KEYMAP), b)
    }
}

/// Write profiles to a file the user picked.
pub fn export_profiles(path: &Path, profiles: &[Profile], keyboard: &str) -> Result<(), String> {
    let file = ProfileFile {
        format: EXPORT_FORMAT.into(),
        version: crate::model::CONFIG_VERSION,
        keyboard: keyboard.into(),
        profiles: profiles.to_vec(),
    };
    write_json_atomic(path, &file)
}

/// Profiles from a file the user picked, brought up to date. Ids and names are the file's; the
/// UI gives them fresh ids before adding them.
pub fn import_profiles(path: &Path) -> Result<Vec<Profile>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let parsed: Importable =
        serde_json::from_slice(&bytes).map_err(|_| format!("{} is not a profile file from this app.", path.display()))?;
    let mut profiles = match parsed {
        Importable::Export(f) if f.format == EXPORT_FORMAT || OLD_EXPORT_FORMATS.contains(&f.format.as_str()) => f.profiles,
        Importable::Export(_) => return Err(format!("{} is not a profile file from this app.", path.display())),
        Importable::Config(c) => c.profiles,
        Importable::One(p) => vec![*p],
    };
    if profiles.is_empty() {
        return Err("That file has no profiles in it.".into());
    }
    for p in &mut profiles {
        p.migrate();
        // The gap's value doesn't change the size: any one checks the profile fits.
        crate::protocol::build_keymap(p, crate::protocol::DEFAULT_MACRO_GAP)?;
    }
    Ok(profiles)
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Seconds since the epoch, for a file name that doesn't collide with the last one.
fn file_stamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Write to a temporary file next to the target, flush it to disk, then rename it over the target,
/// so a crash never leaves a half-written file. The temporary name is unique per write: two saves
/// of the same file at once used to share one `<name>.json.tmp` and could tear.
pub(crate) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().ok_or("bad path")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let tmp = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not write {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DEFAULT_PROFILE_ID;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("v6ps-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn config_round_trip_and_missing_file() {
        let dir = temp_dir("cfg");
        let s = Storage::new(dir.clone());
        let (cfg, err) = s.load_config();
        assert!(err.is_none());
        assert_eq!(cfg, AppConfig::default());

        let mut cfg = cfg;
        cfg.profiles[0].programs.push(crate::model::ProgramRule::by_name("C:\\x.exe"));
        s.save_config(&cfg).unwrap();
        assert!(!dir.join("profiles.json.tmp").exists());
        assert_eq!(s.load_config().0, cfg);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_config_is_set_aside() {
        let dir = temp_dir("bad");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("profiles.json"), b"{ not json").unwrap();
        let (cfg, err) = Storage::new(dir.clone()).load_config();
        assert!(err.is_some());
        assert_eq!(cfg.profiles[0].id, DEFAULT_PROFILE_ID);
        let bad: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("profiles.json.") && n.ends_with(".bad"))
            .collect();
        assert_eq!(bad.len(), 1, "the corrupt file was kept: {bad:?}");
        assert!(!dir.join("profiles.json").exists());
        // A second corruption doesn't destroy the first copy.
        fs::write(dir.join("profiles.json"), b"{ also not json").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100)); // the name carries a second-resolution stamp
        assert!(Storage::new(dir.clone()).load_config().1.is_some());
        let bad = fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".bad")).count();
        assert_eq!(bad, 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_corrupt_file_that_cannot_be_moved_blocks_saving() {
        // Nothing may overwrite a file the app could not read *and* could not set aside.
        let dir = temp_dir("stuck");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("profiles.json"), b"{ not json").unwrap();
        let s = Storage::new(dir.clone());
        s.unquarantined.store(true, Ordering::Relaxed);
        let err = s.save_config(&AppConfig::default()).unwrap_err();
        assert!(err.contains("won't save"), "{err}");
        assert_eq!(fs::read(dir.join("profiles.json")).unwrap(), b"{ not json");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn version_1_files_get_programs() {
        let dir = temp_dir("v1");
        fs::create_dir_all(&dir).unwrap();
        let v1 = r#"{"version":1,"profiles":[{"id":"default","name":"Default","exes":[],"binds":{},"lighting":null},
            {"id":"p","name":"CS2","exes":["C:\\Games\\cs2.exe"],"binds":{},"lighting":null}]}"#;
        fs::write(dir.join("profiles.json"), v1).unwrap();
        let s = Storage::new(dir.clone());
        let (cfg, err) = s.load_config();
        assert!(err.is_none());
        assert_eq!(cfg.version, 2);
        assert_eq!(cfg.profiles[1].programs, vec![crate::model::ProgramRule::by_name("C:\\Games\\cs2.exe")]);
        s.save_config(&cfg).unwrap();
        let text = fs::read_to_string(dir.join("profiles.json")).unwrap();
        assert!(!text.contains("exes"), "the old field isn't written back");
        assert!(text.contains(r#""path": "C:\\Games\\cs2.exe""#));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_default_and_round_trip() {
        let dir = temp_dir("settings");
        let s = Storage::new(dir.clone());
        assert_eq!(s.load_settings(), Settings::default());
        let mine = Settings { key_labels: "0000040C".into(), notify_on_switch: false, ..Settings::default() };
        s.save_settings(&mine).unwrap();
        assert_eq!(s.load_settings(), mine);
        // Fields added later get their default.
        fs::write(dir.join("settings.json"), r#"{"keyLabels":"auto"}"#).unwrap();
        assert!(s.load_settings().close_to_tray);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_then_import() {
        let dir = temp_dir("export");
        fs::create_dir_all(&dir).unwrap();
        let mut p = AppConfig::default().profiles.remove(0);
        p.id = "p_1".into();
        p.name = "CS2".into();
        p.binds.insert("fn:3,1".into(), crate::model::Bind::Key { keycode: 4 });
        let file = dir.join("cs2.v6profile.json");
        export_profiles(&file, std::slice::from_ref(&p), "v6_8k_iso_encoder").unwrap();
        assert_eq!(import_profiles(&file).unwrap(), vec![p.clone()]);
        assert!(fs::read_to_string(&file).unwrap().contains("kboard-companion/profiles"));

        // Exported before the app was renamed.
        let old = fs::read_to_string(&file).unwrap().replace("kboard-companion/profiles", "v6-profile-switcher/profiles");
        fs::write(&file, old).unwrap();
        assert_eq!(import_profiles(&file).unwrap(), vec![p.clone()]);
        let middle = fs::read_to_string(&file).unwrap().replace("v6-profile-switcher/profiles", "keychron-companion/profiles");
        fs::write(&file, middle).unwrap();
        assert_eq!(import_profiles(&file).unwrap(), vec![p.clone()], "exported as Keychron Companion App");
        let keypal = fs::read_to_string(&file).unwrap().replace("keychron-companion/profiles", "keypal/profiles");
        fs::write(&file, keypal).unwrap();
        assert_eq!(import_profiles(&file).unwrap(), vec![p.clone()], "exported as KeyPal");

        // A copy of profiles.json, and a lone profile, are accepted too.
        let cfg = AppConfig { version: 2, profiles: vec![AppConfig::default().profiles.remove(0), p.clone()], macros: vec![] };
        fs::write(&file, serde_json::to_vec(&cfg).unwrap()).unwrap();
        assert_eq!(import_profiles(&file).unwrap().len(), 2);
        fs::write(&file, serde_json::to_vec(&p).unwrap()).unwrap();
        assert_eq!(import_profiles(&file).unwrap(), vec![p]);

        fs::write(&file, b"{\"hello\": 1}").unwrap();
        assert!(import_profiles(&file).is_err());
        fs::write(&file, br#"{"format":"x","version":1,"keyboard":"y","profiles":[]}"#).unwrap();
        assert!(import_profiles(&file).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn base_keymap_comes_back_as_cache() {
        let dir = temp_dir("base");
        let s = Storage::new(dir.clone());
        assert!(s.load_base_keymap().is_none());
        let mut b = BaseKeymap::fallback();
        b.source = KeymapSource::Keyboard;
        b.layers = vec![[("0,0".to_string(), 0x29u16)].into_iter().collect()];
        s.save_base_keymap(&b).unwrap();
        let back = s.load_base_keymap().unwrap();
        assert_eq!(back.source, KeymapSource::Cache);
        assert_eq!(back.layers[0]["0,0"], 0x29);
        fs::remove_dir_all(dir).unwrap();
    }
}
