//! Pure packet builders and reply parsers for the Raw HID interface. The keyboard's side is
//! `firmware/profile_switcher.c`.
//! Nothing here touches the device, so all of it is unit-tested.

use crate::model::{Bind, Hsv, KeyId, Lighting, MacroStep, MixLighting, Profile, MIX_RGB_EFFECT};
use indexmap::IndexMap;

/// Keychron's USB vendor id (every keyboard in `board.rs`).
pub const VENDOR_ID: u16 = 0x3434;
pub const USAGE_PAGE: u16 = 0xFF60;
pub const USAGE: u16 = 0x61;

pub const REPORT_LEN: usize = 32;
pub type Report = [u8; REPORT_LEN];

/// A keyboard's switch matrix and knobs (from its board, `board.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Matrix {
    pub rows: u8,
    pub cols: u8,
    pub encoders: u8,
}

impl Matrix {
    /// Bytes one layer takes in VIA's dynamic keymap buffer (big-endian keycodes, row-major).
    pub fn layer_bytes(&self) -> usize {
        self.rows as usize * self.cols as usize * 2
    }

    /// The keyboard has this key or knob.
    pub fn holds(&self, t: Target) -> bool {
        match t {
            Target::Key { row, col } => row < self.rows && col < self.cols,
            Target::Encoder { index, .. } => index < self.encoders,
        }
    }
}

pub const QK_USER: u16 = 0x7E40;
/// Must match PS_MACRO_BUFFER_SIZE / PS_MAX_MACROS in firmware/profile_switcher.c and src/lib/limits.ts.
pub const MACRO_BUFFER_SIZE: usize = 2048;
pub const MAX_MACROS: usize = 64;
/// Ms a macro waits after each key step unless the macro or the PC's settings say otherwise.
/// Must match DEFAULT_SETTINGS.macroGap in src/lib/types.ts.
pub const DEFAULT_MACRO_GAP: u16 = 10;

// VIA command ids (quantum/via.h).
const ID_CUSTOM_SET_VALUE: u8 = 0x07;
const ID_CUSTOM_GET_VALUE: u8 = 0x08;
const ID_KEYMAP_GET_LAYER_COUNT: u8 = 0x11;
const ID_KEYMAP_GET_BUFFER: u8 = 0x12;
const ID_KEYMAP_GET_ENCODER: u8 = 0x14;
pub const ID_UNHANDLED: u8 = 0xFF;
// Keychron (keyboards/keychron/common/keychron_raw_hid.h). The keyboard also sends this one
// unsolicited, as [0xA3, default_layer, layer], every time a layer changes (state_notify.c).
pub const KC_GET_DEFAULT_LAYER: u8 = 0xA3;
/// Keychron's RGB command (keyboards/keychron/common/rgb/keychron_rgb.c): per-key RGB and Mix RGB.
/// `[0xA8, sub, payload…]`; the reply echoes `sub` and puts 0 (ok) or 1 (refused) in byte 2.
const KC_RGB: u8 = 0xA8;
const KC_RGB_GET_LED_COUNT: u8 = 0x05;
const KC_RGB_GET_LED_IDX: u8 = 0x06;
const KC_RGB_MIX_GET_INFO: u8 = 0x0B;
const KC_RGB_MIX_GET_REGIONS: u8 = 0x0C;
const KC_RGB_MIX_SET_REGIONS: u8 = 0x0D;
const KC_RGB_MIX_GET_EFFECT_LIST: u8 = 0x0E;
const KC_RGB_MIX_SET_EFFECT_LIST: u8 = 0x0F;

// Custom value channels.
const CH_PROFILE: u8 = 0x00;
const CH_RGB_MATRIX: u8 = 0x03;
/// VIA's LED matrix channel (white backlights): brightness 1, effect 2, speed 3 like RGB.
const CH_LED_MATRIX: u8 = 0x05;

// Profile switcher value ids (`firmware/profile_switcher.c`).
const PS_BEGIN: u8 = 0x01;
// 0x02 and 0x03 are reserved (remaps on the default layer only, in development builds before 1.0).
const PS_MACRO_DATA: u8 = 0x04;
const PS_COMMIT: u8 = 0x05;
const PS_RGB_BEGIN: u8 = 0x06;
const PS_RGB_KEYS: u8 = 0x07;
const PS_RGB_COMMIT: u8 = 0x08;
const PS_LIGHTING: u8 = 0x09;
const PS_LAYER_KEYS: u8 = 0x0A;
const PS_LAYER_ENCODERS: u8 = 0x0B;
const PS_RGB_KEYS_ANIM: u8 = 0x0C;
const PS_KEY_REPORT: u8 = 0x0D;
const PS_BOOTLOADER: u8 = 0x0E;
const PS_STATUS: u8 = 0x10;
/// First byte of the module's unsolicited key report: used by neither VIA
/// (0x01–0x15, 0xFF), Keychron (0xA0–0xAB) nor the module's echoed replies (0x07, 0x08).
pub const PS_KEY_REPORT_ID: u8 = 0xE5;
/// The keyboard's own row numbers for a knob's turns (QMK's `KEYLOC_ENCODER_CW` / `_CCW`).
const KEYLOC_ENCODER_CW: u8 = 253;
const KEYLOC_ENCODER_CCW: u8 = 252;
/// The firmware protocol this app speaks (`PS_PROTO_VERSION` in the module, `MODULE_VERSION` in
/// `src/lib/limits.ts`). Only this one: a keyboard reporting any other is treated as having no
/// profile switcher, with a note (`device.rs`). 1 is the protocol of the app's 1.0; the numbers
/// development builds used before it (2-9) were retired with it.
pub const PS_PROTO_VERSION: u8 = 1;
const RGB_KEYS_PER_PACKET: usize = 5;
const RGB_ANIM_KEYS_PER_PACKET: usize = 4;
const RGB_BLANK_OTHERS: u8 = 0x01;

const LAYER_KEYS_PER_PACKET: usize = 6;
const MACRO_BYTES_PER_PACKET: usize = 26;

// RGB matrix value ids (quantum/via.h).
const RGB_BRIGHTNESS: u8 = 1;
const RGB_EFFECT: u8 = 2;
const RGB_SPEED: u8 = 3;
const RGB_COLOR: u8 = 4;

// Macro opcodes.
const OP_TAP: u8 = 0x01;
const OP_PRESS: u8 = 0x02;
const OP_RELEASE: u8 = 0x03;
const OP_DELAY: u8 = 0x04;
const OP_GAP: u8 = 0x05;

fn report(prefix: &[u8]) -> Report {
    let mut r = [0u8; REPORT_LEN];
    r[..prefix.len()].copy_from_slice(prefix);
    r
}

// ------------------------------------------------------------------ key ids

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Key { row: u8, col: u8 },
    Encoder { index: u8, clockwise: bool },
}

/// Stands for "the keyboard's current default layer": remaps saved before layers were chosen
/// (ids without an "L2:" prefix). The device resolves it before sending.
pub const DEFAULT_LAYER: u8 = 0xFF;
/// Layers a key id can name ("L0:" … "L31:"), like QMK's layer state.
pub const MAX_LAYER_ID: u8 = 32;

/// "L2:3,1" → key 3,1 on layer 2; "L3:e0:cw" → the knob on layer 3. Without a prefix: the default
/// layer (`DEFAULT_LAYER`). None for anything out of range.
pub fn parse_bind_id(id: &str) -> Option<(Target, u8)> {
    match split_layer(id) {
        Some((layer, rest)) => parse_key_id(rest).map(|t| (t, layer)),
        None => parse_key_id(id).map(|t| (t, DEFAULT_LAYER)),
    }
}

/// "L2:3,1" → (2, "3,1").
pub fn split_layer(id: &str) -> Option<(u8, &str)> {
    let (layer, rest) = id.strip_prefix('L')?.split_once(':')?;
    let layer: u8 = layer.parse().ok()?;
    (layer < MAX_LAYER_ID).then_some((layer, rest))
}

/// The id of a key (or knob direction) on a layer: "L2:3,1".
pub fn layer_key_id(layer: u8, key: &str) -> KeyId {
    format!("L{layer}:{key}")
}

/// "3,1" → matrix key, "e0:cw" / "e0:ccw" → knob. None for anything out of range.
pub fn parse_key_id(id: &str) -> Option<Target> {
    if let Some(rest) = id.strip_prefix('e') {
        let (idx, dir) = rest.split_once(':')?;
        let index: u8 = idx.parse().ok()?;
        let clockwise = match dir {
            "cw" => true,
            "ccw" => false,
            _ => return None,
        };
        return Some(Target::Encoder { index, clockwise });
    }
    // Any key: whether the keyboard has it is checked when sending (`Matrix::holds`), so a profile
    // made on another keyboard keeps its remaps.
    let (r, c) = id.split_once(',')?;
    let (row, col): (u8, u8) = (r.trim().parse().ok()?, c.trim().parse().ok()?);
    Some(Target::Key { row, col })
}

pub fn encoder_key_id(index: u8, clockwise: bool) -> KeyId {
    format!("e{index}:{}", if clockwise { "cw" } else { "ccw" })
}

/// Keycodes a RAM macro can press: basic keys, optionally wrapped in modifiers (`isMacroSafe`).
pub fn is_macro_safe(kc: u16) -> bool {
    (kc > 0x0001 && kc <= 0x00FF) || (0x0100..=0x1FFF).contains(&kc)
}

// ------------------------------------------------------------------ profile keymap

/// Everything the firmware module needs for one profile, already resolved to keycodes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Keymap {
    /// (layer, row, col, keycode). Layer `DEFAULT_LAYER`: the keyboard's default layer.
    pub keys: Vec<(u8, u8, u8, u16)>,
    /// (layer, knob, clockwise, keycode).
    pub encoders: Vec<(u8, u8, bool, u16)>,
    /// The macros, each starting with its OP_GAP.
    pub macros: Vec<u8>,
}

/// `default_gap`: the PC's gap for macros without their own (`Settings::macro_gap`). Every macro
/// carries its OP_GAP (3 bytes whatever the gap is), so a change of the setting can't push a
/// profile over the keyboard's buffer.
pub fn build_keymap(profile: &Profile, default_gap: u16) -> Result<Keymap, String> {
    let mut km = Keymap::default();
    // Macro slots follow sorted key-id order, so the same profile always gets the same slots.
    let mut ids: Vec<&KeyId> = profile.binds.keys().collect();
    ids.sort();
    let mut slot: usize = 0;
    for id in ids {
        let Some((target, layer)) = parse_bind_id(id) else { continue };
        let keycode = match &profile.binds[id] {
            Bind::Key { keycode } | Bind::Qmk { keycode, .. } => *keycode,
            Bind::Macro { name, steps, gap, .. } => {
                if slot >= MAX_MACROS {
                    return Err(format!("{} has more than {MAX_MACROS} macros.", profile.name));
                }
                let at = km.macros.len();
                encode_macro(steps, &mut km.macros).map_err(|e| format!("Macro \"{name}\" in {}: {e}", profile.name))?;
                let g = gap.unwrap_or(default_gap);
                km.macros.splice(at..at, [OP_GAP, (g >> 8) as u8, g as u8]);
                slot += 1;
                QK_USER + (slot - 1) as u16
            }
        };
        match target {
            Target::Key { row, col } => km.keys.push((layer, row, col, keycode)),
            Target::Encoder { index, clockwise } => km.encoders.push((layer, index, clockwise, keycode)),
        }
    }
    if km.macros.len() > MACRO_BUFFER_SIZE {
        return Err(format!("{}'s macros need {} bytes; the keyboard holds {MACRO_BUFFER_SIZE}.", profile.name, km.macros.len()));
    }
    Ok(km)
}

fn encode_macro(steps: &[MacroStep], out: &mut Vec<u8>) -> Result<(), String> {
    for step in steps {
        let (op, arg) = match *step {
            MacroStep::Tap { keycode } => (OP_TAP, keycode),
            MacroStep::Down { keycode } => (OP_PRESS, keycode),
            MacroStep::Up { keycode } => (OP_RELEASE, keycode),
            MacroStep::Delay { ms } => (OP_DELAY, ms),
        };
        if op != OP_DELAY && !is_macro_safe(arg) {
            return Err(format!("keycode 0x{arg:04X} can't be played by a macro"));
        }
        out.extend_from_slice(&[op, (arg >> 8) as u8, arg as u8]);
    }
    out.push(0x00);
    Ok(())
}

/// Packets for one keymap, and how many remaps had to be left out: on layers the firmware
/// doesn't hold, or on keys this keyboard doesn't have (a profile made on another one).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeymapPackets {
    /// The fingerprint COMMIT carries, which STATUS reads back: it is how the app can tell that
    /// the keyboard really holds what was sent (see `Conn::verify_keymap`).
    pub tag: u16,
    pub packets: Vec<Report>,
    pub dropped: usize,
    pub off_board: usize,
}

impl Keymap {
    /// The same keymap with `DEFAULT_LAYER` replaced by the keyboard's default layer.
    pub fn on_default_layer(&self, default_layer: u8) -> Keymap {
        let fix = |l: u8| if l == DEFAULT_LAYER { default_layer } else { l };
        Keymap {
            keys: self.keys.iter().map(|&(l, r, c, kc)| (fix(l), r, c, kc)).collect(),
            encoders: self.encoders.iter().map(|&(l, i, cw, kc)| (fix(l), i, cw, kc)).collect(),
            macros: self.macros.clone(),
        }
    }

    /// Whether any remap needs the keyboard's default layer to be known.
    pub fn uses_default_layer(&self) -> bool {
        self.keys.iter().any(|k| k.0 == DEFAULT_LAYER) || self.encoders.iter().any(|e| e.0 == DEFAULT_LAYER)
    }

    /// BEGIN, the remaps of every layer below `layers` (LAYER_KEYS / LAYER_ENCODERS), MACRO_DATA…,
    /// then COMMIT(tag). An empty keymap still clears the previous one. Remaps on layers the module
    /// doesn't cover (`layers`, from STATUS) are dropped and counted.
    pub fn packets(&self, default_layer: u8, layers: u8, m: Matrix) -> KeymapPackets {
        let km = self.on_default_layer(default_layer);
        let keep = |l: u8| l < layers;
        let on_board_keys: Vec<_> = km.keys.iter().copied().filter(|&(_, row, col, _)| m.holds(Target::Key { row, col })).collect();
        let on_board_encoders: Vec<_> =
            km.encoders.iter().copied().filter(|&(_, index, clockwise, _)| m.holds(Target::Encoder { index, clockwise })).collect();
        let off_board = km.keys.len() + km.encoders.len() - on_board_keys.len() - on_board_encoders.len();
        let keys: Vec<_> = on_board_keys.iter().copied().filter(|k| keep(k.0)).collect();
        let encoders: Vec<_> = on_board_encoders.iter().copied().filter(|e| keep(e.0)).collect();
        let dropped = on_board_keys.len() + on_board_encoders.len() - keys.len() - encoders.len();

        let mut out = vec![report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_BEGIN])];
        let entries = |v: &[(u8, u8, u8, u16)]| v.iter().map(|&(l, a, b, kc)| (l, [a, b, (kc >> 8) as u8, kc as u8])).collect::<Vec<_>>();
        let key_entries = entries(&keys);
        let enc: Vec<_> = encoders.iter().map(|&(l, i, cw, kc)| (l, i, cw as u8, kc)).collect();
        let enc_entries = entries(&enc);
        layer_packets(PS_LAYER_KEYS, &key_entries, &mut out);
        layer_packets(PS_LAYER_ENCODERS, &enc_entries, &mut out);
        let macros = &self.macros;
        for (n, chunk) in macros.chunks(MACRO_BYTES_PER_PACKET).enumerate() {
            let off = (n * MACRO_BYTES_PER_PACKET) as u16;
            let mut r = report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_MACRO_DATA, (off >> 8) as u8, off as u8, chunk.len() as u8]);
            r[6..6 + chunk.len()].copy_from_slice(chunk);
            out.push(r);
        }
        let tag = Keymap { keys, encoders, macros: macros.clone() }.tag();
        out.push(report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_COMMIT, (tag >> 8) as u8, tag as u8]));
        KeymapPackets { tag, packets: out, dropped, off_board }
    }

    /// 16-bit fingerprint sent with COMMIT and read back by STATUS. Never 0 (= nothing applied).
    pub fn tag(&self) -> u16 {
        let mut h: u32 = 0x811C_9DC5;
        let mut eat = |b: u8| {
            h ^= b as u32;
            h = h.wrapping_mul(0x0100_0193);
        };
        for &(l, r, c, kc) in &self.keys {
            [l, r, c, (kc >> 8) as u8, kc as u8].into_iter().for_each(&mut eat);
        }
        eat(0xEE);
        for &(l, i, cw, kc) in &self.encoders {
            [l, i, cw as u8, (kc >> 8) as u8, kc as u8].into_iter().for_each(&mut eat);
        }
        eat(0xEE);
        self.macros.iter().copied().for_each(&mut eat);
        let t = ((h >> 16) ^ h) as u16;
        if t == 0 {
            1
        } else {
            t
        }
    }
}

/// LAYER_KEYS / LAYER_ENCODERS: `layer, n`, then up to 6 × 4 bytes, one layer per packet.
fn layer_packets(id: u8, entries: &[(u8, [u8; 4])], out: &mut Vec<Report>) {
    let mut layers: Vec<u8> = entries.iter().map(|e| e.0).collect();
    layers.sort_unstable();
    layers.dedup();
    for layer in layers {
        let on: Vec<[u8; 4]> = entries.iter().filter(|e| e.0 == layer).map(|e| e.1).collect();
        for chunk in on.chunks(LAYER_KEYS_PER_PACKET) {
            let mut r = report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, id, layer, chunk.len() as u8]);
            for (i, e) in chunk.iter().enumerate() {
                r[5 + i * 4..9 + i * 4].copy_from_slice(e);
            }
            out.push(r);
        }
    }
}

// ------------------------------------------------------------------ status

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub proto_version: u8,
    pub pending: bool,
    pub active_tag: u16,
    pub macro_buffer: u16,
    pub max_macros: u8,
    /// Layers the module holds remaps for.
    pub layers: u8,
    /// The firmware project this was built from. 0: built by hand.
    pub build_id: u32,
}

/// Restart into the bootloader, ready to flash. The keyboard answers, then disconnects.
pub fn bootloader_request() -> Report {
    report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_BOOTLOADER, b'B', b'O', b'O', b'T'])
}

/// KEY_REPORT: `true` starts reporting key events, or renews it (the keyboard stops by itself 5 s
/// after the last renewal); `false` stops it.
pub fn key_report_request(on: bool) -> Report {
    report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_KEY_REPORT, on as u8])
}

/// The reply to KEY_REPORT: whether the keyboard is reporting now (it can't start without a free
/// deferred-exec slot, and says so here).
pub fn key_report_started(reply: &Report) -> bool {
    reply[3] == 1
}

/// A key event the keyboard reported: the key ("3,1", or a knob turn "e0:cw") and whether it went down.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: KeyId,
    pub down: bool,
}

/// `Some((events, dropped))` when this report is the module's key report: its events in order, and
/// how many it had to drop before them (its queue was full). Positions the app can't name (a
/// combo's, a DIP switch's) are left out.
pub fn key_report(r: &Report) -> Option<(Vec<KeyEvent>, u8)> {
    if r[0] != PS_KEY_REPORT_ID {
        return None;
    }
    let n = (r[1] as usize).min((REPORT_LEN - 3) / 3);
    let events = r[3..3 + n * 3]
        .as_chunks::<3>()
        .0
        .iter()
        .filter_map(|&[row, col, pressed]| {
            let key = match row {
                KEYLOC_ENCODER_CW => encoder_key_id(col, true),
                KEYLOC_ENCODER_CCW => encoder_key_id(col, false),
                row if row < MAX_MATRIX_ROW => format!("{row},{col}"),
                _ => return None,
            };
            Some(KeyEvent { key, down: pressed != 0 })
        })
        .collect();
    Some((events, r[2]))
}
/// Rows above this are QMK's special positions (knobs, combos, DIP switches), not matrix rows.
const MAX_MATRIX_ROW: u8 = 0xF0;

pub fn status_request() -> Report {
    report(&[ID_CUSTOM_GET_VALUE, CH_PROFILE, PS_STATUS])
}

pub fn parse_status(r: &Report) -> Status {
    Status {
        proto_version: r[3],
        pending: r[4] != 0,
        active_tag: u16::from_be_bytes([r[5], r[6]]),
        macro_buffer: u16::from_be_bytes([r[7], r[8]]),
        max_macros: r[9],
        layers: r[10],
        build_id: u32::from_be_bytes([r[11], r[12], r[13], r[14]]),
    }
}

/// The id stamped into a firmware built from the project `id` (FNV-1a over its id, never 0 since
/// 0 means "built by hand"). The app passes it to the build as `-DPS_BUILD_ID` and compares it
/// with what STATUS reports.
pub fn build_id(id: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in id.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    if h == 0 {
        1
    } else {
        h
    }
}

// ------------------------------------------------------------------ lighting

/// Effect 0 ("off") with coloured keys is sent as Solid Color with the other keys blanked by the
/// firmware, so the coloured keys still light up (the effect must run for them to be drawn).
pub fn wire_effect(l: &Lighting) -> u8 {
    if l.effect == 0 && !l.keys.is_empty() {
        1
    } else {
        l.effect
    }
}

/// VIA RGB matrix values on channel 3, for keyboards without the profile switcher (the module's
/// LIGHTING does it with it). RAM-only as long as `id_custom_save` is never sent.
pub fn lighting_packets(l: &Lighting) -> Vec<Report> {
    vec![
        report(&[ID_CUSTOM_SET_VALUE, CH_RGB_MATRIX, RGB_EFFECT, wire_effect(l)]),
        report(&[ID_CUSTOM_SET_VALUE, CH_RGB_MATRIX, RGB_COLOR, l.hue, l.sat]),
        report(&[ID_CUSTOM_SET_VALUE, CH_RGB_MATRIX, RGB_SPEED, l.speed]),
        report(&[ID_CUSTOM_SET_VALUE, CH_RGB_MATRIX, RGB_BRIGHTNESS, l.brightness]),
    ]
}

/// Base lighting in one packet for the module: effect, hue, sat, brightness (VIA
/// scale), speed. Keychron's firmware reloads hue/sat/brightness/speed from EEPROM on every effect
/// change, which undoes the VIA values; the module re-applies these over that.
pub fn module_lighting_packet(l: &Lighting) -> Report {
    report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_LIGHTING, wire_effect(l), l.hue, l.sat, l.brightness, l.speed])
}

/// Requests whose replies `parse_lighting` turns back into a `Lighting`, in this order.
pub fn lighting_requests() -> [Report; 4] {
    [RGB_EFFECT, RGB_COLOR, RGB_SPEED, RGB_BRIGHTNESS].map(|id| report(&[ID_CUSTOM_GET_VALUE, CH_RGB_MATRIX, id]))
}

pub fn parse_lighting(replies: &[Report; 4]) -> Lighting {
    Lighting {
        effect: replies[0][3],
        hue: replies[1][3],
        sat: replies[1][4],
        speed: replies[2][3],
        brightness: replies[3][3],
        ..Default::default()
    }
}

/// A white backlight's effect, speed and brightness, on VIA's LED matrix channel (RAM only, like
/// channel 3). QMK's LED matrix keeps them over effect changes, so no module is needed. Effect 1 is
/// Solid on every Keychron white board, so `wire_effect` works here too. Hue and saturation don't
/// exist.
pub fn white_lighting_packets(l: &Lighting) -> Vec<Report> {
    vec![
        report(&[ID_CUSTOM_SET_VALUE, CH_LED_MATRIX, RGB_EFFECT, wire_effect(l)]),
        report(&[ID_CUSTOM_SET_VALUE, CH_LED_MATRIX, RGB_SPEED, l.speed]),
        report(&[ID_CUSTOM_SET_VALUE, CH_LED_MATRIX, RGB_BRIGHTNESS, l.brightness]),
    ]
}

/// Requests whose replies `parse_white_lighting` turns back into a `Lighting`, in this order.
pub fn white_lighting_requests() -> [Report; 3] {
    [RGB_EFFECT, RGB_SPEED, RGB_BRIGHTNESS].map(|id| report(&[ID_CUSTOM_GET_VALUE, CH_LED_MATRIX, id]))
}

pub fn parse_white_lighting(replies: &[Report; 3]) -> Lighting {
    Lighting { effect: replies[0][3], speed: replies[1][3], brightness: replies[2][3], hue: 0, sat: 0, ..Default::default() }
}

/// Per-key colours (the module's): RGB_BEGIN(flags), RGB_KEYS…, RGB_KEYS_ANIM…, RGB_COMMIT. On
/// white backlights the same packets, of which the module uses the value. Always the full set, so
/// an empty map clears the previous profile's colours. Knob ids have no LED and are skipped.
pub fn key_color_packets(l: &Lighting, m: Matrix) -> Vec<Report> {
    let flags = if l.effect == 0 && !l.keys.is_empty() { RGB_BLANK_OTHERS } else { 0 };
    let mut out = vec![report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_RGB_BEGIN, flags])];
    let mut ids: Vec<(&KeyId, &Hsv)> = l.keys.iter().collect();
    ids.sort_by(|a, b| a.0.cmp(b.0));
    let mut still: Vec<[u8; 5]> = vec![];
    let mut moving: Vec<[u8; 7]> = vec![];
    for (id, c) in ids {
        let Some(t @ Target::Key { row, col }) = parse_key_id(id) else { continue };
        if !m.holds(t) {
            continue;
        }
        match l.key_anims.get(id) {
            Some(a) => moving.push([row, col, c.h, c.s, c.v, a.anim.wire(), a.speed]),
            None => still.push([row, col, c.h, c.s, c.v]),
        }
    }
    for chunk in still.chunks(RGB_KEYS_PER_PACKET) {
        let mut r = report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_RGB_KEYS, chunk.len() as u8]);
        for (i, e) in chunk.iter().enumerate() {
            r[4 + i * 5..9 + i * 5].copy_from_slice(e);
        }
        out.push(r);
    }
    for chunk in moving.chunks(RGB_ANIM_KEYS_PER_PACKET) {
        let mut r = report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_RGB_KEYS_ANIM, chunk.len() as u8]);
        for (i, e) in chunk.iter().enumerate() {
            r[4 + i * 7..11 + i * 7].copy_from_slice(e);
        }
        out.push(r);
    }
    out.push(report(&[ID_CUSTOM_SET_VALUE, CH_PROFILE, PS_RGB_COMMIT]));
    out
}

// ------------------------------------------------------------------ Keychron Mix RGB (0xA8)

/// Asks which LED each key of a matrix row drives (`cols` ≤ 24: a 3-byte column mask). See
/// `parse_led_row`.
pub fn led_index_request(row: u8, cols: u8) -> Report {
    let mask: u32 = (1u32 << cols.min(24)) - 1;
    report(&[KC_RGB, KC_RGB_GET_LED_IDX, row, mask as u8, (mask >> 8) as u8, (mask >> 16) as u8])
}

/// LED of each key in the row ("row,col" → LED index); keys without one are left out.
pub fn parse_led_row(row: u8, cols: u8, r: &Report) -> Vec<(KeyId, u8)> {
    (0..cols.min(24))
        .filter_map(|c| {
            let led = r[3 + c as usize];
            (led != 0xFF).then(|| (format!("{row},{c}"), led))
        })
        .collect()
}

/// Asks how many Mix RGB regions the keyboard has and how many effects each can play.
pub fn mix_info_request() -> Report {
    report(&[KC_RGB, KC_RGB_MIX_GET_INFO])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MixInfo {
    pub regions: u8,
    pub effects_per_region: u8,
}

pub fn parse_mix_info(r: &Report) -> Option<MixInfo> {
    (kc_rgb_ok(r) && r[3] > 0 && r[4] > 0).then_some(MixInfo { regions: r[3], effects_per_region: r[4] })
}

/// Whether a `0xA8` reply says the keyboard took the command.
pub fn kc_rgb_ok(r: &Report) -> bool {
    r[0] == KC_RGB && r[2] == 0
}

const MIX_REGIONS_PER_PACKET: usize = 28;
/// Keychron's get allows 29 per reply, its set 28.
const MIX_REGIONS_PER_READ: usize = 28;
const MIX_EFFECTS_PER_PACKET: usize = 3;
/// One Mix RGB effect slot as the keyboard stores it: effect, hue, sat, speed, time (u32, LE).
pub type MixSlot = [u8; 8];

pub fn led_count_request() -> Report {
    report(&[KC_RGB, KC_RGB_GET_LED_COUNT])
}

pub fn parse_led_count(r: &Report) -> Option<u8> {
    kc_rgb_ok(r).then_some(r[3])
}

/// The keyboard's own Mix RGB setup (what Keychron Launcher saved), read so it can be put back
/// after a profile with regions of its own: requests for the region of every LED, then for each
/// region's effect slots.
pub fn mix_read_requests(led_count: u8, info: MixInfo) -> Vec<Report> {
    let mut out = vec![];
    for start in (0..led_count as usize).step_by(MIX_REGIONS_PER_READ) {
        let n = MIX_REGIONS_PER_READ.min(led_count as usize - start);
        out.push(report(&[KC_RGB, KC_RGB_MIX_GET_REGIONS, start as u8, n as u8]));
    }
    for region in 0..info.regions {
        for start in (0..info.effects_per_region as usize).step_by(MIX_EFFECTS_PER_PACKET) {
            let n = MIX_EFFECTS_PER_PACKET.min(info.effects_per_region as usize - start);
            out.push(report(&[KC_RGB, KC_RGB_MIX_GET_EFFECT_LIST, region, start as u8, n as u8]));
        }
    }
    out
}

/// The replies to `mix_read_requests`, turned into the packets that set it all back.
pub fn mix_restore_packets(requests: &[Report], replies: &[Report], info: MixInfo) -> Option<Vec<Report>> {
    let mut region_of = vec![];
    let mut slots: Vec<Vec<MixSlot>> = vec![vec![]; info.regions as usize];
    for (req, rep) in requests.iter().zip(replies) {
        if !kc_rgb_ok(rep) {
            return None;
        }
        let n = req[3 + (req[1] == KC_RGB_MIX_GET_EFFECT_LIST) as usize] as usize;
        if req[1] == KC_RGB_MIX_GET_REGIONS {
            region_of.extend_from_slice(&rep[3..3 + n]);
        } else {
            let region = slots.get_mut(req[2] as usize)?;
            for i in 0..n {
                region.push(rep[3 + i * 8..11 + i * 8].try_into().ok()?);
            }
        }
    }
    Some(mix_set_packets(&region_of, &slots))
}

/// SET_REGIONS for every LED, then SET_EFFECT_LIST for every region's slots.
fn mix_set_packets(region_of: &[u8], slots: &[Vec<MixSlot>]) -> Vec<Report> {
    let mut out = vec![];
    for (n, chunk) in region_of.chunks(MIX_REGIONS_PER_PACKET).enumerate() {
        let start = (n * MIX_REGIONS_PER_PACKET) as u8;
        let mut r = report(&[KC_RGB, KC_RGB_MIX_SET_REGIONS, start, chunk.len() as u8]);
        r[4..4 + chunk.len()].copy_from_slice(chunk);
        out.push(r);
    }
    for (region, list) in slots.iter().enumerate() {
        for (n, chunk) in list.chunks(MIX_EFFECTS_PER_PACKET).enumerate() {
            let start = (n * MIX_EFFECTS_PER_PACKET) as u8;
            let mut r = report(&[KC_RGB, KC_RGB_MIX_SET_EFFECT_LIST, region as u8, start, chunk.len() as u8]);
            for (i, e) in chunk.iter().enumerate() {
                r[5 + i * 8..13 + i * 8].copy_from_slice(e);
            }
            out.push(r);
        }
    }
    out
}

/// The region of every LED, then each region's effect list padded with "none" up to
/// `info.effects_per_region`. RAM only: Keychron writes these to EEPROM only on its own save
/// command, which the app never sends. Effects Mix RGB can't nest (Per Key RGB, Mix RGB) are
/// dropped, as the keyboard would refuse the whole list.
pub fn mix_packets(mix: &MixLighting, leds: &IndexMap<KeyId, u8>, led_count: u8, info: MixInfo) -> Vec<Report> {
    let led_count = (led_count as usize).max(leds.values().copied().max().map_or(0, |m| m as usize + 1));
    let mut region_of = vec![0u8; led_count];
    for (i, region) in mix.regions.iter().enumerate().skip(1).take(info.regions as usize - 1) {
        for k in &region.keys {
            if let Some(&led) = leds.get(k) {
                region_of[led as usize] = i as u8;
            }
        }
    }
    let slots: Vec<Vec<MixSlot>> = (0..info.regions as usize)
        .map(|region| {
            let effects = mix.regions.get(region).map_or(&[][..], |r| &r.effects[..]);
            let playable = effects.iter().filter(|e| e.effect != 0 && e.effect < MIX_RGB_EFFECT - 1);
            let mut slots: Vec<MixSlot> = playable
                .take(info.effects_per_region as usize)
                .map(|e| {
                    let t = e.time.to_le_bytes();
                    [e.effect, e.hue, e.sat, e.speed, t[0], t[1], t[2], t[3]]
                })
                .collect();
            slots.resize(info.effects_per_region as usize, [0; 8]);
            slots
        })
        .collect();
    mix_set_packets(&region_of, &slots)
}

/// Same base effect settings (everything but the per-key colours).
pub fn same_base(a: &Lighting, b: &Lighting) -> bool {
    lighting_packets(a) == lighting_packets(b)
}

// ------------------------------------------------------------------ base keymap

pub fn default_layer_request() -> Report {
    report(&[KC_GET_DEFAULT_LAYER])
}

/// VIA: how many layers the dynamic keymap has (reply byte 1).
pub fn layer_count_request() -> Report {
    report(&[ID_KEYMAP_GET_LAYER_COUNT])
}

pub const BUFFER_CHUNK: usize = 28;

pub fn keymap_buffer_requests(layer: u8, m: Matrix) -> Vec<Report> {
    let layer_bytes = m.layer_bytes();
    let base = layer as usize * layer_bytes;
    (0..layer_bytes)
        .step_by(BUFFER_CHUNK)
        .map(|start| {
            let off = (base + start) as u16;
            let size = BUFFER_CHUNK.min(layer_bytes - start) as u8;
            report(&[ID_KEYMAP_GET_BUFFER, (off >> 8) as u8, off as u8, size])
        })
        .collect()
}

/// Payload of a `keymap_buffer_requests` reply. The length byte comes from the keyboard, so a
/// misbehaving one must not be able to panic the device thread: an impossible length reads as empty.
pub fn buffer_reply_data(r: &Report) -> &[u8] {
    let len = r[3] as usize;
    match r.get(4..4 + len) {
        Some(data) => data,
        None => {
            log::warn!("the keyboard claimed a {len}-byte keymap chunk in a {REPORT_LEN}-byte report");
            &[]
        }
    }
}

pub fn decode_layer(bytes: &[u8], m: Matrix) -> IndexMap<KeyId, u16> {
    let mut keys = IndexMap::new();
    for row in 0..m.rows as usize {
        for col in 0..m.cols as usize {
            let i = (row * m.cols as usize + col) * 2;
            if let Some(pair) = bytes.get(i..i + 2) {
                keys.insert(format!("{row},{col}"), u16::from_be_bytes([pair[0], pair[1]]));
            }
        }
    }
    keys
}

pub fn encoder_request(layer: u8, index: u8, clockwise: bool) -> Report {
    report(&[ID_KEYMAP_GET_ENCODER, layer, index, clockwise as u8])
}

pub fn parse_encoder(r: &Report) -> u16 {
    u16::from_be_bytes([r[4], r[5]])
}

// ------------------------------------------------------------------ replies

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyKind {
    /// The reply to this request.
    Reply,
    /// The keyboard didn't handle the request (for channel 0: the firmware module is missing).
    Unhandled,
    /// Something else, e.g. an unsolicited layer notification. Keep waiting.
    Other,
}

/// How many leading bytes of a request the keyboard echoes unchanged in its reply.
fn echoed_prefix(cmd: u8) -> usize {
    match cmd {
        ID_CUSTOM_SET_VALUE | ID_CUSTOM_GET_VALUE => 3,
        ID_KEYMAP_GET_BUFFER | ID_KEYMAP_GET_ENCODER => 4,
        KC_RGB => 2,
        _ => 1,
    }
}

pub fn classify_reply(request: &Report, reply: &Report) -> ReplyKind {
    let n = echoed_prefix(request[0]);
    if reply[1..n] != request[1..n] {
        return ReplyKind::Other;
    }
    match reply[0] {
        c if c == request[0] => ReplyKind::Reply,
        ID_UNHANDLED => ReplyKind::Unhandled,
        _ => ReplyKind::Other,
    }
}

/// `Some(tag)` when this packet is the COMMIT that ends a keymap transfer. The keyboard stores
/// that tag and STATUS reads it back (`Status::active_tag`), which is how the app checks that the
/// profile it sent is the profile the keyboard holds. Only the tests need to read it back out
/// of a packet (their stand-in keyboard keeps it, like a real one).
#[cfg(test)]
pub fn commit_tag(r: &Report) -> Option<u16> {
    (r[0] == ID_CUSTOM_SET_VALUE && r[1] == CH_PROFILE && r[2] == PS_COMMIT).then(|| u16::from_be_bytes([r[3], r[4]]))
}

/// `Some(default_layer)` when this report is Keychron's unsolicited layer notification.
pub fn layer_notification(r: &Report) -> Option<u8> {
    (r[0] == KC_GET_DEFAULT_LAYER).then_some(r[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The V6 8K's matrix and knob.
    const V6: Matrix = Matrix { rows: 6, cols: 21, encoders: 1 };

    fn profile(binds: &[(&str, Bind)]) -> Profile {
        Profile {
            id: "p".into(),
            name: "Test".into(),
            programs: vec![],
            exes: vec![],
            binds: binds.iter().map(|(k, b)| (k.to_string(), b.clone())).collect(),
            lighting: None,
        }
    }

    fn mac(name: &str, steps: Vec<MacroStep>) -> Bind {
        Bind::Macro { name: name.into(), steps, gap: None, macro_id: None }
    }

    #[test]
    fn keys_another_keyboard_lacks_are_left_out() {
        // A profile made on the V6 8K (21 columns, a knob), sent to a 65% without a knob.
        let small = Matrix { rows: 5, cols: 15, encoders: 0 };
        let b = |kc| Bind::Key { keycode: kc };
        let mut p = profile(&[]);
        p.binds.insert("L2:1,1".into(), b(0x04));
        p.binds.insert("L2:5,20".into(), b(0x05));
        p.binds.insert("L2:e0:cw".into(), b(0x06));
        let km = build_keymap(&p, DEFAULT_MACRO_GAP).unwrap();
        let out = km.packets(2, 4, small);
        assert_eq!((out.off_board, out.dropped), (2, 0));
        assert_eq!(out, km.packets(2, 4, small), "stable");
        assert_eq!(km.packets(2, 4, V6).off_board, 0, "all there on the V6");
    }

    #[test]
    fn parses_key_ids() {
        assert_eq!(parse_key_id("3,1"), Some(Target::Key { row: 3, col: 1 }));
        assert_eq!(parse_key_id("5,20"), Some(Target::Key { row: 5, col: 20 }));
        // Any key parses; whether the keyboard has it is the matrix's business.
        assert!(!V6.holds(parse_key_id("6,0").unwrap()));
        assert!(!V6.holds(parse_key_id("0,21").unwrap()));
        assert!(V6.holds(parse_key_id("5,20").unwrap()));
        assert_eq!(parse_key_id("e0:cw"), Some(Target::Encoder { index: 0, clockwise: true }));
        assert_eq!(parse_key_id("e0:ccw"), Some(Target::Encoder { index: 0, clockwise: false }));
        assert!(!V6.holds(parse_key_id("e1:cw").unwrap()), "the V6 has one knob");
        assert_eq!(parse_key_id("e0:up"), None);
        assert_eq!(parse_key_id("junk"), None);
        assert_eq!(encoder_key_id(0, false), "e0:ccw");

        assert_eq!(parse_bind_id("L3:3,1"), Some((Target::Key { row: 3, col: 1 }, 3)));
        assert_eq!(parse_bind_id("L0:e0:ccw"), Some((Target::Encoder { index: 0, clockwise: false }, 0)));
        assert_eq!(parse_bind_id("3,1"), Some((Target::Key { row: 3, col: 1 }, DEFAULT_LAYER)), "older files");
        assert_eq!(parse_bind_id("L32:3,1"), None);
        assert_eq!(parse_bind_id("Lx:3,1"), None);
        assert_eq!(
            parse_bind_id("L1:9,9"),
            Some((Target::Key { row: 9, col: 9 }, 1)),
            "another keyboard's key: kept, skipped when sending"
        );
        assert_eq!(layer_key_id(2, "e0:cw"), "L2:e0:cw");
        assert_eq!(split_layer("L12:1,1"), Some((12, "1,1")));
    }

    #[test]
    fn empty_profile_is_begin_then_commit() {
        let km = build_keymap(&profile(&[]), DEFAULT_MACRO_GAP).unwrap();
        let p = km.packets(2, 4, V6).packets;
        assert_eq!(p.len(), 2);
        assert_eq!(&p[0][..4], &[0x07, 0x00, 0x01, 0x00]);
        assert_eq!(&p[1][..3], &[0x07, 0x00, 0x05]);
        assert_ne!(u16::from_be_bytes([p[1][3], p[1][4]]), 0);
    }

    #[test]
    fn every_layer_goes_in_sixes() {
        let mut binds: Vec<(String, Bind)> = (0..8).map(|c| (format!("L0:1,{c}"), Bind::Key { keycode: 0x0004 + c as u16 })).collect();
        binds.push(("L3:3,1".into(), Bind::Key { keycode: 0x3A }));
        binds.push(("L3:e0:cw".into(), Bind::Key { keycode: 0x80 }));
        binds.push(("3,2".into(), Bind::Key { keycode: 0x05 })); // default layer (2)
        binds.push(("L6:3,3".into(), Bind::Key { keycode: 0x06 })); // beyond the firmware's 4 layers
        let refs: Vec<(&str, Bind)> = binds.iter().map(|(k, b)| (k.as_str(), b.clone())).collect();
        let km = build_keymap(&profile(&refs), DEFAULT_MACRO_GAP).unwrap();
        assert!(km.uses_default_layer());
        let out = km.packets(2, 4, V6);
        let p = &out.packets;
        assert_eq!(out.dropped, 1);
        // BEGIN, L0 keys (6 + 2), L2 keys, L3 keys, L3 encoders, COMMIT
        assert_eq!(p.len(), 7);
        assert_eq!(&p[1][..9], &[0x07, 0x00, 0x0A, 0, 6, 1, 0, 0x00, 0x04]);
        assert_eq!(&p[2][..5], &[0x07, 0x00, 0x0A, 0, 2]);
        assert_eq!(&p[3][..9], &[0x07, 0x00, 0x0A, 2, 1, 3, 2, 0x00, 0x05]);
        assert_eq!(&p[4][..9], &[0x07, 0x00, 0x0A, 3, 1, 3, 1, 0x00, 0x3A]);
        assert_eq!(&p[5][..9], &[0x07, 0x00, 0x0B, 3, 1, 0, 1, 0x00, 0x80]);
        assert_ne!(km.packets(0, 4, V6).packets, km.packets(2, 4, V6).packets, "the default layer is resolved when sending");
    }

    #[test]
    fn macros_get_slots_in_sorted_key_order() {
        let km = build_keymap(
            &profile(&[
                ("3,2", mac("b", vec![MacroStep::Tap { keycode: 0x05 }])),
                ("0,1", Bind::Key { keycode: 0x29 }),
                ("3,1", mac("a", vec![MacroStep::Down { keycode: 0x0106 }, MacroStep::Delay { ms: 300 }])),
            ]),
            DEFAULT_MACRO_GAP,
        )
        .unwrap();
        assert!(km.keys.contains(&(DEFAULT_LAYER, 3, 1, QK_USER)));
        assert!(km.keys.contains(&(DEFAULT_LAYER, 3, 2, QK_USER + 1)));
        assert!(km.keys.contains(&(DEFAULT_LAYER, 0, 1, 0x29)));
        assert_eq!(km.macros, vec![0x05, 0, 10, 0x02, 0x01, 0x06, 0x04, 0x01, 0x2C, 0x00, 0x05, 0, 10, 0x01, 0x00, 0x05, 0x00]);
    }

    #[test]
    fn macros_carry_their_gap() {
        let Bind::Macro { name, steps, .. } = mac("own", vec![MacroStep::Tap { keycode: 0x04 }]) else { unreachable!() };
        let own = Bind::Macro { name, steps, gap: Some(0), macro_id: None };
        let km = build_keymap(&profile(&[("2,1", mac("default", vec![MacroStep::Tap { keycode: 0x05 }])), ("2,2", own)]), 25).unwrap();
        // The PC's default (25) for the first, the macro's own (0) for the second.
        assert_eq!(km.macros, vec![0x05, 0, 25, 0x01, 0, 0x05, 0, 0x05, 0, 0, 0x01, 0, 0x04, 0]);
        let sent = || -> Vec<u8> {
            km.packets(2, 4, V6).packets.iter().filter(|r| r[2] == PS_MACRO_DATA).flat_map(|r| r[6..6 + r[5] as usize].to_vec()).collect()
        };
        assert_eq!(sent(), km.macros);

        // The size check counts the gap whatever its value, so changing the setting can't overflow.
        let taps = vec![MacroStep::Tap { keycode: 0x04 }; 682]; // 2047 bytes without the gap, 2050 with
        assert!(build_keymap(&profile(&[("2,1", mac("m", taps.clone()))]), 0).is_err());
        assert!(build_keymap(&profile(&[("2,1", mac("m", taps[1..].to_vec()))]), 0).is_ok());
    }

    #[test]
    fn macro_data_is_split_in_26_byte_chunks() {
        let steps = vec![MacroStep::Tap { keycode: 0x04 }; 20]; // 64 bytes: gap, 20 steps, terminator
        let p = build_keymap(&profile(&[("2,1", mac("long", steps))]), DEFAULT_MACRO_GAP).unwrap().packets(2, 4, V6).packets;
        let data: Vec<&Report> = p.iter().filter(|r| r[2] == 0x04).collect();
        assert_eq!(data.len(), 3);
        assert_eq!(&data[0][3..6], &[0, 0, 26]);
        assert_eq!(&data[1][3..6], &[0, 26, 26]);
        assert_eq!(&data[2][3..6], &[0, 52, 12]);
        let joined: Vec<u8> = data.iter().flat_map(|r| r[6..6 + r[5] as usize].to_vec()).collect();
        assert_eq!(joined.len(), 64);
        assert_eq!(joined[63], 0);
    }

    #[test]
    fn rejects_what_the_keyboard_cannot_hold() {
        let bad = build_keymap(&profile(&[("2,1", mac("m", vec![MacroStep::Tap { keycode: 0x5221 }]))]), DEFAULT_MACRO_GAP);
        assert!(bad.unwrap_err().contains("0x5221"));

        let big = vec![MacroStep::Tap { keycode: 0x04 }; 700]; // 2101 bytes
        assert!(build_keymap(&profile(&[("2,1", mac("m", big))]), DEFAULT_MACRO_GAP).is_err());

        let many: Vec<(String, Bind)> = (0..65).map(|i| (format!("{},{}", i / 21, i % 21), mac("m", vec![]))).collect();
        let refs: Vec<(&str, Bind)> = many.iter().map(|(k, b)| (k.as_str(), b.clone())).collect();
        assert!(build_keymap(&profile(&refs), DEFAULT_MACRO_GAP).is_err());
    }

    #[test]
    fn tag_depends_on_content() {
        let a = build_keymap(&profile(&[("1,1", Bind::Key { keycode: 4 })]), DEFAULT_MACRO_GAP).unwrap();
        let b = build_keymap(&profile(&[("1,1", Bind::Key { keycode: 5 })]), DEFAULT_MACRO_GAP).unwrap();
        assert_ne!(a.tag(), b.tag());
        assert_eq!(a.tag(), a.clone().tag());
    }

    #[test]
    fn lighting_round_trip() {
        let l = Lighting { effect: 4, speed: 10, brightness: 200, hue: 30, sat: 99, ..Default::default() };
        let p = lighting_packets(&l);
        assert_eq!(&p[0][..4], &[0x07, 0x03, 0x02, 4]);
        assert_eq!(&p[1][..5], &[0x07, 0x03, 0x04, 30, 99]);
        assert_eq!(&p[2][..4], &[0x07, 0x03, 0x03, 10]);
        assert_eq!(&p[3][..4], &[0x07, 0x03, 0x01, 200]);
        // A get reply echoes the request with the value filled in, like a set packet.
        let replies = lighting_requests().map(|mut r| {
            let set = p.iter().find(|s| s[2] == r[2]).unwrap();
            r[3..5].copy_from_slice(&set[3..5]);
            r
        });
        assert_eq!(parse_lighting(&replies), l);
    }

    #[test]
    fn white_backlights_use_the_led_matrix_channel() {
        let l = Lighting { effect: 3, hue: 99, sat: 99, speed: 40, brightness: 200, ..Default::default() };
        let p = white_lighting_packets(&l);
        assert_eq!(p.iter().map(|r| r[..4].to_vec()).collect::<Vec<_>>(), [[0x07, 5, 2, 3], [0x07, 5, 3, 40], [0x07, 5, 1, 200]]);
        let replies = white_lighting_requests().map(|mut r| {
            assert_eq!(r[..2], [0x08, 5]);
            r[3] = match r[2] {
                2 => 3,
                3 => 40,
                _ => 200,
            };
            r
        });
        assert_eq!(parse_white_lighting(&replies), Lighting { hue: 0, sat: 0, ..l });
    }

    fn colours(pairs: &[(&str, (u8, u8, u8))]) -> Lighting {
        Lighting {
            effect: 4,
            speed: 10,
            brightness: 200,
            hue: 30,
            sat: 99,
            keys: pairs.iter().map(|(k, (h, s, v))| (k.to_string(), Hsv { h: *h, s: *s, v: *v })).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn per_key_colours_are_staged_then_committed() {
        let l = colours(&[
            ("3,2", (1, 2, 3)),
            ("e0:cw", (9, 9, 9)), // the knob has no LED
            ("0,0", (4, 5, 6)),
            ("1,0", (7, 8, 9)),
            ("1,1", (0, 0, 0)),
            ("1,2", (0, 0, 0)),
            ("1,3", (0, 0, 0)),
        ]);
        let p = key_color_packets(&l, V6);
        assert_eq!(p.len(), 4); // BEGIN, KEYS(5), KEYS(1), COMMIT
        assert_eq!(&p[0][..4], &[0x07, 0x00, 0x06, 0x00]);
        assert_eq!(&p[1][..14], &[0x07, 0x00, 0x07, 5, 0, 0, 4, 5, 6, 1, 0, 7, 8, 9]);
        assert_eq!(&p[2][..9], &[0x07, 0x00, 0x07, 1, 3, 2, 1, 2, 3]);
        assert_eq!(&p[3][..3], &[0x07, 0x00, 0x08]);
        // No colours: still BEGIN + COMMIT, which clears the previous profile's.
        assert_eq!(key_color_packets(&colours(&[]), V6).len(), 2);
    }

    #[test]
    fn effect_off_with_coloured_keys_lights_only_those() {
        let mut l = colours(&[("3,1", (0, 255, 255))]);
        l.effect = 0;
        assert_eq!(lighting_packets(&l)[0][3], 1, "runs Solid Color so the firmware draws");
        assert_eq!(key_color_packets(&l, V6)[0][3], 0x01, "…with the other keys blanked");
        l.keys.clear();
        assert_eq!(lighting_packets(&l)[0][3], 0, "really off without colours");
        assert!(same_base(&colours(&[("1,1", (1, 1, 1))]), &colours(&[])));
    }

    #[test]
    fn module_lighting_is_one_packet() {
        let mut l = colours(&[]);
        assert_eq!(&module_lighting_packet(&l)[..8], &[0x07, 0x00, 0x09, 4, 30, 99, 200, 10]);
        l.effect = 0;
        l.keys.insert("1,1".into(), Hsv { h: 1, s: 1, v: 1 });
        assert_eq!(module_lighting_packet(&l)[3], 1, "off + coloured keys runs Solid Color");
    }

    #[test]
    fn buffer_requests_cover_one_layer() {
        let reqs = keymap_buffer_requests(2, V6);
        assert_eq!(reqs.len(), 9);
        assert_eq!(&reqs[0][..4], &[0x12, 0x01, 0xF8, 28]); // 2 * 252 = 0x1F8
        assert_eq!(&reqs[8][..4], &[0x12, 0x02, 0xD8, 28]);
        let mut bytes = vec![0u8; V6.layer_bytes()];
        bytes[2..4].copy_from_slice(&[0x00, 0x3A]); // 0,1 = KC_F1
        let keys = decode_layer(&bytes, V6);
        assert_eq!(keys.len(), 126);
        assert_eq!(keys["0,1"], 0x3A);
    }

    #[test]
    fn classifies_replies() {
        let req = status_request();
        let mut ok = req;
        ok[3] = 1;
        assert_eq!(classify_reply(&req, &ok), ReplyKind::Reply);
        let mut unhandled = req;
        unhandled[0] = 0xFF;
        assert_eq!(classify_reply(&req, &unhandled), ReplyKind::Unhandled);
        let notify = report(&[0xA3, 0, 1]);
        assert_eq!(classify_reply(&req, &notify), ReplyKind::Other);
        assert_eq!(layer_notification(&notify), Some(0));
        let other_chunk = keymap_buffer_requests(2, V6)[1];
        assert_eq!(classify_reply(&keymap_buffer_requests(2, V6)[0], &other_chunk), ReplyKind::Other);
    }

    #[test]
    fn parses_status() {
        let mut r = status_request();
        r[3..15].copy_from_slice(&[1, 0, 0x12, 0x34, 0x08, 0x00, 64, 4, 0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(
            parse_status(&r),
            Status {
                proto_version: 1,
                pending: false,
                active_tag: 0x1234,
                macro_buffer: 2048,
                max_macros: 64,
                layers: 4,
                build_id: 0xDEAD_BEEF
            }
        );
    }

    #[test]
    fn build_ids_differ_and_are_never_zero() {
        assert_ne!(build_id("my_v6"), build_id("my_v6_2"));
        assert_ne!(build_id("my_v6"), 0);
        assert_eq!(build_id("my_v6"), build_id("my_v6"), "the same project always gets the same id");
    }

    #[test]
    fn animated_colours_go_in_their_own_packets() {
        use crate::model::{Anim, KeyAnim};
        let mut l = colours(&[("1,1", (1, 2, 3)), ("1,2", (4, 5, 6))]);
        l.key_anims.insert("1,2".into(), KeyAnim { anim: Anim::Breathe, speed: 99 });
        let p = key_color_packets(&l, V6);
        assert_eq!(p.len(), 4); // BEGIN, KEYS(1), KEYS_ANIM(1), COMMIT
        assert_eq!(&p[1][..9], &[0x07, 0x00, 0x07, 1, 1, 1, 1, 2, 3]);
        assert_eq!(&p[2][..11], &[0x07, 0x00, 0x0C, 1, 1, 2, 4, 5, 6, 1, 99]);
    }

    #[test]
    fn layers_carry_their_animation_to_the_keyboard() {
        use crate::model::{Anim, ColorLayer};
        let layer = |id: &str, anim: Anim, keys: &[&str]| ColorLayer {
            id: id.into(),
            name: id.into(),
            color: Hsv { h: 1, s: 2, v: 3 },
            keys: keys.iter().map(|k| k.to_string()).collect(),
            hidden: false,
            anim,
            speed: None,
        };
        let mut l = colours(&[]);
        l.layers = vec![layer("under", Anim::Cycle, &["1,1", "1,2"]), layer("over", Anim::Static, &["1,2"])];
        let k = l.for_keyboard();
        assert_eq!(k.key_anims.len(), 1, "the static layer on top hides the animation under it");
        assert_eq!(k.key_anims["1,1"].anim, Anim::Cycle);
        assert_eq!(k.key_anims["1,1"].speed, crate::model::DEFAULT_ANIM_SPEED);
    }

    #[test]
    fn a_bad_length_byte_does_not_panic() {
        // The length byte is the keyboard's: only 28 bytes of a 32-byte report can be payload.
        let mut r = [0u8; REPORT_LEN];
        r[3] = 28;
        assert_eq!(buffer_reply_data(&r).len(), 28, "the largest honest chunk");
        r[3] = 29;
        assert_eq!(buffer_reply_data(&r), &[] as &[u8], "one byte too many");
        r[3] = 0xFF;
        assert_eq!(buffer_reply_data(&r), &[] as &[u8], "nonsense");
        r[3] = 0;
        assert_eq!(buffer_reply_data(&r), &[] as &[u8]);
    }

    #[test]
    fn led_map_rows() {
        let req = led_index_request(2, V6.cols);
        assert_eq!(&req[..6], &[0xA8, 0x06, 2, 0xFF, 0xFF, 0x1F]);
        let mut reply = req;
        reply[2] = 0;
        reply[3..3 + V6.cols as usize].fill(0xFF);
        reply[3] = 40; // 2,0
        reply[4] = 41; // 2,1
        assert_eq!(parse_led_row(2, V6.cols, &reply), vec![("2,0".to_string(), 40), ("2,1".to_string(), 41)]);
        assert!(kc_rgb_ok(&reply));
        let mut info = mix_info_request();
        info[3..5].copy_from_slice(&[2, 5]);
        assert_eq!(parse_mix_info(&info), Some(MixInfo { regions: 2, effects_per_region: 5 }));
        info[2] = 1;
        assert_eq!(parse_mix_info(&info), None, "refused");
    }

    #[test]
    fn mix_regions_and_effect_lists() {
        use crate::model::{MixEffect, MixRegion};
        let fx = |effect: u8, time: u32| MixEffect { effect, hue: 10, sat: 20, speed: 30, time };
        let mix = MixLighting {
            regions: vec![
                MixRegion { keys: vec!["0,0".into()], effects: vec![fx(5, 0)] }, // keys ignored: the rest
                MixRegion { keys: vec!["0,1".into(), "e0:cw".into()], effects: vec![fx(2, 5000), fx(24, 1), fx(4, 0x01020304)] },
            ],
        };
        let leds: IndexMap<KeyId, u8> = [("0,0", 0u8), ("0,1", 1), ("5,20", 29)].into_iter().map(|(k, l)| (k.to_string(), l)).collect();
        let p = mix_packets(&mix, &leds, 30, MixInfo { regions: 2, effects_per_region: 5 });
        // 30 LEDs: two region packets (28 + 2), then 2 packets per region for 5 slots (3 + 2).
        assert_eq!(p.len(), 6);
        assert_eq!(&p[0][..6], &[0xA8, 0x0D, 0, 28, 0, 1]);
        assert_eq!(&p[1][..6], &[0xA8, 0x0D, 28, 2, 0, 0]);
        assert_eq!(&p[2][..13], &[0xA8, 0x0F, 0, 0, 3, 5, 10, 20, 30, 0, 0, 0, 0]);
        assert_eq!(&p[2][13..21], &[0; 8], "unused slots are 'none'");
        assert_eq!(&p[3][..5], &[0xA8, 0x0F, 0, 3, 2]);
        // Region 1: Breathing, then Cycle All (Mix RGB itself can't be nested and is dropped).
        assert_eq!(&p[4][..21], &[0xA8, 0x0F, 1, 0, 3, 2, 10, 20, 30, 0x88, 0x13, 0, 0, 4, 10, 20, 30, 4, 3, 2, 1]);
        assert_eq!(classify_reply(&p[4], &p[4]), ReplyKind::Reply);
    }

    #[test]
    fn the_keyboards_own_mix_is_read_then_put_back() {
        let info = MixInfo { regions: 2, effects_per_region: 5 };
        let reqs = mix_read_requests(30, info);
        // Regions: 0..28, 28..30. Effects: per region, slots 0..3 and 3..5.
        assert_eq!(reqs.len(), 6);
        assert_eq!(&reqs[0][..4], &[0xA8, 0x0C, 0, 28]);
        assert_eq!(&reqs[1][..4], &[0xA8, 0x0C, 28, 2]);
        assert_eq!(&reqs[2][..5], &[0xA8, 0x0E, 0, 0, 3]);
        assert_eq!(&reqs[5][..5], &[0xA8, 0x0E, 1, 3, 2]);
        // What the keyboard answers: status 0 in byte 2, data from byte 3.
        let replies: Vec<Report> = reqs
            .iter()
            .map(|q| {
                let mut r = *q;
                r[2] = 0;
                r[3..].fill(0);
                if q[1] == 0x0C {
                    r[3] = 1; // first LED of each chunk in region 1
                } else {
                    r[3..11].copy_from_slice(&[5, q[2], q[3], 7, 0x88, 0x13, 0, 0]);
                }
                r
            })
            .collect();
        let restore = mix_restore_packets(&reqs, &replies, info).unwrap();
        assert_eq!(restore.len(), 6);
        assert_eq!(&restore[0][..6], &[0xA8, 0x0D, 0, 28, 1, 0]);
        assert_eq!(&restore[1][..6], &[0xA8, 0x0D, 28, 2, 1, 0]);
        assert_eq!(&restore[4][..13], &[0xA8, 0x0F, 1, 0, 3, 5, 1, 0, 7, 0x88, 0x13, 0, 0]);
        assert_eq!(&restore[5][..5], &[0xA8, 0x0F, 1, 3, 2]);
        // A refused read: nothing to put back.
        let mut bad = replies.clone();
        bad[3][2] = 1;
        assert!(mix_restore_packets(&reqs, &bad, info).is_none());
        let mut count = led_count_request();
        count[2] = 0;
        count[3] = 109;
        assert_eq!(parse_led_count(&count), Some(109));
    }

    #[test]
    fn key_reports_name_the_keys_that_moved() {
        assert_eq!(&key_report_request(true)[..4], &[0x07, 0x00, 0x0D, 1]);
        assert_eq!(&key_report_request(false)[..4], &[0x07, 0x00, 0x0D, 0]);

        // What host_test.c checks the module sends: A down, a macro key, a knob click, A up.
        let r = report(&[PS_KEY_REPORT_ID, 5, 0, 3, 1, 1, 2, 2, 1, 253, 0, 1, 253, 0, 0, 3, 1, 0]);
        let (events, dropped) = key_report(&r).unwrap();
        let got: Vec<(&str, bool)> = events.iter().map(|e| (e.key.as_str(), e.down)).collect();
        assert_eq!(got, [("3,1", true), ("2,2", true), ("e0:cw", true), ("e0:cw", false), ("3,1", false)]);
        assert_eq!(dropped, 0);

        // Counter-clockwise, a combo's position (254) left out, and a count past what fits.
        let r = report(&[PS_KEY_REPORT_ID, 200, 7, 252, 1, 1, 254, 0, 1]);
        let (events, dropped) = key_report(&r).unwrap();
        assert_eq!(events[0], KeyEvent { key: "e1:ccw".into(), down: true });
        assert_eq!(events.len(), 1 + 7, "the combo is skipped; the zero padding reads as 0,0 releases");
        assert_eq!(dropped, 7);

        // Not a key report: Keychron's layer notification, a reply.
        assert_eq!(key_report(&report(&[KC_GET_DEFAULT_LAYER, 2])), None);
        assert_eq!(key_report(&key_report_request(true)), None);
    }

    /// The profile the firmware host test (firmware/test/host_test.c) replays. Its packets are
    /// written to firmware/test/fixture.h, so both sides are checked against the same bytes.
    /// Regenerate after a protocol change with `UPDATE_FIXTURE=1 cargo test`.
    #[test]
    fn firmware_fixture() {
        use crate::model::{Anim, KeyAnim};
        let km = build_keymap(
            &profile(&[
                ("L2:3,1", Bind::Key { keycode: 0x0014 }), // KC_Q
                ("L2:1,1", Bind::Key { keycode: 0x0000 }), // KC_NO: key disabled
                ("L2:e0:cw", Bind::Qmk { source: "LCTL(KC_C)".into(), keycode: 0x0106 }),
                ("L2:0,5", mac("hold", vec![MacroStep::Down { keycode: 0x0004 }])), // slot 0, leaves A held
                (
                    "L2:2,2", // slot 1
                    mac(
                        "Hi",
                        vec![
                            MacroStep::Down { keycode: 0x00E1 }, // LSFT
                            MacroStep::Tap { keycode: 0x000B },  // H
                            MacroStep::Up { keycode: 0x00E1 },
                            MacroStep::Delay { ms: 20 },
                            MacroStep::Tap { keycode: 0x000C }, // I
                        ],
                    ),
                ),
                ("L3:3,1", Bind::Key { keycode: 0x003A }),                      // layer 3: KC_F1
                ("L3:e0:ccw", Bind::Key { keycode: 0x0081 }),                   // layer 3: knob ccw
                ("L3:1,2", mac("J", vec![MacroStep::Tap { keycode: 0x000D }])), // slot 2, on layer 3
                ("L0:4,2", Bind::Key { keycode: 0x0005 }),                      // layer 0: KC_B
            ]),
            DEFAULT_MACRO_GAP,
        )
        .unwrap();
        let mut text = String::from("// Generated by `cargo test` (protocol::tests::firmware_fixture). Do not edit.\n");
        // What the current module gets (macros with their gap); the tag is the one COMMIT carries.
        let out = km.packets(2, 4, V6);
        text += &format!("#define FIXTURE_TAG 0x{:04X}\n", out.tag);
        text += "static const uint8_t FIXTURE_PACKETS[][32] = {\n";
        for p in out.packets {
            let bytes: Vec<String> = p.iter().map(|b| format!("0x{b:02X}")).collect();
            text += &format!("    {{{}}},\n", bytes.join(", "));
        }
        text += "};\n";
        let rgb = Lighting {
            effect: 4,
            speed: 0,
            brightness: 255,
            hue: 0,
            sat: 0,
            keys: [
                ("3,1", Hsv { h: 0, s: 255, v: 255 }),
                ("2,2", Hsv { h: 170, s: 255, v: 128 }),
                ("e0:cw", Hsv { h: 1, s: 1, v: 1 }),
                ("1,5", Hsv { h: 10, s: 255, v: 200 }), // breathes
                ("1,6", Hsv { h: 20, s: 255, v: 200 }), // cycles
                ("1,7", Hsv { h: 30, s: 255, v: 200 }), // lights on keypress
            ]
            .into_iter()
            .map(|(k, c)| (k.to_string(), c))
            .collect(),
            key_anims: [(Anim::Breathe, "1,5"), (Anim::Cycle, "1,6"), (Anim::Reactive, "1,7")]
                .into_iter()
                .map(|(anim, k)| (k.to_string(), KeyAnim { anim, speed: 128 }))
                .collect(),
            ..Default::default()
        };
        let bytes: Vec<String> = key_report_request(true).iter().map(|b| format!("0x{b:02X}")).collect();
        text += &format!(
            "static const uint8_t FIXTURE_KEY_REPORT_ON[32] = {{{}}};
",
            bytes.join(", ")
        );
        let bytes: Vec<String> = key_report_request(false).iter().map(|b| format!("0x{b:02X}")).collect();
        text += &format!(
            "static const uint8_t FIXTURE_KEY_REPORT_OFF[32] = {{{}}};
",
            bytes.join(", ")
        );
        let wave = Lighting { effect: 5, speed: 40, brightness: 255, hue: 132, sat: 255, ..Default::default() };
        let bytes: Vec<String> = module_lighting_packet(&wave).iter().map(|b| format!("0x{b:02X}")).collect();
        text += &format!("static const uint8_t FIXTURE_LIGHTING[32] = {{{}}};\n", bytes.join(", "));

        text += "static const uint8_t FIXTURE_RGB_PACKETS[][32] = {\n";
        for p in key_color_packets(&rgb, V6) {
            let bytes: Vec<String> = p.iter().map(|b| format!("0x{b:02X}")).collect();
            text += &format!("    {{{}}},\n", bytes.join(", "));
        }
        text += "};\n";

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../firmware/test/fixture.h");
        if std::env::var_os("UPDATE_FIXTURE").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        // Compare content, not line endings: a Windows checkout with core.autocrlf=true turns the
        // file CRLF, which the C host test doesn't mind but an exact match would.
        let on_disk = on_disk.replace("\r\n", "\n");
        assert!(on_disk == text, "firmware/test/fixture.h is stale: run `UPDATE_FIXTURE=1 cargo test`");
    }
}
