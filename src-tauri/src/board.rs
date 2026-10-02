//! Every Keychron keyboard the app knows: `src/data/boards/index.json`, generated from Keychron's
//! firmware by `scripts/generate_from_qmk.py` (one entry per VIA definition: each ANSI/ISO/JIS,
//! knob and RGB/white variant has its own USB product id). Embedded at build time.

use crate::protocol::Matrix;
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    /// e.g. "v6_8k_iso_encoder" (the UI loads `src/data/boards/<id>.json`).
    pub id: String,
    /// e.g. "Keychron V6 8K ISO Knob".
    pub name: String,
    pub vid: u16,
    pub pid: u16,
    pub rows: u8,
    pub cols: u8,
    pub encoders: u8,
    /// QMK keyboard path, e.g. "keychron/v6_8k/iso_encoder".
    pub firmware: Option<String>,
    /// "rgb", "white" (LED matrix) or "none".
    pub lighting: String,
    /// Keychron's Mix RGB and Per Key RGB effects.
    pub mix: bool,
    /// QMK's bootloader name ("stm32-dfu", "wb32-dfu", "at32-dfu"…): how the firmware is flashed.
    #[serde(default)]
    pub bootloader: Option<String>,
    /// The default layer (Keychron's Win base), used when the keyboard can't say which layer it is
    /// on (non-Keychron firmware). 0 when the board data doesn't say.
    #[serde(default)]
    pub default_layer: u8,
}

impl Board {
    pub fn matrix(&self) -> Matrix {
        Matrix { rows: self.rows, cols: self.cols, encoders: self.encoders }
    }

    /// RGB matrix lighting (VIA channel 3, Keychron's 0xA8).
    pub fn rgb(&self) -> bool {
        self.lighting == "rgb"
    }

    /// A white backlight (LED matrix, VIA channel 5): effects, brightness, speed, and per-key
    /// brightness with the module.
    pub fn white(&self) -> bool {
        self.lighting == "white"
    }

    /// "V6 8K ISO Knob", for messages.
    pub fn short_name(&self) -> &str {
        self.name.strip_prefix("Keychron ").unwrap_or(&self.name)
    }
}

static BOARDS: LazyLock<Vec<Board>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../src/data/boards/index.json")).expect("the boards index is valid JSON"));

#[cfg(test)]
pub fn all() -> &'static [Board] {
    &BOARDS
}

pub fn by_usb(vid: u16, pid: u16) -> Option<&'static Board> {
    BOARDS.iter().find(|b| b.vid == vid && b.pid == pid)
}

pub fn by_id(id: &str) -> Option<&'static Board> {
    BOARDS.iter().find(|b| b.id == id)
}

/// The first board built from a QMK keyboard path (two variants can share one folder).
pub fn by_firmware(path: &str) -> Option<&'static Board> {
    BOARDS.iter().find(|b| b.firmware.as_deref() == Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_every_keychron_keyboard() {
        assert!(all().len() > 250);
        let v6 = by_usb(0x3434, 0x0F61).expect("the V6 8K ISO knob");
        assert_eq!((v6.id.as_str(), v6.rows, v6.cols, v6.encoders), ("v6_8k_iso_encoder", 6, 21, 1));
        assert_eq!(v6.short_name(), "V6 8K ISO Knob");
        assert!(v6.rgb() && v6.mix);
        assert_eq!(by_id("v6_8k_iso_encoder"), Some(v6));
        assert!(all().iter().all(|b| b.vid == 0x3434 && b.rows > 0 && b.cols > 0 && b.cols <= 24), "the Mix LED query fits 24 columns");
        let mut ids: Vec<_> = all().iter().map(|b| (b.vid, b.pid)).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), all().len(), "one board per USB id");
        assert_eq!(v6.bootloader.as_deref(), Some("at32-dfu"));
        assert!(all().iter().filter(|b| b.white()).count() > 40, "white backlights");
        assert!(all().iter().all(|b| b.bootloader.is_some()));
    }
}
