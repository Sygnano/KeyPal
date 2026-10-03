//! Long tasks of the Firmware tab (downloads, installs, builds, flashing), one at a time, on their
//! own thread. They report through events: a state change (`fw-job`) and output lines (`fw-log`).

use serde::Serialize;
use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Toolchain,
    Source,
    Drivers,
    Tools,
    Build,
    Flash,
    /// Reading the keyboard's firmware into a backup, nothing written.
    Backup,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Running,
    Ok,
    Failed,
    Cancelled,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: u64,
    pub kind: JobKind,
    pub state: JobState,
    /// What happened (the result, or why it failed).
    pub message: Option<String>,
    /// Progress of the current step, 0–1, when known.
    pub progress: Option<f64>,
    /// What's being done now ("Downloading QMK MSYS", "Receiving objects").
    pub step: Option<String>,
    /// False while the job is in a step that must not be interrupted (writing the firmware): the
    /// UI hides Cancel, and `Jobs::cancel` refuses.
    pub cancellable: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub id: u64,
    pub line: String,
}

pub enum FwEvent {
    Job(JobEvent),
    Log(LogLine),
}

pub type Emit = Arc<dyn Fn(FwEvent) + Send + Sync>;

struct Running {
    id: u64,
    kind: JobKind,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<u32>>>,
    locked: Arc<AtomicBool>,
}

pub struct Jobs {
    current: Arc<Mutex<Option<Running>>>,
    next: AtomicU64,
    emit: Emit,
}

impl Jobs {
    pub fn new(emit: Emit) -> Self {
        Jobs { current: Arc::new(Mutex::new(None)), next: AtomicU64::new(1), emit }
    }

    /// The running job, if any: (id, kind).
    pub fn running(&self) -> Option<(u64, JobKind)> {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|r| (r.id, r.kind))
    }

    /// Starts `work` on its own thread. Its Ok is the success message. Refused while another job runs.
    pub fn start(&self, kind: JobKind, work: impl FnOnce(&JobCtx) -> Result<String, String> + Send + 'static) -> Result<u64, String> {
        let mut current = self.current.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(r) = current.as_ref() {
            return Err(format!("Wait for the current task ({}) to finish, or cancel it.", kind_name(r.kind)));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let ctx = JobCtx {
            id,
            kind,
            cancel: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            locked: Arc::new(AtomicBool::new(false)),
            emit: self.emit.clone(),
        };
        *current = Some(Running { id, kind, cancel: ctx.cancel.clone(), child: ctx.child.clone(), locked: ctx.locked.clone() });
        drop(current);
        ctx.state(JobState::Running, None);
        log::info!("firmware task {id} ({}) started", kind_name(kind));
        let slot = self.current.clone();
        let spawned = thread::Builder::new().name(format!("v6ps-fw-{}", kind_name(kind))).spawn(move || {
            // Declared first, so it is dropped *last*: the terminal state goes out before the
            // slot is free, and a panic in `work` still frees it.
            let _guard = Slot(slot);
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| work(&ctx))).unwrap_or_else(|_| {
                log::error!("firmware task {} ({}) panicked", ctx.id, kind_name(ctx.kind));
                Err("The task stopped unexpectedly. See the log for what it was doing.".to_string())
            });
            let (state, message) = match result {
                _ if ctx.cancelled() => (JobState::Cancelled, Some("Cancelled.".to_string())),
                Ok(m) => (JobState::Ok, Some(m)),
                Err(e) => (JobState::Failed, Some(e)),
            };
            log::info!("firmware task {} ({}) {:?}: {}", ctx.id, kind_name(ctx.kind), state, message.as_deref().unwrap_or(""));
            ctx.state(state, message);
        });
        if let Err(e) = spawned {
            // The slot was taken above; nothing will ever free it, so free it here.
            *self.current.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return Err(e.to_string());
        }
        Ok(id)
    }

    /// Stops the running job: its downloads stop, its process tree is killed. Refused (false) while
    /// the job is in an uninterruptible step: killing the flashing tool mid-write would leave the
    /// keyboard without firmware, and the Esc way back into its bootloader is part of that firmware.
    pub fn cancel(&self) -> bool {
        if let Some(r) = self.current.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            if r.locked.load(Ordering::Relaxed) {
                log::warn!("firmware task {} ({}): cancel refused while the firmware is being written", r.id, kind_name(r.kind));
                return false;
            }
            r.cancel.store(true, Ordering::Relaxed);
            if let Some(pid) = *r.child.lock().unwrap_or_else(|p| p.into_inner()) {
                kill_tree(pid);
            }
        }
        true
    }
}

/// Frees the "one job at a time" slot when the job's thread ends, however it ends.
struct Slot(Arc<Mutex<Option<Running>>>);

impl Drop for Slot {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// What a running job uses to report and to run processes.
pub struct JobCtx {
    pub id: u64,
    kind: JobKind,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<u32>>>,
    /// Set during an uninterruptible step (see `uninterruptible`).
    locked: Arc<AtomicBool>,
    emit: Emit,
}

/// The job kind as it reads in a log line or a message.
pub fn kind_name(kind: JobKind) -> &'static str {
    match kind {
        JobKind::Toolchain => "toolchain",
        JobKind::Source => "source",
        JobKind::Drivers => "drivers",
        JobKind::Tools => "tools",
        JobKind::Build => "build",
        JobKind::Flash => "flash",
        JobKind::Backup => "backup",
    }
}

impl JobCtx {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    fn state(&self, state: JobState, message: Option<String>) {
        (self.emit)(FwEvent::Job(JobEvent {
            id: self.id,
            kind: self.kind,
            state,
            message,
            progress: None,
            step: None,
            cancellable: !self.locked.load(Ordering::Relaxed),
        }));
    }

    /// Runs `f` as a step Cancel can't interrupt (writing the firmware): `Jobs::cancel` refuses
    /// meanwhile, and every event says `cancellable: false`, so the UI hides its Cancel button.
    pub fn uninterruptible<T>(&self, f: impl FnOnce() -> T) -> T {
        self.locked.store(true, Ordering::Relaxed);
        let out = f();
        self.locked.store(false, Ordering::Relaxed);
        out
    }

    pub fn log(&self, line: impl Into<String>) {
        (self.emit)(FwEvent::Log(LogLine { id: self.id, line: line.into() }));
    }

    /// The current step and how far along it is (None: unknown).
    pub fn step(&self, step: &str, progress: Option<f64>) {
        (self.emit)(FwEvent::Job(JobEvent {
            id: self.id,
            kind: self.kind,
            state: JobState::Running,
            message: None,
            progress,
            step: Some(step.into()),
            cancellable: !self.locked.load(Ordering::Relaxed),
        }));
    }

    /// Runs a process to the end, its output (both streams) sent as log lines. Progress lines that
    /// rewrite themselves ("Receiving objects:  45%", ended by `\r`) become the step instead.
    /// Returns the exit code.
    pub fn run(&self, mut cmd: Command) -> Result<i32, String> {
        if self.cancelled() {
            return Err("Cancelled.".into());
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        no_window(&mut cmd);
        let mut child: Child = cmd.spawn().map_err(|e| format!("Could not start {:?}: {e}", cmd.get_program()))?;
        *self.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child.id());
        // Cancel may have run between the check above and the spawn, when there was no pid to kill.
        if self.cancelled() {
            kill_tree(child.id());
        }
        let readers: Vec<_> = [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|stream| {
            let emit = self.emit.clone();
            let locked = self.locked.clone();
            let (id, kind) = (self.id, self.kind);
            thread::spawn(move || {
                read_lines(stream, |line, rewritten| {
                    if rewritten {
                        if let Some((step, fraction)) = progress_line(&line) {
                            emit(FwEvent::Job(JobEvent {
                                id,
                                kind,
                                state: JobState::Running,
                                message: None,
                                progress: Some(fraction),
                                step: Some(step),
                                cancellable: !locked.load(Ordering::Relaxed),
                            }));
                            return;
                        }
                    }
                    emit(FwEvent::Log(LogLine { id, line }));
                })
            })
        })
        .collect();
        let status = child.wait().map_err(|e| e.to_string())?;
        for r in readers {
            let _ = r.join();
        }
        *self.child.lock().unwrap_or_else(|p| p.into_inner()) = None;
        if self.cancelled() {
            return Err("Cancelled.".into());
        }
        Ok(status.code().unwrap_or(-1))
    }
}

/// Splits a stream into lines at `\n` and `\r`; `f(line, rewritten)`, where `rewritten` means it
/// ended with a lone `\r` (a progress line that the next one overwrites).
pub fn read_lines(mut stream: impl Read, mut f: impl FnMut(String, bool)) {
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = vec![];
    let mut after_cr = false;
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            match b {
                b'\n' => {
                    if !(after_cr && line.is_empty()) {
                        f(clean(&line), false);
                    }
                    line.clear();
                    after_cr = false;
                }
                b'\r' => {
                    if !line.is_empty() {
                        f(clean(&line), true);
                    }
                    line.clear();
                    after_cr = true;
                }
                _ => {
                    line.push(b);
                    after_cr = false;
                }
            }
        }
    }
    if !line.is_empty() {
        f(clean(&line), false);
    }
}

/// Text without terminal colour codes.
fn clean(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// "Receiving objects:  45% (1234/2742), 1.20 MiB | 2.00 MiB/s" → ("Receiving objects", 0.45);
/// dfu-util's "Download\t[=====      ]  45%   12288 bytes" → ("Download", 0.45).
pub fn progress_line(line: &str) -> Option<(String, f64)> {
    if let (Some(open), Some(close)) = (line.find('['), line.find(']')) {
        if open < close {
            let pct = line[close + 1..].trim_start().split('%').next()?.trim();
            let n: f64 = pct.parse().ok()?;
            return (0.0..=100.0).contains(&n).then(|| (line[..open].trim().to_string(), n / 100.0));
        }
    }
    let line = line.trim_start().strip_prefix("remote:").unwrap_or(line);
    let (label, rest) = line.split_once(':')?;
    let pct = rest.trim_start().split('%').next()?.trim();
    let n: f64 = pct.parse().ok()?;
    (0.0..=100.0).contains(&n).then(|| (label.trim().to_string(), n / 100.0))
}

/// No console window flashing up for the tools the app runs.
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_and_progress() {
        let input =
            b"Cloning into 'x'...\nReceiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\r\n\x1b[32;01m[OK]\x1b[0m\nlast";
        let mut got = vec![];
        read_lines(&input[..], |l, r| got.push((l, r)));
        assert_eq!(
            got,
            vec![
                ("Cloning into 'x'...".to_string(), false),
                ("Receiving objects:  10% (1/10)".to_string(), true),
                ("Receiving objects: 100% (10/10), done.".to_string(), true),
                ("[OK]".to_string(), false),
                ("last".to_string(), false),
            ]
        );
        assert_eq!(progress_line("Receiving objects:  45% (1/2)"), Some(("Receiving objects".into(), 0.45)));
        assert_eq!(progress_line("remote: Counting objects:  7% (1/14)"), Some(("Counting objects".into(), 0.07)));
        assert_eq!(progress_line("Compiling: quantum/keymap.c"), None);
        assert_eq!(progress_line("Download\t[=========                ]  38%        28672 bytes"), Some(("Download".into(), 0.38)));
        assert_eq!(progress_line("Linking: .build/x.elf [OK]"), None);
    }

    #[test]
    fn one_job_at_a_time() {
        let events = Arc::new(Mutex::new(vec![]));
        let e2 = events.clone();
        let jobs = Jobs::new(Arc::new(move |e| {
            if let FwEvent::Job(j) = e {
                e2.lock().unwrap().push((j.state, j.message));
            }
        }));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        jobs.start(JobKind::Build, move |ctx| {
            ctx.log("hello");
            rx.recv().unwrap();
            Ok("built".into())
        })
        .unwrap();
        assert!(jobs.start(JobKind::Flash, |_| Ok(String::new())).is_err(), "busy");
        assert_eq!(jobs.running().unwrap().1, JobKind::Build);
        tx.send(()).unwrap();
        for _ in 0..200 {
            if jobs.running().is_none() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(jobs.running().is_none());
        let ev = events.lock().unwrap().clone();
        assert_eq!(ev.first().unwrap().0, JobState::Running);
        assert_eq!(ev.last().unwrap(), &(JobState::Ok, Some("built".to_string())));
    }

    #[test]
    fn cancel_is_refused_while_the_firmware_is_written() {
        let events = Arc::new(Mutex::new(vec![]));
        let e2 = events.clone();
        let jobs = Jobs::new(Arc::new(move |e| {
            if let FwEvent::Job(j) = e {
                e2.lock().unwrap().push((j.step, j.cancellable));
            }
        }));
        let (to_job, job_rx) = std::sync::mpsc::channel::<()>();
        let (to_test, test_rx) = std::sync::mpsc::channel::<()>();
        jobs.start(JobKind::Flash, move |ctx| {
            ctx.uninterruptible(|| {
                ctx.step("Flashing", Some(0.0));
                to_test.send(()).unwrap();
                job_rx.recv().unwrap();
            });
            if ctx.cancelled() {
                return Err("cancelled mid-write".into());
            }
            Ok("flashed".into())
        })
        .unwrap();
        test_rx.recv().unwrap();
        assert!(!jobs.cancel(), "refused during the write");
        to_job.send(()).unwrap();
        for _ in 0..400 {
            if jobs.running().is_none() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        let ev = events.lock().unwrap().clone();
        assert!(ev.contains(&(Some("Flashing".into()), false)), "the write step says it can't be cancelled: {ev:?}");
        assert!(ev.first().unwrap().1, "before it, Cancel is offered");
        // After the write, Cancel works again (a job that is still running can be cancelled).
        let (to_job, job_rx) = std::sync::mpsc::channel::<()>();
        jobs.start(JobKind::Flash, move |ctx| {
            ctx.uninterruptible(|| ());
            job_rx.recv().unwrap();
            Ok(String::new())
        })
        .unwrap();
        thread::sleep(std::time::Duration::from_millis(20));
        assert!(jobs.cancel());
        to_job.send(()).unwrap();
    }

    #[test]
    fn a_panicking_job_does_not_wedge_the_slot() {
        let events = Arc::new(Mutex::new(vec![]));
        let e2 = events.clone();
        let jobs = Jobs::new(Arc::new(move |e| {
            if let FwEvent::Job(j) = e {
                e2.lock().unwrap().push((j.state, j.message));
            }
        }));
        jobs.start(JobKind::Build, |_| panic!("boom")).unwrap();
        for _ in 0..400 {
            if jobs.running().is_none() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(jobs.running().is_none(), "the slot was freed");
        let ev = events.lock().unwrap().clone();
        let (state, message) = ev.last().unwrap().clone();
        assert_eq!(state, JobState::Failed, "the UI is told, rather than left on \"running\"");
        assert!(message.unwrap().contains("stopped unexpectedly"));
        // And the next task can start.
        jobs.start(JobKind::Flash, |_| Ok("flashed".into())).unwrap();
    }
}
