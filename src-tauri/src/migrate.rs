//! Moving the app's folders when its identifier changes (a rename). The
//! data lives in `%APPDATA%\<identifier>` (profiles, settings, firmware projects) and
//! `%LOCALAPPDATA%\<identifier>` (logs, the downloaded firmware and tools): a new identifier would
//! start empty, so at start-up anything under an older identifier moves over.

use std::path::Path;

/// Identifiers the app had before (newest first). The current one comes from tauri.conf.json.
pub const OLD_IDENTIFIERS: &[&str] = &["fr.sygnano.keypal", "fr.sygnano.keychron-companion", "fr.julien.v6-profile-switcher"];

/// Moves what `old` holds into `new`, entry by entry: what `new` already has stays (e.g. the logs
/// folder the log plugin made a moment ago), the rest is renamed over (same parent, so the same
/// drive: instant, even for the 5 GB of tools). `old` goes when it's left empty. Returns what moved.
pub fn move_folder(old: &Path, new: &Path) -> std::io::Result<Vec<String>> {
    if !old.is_dir() || old == new {
        return Ok(vec![]);
    }
    std::fs::create_dir_all(new)?;
    let mut moved = vec![];
    for entry in std::fs::read_dir(old)? {
        let entry = entry?;
        let target = new.join(entry.file_name());
        if target.exists() {
            continue;
        }
        std::fs::rename(entry.path(), &target)?;
        moved.push(entry.file_name().to_string_lossy().into_owned());
    }
    if std::fs::read_dir(old)?.next().is_none() {
        std::fs::remove_dir(old)?;
    }
    moved.sort();
    Ok(moved)
}

/// Both folders of every older identifier into the current ones. `roaming` / `local`: the current
/// `%APPDATA%\<identifier>` and `%LOCALAPPDATA%\<identifier>`.
pub fn move_old_folders(roaming: &Path, local: &Path) {
    for current in [roaming, local] {
        let (Some(parent), Some(name)) = (current.parent(), current.file_name()) else { continue };
        for old in OLD_IDENTIFIERS.iter().filter(|o| **o != name.to_string_lossy()) {
            match move_folder(&parent.join(old), current) {
                Ok(moved) if !moved.is_empty() => log::info!("moved {} from {old}: {}", current.display(), moved.join(", ")),
                Ok(_) => {}
                Err(e) => log::warn!("could not move the data of {old} to {}: {e}", current.display()),
            }
        }
    }
}

/// Product names the app had before: their "Start with Windows" entry (HKCU Run, named after
/// the product) points at the old program.
pub const OLD_PRODUCT_NAMES: &[&str] = &["KeyPal", "Keychron Companion App", "V6 Profile Switcher"];

/// Whether an older name's "Start with Windows" entry was there; it's removed (the caller then
/// turns autostart on under the current name).
#[cfg(windows)]
pub fn take_old_autostart() -> bool {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE};
    let mut key = HKEY::default();
    let run = HSTRING::from(r"Software\Microsoft\Windows\CurrentVersion\Run");
    // SAFETY: `key` is a valid out-parameter and `run` is a NUL-terminated HSTRING; the handle is
    // closed below.
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &run, Some(0), KEY_SET_VALUE, &mut key) }.is_err() {
        return false;
    }
    let mut found = false;
    for name in OLD_PRODUCT_NAMES {
        // Deleting succeeds only when the value exists.
        // SAFETY: `key` is the open key above and `name` is a NUL-terminated HSTRING.
        if unsafe { RegDeleteValueW(key, &HSTRING::from(*name)) }.is_ok() {
            log::info!("removed the old \"{name}\" start-with-Windows entry");
            found = true;
        }
    }
    // SAFETY: `key` was opened above and is not used afterwards.
    let _ = unsafe { RegCloseKey(key) };
    found
}

#[cfg(not(windows))]
pub fn take_old_autostart() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_identifiers_data_moves_over() {
        let base = std::env::temp_dir().join(format!("v6ps-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (old, new) = (base.join("fr.julien.v6-profile-switcher"), base.join("new.identifier"));
        std::fs::create_dir_all(old.join("firmware/my_v6")).unwrap();
        std::fs::create_dir_all(old.join("logs")).unwrap();
        std::fs::write(old.join("profiles.json"), "{}").unwrap();
        std::fs::write(old.join("logs/v6ps.log"), "old").unwrap();
        // The log plugin already made the new logs folder.
        std::fs::create_dir_all(new.join("logs")).unwrap();

        assert_eq!(move_folder(&old, &new).unwrap(), ["firmware", "profiles.json"]);
        assert_eq!(std::fs::read_to_string(new.join("profiles.json")).unwrap(), "{}");
        assert!(new.join("firmware/my_v6").is_dir());
        assert!(old.join("logs/v6ps.log").exists(), "the new logs folder wins; the old one stays");
        assert_eq!(move_folder(&old, &new).unwrap(), Vec::<String>::new(), "nothing twice");

        std::fs::remove_dir_all(old.join("logs")).unwrap();
        move_folder(&old, &new).unwrap();
        assert!(!old.exists(), "an emptied old folder goes");
        assert_eq!(move_folder(&base.join("missing"), &new).unwrap(), Vec::<String>::new());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_current_identifier_moves_nothing() {
        let base = std::env::temp_dir().join(format!("v6ps-migrate-same-{}", std::process::id()));
        let current = base.join(OLD_IDENTIFIERS[0]);
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("profiles.json"), "{}").unwrap();
        move_old_folders(&current, &current);
        assert!(current.join("profiles.json").exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}
