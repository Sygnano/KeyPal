//! Keyboard layouts, for the key legends. A keyboard only sends key *positions*; the character a
//! position types (A on AZERTY, Q on QWERTY) is decided by the computer's layout. So the legends
//! come from Windows: the layouts it knows, and what each key types in one of them.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    /// Windows keyboard layout id (KLID), e.g. "0000040C" for French.
    pub id: String,
    pub name: String,
    /// In the user's own list of input layouts.
    pub installed: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutList {
    /// The layout Windows uses by default, when known.
    pub current: Option<String>,
    /// Installed layouts first, then every other layout Windows ships, by name.
    pub layouts: Vec<LayoutInfo>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Legend {
    pub base: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altgr: Option<String>,
    /// The levels ("base", "shift", "altgr") that are dead keys: the UI needs it to type text.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dead: Vec<&'static str>,
}

/// QMK basic keycodes that type a character, with the PC scancode (set 1) of the same key
/// position. Positions don't depend on the layout; what they type does.
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows side
pub const PRINTABLE: &[(u16, u16)] = &[
    (0x04, 0x1E),
    (0x05, 0x30),
    (0x06, 0x2E),
    (0x07, 0x20),
    (0x08, 0x12),
    (0x09, 0x21), // A-F
    (0x0A, 0x22),
    (0x0B, 0x23),
    (0x0C, 0x17),
    (0x0D, 0x24),
    (0x0E, 0x25),
    (0x0F, 0x26), // G-L
    (0x10, 0x32),
    (0x11, 0x31),
    (0x12, 0x18),
    (0x13, 0x19),
    (0x14, 0x10),
    (0x15, 0x13), // M-R
    (0x16, 0x1F),
    (0x17, 0x14),
    (0x18, 0x16),
    (0x19, 0x2F),
    (0x1A, 0x11),
    (0x1B, 0x2D), // S-X
    (0x1C, 0x15),
    (0x1D, 0x2C), // Y Z
    (0x1E, 0x02),
    (0x1F, 0x03),
    (0x20, 0x04),
    (0x21, 0x05),
    (0x22, 0x06), // 1-5
    (0x23, 0x07),
    (0x24, 0x08),
    (0x25, 0x09),
    (0x26, 0x0A),
    (0x27, 0x0B), // 6-0
    (0x2D, 0x0C), // KC_MINS
    (0x2E, 0x0D), // KC_EQL
    (0x2F, 0x1A), // KC_LBRC
    (0x30, 0x1B), // KC_RBRC
    (0x31, 0x2B), // KC_BSLS (ANSI)
    (0x32, 0x2B), // KC_NUHS (ISO key left of Enter: same scancode)
    (0x33, 0x27), // KC_SCLN
    (0x34, 0x28), // KC_QUOT
    (0x35, 0x29), // KC_GRV
    (0x36, 0x33), // KC_COMM
    (0x37, 0x34), // KC_DOT
    (0x38, 0x35), // KC_SLSH
    (0x64, 0x56), // KC_NUBS (ISO key right of left Shift)
];

/// Keycap legend from what a key types alone, with Shift and with AltGr. Letters show one
/// capital, like on a real keycap; a Shift character equal to the plain one isn't repeated.
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows side
pub fn legend_from(base: Option<String>, shift: Option<String>, altgr: Option<String>) -> Option<Legend> {
    let base = base?;
    let letter = base.chars().count() == 1 && base.chars().all(char::is_alphabetic);
    if letter && shift.as_deref().is_none_or(|s| s == base.to_uppercase()) {
        return Some(Legend { base: base.to_uppercase(), shift: None, altgr, dead: vec![] });
    }
    let shift = shift.filter(|s| *s != base);
    Some(Legend { base, shift, altgr, dead: vec![] })
}

/// Only printable text: Windows returns control characters for some keys (e.g. Ctrl+Alt+[ ).
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows side
fn printable(s: String) -> Option<String> {
    (!s.is_empty() && s.chars().all(|c| !c.is_control())).then_some(s)
}

pub fn list() -> LayoutList {
    imp::list()
}

/// Legend per keycode (as a decimal string, for JSON) for one layout.
pub fn legends(id: &str) -> Result<BTreeMap<String, Legend>, String> {
    imp::legends(id)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegEnumValueW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
        RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayoutList, GetKeyboardLayoutNameW, LoadKeyboardLayoutW, MapVirtualKeyExW, ToUnicodeEx, UnloadKeyboardLayout, HKL,
        KLF_NOTELLSHELL, MAPVK_VSC_TO_VK_EX, VK_CONTROL, VK_LCONTROL, VK_LSHIFT, VK_MENU, VK_RMENU, VK_SHIFT,
    };

    const ALL_LAYOUTS: &str = r"SYSTEM\CurrentControlSet\Control\Keyboard Layouts";

    fn reg_string(root: HKEY, key: &str, value: &str) -> Option<String> {
        let mut buf = [0u16; 260];
        let mut len = (buf.len() * 2) as u32;
        // SAFETY: `buf` is a writable buffer of `len` bytes; the key/value are NUL-terminated
        // HSTRINGs, and `len` is updated to the bytes written.
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
        if err != ERROR_SUCCESS {
            return None;
        }
        let chars = (len as usize / 2).saturating_sub(1); // without the terminating NUL
        Some(String::from_utf16_lossy(&buf[..chars.min(buf.len())]))
    }

    fn open(root: HKEY, key: &str) -> Option<HKEY> {
        let mut h = HKEY::default();
        // SAFETY: `h` is a valid out-parameter and the key is a NUL-terminated HSTRING; the
        // returned handle is closed by the caller.
        let err = unsafe { RegOpenKeyExW(root, &HSTRING::from(key), Some(0), KEY_READ, &mut h) };
        (err == ERROR_SUCCESS).then_some(h)
    }

    /// Every layout Windows ships: the subkeys of Keyboard Layouts, with their "Layout Text".
    fn all_layouts() -> Vec<(String, String)> {
        let Some(h) = open(HKEY_LOCAL_MACHINE, ALL_LAYOUTS) else { return vec![] };
        let mut out = vec![];
        for i in 0.. {
            // SAFETY: `name` is a writable buffer of `len` u16s; `h` is a key opened above.
            let mut name = [0u16; 64];
            let mut len = name.len() as u32;
            let err = unsafe { RegEnumKeyExW(h, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, Some(PWSTR::null()), None, None) };
            if err != ERROR_SUCCESS {
                break;
            }
            let id = String::from_utf16_lossy(&name[..len as usize]).to_uppercase();
            if let Some(text) = reg_string(HKEY_LOCAL_MACHINE, &format!(r"{ALL_LAYOUTS}\{id}"), "Layout Text") {
                out.push((id, text));
            }
            // SAFETY: `h` is a key opened above and not used afterwards.
        }
        unsafe {
            let _ = RegCloseKey(h);
        }
        out
    }

    /// The user's input layouts, in their order (Keyboard Layout\Preload, through Substitutes).
    fn installed() -> Vec<String> {
        let Some(h) = open(HKEY_CURRENT_USER, r"Keyboard Layout\Preload") else { return vec![] };
        let mut entries: Vec<(u32, String)> = vec![];
        for i in 0.. {
            let mut name = [0u16; 16];
            let mut name_len = name.len() as u32;
            let mut data = [0u16; 16];
            // SAFETY: `name`/`data` are writable buffers of the lengths passed; `h` is a key
            // opened above.
            let mut data_len = (data.len() * 2) as u32;
            let err = unsafe {
                RegEnumValueW(
                    h,
                    i,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut name_len,
                    None,
                    None,
                    Some(data.as_mut_ptr().cast()),
                    Some(&mut data_len),
                )
            };
            if err != ERROR_SUCCESS {
                break;
            }
            let order = String::from_utf16_lossy(&name[..name_len as usize]).parse().unwrap_or(u32::MAX);
            // SAFETY: `h` is a key opened above and not used afterwards.
            let klid = String::from_utf16_lossy(&data[..(data_len as usize / 2)]).trim_end_matches('\0').to_uppercase();
            entries.push((order, klid));
        }
        unsafe {
            let _ = RegCloseKey(h);
        }
        entries.sort();
        entries
            .into_iter()
            .map(|(_, klid)| reg_string(HKEY_CURRENT_USER, r"Keyboard Layout\Substitutes", &klid).map(|s| s.to_uppercase()).unwrap_or(klid))
            .collect()
    }
    // SAFETY: `name` is a writable buffer of 9 u16s, the size the API expects (KL_NAMELENGTH).

    fn current() -> Option<String> {
        let mut name = [0u16; 9];
        unsafe { GetKeyboardLayoutNameW(&mut name) }.ok()?;
        Some(String::from_utf16_lossy(&name[..8]).to_uppercase())
    }

    pub fn list() -> LayoutList {
        let all = all_layouts();
        let mine = installed();
        let name_of = |id: &str| all.iter().find(|(k, _)| k == id).map(|(_, n)| n.clone());
        let mut layouts: Vec<LayoutInfo> =
            mine.iter().filter_map(|id| Some(LayoutInfo { id: id.clone(), name: name_of(id)?, installed: true })).collect();
        let mut rest: Vec<LayoutInfo> = all
            .iter()
            .filter(|(id, _)| !mine.contains(id))
            .map(|(id, name)| LayoutInfo { id: id.clone(), name: name.clone(), installed: false })
            .collect();
        rest.sort_by(|a, b| a.name.cmp(&b.name));
        layouts.extend(rest);
        LayoutList { current: current().or_else(|| mine.first().cloned()), layouts }
    }

    fn loaded_layouts() -> Vec<HKL> {
        // SAFETY: a null buffer asks for the count only; the second call fills a buffer of that
        // length, and the result is truncated to what it wrote.
        let n = unsafe { GetKeyboardLayoutList(None) };
        let mut list = vec![HKL::default(); n.max(0) as usize];
        let got = unsafe { GetKeyboardLayoutList(Some(&mut list)) };
        list.truncate(got.max(0) as usize);
        list
    }

    /// What one key types in `hkl` with this modifier state, and whether it is a dead key.
    fn type_key(hkl: HKL, scancode: u16, state: &[u8; 256]) -> Option<(String, bool)> {
        // SAFETY: `hkl` is a layout handle loaded by the caller; the scancode is a plain value.
        let vk = unsafe { MapVirtualKeyExW(scancode as u32, MAPVK_VSC_TO_VK_EX, Some(hkl)) };
        if vk == 0 {
            return None;
        }
        let mut buf = [0u16; 8];
        // Flag 0x4: don't change the keyboard state (no dead key left pending). Windows 10 1607+.
        // SAFETY: `state` is a 256-byte key-state array and `buf` is a writable buffer of 8 u16s.
        let n = unsafe { ToUnicodeEx(vk, scancode as u32, state, &mut buf, 0x4, Some(hkl)) };
        let len = match n {
            0 => return None,
            n if n < 0 => 1, // a dead key (^, ¨, ~…): its own character is in the buffer
            n => n as usize,
        };
        printable(String::from_utf16_lossy(&buf[..len.min(buf.len())])).map(|s| (s, n < 0))
    }

    pub fn legends(id: &str) -> Result<BTreeMap<String, Legend>, String> {
        if id.len() != 8 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("{id:?} isn't a keyboard layout id"));
        }
        let before = loaded_layouts();
        // SAFETY: the id is a NUL-terminated HSTRING; the returned handle is unloaded below when
        // the user didn't already have the layout.
        let hkl = unsafe { LoadKeyboardLayoutW(PCWSTR(HSTRING::from(id).as_ptr()), KLF_NOTELLSHELL) }
            .map_err(|e| format!("Windows couldn't load layout {id}: {e}"))?;

        let plain = [0u8; 256];
        let mut shift = [0u8; 256];
        shift[VK_SHIFT.0 as usize] = 0x80;
        shift[VK_LSHIFT.0 as usize] = 0x80;
        let mut altgr = [0u8; 256]; // AltGr is Ctrl + right Alt
        for vk in [VK_CONTROL, VK_LCONTROL, VK_MENU, VK_RMENU] {
            altgr[vk.0 as usize] = 0x80;
        }

        let mut out = BTreeMap::new();
        for &(kc, sc) in PRINTABLE {
            let typed = [("base", &plain), ("shift", &shift), ("altgr", &altgr)].map(|(level, state)| (level, type_key(hkl, sc, state)));
            let [base, shift, altgr] = typed.clone().map(|(_, t)| t.map(|(s, _)| s));
            if let Some(mut l) = legend_from(base, shift, altgr) {
                let shown = [true, l.shift.is_some(), l.altgr.is_some()];
                l.dead = typed
                    .iter()
                    .zip(shown)
                    .filter(|((_, t), shown)| *shown && t.as_ref().is_some_and(|t| t.1))
                    .map(|((level, _), _)| *level)
                    .collect();
                out.insert(kc.to_string(), l);
            }
        }
        // Don't leave a layout the user doesn't have in their language bar.
        if !before.contains(&hkl) {
            // SAFETY: `hkl` was loaded above and is not used afterwards.
            unsafe {
                let _ = UnloadKeyboardLayout(hkl);
            }
        }
        Ok(out)
    }
}

/// Other platforms (development only): no layouts to ask; the UI keeps its built-in tables.
#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn list() -> LayoutList {
        LayoutList::default()
    }

    pub fn legends(_id: &str) -> Result<BTreeMap<String, Legend>, String> {
        Err("Keyboard layouts come from Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> Option<String> {
        Some(x.to_string())
    }

    #[test]
    fn letters_show_one_capital() {
        assert_eq!(legend_from(s("a"), s("A"), None), Some(Legend { base: "A".into(), ..Default::default() }));
        assert_eq!(legend_from(s("e"), s("E"), s("€")).unwrap().altgr.as_deref(), Some("€"));
        assert_eq!(legend_from(s("é"), s("2"), s("~")).unwrap(), Legend { base: "é".into(), shift: s("2"), altgr: s("~"), dead: vec![] });
        assert_eq!(legend_from(s("ß"), s("?"), s("\\")).unwrap().shift.as_deref(), Some("?"), "ß isn't shown as a capital");
    }

    #[test]
    fn symbols_keep_their_shift_character() {
        assert_eq!(legend_from(s("&"), s("1"), None).unwrap(), Legend { base: "&".into(), shift: s("1"), ..Default::default() });
        assert_eq!(legend_from(s("*"), s("*"), None).unwrap().shift, None, "not repeated");
        assert_eq!(legend_from(None, s("x"), None), None, "nothing typed without modifiers: no legend");
    }

    /// Asks Windows itself: French has ^ and ¨ as dead keys on one key, and é is not one.
    #[cfg(windows)]
    #[test]
    fn windows_says_which_keys_are_dead() {
        let french = legends("0000040C").expect("Windows ships the French layout");
        assert_eq!(french["47"].base, "^"); // KC_LBRC
        assert_eq!(french["47"].dead, ["base", "shift"]);
        assert_eq!(french["31"].dead, ["altgr"], "AltGr+2 is the dead ~"); // KC_2
        assert!(french["20"].dead.is_empty()); // KC_Q, "A"
    }

    #[test]
    fn printable_keys_cover_every_position_once() {
        let mut kcs: Vec<u16> = PRINTABLE.iter().map(|&(kc, _)| kc).collect();
        kcs.sort();
        kcs.dedup();
        assert_eq!(kcs.len(), PRINTABLE.len(), "no keycode twice");
        assert_eq!(PRINTABLE.len(), 26 + 10 + 13, "letters, digits, 13 symbol keys");
        assert!(printable("\u{1b}".into()).is_none());
    }
}
