//! Polls the foreground window every 250 ms and reports its program and title when they change.
//! Also lists the programs that have a window open, for the "running programs" picker.

use serde::Serialize;
use std::thread;
use std::time::Duration;

const POLL_EVERY: Duration = Duration::from_millis(250);

/// The focused window's program and title.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Focus {
    /// Full path of the program, e.g. "C:\\Games\\cs2.exe".
    pub path: String,
    pub title: String,
}

impl Focus {
    /// "cs2.exe"
    pub fn exe(&self) -> &str {
        file_name(&self.path)
    }
}

#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Foreground {
    Program(Focus),
    /// Our own window: never changes the profile.
    Own,
    /// No window (secure desktop, UAC prompt…) or a process we may not inspect: keep the profile.
    Unknown,
}

/// A program with a window open, for the picker.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningProgram {
    pub path: String,
    pub name: String,
    pub title: String,
}

/// Calls `on_change` whenever the focused program or its window title changes.
pub fn spawn(on_change: impl Fn(Focus) + Send + 'static) {
    thread::Builder::new()
        .name("v6ps-watcher".into())
        .spawn(move || {
            let mut last: Option<Focus> = None;
            loop {
                if let Foreground::Program(focus) = foreground() {
                    if last.as_ref() != Some(&focus) {
                        last = Some(focus.clone());
                        on_change(focus);
                    }
                }
                thread::sleep(POLL_EVERY);
            }
        })
        .expect("spawn watcher thread");
}

#[cfg(windows)]
mod win {
    use super::{file_name, Focus, RunningProgram};
    use windows::core::BOOL;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    /// The window's process id and program path, None if it can't be inspected.
    pub fn program_of(hwnd: HWND) -> Option<(u32, String)> {
        // SAFETY: `hwnd` is a window handle from the caller; the process handle opened here is
        // closed before returning, and `buf` is a writable buffer of the length passed.
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            ok.ok()?;
            Some((pid, String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    pub fn title_of(hwnd: HWND) -> String {
        // SAFETY: `hwnd` is a window handle from the caller; `buf` is sized from the length the
        // API reported and is a writable buffer of that length.
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    /// Top-level windows a user would call "a program": visible, titled, not owned, not a tool window.
    ///
    /// # Safety
    /// Called by `EnumWindows` with `out` a valid `*mut Vec<RunningProgram>` (see `running`).
    unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
        let list = &mut *(out.0 as *mut Vec<RunningProgram>);
        let tool = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0;
        let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
        if !IsWindowVisible(hwnd).as_bool() || tool || owned {
            return BOOL(1);
        }
        let title = title_of(hwnd);
        if title.is_empty() {
            return BOOL(1);
        }
        if let Some((pid, path)) = program_of(hwnd) {
            if pid != std::process::id() {
                let name = file_name(&path).to_string();
                list.push(RunningProgram { path, name, title });
            }
        }
        BOOL(1)
    }
    // SAFETY: `collect` is called with a pointer to `list`, which outlives the call.

    pub fn running() -> Vec<RunningProgram> {
        let mut list: Vec<RunningProgram> = vec![];
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
        }
        list
    }

    pub fn focus_of(hwnd: HWND) -> Option<(u32, Focus)> {
        let (pid, path) = program_of(hwnd)?;
        Some((pid, Focus { path, title: title_of(hwnd) }))
    }
}

#[cfg(windows)]
fn foreground() -> Foreground {
    // SAFETY: no arguments; the returned handle is only checked and passed on.
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return Foreground::Unknown;
    }
    match win::focus_of(hwnd) {
        Some((pid, _)) if pid == std::process::id() => Foreground::Own,
        Some((_, focus)) => Foreground::Program(focus),
        None => Foreground::Unknown,
    }
}

/// Other platforms (development only): nothing to watch, the profile stays on Default.
#[cfg(not(windows))]
fn foreground() -> Foreground {
    Foreground::Unknown
}

/// Programs with a window open, one entry per program and title, sorted by name.
pub fn running_programs() -> Vec<RunningProgram> {
    #[cfg(windows)]
    let mut list = win::running();
    #[cfg(not(windows))]
    let mut list: Vec<RunningProgram> = vec![];
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.title.cmp(&b.title)));
    list.dedup();
    list
}

/// "C:\\Games\\cs2.exe" → "cs2.exe"
pub fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::{file_name, Focus};

    #[test]
    fn file_names() {
        assert_eq!(file_name("C:\\Games\\cs2.exe"), "cs2.exe");
        assert_eq!(file_name("C:/Games/cs2.exe"), "cs2.exe");
        assert_eq!(file_name("cs2.exe"), "cs2.exe");
        assert_eq!(Focus { path: "D:\\x\\Game.exe".into(), title: "t".into() }.exe(), "Game.exe");
    }

    #[test]
    fn running_programs_does_not_panic() {
        // On Windows this enumerates real windows; elsewhere it's empty.
        let list = super::running_programs();
        assert!(list.iter().all(|p| !p.title.is_empty() && !p.path.is_empty()));
    }
}
