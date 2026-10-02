//! Program and folder icons for the UI, as PNG data URLs (the webview's CSP allows `data:`
//! images). Asked from the Windows shell, so a program shows the icon Explorer shows. Cached for
//! the app's lifetime. Other platforms: none.

use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The icon of a program (or folder) as `data:image/png;base64,…`. A program that isn't there any
/// more gets Windows' generic icon for its kind. None for an empty path or when Windows has none.
pub fn icon_data_url(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let key = path.to_lowercase();
    if let Some(hit) = cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return hit.clone();
    }
    let url = platform::icon_rgba(path)
        .and_then(|(w, h, rgba)| encode_png(w, h, &rgba))
        .map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
    cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, url.clone());
    url
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// "C:\\x\\game.exe" looks like a file, "D:\\Games" like a folder (for paths that no longer exist).
#[cfg_attr(not(windows), allow(dead_code))]
fn looks_like_file(path: &str) -> bool {
    crate::watcher::file_name(path).contains('.')
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HDC,
    };
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// Width, height and RGBA pixels of the path's large (32 px) shell icon.
    pub fn icon_rgba(path: &str) -> Option<(u32, u32, Vec<u8>)> {
        // SAFETY: `wide` is NUL-terminated and outlives the call; `info` is a zeroed SHFILEINFOW
        // of the size passed; the icon handle is destroyed here, and COM is uninitialised only if
        // this call initialised it.
        unsafe {
            // The shell wants COM on the calling thread (a blocking-pool thread here).
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let mut info = SHFILEINFOW::default();
            let flags = SHGFI_ICON | SHGFI_LARGEICON;
            let size = size_of::<SHFILEINFOW>() as u32;
            let mut got = SHGetFileInfoW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(0), Some(&mut info), size, flags);
            if got == 0 || info.hIcon.is_invalid() {
                // Not there any more: the generic icon for a program or a folder.
                let kind = if super::looks_like_file(path) { FILE_ATTRIBUTE_NORMAL } else { FILE_ATTRIBUTE_DIRECTORY };
                got = SHGetFileInfoW(PCWSTR(wide.as_ptr()), kind, Some(&mut info), size, flags | SHGFI_USEFILEATTRIBUTES);
            }
            let out = if got != 0 && !info.hIcon.is_invalid() {
                let pixels = icon_pixels(info.hIcon);
                let _ = DestroyIcon(info.hIcon);
                pixels
            } else {
                None
            };
            if com {
                CoUninitialize();
            }
            out
        }
    }

    /// # Safety
    /// `icon` must be a valid HICON the caller owns; the bitmaps it returns are deleted here.
    unsafe fn icon_pixels(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut ii = ICONINFO::default();
        GetIconInfo(icon, &mut ii).ok()?;
        let (color, mask) = (ii.hbmColor, ii.hbmMask);
        let out = (|| {
            if color.is_invalid() {
                return None; // a black-and-white icon: not worth showing
            }
            let mut bm = BITMAP::default();
            if GetObjectW(color.into(), size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0 {
                return None;
            }
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            if w <= 0 || h <= 0 || w > 256 || h > 256 {
                return None;
            }
            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let dc = CreateCompatibleDC(Some(HDC::default()));
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(dc, color, 0, h as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
            // Older icons have no alpha channel: their AND mask says which pixels are see-through.
            let mut and_mask = None;
            if lines != 0 && bgra.as_chunks::<4>().0.iter().all(|p| p[3] == 0) && !mask.is_invalid() {
                let mut m = vec![0u8; (w * h * 4) as usize];
                if GetDIBits(dc, mask, 0, h as u32, Some(m.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS) != 0 {
                    and_mask = Some(m);
                }
            }
            let _ = DeleteDC(dc);
            if lines == 0 {
                return None;
            }
            let mut rgba = Vec::with_capacity(bgra.len());
            for (i, p) in bgra.as_chunks::<4>().0.iter().enumerate() {
                let alpha = match &and_mask {
                    Some(m) => {
                        if m[i * 4] == 0 {
                            255
                        } else {
                            0
                        }
                    }
                    None => p[3],
                };
                rgba.extend_from_slice(&[p[2], p[1], p[0], alpha]);
            }
            Some((w as u32, h as u32, rgba))
        })();
        if !color.is_invalid() {
            let _ = DeleteObject(color.into());
        }
        if !mask.is_invalid() {
            let _ = DeleteObject(mask.into());
        }
        out
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn icon_rgba(_path: &str) -> Option<(u32, u32, Vec<u8>)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_data_urls() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 0, 255, 128]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(icon_data_url("  "), None);
        assert!(looks_like_file("C:\\Games\\cs2.exe") && !looks_like_file("D:\\Games"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_gives_icons_even_for_missing_programs() {
        let explorer = icon_data_url("C:\\Windows\\explorer.exe").expect("explorer has an icon");
        assert!(explorer.starts_with("data:image/png;base64,"));
        assert!(icon_data_url("C:\\Nowhere\\gone.exe").is_some(), "the generic program icon");
        assert!(icon_data_url("C:\\Windows").is_some(), "a folder");
        assert_eq!(icon_data_url("c:\\windows\\EXPLORER.exe"), Some(explorer), "cached, case-insensitive");
    }

    /// `ICON_DUMP=<folder> cargo test dump_icons` writes a few icons as PNG files, to look at them.
    #[test]
    fn dump_icons() {
        let Some(dir) = std::env::var_os("ICON_DUMP") else { return };
        for (name, path) in [
            ("explorer", "C:\\Windows\\explorer.exe"),
            ("notepad", "C:\\Windows\\notepad.exe"),
            ("osk", "C:\\Windows\\System32\\osk.exe"),
            ("missing", "C:\\Nowhere\\gone.exe"),
            ("folder", "C:\\Windows"),
        ] {
            let url = icon_data_url(path).unwrap();
            let png = STANDARD.decode(url.trim_start_matches("data:image/png;base64,")).unwrap();
            std::fs::write(std::path::Path::new(&dir).join(format!("{name}.png")), png).unwrap();
        }
    }
}
