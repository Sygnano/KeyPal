//! Backups of the firmware on a keyboard: read through its bootloader (the same tools that write
//! it, `quick::Method::backup_commands`) before the app writes something else, or on their own, and
//! written back through the one guarded flash path (`quick::flash_bin`).
//!
//! Each backup is two files in `Paths::backups`: `<id>.bin`, the chip's flash from `0x08000000`,
//! and `<id>.json`, what it is (`Backup`). The id is `<board id>-<seconds since 1970>`.

use super::http;
use super::jobs::JobCtx;
use super::quick::{self, Method};
use super::tools::Paths;
use crate::board::Board;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    /// The keyboard it was read from (a `board.rs` id): it is only written back to that model.
    pub board: String,
    /// The keyboard's name then, for the list (the board data may move on).
    pub name: String,
    /// Seconds since 1970.
    pub at: u64,
    pub size: u64,
    pub sha256: String,
}

/// Every backup there is, newest first. One whose firmware file is missing or doesn't match its
/// record is left out (it can't be written back).
pub fn list(paths: &Paths) -> Vec<Backup> {
    let Ok(dir) = std::fs::read_dir(paths.backups()) else { return vec![] };
    let mut all: Vec<Backup> = dir
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str::<Backup>(&std::fs::read_to_string(e.path()).ok()?).ok())
        .filter(|b| valid_id(&b.id) && std::fs::metadata(bin_path(paths, &b.id)).is_ok_and(|m| m.len() == b.size))
        .collect();
    all.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
    all
}

/// A backup and its firmware file, checked against its hash.
pub fn get(paths: &Paths, id: &str) -> Result<(Backup, PathBuf), String> {
    if !valid_id(id) {
        return Err(format!("{id:?} isn't a backup."));
    }
    let record = std::fs::read_to_string(json_path(paths, id)).map_err(|_| "That backup is gone.".to_string())?;
    let backup: Backup = serde_json::from_str(&record).map_err(|e| format!("That backup's record is damaged ({e})."))?;
    let bin = bin_path(paths, id);
    let bytes = std::fs::read(&bin).map_err(|_| "That backup's firmware file is gone.".to_string())?;
    if http::hex(&Sha256::digest(&bytes)) != backup.sha256 {
        return Err("That backup's firmware file has changed since it was made: the app won't write it.".into());
    }
    Ok((backup, bin))
}

pub fn delete(paths: &Paths, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("{id:?} isn't a backup."));
    }
    let _ = std::fs::remove_file(bin_path(paths, id));
    std::fs::remove_file(json_path(paths, id)).map_err(|e| format!("Couldn't delete the backup: {e}"))
}

/// Reads the firmware of `board`, which is in its bootloader now, into a new backup. `leave`: send
/// the keyboard back to its firmware afterwards (a backup on its own, not before a flash).
pub fn read(ctx: &JobCtx, paths: &Paths, board: &Board, method: Method, tools: &Path, leave: bool) -> Result<Backup, String> {
    ctx.step("Backing up the firmware on the keyboard", None);
    let dir = paths.backups();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the backups folder {}: {e}", dir.display()))?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let id = format!("{}-{at}", board.id);
    // The tools write their own file; it becomes the backup only once it has been checked.
    let part = dir.join(format!("{id}.part"));
    // dfu-util won't write over a file.
    let _ = std::fs::remove_file(&part);
    let result = (|| {
        for cmd in method.backup_commands(tools, &part, leave) {
            ctx.log(format!(
                "$ {} {}",
                cmd.get_program().to_string_lossy(),
                cmd.get_args().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ")
            ));
            let code = ctx.run(cmd)?;
            if code != 0 {
                return Err(format!("Reading the firmware stopped with code {code}."));
            }
        }
        let bytes = std::fs::read(&part).map_err(|_| "The tool said it read the firmware, but wrote no file.".to_string())?;
        check_image(&bytes)?;
        Ok(bytes)
    })();
    let bytes = match result {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Couldn't back up the firmware: {e}"));
        }
    };
    let backup = Backup {
        id: id.clone(),
        board: board.id.clone(),
        name: board.name.clone(),
        at,
        size: bytes.len() as u64,
        sha256: http::hex(&Sha256::digest(&bytes)),
    };
    let record = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    std::fs::rename(&part, bin_path(paths, &id))
        .and_then(|_| std::fs::write(json_path(paths, &id), record))
        .map_err(|e| format!("Couldn't keep the backup in {}: {e}", dir.display()))?;
    ctx.log(format!("Backed up {} KB of firmware: {}", backup.size / 1024, bin_path(paths, &id).display()));
    Ok(backup)
}

/// A backup on its own: waits for the bootloader like a flash, reads, and sends the keyboard back
/// to its firmware. Nothing is written to the keyboard.
pub fn back_up(ctx: &JobCtx, paths: &Paths, board: &Board, chosen: Option<&str>) -> Result<String, String> {
    let method = quick::method_for(board)?;
    let before = quick::Bus::now(method);
    let (tools, _device) = quick::reach_bootloader(ctx, paths, board, method, &before, chosen)?;
    let backup = read(ctx, paths, board, method, &tools, true)?;
    Ok(format!(
        "The {}'s firmware is backed up ({} KB). It is restarting with it; if it doesn't, unplug it and plug it back in.",
        board.short_name(),
        backup.size / 1024
    ))
}

/// Writes a backup back to the keyboard it came from, through the same checks as any flash (that
/// model must be plugged in, or its bootloader picked). `backup`: back up what is on it now first.
pub fn restore(ctx: &JobCtx, paths: &Paths, id: &str, chosen: Option<&str>, backup: bool) -> Result<String, String> {
    let (record, bin) = get(paths, id)?;
    let board =
        crate::board::by_id(&record.board).ok_or(format!("This backup is of a keyboard the app no longer knows ({}).", record.board))?;
    ctx.log(format!("Restoring the backup of {} KB made {}.", record.size / 1024, record.id));
    quick::flash_bin(ctx, paths, board, &bin, &quick::FlashOptions { chosen, backup, source: "backup", release: None })
}

/// Whether `bytes` looks like the start of an ARM Cortex-M firmware: a vector table whose first
/// word is the initial stack pointer (in SRAM) and whose second is the reset handler (a Thumb
/// address in flash). A read-protected chip that answers with zeros or 0xFF, or a short read,
/// fails this rather than becoming a backup that would write nothing useful back.
pub fn check_image(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 4096 {
        return Err(format!("only {} bytes came back.", bytes.len()));
    }
    let word = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let (sp, reset) = (word(0), word(4));
    if bytes.iter().all(|&b| b == bytes[0]) {
        return Err("the chip reads as blank. It may be read-protected.".into());
    }
    if !(0x2000_0000..=0x2010_0000).contains(&sp) || !(0x0800_0000..0x0810_0000).contains(&reset) || reset & 1 == 0 {
        return Err("what came back isn't firmware the app recognises. The chip may be read-protected.".into());
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn bin_path(paths: &Paths, id: &str) -> PathBuf {
    paths.backups().join(format!("{id}.bin"))
}

fn json_path(paths: &Paths, id: &str) -> PathBuf {
    paths.backups().join(format!("{id}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image() -> Vec<u8> {
        let mut b = vec![0xFF; 64 * 1024];
        b[0..4].copy_from_slice(&0x2000_8000u32.to_le_bytes());
        b[4..8].copy_from_slice(&0x0800_0131u32.to_le_bytes());
        b[8..12].copy_from_slice(&[1, 2, 3, 4]);
        b
    }

    #[test]
    fn only_firmware_becomes_a_backup() {
        assert!(check_image(&image()).is_ok());
        assert!(check_image(&image()[..1024]).is_err(), "short read");
        assert!(check_image(&vec![0xFF; 64 * 1024]).is_err(), "erased or protected");
        assert!(check_image(&vec![0; 64 * 1024]).is_err(), "protected, read as zeros");
        let mut even = image();
        even[4..8].copy_from_slice(&0x0800_0130u32.to_le_bytes());
        assert!(check_image(&even).is_err(), "a reset handler is a Thumb address");
        let mut sp = image();
        sp[0..4].copy_from_slice(&0x0800_0000u32.to_le_bytes());
        assert!(check_image(&sp).is_err(), "the stack is in SRAM");
    }

    #[test]
    fn reading_commands() {
        let t = Path::new("T");
        let args = |c: &std::process::Command| c.get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>();
        let at32 = Method::for_bootloader("at32-dfu").unwrap();
        // No length: dfu-util reads the whole flash the bootloader describes, EEPROM included.
        assert_eq!(args(&at32.backup_commands(t, Path::new("b"), false)[0]), ["-d", "2E3C:DF11", "-a", "0", "-s", "0x08000000", "-U", "b"]);
        assert_eq!(args(&at32.backup_commands(t, Path::new("b"), true)[0])[5], "0x08000000:leave");
        let wb = Method::for_bootloader("wb32-dfu").unwrap();
        let cmds = wb.backup_commands(t, Path::new("b"), false);
        assert_eq!(cmds.len(), 1, "stays in the bootloader for the flash");
        assert_eq!(args(&cmds[0]), ["-Z", "98304", "-U", "b"]);
        assert_eq!(wb.backup_commands(t, Path::new("b"), true).len(), 2, "read, then reset");
        // Never the WB32 tool's toolbox mode: it removes read protection by erasing the chip.
        for b in crate::board::all() {
            let m = quick::method_for(b).unwrap();
            for leave in [false, true] {
                for c in m.backup_commands(t, Path::new("b"), leave) {
                    let a = args(&c);
                    assert!(
                        !a.iter().any(|x| x == "-t" || x == "-D" || x.contains("unprotect") || x.contains("mass-erase")),
                        "{}: {a:?}",
                        b.id
                    );
                }
            }
        }
    }

    #[test]
    fn kept_listed_checked_deleted() {
        let dir = std::env::temp_dir().join(format!("v6ps_backup_{}", std::process::id()));
        let paths = Paths { qmk: dir.join("qmk"), projects: dir.join("firmware") };
        assert!(list(&paths).is_empty());
        std::fs::create_dir_all(paths.backups()).unwrap();
        let bytes = image();
        for (id, at) in [("v6_8k_iso_encoder-100", 100), ("v6_8k_iso_encoder-200", 200)] {
            std::fs::write(bin_path(&paths, id), &bytes).unwrap();
            let b = Backup {
                id: id.into(),
                board: "v6_8k_iso_encoder".into(),
                name: "Keychron V6 8K ISO".into(),
                at,
                size: bytes.len() as u64,
                sha256: http::hex(&Sha256::digest(&bytes)),
            };
            std::fs::write(json_path(&paths, id), serde_json::to_string(&b).unwrap()).unwrap();
        }
        let all = list(&paths);
        assert_eq!(all.iter().map(|b| b.at).collect::<Vec<_>>(), [200, 100], "newest first");
        assert!(get(&paths, "v6_8k_iso_encoder-200").is_ok());
        assert!(get(&paths, "../settings").is_err(), "ids are names, not paths");
        // A firmware file that changed is not written back.
        std::fs::write(bin_path(&paths, "v6_8k_iso_encoder-200"), [0u8; 10]).unwrap();
        assert!(get(&paths, "v6_8k_iso_encoder-200").is_err());
        assert_eq!(list(&paths).len(), 1, "and isn't listed");
        delete(&paths, "v6_8k_iso_encoder-100").unwrap();
        delete(&paths, "v6_8k_iso_encoder-200").unwrap();
        assert!(list(&paths).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
