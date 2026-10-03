//! Serde mirror of `src/lib/types.ts`. The JSON on disk is exactly this shape, so keep both in sync.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub const DEFAULT_PROFILE_ID: &str = "default";
/// Written to `profiles.json`. Version 1 had `exes` (file names only) instead of `programs`.
pub const CONFIG_VERSION: u32 = 2;

/// "row,col" for matrix keys, "e0:cw" / "e0:ccw" for the knob rotation. In `Profile.binds` they
/// carry their keyboard layer: "L2:3,1", "L3:e0:cw". Files from before layers had no prefix: the
/// keyboard's default layer (`AppConfig::put_binds_on_layers` gives them one).
pub type KeyId = String;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum MacroStep {
    Tap { keycode: u16 },
    Down { keycode: u16 },
    Up { keycode: u16 },
    Delay { ms: u16 },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Bind {
    Key {
        keycode: u16,
    },
    Qmk {
        source: String,
        keycode: u16,
    },
    Macro {
        name: String,
        steps: Vec<MacroStep>,
        /// Ms to wait after each key step (an explicit delay replaces it there). None: the PC's
        /// default (`Settings::macro_gap`). Left out of the JSON when None.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<u16>,
        /// The macro bank entry this key plays (`AppConfig::macros`); the fields above always equal
        /// it. None in files from before the bank (the UI gives them an entry on load).
        #[serde(default, rename = "macroId", skip_serializing_if = "Option::is_none")]
        macro_id: Option<String>,
    },
}

/// A macro in the bank (`AppConfig::macros`): reusable on any key, in any profile.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BankMacro {
    pub id: String,
    pub name: String,
    pub steps: Vec<MacroStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<u16>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hsv {
    pub h: u8,
    pub s: u8,
    pub v: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lighting {
    /// VIA effect id, 0 = off.
    pub effect: u8,
    pub speed: u8,
    pub brightness: u8,
    pub hue: u8,
    pub sat: u8,
    /// Per-key colours drawn over the effect (needs the profile switcher). With effect 0 only
    /// these keys light up. Left out of the JSON when empty. Files saved by the app use `layers`
    /// instead; this is what the keyboard gets (`for_keyboard`), and what older files hold.
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub keys: IndexMap<KeyId, Hsv>,
    /// Colour layers over the effect, bottom to top. Left out of the JSON when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<ColorLayer>,
    /// Keychron's "Mix RGB" effect (24): regions of keys, each playing its own effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix: Option<MixLighting>,
    /// Animation of each per-key colour in `keys` (keys missing here are static). Only filled by
    /// `for_keyboard`, never saved.
    #[serde(skip)]
    pub key_anims: IndexMap<KeyId, KeyAnim>,
}

/// How a colour layer's keys move. Drawn by the firmware module.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Anim {
    #[default]
    Static,
    /// Fades in and out.
    Breathe,
    /// Goes round the colour wheel from its colour.
    Cycle,
    /// Lights up when the key is pressed, then fades out.
    Reactive,
}

impl Anim {
    pub fn wire(self) -> u8 {
        match self {
            Anim::Static => 0,
            Anim::Breathe => 1,
            Anim::Cycle => 2,
            Anim::Reactive => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyAnim {
    pub anim: Anim,
    pub speed: u8,
}

/// One static colour on a set of keys. Where layers overlap, the higher one wins.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorLayer {
    pub id: String,
    pub name: String,
    pub color: Hsv,
    pub keys: Vec<KeyId>,
    /// Kept in the stack but not drawn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "is_default")]
    pub anim: Anim,
    /// Animation speed, 0–255. Left out for static layers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<u8>,
}

/// Keychron's Mix RGB: every key belongs to one region, and each region plays its effects in turn.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MixLighting {
    /// The first region holds every key that isn't in another one (its `keys` are ignored).
    pub regions: Vec<MixRegion>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MixRegion {
    pub keys: Vec<KeyId>,
    pub effects: Vec<MixEffect>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MixEffect {
    pub effect: u8,
    pub hue: u8,
    pub sat: u8,
    pub speed: u8,
    /// How long it plays before the next one, in ms (only matters with several).
    pub time: u32,
}

/// Default animation speed when a layer has none.
pub const DEFAULT_ANIM_SPEED: u8 = 128;

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

impl Lighting {
    /// What the keyboard gets: the layers flattened to one colour per key (the topmost visible
    /// layer holding a key wins), and no layers. Without layers, `keys` is used as it is.
    pub fn for_keyboard(&self) -> Lighting {
        let mut out = self.clone();
        if !self.layers.is_empty() {
            out.keys = IndexMap::new();
            out.key_anims = IndexMap::new();
            for layer in self.layers.iter().rev().filter(|l| !l.hidden) {
                for k in &layer.keys {
                    if out.keys.contains_key(k) {
                        continue;
                    }
                    out.keys.insert(k.clone(), layer.color);
                    if layer.anim != Anim::Static {
                        let speed = layer.speed.unwrap_or(DEFAULT_ANIM_SPEED);
                        out.key_anims.insert(k.clone(), KeyAnim { anim: layer.anim, speed });
                    }
                }
            }
            out.keys.sort_keys();
            out.key_anims.sort_keys();
        }
        out.layers.clear();
        // Only Mix RGB uses the regions: another effect needn't resend them. (The colour layers go
        // over any effect, Mix RGB's regions included: the module paints them after it.)
        if out.effect != MIX_RGB_EFFECT {
            out.mix = None;
        }
        out
    }
}

/// Keychron's "Mix RGB" effect id.
pub const MIX_RGB_EFFECT: u8 = 24;

/// How a profile is picked for the focused program.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProgramMatch {
    /// Any program with this file name, in any folder.
    #[default]
    Name,
    /// Only this exact file.
    Path,
    /// Any program in this folder or below it.
    Folder,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProgramRule {
    /// The program's full path as picked (a folder for `Folder`). Empty: any program, then
    /// `title` must be set.
    pub path: String,
    #[serde(default, rename = "match", skip_serializing_if = "is_default")]
    pub match_by: ProgramMatch,
    /// Only while the focused window's title contains this (case-insensitive).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
}

impl ProgramRule {
    pub fn by_name(path: impl Into<String>) -> Self {
        ProgramRule { path: path.into(), match_by: ProgramMatch::Name, title: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// Programs that turn this profile on (see `engine::select_profile`).
    #[serde(default)]
    pub programs: Vec<ProgramRule>,
    /// Version 1 files: full paths matched by file name. `normalize` turns them into `programs`.
    #[serde(default, skip_serializing)]
    pub exes: Vec<String>,
    /// Insertion order is kept so the file round-trips unchanged.
    pub binds: IndexMap<KeyId, Bind>,
    /// None → default profile: leave the keyboard's lighting alone; custom profile: same as default.
    pub lighting: Option<Lighting>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    /// profiles[0] is always the default profile (id "default").
    pub profiles: Vec<Profile>,
    /// The macro bank, shared by every profile. Left out of the JSON while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub macros: Vec<BankMacro>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            version: CONFIG_VERSION,
            profiles: vec![Profile {
                id: DEFAULT_PROFILE_ID.into(),
                name: "Default".into(),
                programs: vec![],
                exes: vec![],
                binds: IndexMap::new(),
                lighting: None,
            }],
            macros: vec![],
        }
    }
}

impl Profile {
    /// Older files: `exes` (matched by file name) become `programs`.
    pub fn migrate(&mut self) {
        for exe in self.exes.drain(..) {
            if !self.programs.iter().any(|r| r.path.eq_ignore_ascii_case(&exe)) {
                self.programs.push(ProgramRule::by_name(exe));
            }
        }
    }
}

impl AppConfig {
    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    pub fn default_profile(&self) -> &Profile {
        &self.profiles[0]
    }

    /// Structural checks the UI relies on. Macro limits are checked by `protocol::build_keymap`.
    pub fn validate(&self) -> Result<(), String> {
        match self.profiles.first() {
            Some(p) if p.id == DEFAULT_PROFILE_ID => {}
            _ => return Err("The first profile must be the default profile.".into()),
        }
        for (i, p) in self.profiles.iter().enumerate() {
            if p.name.trim().is_empty() {
                return Err("Every profile needs a name.".into());
            }
            if self.profiles[..i].iter().any(|q| q.id == p.id) {
                return Err(format!("Two profiles share the id {:?}.", p.id));
            }
        }
        Ok(())
    }

    /// Remaps saved without a layer (before layers could be chosen) applied on the keyboard's
    /// default layer: they get that layer. Insertion order is kept.
    pub fn put_binds_on_layers(&mut self, default_layer: u8) {
        for p in &mut self.profiles {
            if p.binds.keys().all(|k| crate::protocol::split_layer(k).is_some()) {
                continue;
            }
            p.binds = std::mem::take(&mut p.binds)
                .into_iter()
                .map(|(k, b)| match crate::protocol::split_layer(&k) {
                    Some(_) => (k, b),
                    None => (crate::protocol::layer_key_id(default_layer, &k), b),
                })
                .collect();
        }
    }

    /// Repairs a config read from disk so `validate` holds: puts a default profile first. Also
    /// brings older files up to date.
    pub fn normalize(mut self) -> Self {
        self.version = CONFIG_VERSION;
        self.profiles.iter_mut().for_each(Profile::migrate);
        match self.profiles.iter().position(|p| p.id == DEFAULT_PROFILE_ID) {
            Some(0) => {}
            Some(i) => {
                let def = self.profiles.remove(i);
                self.profiles.insert(0, def);
            }
            None => self.profiles.insert(0, AppConfig::default().profiles.remove(0)),
        }
        let mut seen = std::collections::HashSet::new();
        self.profiles.retain(|p| seen.insert(p.id.clone()));
        for p in &mut self.profiles {
            if p.name.trim().is_empty() {
                p.name = if p.id == DEFAULT_PROFILE_ID { "Default".into() } else { "Profile".into() };
            }
        }
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeymapSource {
    Keyboard,
    Cache,
    Fallback,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaseKeymap {
    pub source: KeymapSource,
    /// The keyboard's default layer (the Mac/Win switch picks it), as it reported.
    pub layer: u8,
    /// Every layer of its keymap, as stored: transparent keys stay `KC_TRNS`. Empty for the
    /// fallback: the frontend uses its built-in Keychron keymap then.
    #[serde(default)]
    pub layers: Vec<IndexMap<KeyId, u16>>,
    /// The keyboard it was read from (a board id, `board.rs`), so a cache isn't shown for another.
    #[serde(default)]
    pub board: Option<String>,
}

impl BaseKeymap {
    pub fn fallback() -> Self {
        BaseKeymap { source: KeymapSource::Fallback, layer: 2, layers: vec![], board: None }
    }
}

/// App settings for this PC (`settings.json`), as opposed to the profiles.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Key legends: "auto" (Windows' layout) or a Windows layout id (KLID).
    pub key_labels: String,
    /// A Windows notification when the active profile changes while the window isn't focused.
    pub notify_on_switch: bool,
    /// Closing the window keeps the app running in the tray (else it quits).
    pub close_to_tray: bool,
    /// Debug-level lines in the log file.
    pub verbose_log: bool,
    /// The user's names for the keyboard's layers ("2" → "Windows"), shown on the layer tabs.
    pub layer_names: std::collections::BTreeMap<String, String>,
    /// Firmware tab: a QMK MSYS install to use instead of the one found (None: find it).
    pub fw_msys_path: Option<String>,
    /// Firmware tab: a qmk_firmware folder to use instead of the app's download (None: the app's).
    pub fw_source_path: Option<String>,
    /// Firmware tab: "basic" (the app's ready-made firmware) or "advanced" (build your own).
    /// None until the user picks one: the app opens on whichever suits what's installed.
    pub fw_mode: Option<String>,
    /// Firmware: read what is on the keyboard into a backup before every flash
    /// (`firmware::backup`).
    #[serde(default = "default_true")]
    pub fw_backup: bool,
    /// "system" (follow Windows), "light" or "dark".
    pub theme: String,
    /// Colours the user saved in the colour picker, to reuse in any profile.
    pub saved_colors: Vec<Hsv>,
    /// The last keyboard plugged in (a `board.rs` id): the UI shows it while none is.
    pub last_board: Option<String>,
    /// The getting-started guide was closed (it opens by itself until then).
    pub guide_seen: bool,
    /// Quietly check for a newer app release a little after start.
    #[serde(default = "default_true")]
    pub check_updates_on_start: bool,
    /// Ms a macro waits after each key step, for macros without a gap of their own.
    pub macro_gap: u16,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            key_labels: "auto".into(),
            notify_on_switch: true,
            close_to_tray: true,
            verbose_log: false,
            layer_names: Default::default(),
            fw_msys_path: None,
            fw_source_path: None,
            fw_mode: None,
            fw_backup: true,
            theme: "system".into(),
            saved_colors: vec![],
            last_board: None,
            guide_seen: false,
            check_updates_on_start: true,
            macro_gap: crate::protocol::DEFAULT_MACRO_GAP,
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Firmware {
    Ok,
    Missing,
    Unknown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Auto,
    Manual,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    pub connected: bool,
    pub firmware: Firmware,
    /// Profile switcher protocol version the keyboard speaks (0: none or not connected).
    pub firmware_version: u8,
    /// Which firmware project the keyboard's build came from (the app stamps it into its builds; 0 when the
    /// firmware is older, was built by hand, or nothing is connected).
    pub build_id: u32,
    /// The keyboard can play Keychron's Mix RGB regions (it answered their `0xA8` command).
    pub mix_rgb: bool,
    /// How many Mix RGB regions the keyboard has (0: none, or not connected).
    pub mix_regions: u8,
    /// The keyboard plugged in (a `board.rs` id), when connected.
    pub board: Option<String>,
    /// A keyboard plugged in whose firmware has no Raw HID (a `board.rs` id): only reflashing helps.
    pub unreachable: Option<String>,
    pub mode: Mode,
    pub active_profile_id: String,
    pub last_error: Option<String>,
}

/// The focused window, sent on its own so a title change (up to four times a second) doesn't
/// re-render every subscriber of `EngineState`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    /// File name of the focused program.
    pub exe: Option<String>,
    pub path: Option<String>,
    pub title: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_frontend_json() {
        let json = r#"{"version":2,"profiles":[
          {"id":"default","name":"Default","programs":[],"binds":{},"lighting":null},
          {"id":"p_1","name":"CS2","programs":[{"path":"C:\\Games\\cs2.exe"}],
           "binds":{
             "3,1":{"kind":"key","keycode":4},
             "0,1":{"kind":"qmk","source":"LT(2, KC_SPC)","keycode":16940},
             "e0:cw":{"kind":"macro","name":"hi","steps":[
               {"op":"tap","keycode":11},{"op":"delay","ms":50},{"op":"down","keycode":225},{"op":"up","keycode":225}]}},
           "lighting":{"effect":1,"speed":128,"brightness":200,"hue":30,"sat":200}}]}"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.profiles[1].binds.keys().collect::<Vec<_>>(), ["3,1", "0,1", "e0:cw"]);
        let back: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        let orig: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(back, orig);
        assert!(cfg.validate().is_ok());
    }

    /// The same file the TypeScript test reads (`tests/fixtures/config.json`): if the two sides
    /// drift, one of them fails. `types.ts` and this file must describe the same JSON.
    #[test]
    fn the_shared_fixture_round_trips() {
        let json = include_str!("../../tests/fixtures/config.json");
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.profiles.len(), 2);
        assert_eq!(cfg.profiles[0].lighting.as_ref().unwrap().layers.len(), 1);
        assert_eq!(cfg.profiles[1].lighting.as_ref().unwrap().mix.as_ref().unwrap().regions.len(), 2);
        assert!(matches!(cfg.profiles[1].binds["e0:cw"], Bind::Macro { gap: Some(25), .. }));
        // The macro bank: a linked macro and an entry no key uses, both kept.
        assert!(matches!(&cfg.profiles[1].binds["e0:cw"], Bind::Macro { macro_id: Some(id), .. } if id == "m_hi"));
        assert_eq!(cfg.macros.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m_hi", "m_unused"]);
        assert_eq!(cfg.macros[0].gap, Some(25));
        assert!(cfg.validate().is_ok());
        // Round-trips byte-for-byte (the fixture is written in the app's own field order).
        let back: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        let orig: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(back, orig);
    }

    #[test]
    fn per_key_colours_round_trip() {
        let json = r#"{"effect":4,"speed":1,"brightness":2,"hue":3,"sat":5,"keys":{"3,1":{"h":0,"s":255,"v":255}}}"#;
        let l: Lighting = serde_json::from_str(json).unwrap();
        assert_eq!(l.keys["3,1"], Hsv { h: 0, s: 255, v: 255 });
        assert_eq!(serde_json::to_value(&l).unwrap(), serde_json::from_str::<serde_json::Value>(json).unwrap());
    }

    #[test]
    fn layers_flatten_topmost_first() {
        let layer = |id: &str, h: u8, keys: &[&str], hidden: bool| ColorLayer {
            id: id.into(),
            name: id.into(),
            color: Hsv { h, s: 255, v: 255 },
            keys: keys.iter().map(|k| k.to_string()).collect(),
            hidden,
            anim: Anim::Static,
            speed: None,
        };
        let json = r#"{"effect":1,"speed":0,"brightness":255,"hue":0,"sat":0,
          "layers":[{"id":"a","name":"White","color":{"h":0,"s":0,"v":255},"keys":["1,1","1,2"]},
                    {"id":"b","name":"Red","color":{"h":0,"s":255,"v":255},"keys":["1,2"],"hidden":true}]}"#;
        let l: Lighting = serde_json::from_str(json).unwrap();
        assert_eq!(serde_json::to_value(&l).unwrap(), serde_json::from_str::<serde_json::Value>(json).unwrap());

        let mut l = Lighting { keys: [("9,9".to_string(), Hsv { h: 1, s: 1, v: 1 })].into_iter().collect(), ..l };
        l.layers =
            vec![layer("white", 0, &["1,1", "1,2", "1,3"], false), layer("red", 5, &["1,2"], false), layer("off", 9, &["1,3"], true)];
        let k = l.for_keyboard();
        assert!(k.layers.is_empty());
        assert_eq!(k.keys.len(), 3, "old per-key colours are replaced by the layers");
        assert_eq!(k.keys["1,1"].h, 0);
        assert_eq!(k.keys["1,2"].h, 5, "the higher layer wins");
        assert_eq!(k.keys["1,3"].h, 0, "a hidden layer isn't drawn");

        l.layers.clear();
        assert_eq!(l.for_keyboard().keys.len(), 1, "no layers: an older file's colours still apply");
    }

    #[test]
    fn normalize_puts_default_first() {
        let mut cfg = AppConfig::default();
        let mut other = cfg.profiles[0].clone();
        other.id = "p_x".into();
        other.name = "X".into();
        cfg.profiles.insert(0, other);
        assert!(cfg.validate().is_err());
        let fixed = cfg.normalize();
        assert_eq!(fixed.profiles[0].id, DEFAULT_PROFILE_ID);
        assert!(fixed.validate().is_ok());

        let empty = AppConfig { version: 1, profiles: vec![], macros: vec![] }.normalize();
        assert_eq!(empty.profiles.len(), 1);
    }

    #[test]
    fn new_fields_round_trip() {
        let json = r#"{"id":"p","name":"Browser","programs":[
            {"path":"C:\\Program Files\\Google\\Chrome\\chrome.exe"},
            {"path":"D:\\Games","match":"folder"},
            {"path":"","title":"Figma"}],
          "binds":{"fn:3,1":{"kind":"key","keycode":58}},
          "lighting":{"effect":24,"speed":1,"brightness":2,"hue":3,"sat":4,
            "layers":[{"id":"l","name":"W","color":{"h":0,"s":0,"v":255},"keys":["1,1"],"anim":"breathe","speed":40}],
            "mix":{"regions":[{"keys":[],"effects":[{"effect":5,"hue":0,"sat":255,"speed":128,"time":5000}]},
                              {"keys":["2,1"],"effects":[{"effect":2,"hue":170,"sat":255,"speed":60,"time":0}]}]}}}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(p.programs[1].match_by, ProgramMatch::Folder);
        assert_eq!(p.programs[2].title, "Figma");
        let l = p.lighting.as_ref().unwrap();
        assert_eq!(l.layers[0].anim, Anim::Breathe);
        assert_eq!(l.mix.as_ref().unwrap().regions[1].keys, ["2,1"]);
        assert_eq!(serde_json::to_value(&p).unwrap(), serde_json::from_str::<serde_json::Value>(json).unwrap());

        let k = l.for_keyboard();
        assert!(k.mix.is_some(), "Mix RGB keeps its regions");
        assert_eq!(k.key_anims["1,1"], KeyAnim { anim: Anim::Breathe, speed: 40 }, "colour layers go over Mix RGB too");
        let other = Lighting { effect: 5, ..l.clone() }.for_keyboard();
        assert!(other.mix.is_none(), "another effect doesn't need them");
        assert_eq!(other.key_anims["1,1"], KeyAnim { anim: Anim::Breathe, speed: 40 });
    }

    #[test]
    fn remaps_without_a_layer_go_on_the_default_layer() {
        let mut cfg = AppConfig::default();
        let b = |kc| Bind::Key { keycode: kc };
        cfg.profiles[0].binds = [("3,1", b(4)), ("L3:3,1", b(5)), ("e0:cw", b(6))].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        cfg.put_binds_on_layers(2);
        assert_eq!(cfg.profiles[0].binds.keys().collect::<Vec<_>>(), ["L2:3,1", "L3:3,1", "L2:e0:cw"]);
        let again = cfg.clone();
        cfg.put_binds_on_layers(0);
        assert_eq!(cfg, again, "only once");
    }

    #[test]
    fn engine_state_is_camel_case() {
        let s = EngineState {
            connected: true,
            firmware: Firmware::Missing,
            firmware_version: 3,
            build_id: 0,
            mix_rgb: false,
            mix_regions: 0,
            board: None,
            unreachable: Some("k8_max_ansi_white".into()),
            mode: Mode::Manual,
            active_profile_id: "default".into(),
            last_error: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["firmware"], "missing");
        assert_eq!(v["mode"], "manual");
        assert_eq!(v["activeProfileId"], "default");
        assert_eq!(v["firmwareVersion"], 3);
        assert_eq!(v["unreachable"], "k8_max_ansi_white");

        let f = FocusState { exe: None, path: None, title: Some("t".into()) };
        let v = serde_json::to_value(&f).unwrap();
        assert!(v["exe"].is_null());
        assert_eq!(v["title"], "t");
    }
}
