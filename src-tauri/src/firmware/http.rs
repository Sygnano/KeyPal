//! Downloads for the Firmware tab: GitHub's API (latest versions) and big files (the QMK MSYS
//! installer, ~600 MB) streamed to disk with progress, cancellable, and checked with SHA-256.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::Duration;

const USER_AGENT: &str = concat!("kboard-companion/", env!("CARGO_PKG_VERSION"));

/// One agent for every call, with timeouts. ureq sets none by default, so a stalled connection
/// would block for ever — and Cancel is only checked between reads, so the one job slot would
/// stay taken until the app restarted.
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        // Per read, not for the whole download: a big file may take minutes, but no single read
        // should stall for more than this.
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .build()
        .into()
});

pub fn get_text(url: &str) -> Result<String, String> {
    let mut res = AGENT
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("{url}: {e}"))?;
    res.body_mut().read_to_string().map_err(|e| format!("{url}: {e}"))
}

pub fn get_json(url: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(&get_text(url)?).map_err(|e| format!("{url}: {e}"))
}

/// Streams `url` to `dest` (through `dest.part`, renamed when complete). Calls `progress(done,
/// total)` as it goes. Stops with an error when `cancel` is set. Returns the file's SHA-256 (hex).
pub fn download(url: &str, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<String, String> {
    let res = AGENT.get(url).header("User-Agent", USER_AGENT).call().map_err(|e| format!("{url}: {e}"))?;
    let total = res.body().content_length();
    let mut reader = res.into_body().into_reader();
    let part = dest.with_extension("part");
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut last_report = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err("Cancelled.".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hash.update(&buf[..n]);
        done += n as u64;
        if done - last_report >= 1 << 20 {
            last_report = done;
            progress(done, total);
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    progress(done, total);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(hex(&hash.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The hash in a `.sha256` file ("<hex>  name" or just "<hex>").
pub fn parse_sha256_file(text: &str) -> Option<String> {
    let h = text.split_whitespace().next()?.to_ascii_lowercase();
    (h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).then_some(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_files() {
        let h = "a".repeat(64);
        assert_eq!(parse_sha256_file(&format!("{h}  QMK_MSYS.exe\n")), Some(h.clone()));
        assert_eq!(parse_sha256_file(&h.to_uppercase()), Some(h));
        assert_eq!(parse_sha256_file("not a hash"), None);
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
