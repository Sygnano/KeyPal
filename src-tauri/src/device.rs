//! Worker thread that owns the HID device. The engine sends it the *desired* keyboard state; the
//! worker sends only what differs from what it last sent, and sends everything again after a
//! reconnect (the keyboard forgets it all on replug).

use crate::board::{self, Board};
use crate::model::{BaseKeymap, Firmware, KeyId, KeymapSource, Lighting, MixLighting};
use crate::protocol::{self as proto, KeyEvent, Keymap, MixInfo, ReplyKind, Report, REPORT_LEN};
use hidapi::{HidApi, HidDevice};
use indexmap::IndexMap;
use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

const RECONNECT_EVERY: Duration = Duration::from_millis(1500);
const PING_EVERY: Duration = Duration::from_secs(2);
const REPLY_TIMEOUT: Duration = Duration::from_millis(500);
/// How long the idle loop listens for unsolicited reports before checking for commands again.
const IDLE_READ_MS: i32 = 40;
/// Without the profile switcher: time for the keyboard to render (and reload from EEPROM) after an
/// effect change, before the colour and speed are sent over VIA.
const EFFECT_SETTLE: Duration = Duration::from_millis(60);
/// Pings in a row the keyboard may miss before it counts as unplugged (3 × `PING_EVERY` ≈ 6 s).
/// A wedged keyboard used to stay "connected" for ever, with no error shown anywhere.
const MISSED_PINGS_GONE: u8 = 3;
/// Waits before re-reading the keymap again after the read failed, then it is left as it is until
/// the keyboard reports another default layer. Without this the read retried on every idle tick.
const BASE_RETRY: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(5)];
/// Key reports: how long one request from the UI keeps them on (the tester renews
/// every 2 s, so a closed or crashed window stops them), and how often the keyboard is reminded
/// (it stops by itself 5 s after the last reminder).
const KEY_REPORT_HOLD: Duration = Duration::from_secs(5);
const KEY_REPORT_RENEW: Duration = Duration::from_secs(2);
/// Reports read in one go while key reports flow, before going back to the command queue.
const KEY_REPORT_BURST: usize = 32;

/// What the keyboard should currently hold.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Desired {
    pub keymap: Keymap,
    /// None: don't touch the lighting.
    pub lighting: Option<Lighting>,
}

pub enum Command {
    SetDesired(Desired),
    /// Temporarily show this lighting (Lighting tab preview); None ends the preview.
    Preview(Option<Lighting>),
    ReadBase(Sender<Result<BaseKeymap, String>>),
    /// Key reports for the keyboard tester: `true` turns them on (or keeps them on) for
    /// `KEY_REPORT_HOLD`, `false` turns them off. The answer: whether the keyboard is reporting.
    KeyReport(bool, Sender<bool>),
    /// Restart the keyboard into its bootloader (the profile switcher's BOOTLOADER), to flash it.
    Bootloader(Sender<Result<(), String>>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// `version`: profile switcher protocol (0 without it). `mix_rgb`: Keychron's Mix RGB works.
    /// `mix_regions`: Keychron's Mix RGB regions (0: the keyboard has no Mix RGB). `board`: which
    /// keyboard (`board.rs` id). `build_id`: which firmware project it was built from (0 when
    /// unknown).
    Connection {
        connected: bool,
        firmware: Firmware,
        version: u8,
        mix_regions: u8,
        board: Option<String>,
        build_id: u32,
    },
    BaseKeymap(BaseKeymap),
    /// Result of the last attempt to send the desired state (None = fine).
    ApplyError(Option<String>),
    /// While not connected: why the keyboard can't be used (None = simply not plugged in).
    Search(Option<String>),
    /// A keyboard the app knows is plugged in, but its firmware has no Raw HID interface (a
    /// `board.rs` id; None when that's no longer so): the app can't reach it, only reflash it.
    Unreachable(Option<String>),
    /// The keyboard's own lighting, read on connect before the app changes anything.
    KeyboardLighting(Lighting),
    /// Keys that went down or up, while the tester asks for them.
    Keys(Vec<KeyEvent>),
}

#[derive(Clone)]
pub struct DeviceHandle {
    tx: Sender<Command>,
}

impl DeviceHandle {
    pub fn send(&self, cmd: Command) {
        let _ = self.tx.send(cmd);
    }

    /// Blocking: asks the keyboard to restart into its bootloader.
    pub fn enter_bootloader(&self) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.send(Command::Bootloader(tx));
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "The keyboard didn't answer.".to_string())?
    }

    /// Blocking: asks for key reports (or stops them); true when the keyboard is reporting.
    pub fn key_report(&self, on: bool) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        self.send(Command::KeyReport(on, tx));
        rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "The keyboard didn't answer.".to_string())
    }

    /// Blocking: reads the base keymap from the keyboard. Call from a blocking-friendly thread.
    pub fn read_base(&self) -> Result<BaseKeymap, String> {
        let (tx, rx) = mpsc::channel();
        self.send(Command::ReadBase(tx));
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "The keyboard didn't answer.".to_string())?
    }
}

/// The handle can be used (commands queue up) before the worker is started with `spawn`.
pub fn channel() -> (DeviceHandle, Receiver<Command>) {
    let (tx, rx) = mpsc::channel();
    (DeviceHandle { tx }, rx)
}

pub fn spawn(rx: Receiver<Command>, on_event: impl Fn(Event) + Send + 'static) {
    thread::Builder::new().name("v6ps-device".into()).spawn(move || run_guarded(rx, Rc::new(on_event))).expect("spawn device thread");
}

/// How many times the worker is started again after a panic before the app gives up on the
/// keyboard. Without this the receiver would be dropped, every later command silently discarded,
/// and the UI would report "applied" forever while nothing reached the keyboard.
const MAX_RESTARTS: u32 = 3;

fn run_guarded(rx: Receiver<Command>, on_event: Rc<dyn Fn(Event)>) {
    let cb = on_event.clone();
    // The desired state and the preview outlive a worker: after a panic the new worker starts
    // with an empty `Desired`, and the engine's `last_sent` is unchanged, so without this it
    // would never resend and the keyboard would be left cleared while the UI says "applied".
    let state = Rc::new(RefCell::new(WorkerState::default()));
    let ended = restarting(
        MAX_RESTARTS,
        || Worker::new(on_event.clone(), state.clone()).run(&rx),
        |left| {
            log::error!("the keyboard worker stopped unexpectedly; {left} restart(s) left");
            cb(Event::Connection { connected: false, firmware: Firmware::Unknown, version: 0, mix_regions: 0, board: None, build_id: 0 });
        },
    );
    if !ended {
        log::error!("the keyboard worker kept stopping: giving up");
        cb(Event::Search(Some("The keyboard connection stopped unexpectedly — restart the app.".into())));
    }
}

/// What a worker keeps across a restart: the desired state and the lighting preview.
#[derive(Default)]
struct WorkerState {
    desired: Desired,
    preview: Option<Lighting>,
    /// Key reports are wanted until then (None: off).
    key_report_until: Option<Instant>,
}

/// Runs `attempt`, and after a panic runs it again, at most `restarts` more times, calling
/// `on_panic` with the number of restarts still left. False when every attempt panicked.
fn restarting(restarts: u32, mut attempt: impl FnMut(), mut on_panic: impl FnMut(u32)) -> bool {
    for left in (0..=restarts).rev() {
        if std::panic::catch_unwind(AssertUnwindSafe(&mut attempt)).is_ok() {
            return true;
        }
        on_panic(left);
    }
    false
}

#[derive(Debug)]
enum IoError {
    /// The device is gone (unplugged, or the handle broke).
    Lost(String),
    /// Nothing arrived before the deadline.
    Timeout,
    /// The keyboard answered, but said it doesn't handle this command (0xFF).
    Unhandled,
    /// The keyboard answered, but holds a different profile than the one just sent.
    TagMismatch,
}

/// The two things `Conn` does to the keyboard. Everything else in this file — the connect
/// sequence, what is re-sent and what isn't, the ping and its timeouts — is built on these two,
/// so with a scripted stand-in all of it can be tested without a keyboard.
pub trait Transport: Send {
    fn write(&mut self, report: &Report) -> std::io::Result<()>;
    /// `Ok(None)` when nothing arrived before the timeout.
    fn read(&mut self, timeout_ms: i32) -> std::io::Result<Option<Report>>;
}

/// The real one: a HID device. On Windows a write needs a leading report id of 0.
struct Hid(HidDevice);

impl Transport for Hid {
    fn write(&mut self, report: &Report) -> std::io::Result<()> {
        let mut buf = [0u8; REPORT_LEN + 1];
        buf[1..].copy_from_slice(report);
        self.0.write(&buf).map(|_| ()).map_err(std::io::Error::other)
    }

    fn read(&mut self, timeout_ms: i32) -> std::io::Result<Option<Report>> {
        let mut r = [0u8; REPORT_LEN];
        match self.0.read_timeout(&mut r, timeout_ms) {
            Ok(0) => Ok(None),
            Ok(_) => Ok(Some(r)),
            Err(e) => Err(std::io::Error::other(e)),
        }
    }
}

enum Reply {
    Ok(Report),
    Unhandled,
}

/// What `verify_keymap` found: the profile is live, or the keyboard accepted it but is waiting
/// for the keys to be released before swapping (so the tag is re-checked on the next ping).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verify {
    Live,
    Pending,
}

/// Key id → LED index, as the keyboard maps them.
type LedMap = IndexMap<KeyId, u8>;

/// Which Mix RGB regions the keyboard is playing (it keeps them in RAM until unplugged).
#[derive(Clone, Debug, PartialEq, Eq)]
enum MixState {
    /// Its own, as saved with Keychron Launcher.
    Own,
    /// A profile's.
    App(MixLighting),
    /// A send failed half-way.
    Unknown,
    /// The profile wants the keyboard's own regions back, but they could not be read on connect,
    /// so there is nothing to put back. Distinct from `Own` so the attempt is not repeated, and
    /// so it doesn't claim the keyboard's own regions are playing when a profile's may be.
    NoOwn,
}

struct Conn {
    dev: Box<dyn Transport>,
    /// Which keyboard: its matrix, knobs and lighting.
    board: &'static Board,
    firmware: Firmware,
    /// Profile switcher protocol version (0 without the module, or with one the app can't talk to).
    fw_version: u8,
    /// Shown instead of "no error" while connected, e.g. a firmware protocol mismatch.
    note: Option<String>,
    /// Layers in the dynamic keymap (VIA), to know whether an Fn layer follows the default one.
    layer_count: u8,
    /// Keychron's Mix RGB (None: the keyboard doesn't have it) and the LED of each key.
    mix: Option<MixInfo>,
    leds: LedMap,
    led_count: u8,
    /// Packets that put the keyboard's own Mix RGB regions back (None if they couldn't be read).
    own_mix: Option<Vec<Report>>,
    mix_state: MixState,

    /// Default layer the current base keymap was read from.
    base_layer: Option<u8>,
    /// Latest default layer the keyboard reported, from a reply or a notification.
    seen_layer: Option<u8>,
    /// What was last sent, with the default layer it was sent for.
    applied_keymap: Option<(Keymap, u8)>,
    /// The tag of a profile the keyboard accepted but hasn't swapped to yet (a key was held):
    /// re-checked on the next ping, and cleared once it is live.
    pending_tag: Option<u16>,
    /// Layers the module holds remaps for (from STATUS).
    max_layers: u8,
    /// The firmware project this build came from. 0: built by hand.
    build_id: u32,
    /// Remaps of the active profile left out: on layers the firmware can't hold…
    dropped: usize,
    /// …and on keys this keyboard doesn't have (a profile made on another one).
    off_board: usize,
    /// What we last sent; None before the first send or after a failed one (then it's retried).
    applied_lighting: Option<Lighting>,
    last_ping: Instant,
    missed_pings: u8,
    /// Failed attempts in a row to re-read the keymap after the default layer changed, and when
    /// the next one is due (`BASE_RETRY`).
    base_failures: u8,
    base_retry_at: Option<Instant>,
    /// When the keyboard was last told to report keys (None: it isn't reporting).
    key_report_sent: Option<Instant>,
    /// The keyboard answered that it couldn't start reporting (no free deferred-exec slot): not
    /// asked again until the tester asks again.
    key_report_refused: bool,
    /// Key events read since they were last handed on (they can arrive in any read).
    key_events: Vec<KeyEvent>,
}

impl Conn {
    fn write(&mut self, req: &Report) -> Result<(), IoError> {
        self.dev.write(req).map_err(|e| IoError::Lost(e.to_string()))
    }

    /// One read; notes layer notifications on the way. Ok(None) on timeout.
    fn read(&mut self, timeout_ms: i32) -> Result<Option<Report>, IoError> {
        match self.dev.read(timeout_ms) {
            Ok(None) => Ok(None),
            Ok(Some(r)) => {
                if let Some(layer) = proto::layer_notification(&r) {
                    self.seen_layer = Some(layer);
                }
                if let Some((events, dropped)) = proto::key_report(&r) {
                    if dropped > 0 {
                        log::debug!("the keyboard dropped {dropped} key event(s): its queue was full");
                    }
                    self.key_events.extend(events);
                }
                Ok(Some(r))
            }
            Err(e) => Err(IoError::Lost(e.to_string())),
        }
    }

    /// Send a request and wait for its echo, skipping unrelated (unsolicited) reports.
    fn transact(&mut self, req: &Report) -> Result<Reply, IoError> {
        self.write(req)?;
        let deadline = Instant::now() + REPLY_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(IoError::Timeout);
            }
            let Some(r) = self.read(left.as_millis().max(1) as i32)? else { continue };
            match proto::classify_reply(req, &r) {
                ReplyKind::Reply => return Ok(Reply::Ok(r)),
                ReplyKind::Unhandled => return Ok(Reply::Unhandled),
                ReplyKind::Other => {}
            }
        }
    }

    fn expect_reply(&mut self, req: &Report) -> Result<Report, IoError> {
        match self.transact(req)? {
            Reply::Ok(r) => Ok(r),
            Reply::Unhandled => Err(IoError::Unhandled),
        }
    }

    fn query_firmware(&mut self) -> Result<(Firmware, u8, Option<String>), IoError> {
        Ok(match self.transact(&proto::status_request())? {
            Reply::Unhandled => (Firmware::Missing, 0, None),
            Reply::Ok(r) => {
                let status = proto::parse_status(&r);
                let v = status.proto_version;
                self.max_layers = status.layers.max(1);
                self.build_id = status.build_id;
                if v == proto::PS_PROTO_VERSION {
                    if (status.max_macros as usize) < proto::MAX_MACROS || (status.macro_buffer as usize) < proto::MACRO_BUFFER_SIZE {
                        log::warn!(
                            "the keyboard's firmware holds {} macro(s) in {} bytes; the app assumes {} in {}",
                            status.max_macros,
                            status.macro_buffer,
                            proto::MAX_MACROS,
                            proto::MACRO_BUFFER_SIZE
                        );
                    }
                    (Firmware::Ok, v, None)
                } else {
                    // Any other number: a development build from before 1.0 (they used 2-9), or a
                    // module newer than this app. The app can't tell which, so it names both.
                    log::warn!("the keyboard's profile switcher speaks protocol {v}; this app speaks {}", proto::PS_PROTO_VERSION);
                    let msg = "The keyboard's profile switcher is a version this app can't talk to. Install the profile switcher from this app (Settings \u{2192} Keyboard), or update the app if the firmware is newer.";
                    (Firmware::Missing, 0, Some(msg.to_string()))
                }
            }
        })
    }

    fn query_layer_count(&mut self) -> Result<u8, IoError> {
        Ok(match self.transact(&proto::layer_count_request())? {
            Reply::Ok(r) => r[1],
            Reply::Unhandled => 0,
        })
    }

    /// Keychron's Mix RGB, the key → LED map it needs, and the keyboard's own regions (to put
    /// back later). Leaves `mix` None on keyboards without it.
    fn query_mix(&mut self) -> Result<(), IoError> {
        let info = match self.transact(&proto::mix_info_request())? {
            Reply::Ok(r) => proto::parse_mix_info(&r),
            Reply::Unhandled => None,
        };
        let Some(info) = info else { return Ok(()) };
        let m = self.board.matrix();
        let mut leds = IndexMap::new();
        for row in 0..m.rows {
            let r = self.expect_reply(&proto::led_index_request(row, m.cols))?;
            if !proto::kc_rgb_ok(&r) {
                return Ok(());
            }
            leds.extend(proto::parse_led_row(row, m.cols, &r));
        }
        let led_count = proto::parse_led_count(&self.expect_reply(&proto::led_count_request())?)
            .unwrap_or_else(|| leds.values().copied().max().map_or(0, |m| m + 1));
        let requests = proto::mix_read_requests(led_count, info);
        let mut replies = vec![];
        for req in &requests {
            replies.push(self.expect_reply(req)?);
        }
        self.own_mix = proto::mix_restore_packets(&requests, &replies, info);
        if self.own_mix.is_none() {
            log::warn!("could not read the keyboard's own Mix RGB regions");
        }
        log::info!(
            "Mix RGB: {} regions of up to {} effects, {} LEDs, {} keys with an LED",
            info.regions,
            info.effects_per_region,
            led_count,
            leds.len()
        );
        self.mix = Some(info);
        self.leds = leds;
        self.led_count = led_count;
        Ok(())
    }

    fn query_layer(&mut self) -> Result<u8, IoError> {
        let layer = match self.transact(&proto::default_layer_request())? {
            Reply::Ok(r) => r[1],
            Reply::Unhandled => self.board.default_layer,
        };
        self.seen_layer = Some(layer);
        Ok(layer)
    }

    /// Keys and knob of one layer of VIA's dynamic keymap, as stored.
    fn read_layer(&mut self, layer: u8) -> Result<IndexMap<KeyId, u16>, IoError> {
        let m = self.board.matrix();
        let mut bytes = Vec::with_capacity(m.layer_bytes());
        for req in proto::keymap_buffer_requests(layer, m) {
            let r = self.expect_reply(&req)?;
            bytes.extend_from_slice(proto::buffer_reply_data(&r));
        }
        let mut keys = proto::decode_layer(&bytes, m);
        for index in 0..m.encoders {
            for cw in [false, true] {
                let r = self.expect_reply(&proto::encoder_request(layer, index, cw))?;
                keys.insert(proto::encoder_key_id(index, cw), proto::parse_encoder(&r));
            }
        }
        Ok(keys)
    }

    /// Every layer of the keyboard's keymap, as stored (transparent keys stay `KC_TRNS`), and
    /// which one is the default layer.
    fn read_base(&mut self) -> Result<BaseKeymap, IoError> {
        let layer = self.query_layer()?;
        // Without VIA's layer count, at least up to the default layer.
        let count = if self.layer_count > 0 { self.layer_count } else { layer.saturating_add(1) }.min(proto::MAX_LAYER_ID);
        let mut layers = Vec::with_capacity(count as usize);
        for l in 0..count {
            layers.push(self.read_layer(l)?);
        }
        log::info!("keymap: {count} layer(s), default layer {layer}");
        self.base_layer = Some(layer);
        Ok(BaseKeymap { source: KeymapSource::Keyboard, layer, layers, board: Some(self.board.id.clone()) })
    }

    /// The default layer as last seen (a notification, a ping, or the keymap read).
    fn default_layer(&self) -> u8 {
        self.seen_layer.or(self.base_layer).unwrap_or(self.board.default_layer)
    }

    fn read_lighting(&mut self) -> Result<Lighting, IoError> {
        if self.board.white() {
            let reqs = proto::white_lighting_requests();
            let mut replies = [[0u8; REPORT_LEN]; 3];
            for (i, req) in reqs.iter().enumerate() {
                replies[i] = self.expect_reply(req)?;
            }
            return Ok(proto::parse_white_lighting(&replies));
        }
        let reqs = proto::lighting_requests();
        let mut replies = [[0u8; REPORT_LEN]; 4];
        for (i, req) in reqs.iter().enumerate() {
            replies[i] = self.expect_reply(req)?;
        }
        Ok(proto::parse_lighting(&replies))
    }

    fn send_all(&mut self, packets: &[Report]) -> Result<(), IoError> {
        for p in packets {
            self.expect_reply(p)?;
        }
        Ok(())
    }

    /// Mix RGB regions: the profile's, or the keyboard's own back when the profile has none.
    /// Sent before the effect itself switches to Mix RGB.
    fn send_mix(&mut self, want: Option<&MixLighting>) -> Result<(), IoError> {
        let Some(info) = self.mix else { return Ok(()) };
        let target = want.map_or(MixState::Own, |m| MixState::App(m.clone()));
        if self.mix_state == target || (target == MixState::Own && self.mix_state == MixState::NoOwn) {
            return Ok(());
        }
        let packets = match want {
            Some(mix) => {
                log::info!("lighting: Mix RGB, the profile's {} region(s)", mix.regions.len().min(info.regions as usize));
                proto::mix_packets(mix, &self.leds, self.led_count, info)
            }
            None => match &self.own_mix {
                Some(own) => {
                    log::info!("lighting: Mix RGB, the keyboard's own regions");
                    own.clone()
                }
                None => {
                    log::warn!("the keyboard's own Mix RGB regions could not be read on connect: leaving the regions as they are");
                    self.mix_state = MixState::NoOwn;
                    return Ok(());
                }
            },
        };
        self.mix_state = MixState::Unknown; // until every packet went through
        for p in &packets {
            if !proto::kc_rgb_ok(&self.expect_reply(p)?) {
                log::warn!("the keyboard refused a Mix RGB packet: {:02X?}", &p[..8]);
            }
        }
        self.mix_state = target;
        Ok(())
    }

    /// An RGB keyboard's effect, colour, speed and brightness.
    fn send_rgb_base(&mut self, l: &Lighting, prev: Option<&Lighting>) -> Result<(), IoError> {
        log::info!("lighting: effect {} hue {} sat {} speed {} brightness {}", l.effect, l.hue, l.sat, l.speed, l.brightness);
        if self.firmware == Firmware::Ok {
            self.expect_reply(&proto::module_lighting_packet(l))?;
            return Ok(());
        }
        // Keychron's own firmware (no profile switcher) reloads hue/sat/brightness/speed from
        // EEPROM when the effect changes, at the next frame. Let that happen before sending ours,
        // or they're overwritten (a Solid Color profile comes out in the saved hue, red). The
        // module does this properly.
        let packets = proto::lighting_packets(l);
        let effect_changed = prev.is_none_or(|p| proto::wire_effect(p) != proto::wire_effect(l));
        self.expect_reply(&packets[0])?;
        if effect_changed {
            thread::sleep(EFFECT_SETTLE);
        }
        self.send_all(&packets[1..])
    }

    /// Asks the keyboard what it is holding, and complains if it isn't what was just sent.
    ///
    /// COMMIT carries a fingerprint of the remaps and macros, and STATUS reads it back in
    /// `active_tag`, with `pending` still set while a transfer is half-open. That is the only
    /// way the app can notice a profile that arrived in pieces — a packet lost to a shared Raw
    /// HID interface, say. An error here leaves `applied_keymap` as None, so the idle loop sends
    /// the whole profile again.
    fn verify_keymap(&mut self, tag: u16) -> Result<Verify, IoError> {
        if self.firmware != Firmware::Ok {
            return Ok(Verify::Live);
        }
        let Reply::Ok(r) = self.transact(&proto::status_request())? else { return Ok(Verify::Live) };
        let status = proto::parse_status(&r);
        if status.pending {
            // The firmware waits until no key is held before swapping profiles (a key pressed
            // before the swap would be released through the new map and stick). That is not a
            // failure: the profile is accepted, just not live yet. Lighting goes ahead, and the
            // tag is re-checked on the next ping.
            log::info!("the keyboard accepted the profile and is waiting for the keys to be released before swapping");
            return Ok(Verify::Pending);
        }
        if status.active_tag != tag {
            log::warn!(
                "the keyboard holds a different profile than the one just sent (it says {:#06X}, we sent {tag:#06X}): sending it again",
                status.active_tag
            );
            return Err(IoError::TagMismatch);
        }
        Ok(Verify::Live)
    }

    /// Bring the keyboard to `desired` (with `preview` on top), sending only what changed.
    fn reconcile(&mut self, desired: &Desired, preview: Option<&Lighting>) -> Result<(), IoError> {
        // Which default layer the packets depend on: only old remaps saved without a layer.
        let needs_default = desired.keymap.uses_default_layer();
        let default_layer = if needs_default { self.default_layer() } else { 0 };
        let wanted = (desired.keymap.clone(), default_layer);
        if self.firmware == Firmware::Ok && self.applied_keymap.as_ref() != Some(&wanted) {
            self.applied_keymap = None; // stays None if sending fails half-way, so it's retried
            let out = desired.keymap.packets(self.default_layer(), self.max_layers, self.board.matrix());
            if out.dropped > 0 {
                log::warn!("{} remap(s) on layers this firmware can't hold were left out", out.dropped);
            }
            if out.off_board > 0 {
                log::info!("{} remap(s) on keys the {} doesn't have were left out", out.off_board, self.board.short_name());
            }
            self.dropped = out.dropped;
            self.off_board = out.off_board;
            self.send_all(&out.packets)?;
            match self.verify_keymap(out.tag)? {
                Verify::Live => {
                    self.applied_keymap = Some(wanted);
                    self.pending_tag = None;
                }
                // Accepted, not live yet: remember it as sent (so it isn't resent) and re-check
                // the tag on the next ping. Lighting still goes ahead below.
                Verify::Pending => {
                    self.applied_keymap = Some(wanted);
                    self.pending_tag = Some(out.tag);
                }
            }
        }
        // No lighting wanted, or no lighting on this keyboard: leave the keyboard as it is.
        let white = self.board.white();
        if !self.board.rgb() && !white {
            return Ok(());
        }
        let Some(l) = preview.or(desired.lighting.as_ref()) else { return Ok(()) };
        if self.applied_lighting.as_ref() == Some(l) {
            return Ok(());
        }
        let prev = self.applied_lighting.take(); // stays None if sending fails, so it's retried
        if white {
            // QMK's LED matrix keeps VIA's values over effect changes: no module needed.
            let packets = proto::white_lighting_packets(l);
            if prev.as_ref().is_none_or(|p| proto::white_lighting_packets(p) != packets) {
                log::info!("lighting: white backlight effect {} speed {} brightness {}", l.effect, l.speed, l.brightness);
                self.send_all(&packets)?;
            }
        } else {
            if l.effect == crate::model::MIX_RGB_EFFECT {
                self.send_mix(l.mix.as_ref())?;
            }
            if prev.as_ref().is_none_or(|p| !proto::same_base(p, l)) {
                self.send_rgb_base(l, prev.as_ref())?;
            }
        }
        let keys_changed = prev.as_ref().is_none_or(|p| p.keys != l.keys || p.key_anims != l.key_anims || p.effect != l.effect);
        if keys_changed && self.firmware == Firmware::Ok {
            log::info!("lighting: {} lit key(s), {} animated", l.keys.len(), l.key_anims.len());
            self.send_all(&proto::key_color_packets(l, self.board.matrix()))?;
        }
        self.applied_lighting = Some(l.clone());
        Ok(())
    }
}

struct Worker {
    api: Option<HidApi>,
    conn: Option<Conn>,
    /// The desired state and the preview, shared with the next worker if this one panics.
    state: Rc<RefCell<WorkerState>>,
    on_event: Rc<dyn Fn(Event)>,
    last_attempt: Option<Instant>,
    last_error: Option<String>,
    search_note: Option<String>,
    unreachable: Option<String>,
    /// Keychron HID interfaces seen on the last scan (None before the first), logged when they change.
    seen_interfaces: Option<Vec<(u16, u16, u16)>>,
}

impl Worker {
    fn new(on_event: Rc<dyn Fn(Event)>, state: Rc<RefCell<WorkerState>>) -> Self {
        Worker {
            api: None,
            conn: None,
            state,
            on_event,
            last_attempt: None,
            last_error: None,
            search_note: None,
            unreachable: None,
            seen_interfaces: None,
        }
    }

    fn run(mut self, rx: &Receiver<Command>) {
        loop {
            if self.conn.is_none() {
                let due = !matches!(self.last_attempt, Some(t) if t.elapsed() < RECONNECT_EVERY);
                if due {
                    self.last_attempt = Some(Instant::now());
                    self.try_connect();
                }
                if self.conn.is_none() {
                    let wait = RECONNECT_EVERY.saturating_sub(self.last_attempt.unwrap().elapsed());
                    match rx.recv_timeout(wait) {
                        Ok(cmd) => self.handle(cmd),
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    continue;
                }
            }

            loop {
                match rx.try_recv() {
                    Ok(cmd) => self.handle(cmd),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            }
            // Once, after every queued command: live preview sends up to 25/s and a layer-colour
            // drag resends every key colour, so applying per command would back the queue up on a
            // slow board. Only the last desired state matters.
            self.apply();
            self.sync_key_report();
            self.idle_tick();
            self.hand_on_keys();
        }
    }

    fn try_connect(&mut self) {
        let listed = match self.api.as_mut() {
            Some(api) => api.refresh_devices(),
            None => HidApi::new().map(|api| {
                self.api = Some(api);
            }),
        };
        if let Err(e) = listed {
            self.set_search(Some(format!("Could not list USB devices: {e}")));
            return;
        }
        let api = self.api.as_ref().unwrap();

        let keychron: Vec<(u16, u16, u16)> =
            api.device_list().filter(|d| d.vendor_id() == proto::VENDOR_ID).map(|d| (d.product_id(), d.usage_page(), d.usage())).collect();
        if self.seen_interfaces.as_ref() != Some(&keychron) {
            log_interfaces(&keychron);
            self.seen_interfaces = Some(keychron.clone());
        }
        self.set_unreachable(unreachable_board(&keychron));
        let api = self.api.as_ref().unwrap();
        // The first Keychron keyboard the app knows, on its Raw HID (VIA) interface.
        let found = api.device_list().find_map(|d| {
            let usable = d.vendor_id() == proto::VENDOR_ID && d.usage_page() == proto::USAGE_PAGE && d.usage() == proto::USAGE;
            usable.then(|| board::by_usb(d.vendor_id(), d.product_id()).map(|b| (d, b))).flatten()
        });
        let Some((info, board)) = found else {
            self.set_search(missing_reason(&keychron));
            return;
        };
        let dev = match info.open_device(api) {
            Ok(dev) => dev,
            Err(e) => {
                self.set_search(Some(format!(
                    "Found the {}, but Windows would not open it ({e}). Close VIA or Keychron Launcher if one is open.",
                    board.short_name()
                )));
                return;
            }
        };
        let mut conn = Conn {
            dev: Box::new(Hid(dev)),
            board,
            firmware: Firmware::Unknown,
            fw_version: 0,
            note: None,
            layer_count: 0,
            mix: None,
            leds: IndexMap::new(),
            led_count: 0,
            own_mix: None,
            mix_state: MixState::Own,
            max_layers: 1,
            build_id: 0,
            dropped: 0,
            off_board: 0,
            base_layer: None,
            seen_layer: None,
            applied_keymap: None,
            pending_tag: None,
            applied_lighting: None,
            last_ping: Instant::now(),
            missed_pings: 0,
            base_failures: 0,
            base_retry_at: None,
            key_report_sent: None,
            key_report_refused: false,
            key_events: Vec::new(),
        };
        let (firmware, fw_version, note) = match conn.query_firmware() {
            Ok(v) => v,
            Err(_) => {
                // Opened but silent: try again on the next round.
                self.set_search(Some(format!(
                    "Found the {}, but it didn't answer. Try unplugging it and plugging it back in.",
                    board.short_name()
                )));
                return;
            }
        };
        conn.firmware = firmware;
        conn.fw_version = fw_version;
        conn.note = note;
        conn.layer_count = conn.query_layer_count().unwrap_or(0);
        if !board.rgb() || conn.query_mix().is_err() {
            conn.mix = None;
        }
        log::info!("connected: {} ({}), firmware {firmware:?}, protocol {fw_version}, {} layer(s)", board.name, board.id, conn.layer_count);
        let mix_regions = conn.mix.map_or(0, |m| m.regions);
        let build_id = conn.build_id;
        self.set_search(None);
        self.conn = Some(conn);
        self.emit(Event::Connection {
            connected: true,
            firmware,
            version: fw_version,
            mix_regions,
            board: Some(board.id.clone()),
            build_id,
        });
        self.refresh_base();
        // Before anything is sent: lets the engine adopt the keyboard's lighting for Default.
        if let Some(conn) = self.conn.as_mut().filter(|c| c.board.rgb() || c.board.white()) {
            if let Ok(own) = conn.read_lighting() {
                log::info!(
                    "keyboard's own lighting: effect {} hue {} sat {} speed {} brightness {}",
                    own.effect,
                    own.hue,
                    own.sat,
                    own.speed,
                    own.brightness
                );
                self.emit(Event::KeyboardLighting(own));
            }
        }
        self.apply();
    }

    fn handle(&mut self, cmd: Command) {
        match cmd {
            // The desired state and the preview are only stored here; the run loop applies once
            // after draining every queued command (see `run`).
            Command::SetDesired(d) => {
                self.state.borrow_mut().desired = d;
            }
            Command::Preview(l) => {
                self.state.borrow_mut().preview = l;
            }
            Command::KeyReport(on, reply) => {
                self.state.borrow_mut().key_report_until = on.then(|| Instant::now() + KEY_REPORT_HOLD);
                // Asked again: a keyboard that refused gets another chance (a slot may be free now).
                if let Some(conn) = self.conn.as_mut() {
                    conn.key_report_refused = false;
                }
                self.sync_key_report();
                let _ = reply.send(on && self.conn.as_ref().is_some_and(|c| c.key_report_sent.is_some()));
            }
            Command::Bootloader(reply) => {
                let result = match self.conn.as_mut() {
                    None => Err("The keyboard is not connected.".to_string()),
                    Some(conn) if conn.firmware != Firmware::Ok => Err(
                        "This keyboard's firmware has no profile switcher (or one this app can't talk to), so the app can't restart it. Unplug the keyboard, hold Esc and plug it back in instead."
                            .to_string(),
                    ),
                    Some(conn) => match conn.expect_reply(&proto::bootloader_request()) {
                        Ok(_) => {
                            log::info!("keyboard restarting into its bootloader");
                            Ok(())
                        }
                        Err(e) => Err(self.io_failed(e, "restart the keyboard")),
                    },
                };
                let _ = reply.send(result);
            }
            Command::ReadBase(reply) => {
                let result = match self.conn.as_mut() {
                    None => Err("The keyboard is not connected.".to_string()),
                    Some(conn) => match conn.read_base() {
                        Ok(b) => Ok(b),
                        Err(e) => Err(self.io_failed(e, "read the keymap")),
                    },
                };
                if let Ok(b) = &result {
                    self.emit(Event::BaseKeymap(b.clone()));
                }
                let _ = reply.send(result);
            }
        }
    }

    /// Re-reads the keyboard's keymap. False when it couldn't be read (the caller backs off).
    fn refresh_base(&mut self) -> bool {
        let Some(conn) = self.conn.as_mut() else { return false };
        match conn.read_base() {
            Ok(b) => {
                self.emit(Event::BaseKeymap(b));
                true
            }
            Err(e) => {
                let msg = self.io_failed(e, "read the keymap");
                self.set_error(Some(msg));
                false
            }
        }
    }

    /// What the status line should say while everything is working (None: nothing to report).
    fn note(&self) -> Option<String> {
        self.conn.as_ref().and_then(|c| {
            c.note
                .clone()
                .or((c.dropped > 0).then(|| {
                    format!("{} remap(s) of this profile are on layers the keyboard's profile switcher doesn't cover.", c.dropped)
                }))
                .or((c.off_board > 0)
                    .then(|| format!("{} remap(s) of this profile are on keys the {} doesn't have.", c.off_board, c.board.short_name())))
        })
    }

    fn apply(&mut self) {
        let Some(conn) = self.conn.as_mut() else { return };
        // Clone out of the shared state so the borrow ends before `self` is used again below.
        let (desired, preview) = {
            let state = self.state.borrow();
            (state.desired.clone(), state.preview.clone())
        };
        match conn.reconcile(&desired, preview.as_ref()) {
            Ok(()) => {
                let note = self.note();
                self.set_error(note);
            }
            Err(e) => {
                let msg = self.io_failed(e, "send the profile");
                self.set_error(Some(msg));
            }
        }
    }

    /// Whether the tester wants key reports and this keyboard can send them.
    fn key_report_wanted(&self) -> bool {
        let until = self.state.borrow().key_report_until;
        until.is_some_and(|t| Instant::now() < t) && self.conn.as_ref().is_some_and(|c| c.firmware == Firmware::Ok)
    }

    /// Turns the keyboard's key reports on, reminds it every `KEY_REPORT_RENEW`, or turns them off.
    fn sync_key_report(&mut self) {
        let wanted = self.key_report_wanted();
        let Some(conn) = self.conn.as_mut() else { return };
        let due = match conn.key_report_sent {
            None => wanted && !conn.key_report_refused,
            Some(at) => !wanted || at.elapsed() >= KEY_REPORT_RENEW,
        };
        if !due {
            return;
        }
        match conn.expect_reply(&proto::key_report_request(wanted)) {
            Ok(r) if wanted && !proto::key_report_started(&r) => {
                log::warn!("the keyboard couldn't start reporting keys (no free deferred-exec slot)");
                conn.key_report_refused = true;
                conn.key_report_sent = None;
            }
            Ok(_) => {
                if wanted != conn.key_report_sent.is_some() {
                    log::info!("key reports {}", if wanted { "on" } else { "off" });
                }
                conn.key_report_sent = wanted.then(Instant::now);
            }
            // Tried again on the next round; a keyboard that is gone is dropped by io_failed.
            Err(e) => {
                let msg = self.io_failed(e, "reach the keyboard");
                self.set_error(Some(msg));
            }
        }
    }

    /// Passes the key events read on to the UI while the tester wants them, and drops them
    /// otherwise (a few can still arrive just after reporting was turned off).
    fn hand_on_keys(&mut self) {
        let wanted = self.key_report_wanted();
        let Some(conn) = self.conn.as_mut() else { return };
        if conn.key_events.is_empty() {
            return;
        }
        let events = std::mem::take(&mut conn.key_events);
        if wanted {
            self.emit(Event::Keys(events));
        }
    }

    /// Listen for unsolicited reports; ping now and then to notice an unplug.
    fn idle_tick(&mut self) {
        let Some(conn) = self.conn.as_mut() else { return };
        let mut read = conn.read(IDLE_READ_MS);
        // While keys are reported, take everything that is waiting, not one report per tick.
        if matches!(read, Ok(Some(_))) && conn.key_report_sent.is_some() {
            for _ in 0..KEY_REPORT_BURST {
                read = conn.read(0);
                if !matches!(read, Ok(Some(_))) {
                    break;
                }
            }
        }
        if let Err(e) = read {
            let msg = self.io_failed(e, "listen");
            self.set_error(Some(msg));
            return;
        }
        let Some(conn) = self.conn.as_mut() else { return };
        if conn.last_ping.elapsed() >= PING_EVERY {
            conn.last_ping = Instant::now();
            match conn.query_layer() {
                Ok(_) => {
                    let recovered = conn.missed_pings > 0;
                    conn.missed_pings = 0;
                    if recovered {
                        let note = self.note();
                        self.set_error(note);
                    }
                }
                Err(IoError::Timeout) => {
                    conn.missed_pings += 1;
                    let missed = conn.missed_pings;
                    if missed >= MISSED_PINGS_GONE {
                        log::warn!("the keyboard missed {missed} pings in a row: treating it as unplugged");
                        self.disconnected();
                        self.set_search(Some(
                            "The keyboard stopped answering. Unplug it and plug it back in; close VIA or Keychron Launcher if one is open."
                                .into(),
                        ));
                        return;
                    }
                    let msg = self.io_failed(IoError::Timeout, "reach the keyboard");
                    self.set_error(Some(msg));
                }
                Err(e) => {
                    let msg = self.io_failed(e, "reach the keyboard");
                    self.set_error(Some(msg));
                    return;
                }
            }
            let Some(conn) = self.conn.as_mut() else { return };
            // A profile the keyboard accepted while a key was held: check whether it has swapped
            // to it now (the tag matches), and stop re-checking once it has.
            if let Some(tag) = conn.pending_tag {
                match conn.verify_keymap(tag) {
                    Ok(Verify::Live) => {
                        conn.pending_tag = None;
                        log::info!("the keyboard swapped to the profile it was holding");
                    }
                    Ok(Verify::Pending) => {}
                    Err(e) => {
                        // The tag no longer matches: send the whole profile again.
                        conn.pending_tag = None;
                        conn.applied_keymap = None;
                        let msg = self.io_failed(e, "send the profile");
                        self.set_error(Some(msg));
                    }
                }
            }
            let Some(conn) = self.conn.as_mut() else { return };
            // Retry anything a timeout left unsent.
            let lighting_wanted = self.state.borrow().preview.is_some() || self.state.borrow().desired.lighting.is_some();
            if (conn.applied_keymap.is_none() && conn.firmware == Firmware::Ok) || (conn.applied_lighting.is_none() && lighting_wanted) {
                self.apply();
            }
        }
        // Mac/Win switch flipped: the UI marks the new default layer, and remaps tied to the
        // default layer (older files, older firmware) move with it.
        self.follow_default_layer();
    }

    /// The keyboard reported a default layer the shown keymap wasn't read from: read it again.
    /// A failing read backs off and finally gives up, rather than retrying on every idle tick.
    fn follow_default_layer(&mut self) {
        let Some(conn) = self.conn.as_mut() else { return };
        if conn.seen_layer.is_none() || conn.seen_layer == conn.base_layer {
            return;
        }
        if conn.base_retry_at.is_some_and(|due| Instant::now() < due) {
            return;
        }
        if self.refresh_base() {
            if let Some(conn) = self.conn.as_mut() {
                conn.base_failures = 0;
                conn.base_retry_at = None;
            }
            self.apply();
            return;
        }
        let Some(conn) = self.conn.as_mut() else { return };
        conn.base_failures += 1;
        match BASE_RETRY.get(conn.base_failures as usize - 1) {
            Some(wait) => {
                if conn.base_failures == 1 {
                    log::warn!("could not re-read the keymap after the default layer changed; backing off");
                }
                conn.base_retry_at = Some(Instant::now() + *wait);
            }
            None => {
                log::warn!(
                    "giving up re-reading the keymap for default layer {:?}: the keymap shown stays the one that was read",
                    conn.seen_layer
                );
                // Not a claim that it was read from that layer — only what stops the retry loop
                // until the keyboard reports a *different* default layer again.
                conn.base_layer = conn.seen_layer;
                conn.base_failures = 0;
                conn.base_retry_at = None;
            }
        }
    }

    /// A timeout keeps the connection; anything else drops it. Returns a message for the UI —
    /// every caller passes it on, so a keyboard that stops answering is always visible.
    fn io_failed(&mut self, e: IoError, what: &str) -> String {
        match e {
            IoError::Timeout => format!("Could not {what}: the keyboard didn't answer."),
            IoError::Unhandled => format!("Could not {what}: the keyboard's firmware doesn't handle that."),
            IoError::TagMismatch => format!("Could not {what}: the keyboard didn't take the profile (it holds a different one)."),
            IoError::Lost(msg) => {
                log::warn!("keyboard lost: {msg}");
                self.disconnected();
                format!("Could not {what}: the keyboard was disconnected ({msg}).")
            }
        }
    }

    /// Drop the connection and tell the UI; the reconnect loop takes over.
    fn disconnected(&mut self) {
        self.conn = None;
        self.last_error = None;
        self.last_attempt = Some(Instant::now());
        self.emit(Event::Connection {
            connected: false,
            firmware: Firmware::Unknown,
            version: 0,
            mix_regions: 0,
            board: None,
            build_id: 0,
        });
    }

    fn set_error(&mut self, e: Option<String>) {
        // A disconnect is shown as such by the UI; don't keep a stale error around for it.
        let e = if self.conn.is_none() { None } else { e };
        if self.last_error != e {
            self.last_error = e.clone();
            self.emit(Event::ApplyError(e));
        }
    }

    fn set_unreachable(&mut self, board: Option<String>) {
        if self.unreachable != board {
            self.unreachable = board.clone();
            self.emit(Event::Unreachable(board));
        }
    }

    fn set_search(&mut self, note: Option<String>) {
        if self.search_note != note {
            if let Some(n) = &note {
                log::warn!("{n}");
            }
            self.search_note = note.clone();
            self.emit(Event::Search(note));
        }
    }

    fn emit(&self, e: Event) {
        (self.on_event)(e);
    }
}

/// Logged (and printed in the `pnpm dev` terminal), to diagnose a keyboard that isn't found.
fn log_interfaces(keychron: &[(u16, u16, u16)]) {
    if keychron.is_empty() {
        log::info!("no Keychron HID interface (VID 0x{:04X}) found", proto::VENDOR_ID);
    }
    for (pid, page, usage) in keychron {
        log::info!("Keychron HID interface: PID 0x{pid:04X}, usage page 0x{page:04X}, usage 0x{usage:02X}");
    }
}

/// Why no usable interface was found, given the Keychron (pid, usage page, usage) interfaces
/// present. None means no Keychron keyboard at all: the UI shows its plain "not found".
/// A keyboard the app knows among the Keychron interfaces (pid, usage page, usage), none of them
/// its Raw HID one: its firmware was built without VIA.
fn unreachable_board(keychron: &[(u16, u16, u16)]) -> Option<String> {
    let raw_hid = |&&(_, page, usage): &&(u16, u16, u16)| page == proto::USAGE_PAGE && usage == proto::USAGE;
    let known = |&(pid, ..): &(u16, u16, u16)| board::by_usb(proto::VENDOR_ID, pid);
    if keychron.iter().filter(raw_hid).any(|k| known(k).is_some()) {
        return None;
    }
    keychron.iter().find_map(known).map(|b| b.id.clone())
}

fn missing_reason(keychron: &[(u16, u16, u16)]) -> Option<String> {
    if keychron.is_empty() {
        return None;
    }
    // A keyboard the app knows, but without its Raw HID (VIA) interface.
    if let Some(b) = keychron.iter().find_map(|&(pid, ..)| board::by_usb(proto::VENDOR_ID, pid)) {
        return Some(format!(
            "The {} is plugged in, but its firmware has no Raw HID interface (VIA): the app can't reach it. Install the profile switcher firmware, which has it.",
            b.short_name()
        ));
    }
    let pid = keychron[0].0;
    Some(format!(
        "Found a Keychron keyboard (USB id 0x{pid:04X}) this version of the app doesn't know. A wireless dongle? Plug the keyboard in with its cable."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Profile;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    // ------------------------------------------------------------ a keyboard on a string
    //
    // `Transport` is the only way `Conn` touches the device, so a scripted stand-in can play a
    // keyboard that answers, one that stays silent, or one that disappears — and the connect
    // sequence, what gets re-sent and what doesn't, and the ping logic can all be tested here.

    /// What the fake keyboard does with one request.
    enum Answer {
        /// Hand back these reports, in order.
        Send(Vec<Report>),
        /// Nothing at all: the caller waits out its timeout.
        Silent,
        /// The device is gone.
        Lost,
    }

    struct Fake {
        answer: Box<dyn FnMut(&Report) -> Answer + Send>,
        queue: VecDeque<Report>,
        /// Every request the app made, for a test to look at.
        seen: Arc<Mutex<Vec<Report>>>,
        gone: bool,
    }

    fn fake(answer: impl FnMut(&Report) -> Answer + Send + 'static) -> (Box<Fake>, Arc<Mutex<Vec<Report>>>) {
        let seen = Arc::new(Mutex::new(vec![]));
        (Box::new(Fake { answer: Box::new(answer), queue: VecDeque::new(), seen: seen.clone(), gone: false }), seen)
    }

    impl Transport for Fake {
        fn write(&mut self, r: &Report) -> std::io::Result<()> {
            self.seen.lock().unwrap().push(*r);
            if self.gone {
                return Err(std::io::Error::other("gone"));
            }
            match (self.answer)(r) {
                Answer::Send(reports) => self.queue.extend(reports),
                Answer::Silent => {}
                Answer::Lost => {
                    self.gone = true;
                    return Err(std::io::Error::other("the keyboard was unplugged"));
                }
            }
            Ok(())
        }

        fn read(&mut self, timeout_ms: i32) -> std::io::Result<Option<Report>> {
            if self.gone {
                return Err(std::io::Error::other("gone"));
            }
            match self.queue.pop_front() {
                Some(r) => Ok(Some(r)),
                // Nothing to say: wait out the timeout, like a real read does. Without this the
                // caller's deadline loop would spin.
                None => {
                    thread::sleep(Duration::from_millis(timeout_ms.max(0) as u64));
                    Ok(None)
                }
            }
        }
    }

    /// A reply `classify_reply` accepts for `req`: the request's own bytes back.
    fn echo(req: &Report) -> Report {
        *req
    }

    /// A fake that echoes every request, and — like a real keyboard — remembers the tag the last
    /// COMMIT carried and reports it in STATUS, so `verify_keymap` is satisfied.
    fn echoing_keyboard() -> (Box<Fake>, Arc<Mutex<Vec<Report>>>) {
        let tag = Arc::new(Mutex::new(0u16));
        fake(move |r| {
            if let Some(t) = proto::commit_tag(r) {
                *tag.lock().unwrap() = t;
            }
            let mut reply = echo(r);
            if r == &proto::status_request() {
                reply[3] = proto::PS_PROTO_VERSION;
                reply[4] = 0; // nothing pending
                reply[5..7].copy_from_slice(&tag.lock().unwrap().to_be_bytes());
                reply[10] = 4;
            }
            Answer::Send(vec![reply])
        })
    }

    /// The V6 8K ISO, the board every test here pretends to be.
    fn board() -> &'static board::Board {
        board::by_id("v6_8k_iso_encoder").expect("a board the app knows")
    }

    fn conn(dev: Box<Fake>) -> Conn {
        Conn {
            dev,
            board: board(),
            firmware: Firmware::Ok,
            fw_version: proto::PS_PROTO_VERSION,
            note: None,
            layer_count: 4,
            mix: None,
            leds: IndexMap::new(),
            led_count: 0,
            own_mix: None,
            mix_state: MixState::Own,
            max_layers: 4,
            build_id: 0,
            dropped: 0,
            off_board: 0,
            base_layer: Some(2),
            seen_layer: Some(2),
            applied_keymap: None,
            pending_tag: None,
            applied_lighting: None,
            last_ping: Instant::now(),
            missed_pings: 0,
            base_failures: 0,
            base_retry_at: None,
            key_report_sent: None,
            key_report_refused: false,
            key_events: Vec::new(),
        }
    }

    /// A worker holding `c`, and the events it emits.
    fn worker(c: Conn) -> (Worker, Rc<RefCell<Vec<Event>>>) {
        let events = Rc::new(RefCell::new(vec![]));
        let sink = events.clone();
        let mut w = Worker::new(Rc::new(move |e| sink.borrow_mut().push(e)), Rc::new(RefCell::new(WorkerState::default())));
        w.conn = Some(c);
        (w, events)
    }

    fn profile_with(binds: &[(&str, u16)]) -> Profile {
        Profile {
            id: "p".into(),
            name: "Test".into(),
            programs: vec![],
            exes: vec![],
            binds: binds.iter().map(|(k, kc)| ((*k).to_string(), crate::model::Bind::Key { keycode: *kc })).collect(),
            lighting: None,
        }
    }

    #[test]
    fn a_keyboard_that_answers_is_read_from_end_to_end() {
        // STATUS, the layer count, the default layer and every layer of the keymap — with one of
        // Keychron's unsolicited layer notifications turning up in the middle of an exchange,
        // which is what `classify_reply` has to step over.
        let notified = Arc::new(Mutex::new(false));
        let flag = notified.clone();
        let (dev, seen) = fake(move |r| {
            if r == &proto::status_request() {
                let mut reply = echo(r);
                reply[3] = proto::PS_PROTO_VERSION;
                reply[10] = 4;
                return Answer::Send(vec![reply]);
            }
            if r[0] == proto::KC_GET_DEFAULT_LAYER {
                let mut reply = echo(r);
                reply[1] = 2; // WIN_BASE
                return Answer::Send(vec![reply]);
            }
            let reply = echo(r);
            let mut sent = flag.lock().unwrap();
            if !*sent {
                *sent = true;
                // An unsolicited report before the real reply: it must not be mistaken for it.
                let mut note = [0u8; REPORT_LEN];
                note[0] = proto::KC_GET_DEFAULT_LAYER;
                note[1] = 2;
                return Answer::Send(vec![note, reply]);
            }
            Answer::Send(vec![reply])
        });
        let mut c = conn(dev);

        let (firmware, version, note) = c.query_firmware().expect("STATUS answered");
        assert_eq!((firmware, version), (Firmware::Ok, proto::PS_PROTO_VERSION));
        assert_eq!(note, None, "a current module has nothing to complain about");
        assert_eq!(c.max_layers, 4);

        let base = c.read_base().expect("the keymap was read");
        assert_eq!(base.layer, 2, "the default layer the keyboard reported");
        assert_eq!(base.layers.len(), 4);
        assert_eq!(base.board.as_deref(), Some("v6_8k_iso_encoder"));
        assert_eq!(base.source, KeymapSource::Keyboard);
        assert!(*notified.lock().unwrap(), "the notification was delivered and stepped over");
        assert!(seen.lock().unwrap().len() > 40, "one request per chunk, per encoder, per layer");
    }

    #[test]
    fn a_keyboard_without_the_module_is_recognised() {
        let (dev, _) = fake(|r| {
            let mut reply = echo(r);
            reply[0] = proto::ID_UNHANDLED;
            Answer::Send(vec![reply])
        });
        let mut c = conn(dev);
        let (firmware, version, note) = c.query_firmware().unwrap();
        assert_eq!((firmware, version, note), (Firmware::Missing, 0, None));
    }

    #[test]
    fn a_module_this_app_cannot_speak_is_reported_not_used() {
        let (dev, _) = fake(|r| {
            let mut reply = echo(r);
            reply[3] = proto::PS_PROTO_VERSION + 1;
            Answer::Send(vec![reply])
        });
        let mut c = conn(dev);
        let (firmware, version, note) = c.query_firmware().unwrap();
        assert_eq!((firmware, version), (Firmware::Missing, 0));
        assert!(note.unwrap().contains("can't talk to"));
    }

    #[test]
    fn a_development_module_from_before_1_0_is_told_to_reinstall() {
        // Development builds used 2-9 (the user's keyboard ran 4): higher than 1, but not newer.
        for old in [4, 9] {
            let (dev, seen) = fake(move |r| {
                let mut reply = echo(r);
                reply[3] = old;
                Answer::Send(vec![reply])
            });
            let mut c = conn(dev);
            let (firmware, version, note) = c.query_firmware().unwrap();
            assert_eq!((firmware, version), (Firmware::Missing, 0), "protocol {old}");
            assert!(note.unwrap().contains("Install the profile switcher from this app"), "protocol {old}");
            // Nothing of the profile is sent to it.
            c.firmware = firmware;
            c.fw_version = version;
            let keymap = proto::build_keymap(&profile_with(&[("L2:3,1", 0x14)]), proto::DEFAULT_MACRO_GAP).unwrap();
            c.reconcile(&Desired { keymap, lighting: None }, None).unwrap();
            assert!(
                !seen.lock().unwrap().iter().any(|r| r[0] == 0x07 && r[1] == 0x00),
                "protocol {old}: no profile switcher packet goes to it"
            );
        }
    }

    #[test]
    fn what_has_not_changed_is_not_sent_again() {
        let (dev, seen) = echoing_keyboard();
        let mut c = conn(dev);
        let keymap = proto::build_keymap(&profile_with(&[("L2:3,1", 0x14)]), proto::DEFAULT_MACRO_GAP).unwrap();
        let desired = Desired { keymap, lighting: None };

        c.reconcile(&desired, None).expect("sent");
        let first = seen.lock().unwrap().len();
        assert!(first > 0, "the remap went out");

        c.reconcile(&desired, None).expect("nothing to do");
        assert_eq!(seen.lock().unwrap().len(), first, "the same state is not sent twice");

        // A different profile is.
        let other =
            Desired { keymap: proto::build_keymap(&profile_with(&[("L2:3,1", 0x15)]), proto::DEFAULT_MACRO_GAP).unwrap(), lighting: None };
        c.reconcile(&other, None).expect("sent");
        assert!(seen.lock().unwrap().len() > first);
    }

    #[test]
    fn a_send_cut_short_by_a_timeout_is_tried_again() {
        // The keyboard answers the first packet and then goes quiet once.
        let answered = Arc::new(Mutex::new(0));
        let count = answered.clone();
        let tag = Arc::new(Mutex::new(0u16));
        let (dev, _) = fake(move |r| {
            let mut n = count.lock().unwrap();
            *n += 1;
            if *n == 2 {
                return Answer::Silent;
            }
            if let Some(t) = proto::commit_tag(r) {
                *tag.lock().unwrap() = t;
            }
            let mut reply = echo(r);
            if r == &proto::status_request() {
                reply[3] = proto::PS_PROTO_VERSION;
                reply[5..7].copy_from_slice(&tag.lock().unwrap().to_be_bytes());
                reply[10] = 4;
            }
            Answer::Send(vec![reply])
        });
        let mut c = conn(dev);
        let desired = Desired {
            keymap: proto::build_keymap(&profile_with(&[("L2:3,1", 0x14), ("L2:3,2", 0x15)]), proto::DEFAULT_MACRO_GAP).unwrap(),
            lighting: None,
        };
        assert!(c.reconcile(&desired, None).is_err(), "it gave up on the timeout");
        assert!(c.applied_keymap.is_none(), "so nothing is remembered as sent, and it is retried");
        c.reconcile(&desired, None).expect("the second attempt gets through");
        assert!(c.applied_keymap.is_some());
    }

    #[test]
    fn a_profile_the_keyboard_did_not_really_take_is_sent_again() {
        // The keyboard answers every packet but ends up holding something else: a packet lost on
        // a Raw HID interface shared with VIA, say. COMMIT's fingerprint is how that shows up.
        let (dev, _) = fake(|r| {
            let mut reply = echo(r);
            if r == &proto::status_request() {
                reply[3] = proto::PS_PROTO_VERSION;
                reply[5..7].copy_from_slice(&0xBEEFu16.to_be_bytes()); // not what was committed
                reply[10] = 4;
            }
            Answer::Send(vec![reply])
        });
        let mut c = conn(dev);
        let desired =
            Desired { keymap: proto::build_keymap(&profile_with(&[("L2:3,1", 0x14)]), proto::DEFAULT_MACRO_GAP).unwrap(), lighting: None };
        assert!(c.reconcile(&desired, None).is_err(), "the app notices");
        assert!(c.applied_keymap.is_none(), "so it is sent again rather than reported as applied");
    }

    #[test]
    fn a_profile_accepted_while_a_key_is_held_is_not_an_error() {
        // The firmware waits until no key is held before swapping profiles, and reports `pending`
        // until then. That is not a failure: the profile is accepted, lighting still goes out, and
        // the tag is re-checked on the next ping.
        let pending = Arc::new(Mutex::new(true));
        let flag = pending.clone();
        let tag = Arc::new(Mutex::new(0u16));
        let (dev, _) = fake(move |r| {
            if let Some(t) = proto::commit_tag(r) {
                *tag.lock().unwrap() = t;
            }
            let mut reply = echo(r);
            if r == &proto::status_request() {
                reply[3] = proto::PS_PROTO_VERSION;
                reply[4] = u8::from(*flag.lock().unwrap()); // pending while a key is held
                reply[5..7].copy_from_slice(&tag.lock().unwrap().to_be_bytes());
                reply[10] = 4;
            }
            Answer::Send(vec![reply])
        });
        let mut c = conn(dev);
        let desired =
            Desired { keymap: proto::build_keymap(&profile_with(&[("L2:3,1", 0x14)]), proto::DEFAULT_MACRO_GAP).unwrap(), lighting: None };
        c.reconcile(&desired, None).expect("accepted, not an error");
        assert!(c.applied_keymap.is_some(), "remembered as sent, so it isn't resent");
        assert!(c.pending_tag.is_some(), "and re-checked on the next ping");

        // The key is released: the next check finds the tag live and stops re-checking.
        *pending.lock().unwrap() = false;
        let tag = c.pending_tag.unwrap();
        assert_eq!(c.verify_keymap(tag).unwrap(), Verify::Live);
    }

    #[test]
    fn mix_regions_that_could_not_be_read_are_not_restored_over_and_over() {
        let (dev, seen) = fake(|r| Answer::Send(vec![echo(r)]));
        let mut c = conn(dev);
        c.mix = Some(proto::MixInfo { regions: 2, effects_per_region: 5 });
        c.mix_state = MixState::Unknown; // a profile's regions are playing
        c.own_mix = None; // …and the keyboard's own were never readable

        c.send_mix(None).expect("nothing it can do");
        assert_eq!(c.mix_state, MixState::NoOwn, "it remembers that it tried");
        let after = seen.lock().unwrap().len();
        c.send_mix(None).expect("and doesn't try again");
        assert_eq!(seen.lock().unwrap().len(), after);
    }

    /// What the module sends while it reports keys: 3,1 down, the knob turned clockwise once.
    fn key_report() -> Report {
        let mut r = [0u8; REPORT_LEN];
        r[..12].copy_from_slice(&[proto::PS_KEY_REPORT_ID, 3, 0, 3, 1, 1, 253, 0, 1, 253, 0, 0]);
        r
    }

    /// One round of the worker's loop, after the commands.
    fn tick(w: &mut Worker) {
        w.sync_key_report();
        w.idle_tick();
        w.hand_on_keys();
    }

    fn keys_of(events: &Rc<RefCell<Vec<Event>>>) -> Vec<(String, bool)> {
        events
            .borrow()
            .iter()
            .filter_map(|e| if let Event::Keys(k) = e { Some(k.clone()) } else { None })
            .flatten()
            .map(|e| (e.key, e.down))
            .collect()
    }

    #[test]
    fn key_reports_flow_only_while_the_tester_asks_for_them() {
        // The keyboard answers KEY_REPORT on with the echo, then starts reporting.
        let (dev, seen) = fake(|r| {
            if r == &proto::key_report_request(true) {
                Answer::Send(vec![echo(r), key_report()])
            } else {
                Answer::Send(vec![echo(r)])
            }
        });
        let (mut w, events) = worker(conn(dev));
        let asked =
            |seen: &Arc<Mutex<Vec<Report>>>, on: bool| seen.lock().unwrap().iter().filter(|r| **r == proto::key_report_request(on)).count();

        tick(&mut w);
        assert_eq!(asked(&seen, true), 0, "nobody asked: the keyboard isn't told to report");

        let (tx, answer) = mpsc::channel();
        w.handle(Command::KeyReport(true, tx));
        assert!(answer.recv().unwrap(), "the keyboard said it is reporting");
        tick(&mut w);
        assert_eq!(asked(&seen, true), 1);
        assert_eq!(keys_of(&events), [("3,1".to_string(), true), ("e0:cw".to_string(), true), ("e0:cw".to_string(), false)]);
        tick(&mut w);
        assert_eq!(asked(&seen, true), 1, "renewed every few seconds, not every round");

        // Renewal: due once KEY_REPORT_RENEW has passed.
        w.conn.as_mut().unwrap().key_report_sent = Some(Instant::now() - KEY_REPORT_RENEW);
        tick(&mut w);
        assert_eq!(asked(&seen, true), 2);

        // The UI stopped renewing (closed, crashed): off, and late reports go nowhere.
        events.borrow_mut().clear();
        w.state.borrow_mut().key_report_until = Some(Instant::now() - Duration::from_millis(1));
        w.conn.as_mut().unwrap().dev = {
            let (mut dev, _) = fake(|r| Answer::Send(vec![echo(r)]));
            dev.queue.push_back(key_report());
            dev
        };
        tick(&mut w);
        assert!(w.conn.as_ref().unwrap().key_report_sent.is_none(), "told to stop");
        assert!(keys_of(&events).is_empty(), "a report after that isn't passed on");
    }

    #[test]
    fn key_reports_are_not_asked_of_a_keyboard_without_the_module() {
        let (dev, seen) = echoing_keyboard();
        let mut c = conn(dev);
        c.firmware = Firmware::Missing;
        c.fw_version = 0;
        let (mut w, _) = worker(c);
        let (tx, answer) = mpsc::channel();
        w.handle(Command::KeyReport(true, tx));
        assert!(!answer.recv().unwrap());
        tick(&mut w);
        assert!(!seen.lock().unwrap().contains(&proto::key_report_request(true)), "no module, no KEY_REPORT");
    }

    #[test]
    fn a_keyboard_that_cannot_start_key_reports_says_so_and_is_not_asked_every_round() {
        // Every deferred-exec slot taken: the reply's byte 3 says it isn't reporting.
        let (dev, seen) = fake(|r| {
            let mut reply = echo(r);
            if r == &proto::key_report_request(true) {
                reply[3] = 0;
            }
            Answer::Send(vec![reply])
        });
        let (mut w, _) = worker(conn(dev));
        let asked = |seen: &Arc<Mutex<Vec<Report>>>| seen.lock().unwrap().iter().filter(|r| **r == proto::key_report_request(true)).count();
        let (tx, answer) = mpsc::channel();
        w.handle(Command::KeyReport(true, tx));
        assert!(!answer.recv().unwrap(), "the UI hears it, and falls back to Windows' keys");
        tick(&mut w);
        tick(&mut w);
        assert_eq!(asked(&seen), 1, "not asked again on every round");
        let (tx, answer) = mpsc::channel();
        w.handle(Command::KeyReport(true, tx));
        assert!(!answer.recv().unwrap());
        assert_eq!(asked(&seen), 2, "asked again when the tester asks again");
    }

    #[test]
    fn a_keyboard_that_stops_answering_is_treated_as_unplugged() {
        let (dev, _) = fake(|_| Answer::Silent);
        let (mut w, events) = worker(conn(dev));
        for tick in 1..=MISSED_PINGS_GONE {
            w.conn.as_mut().unwrap().last_ping = Instant::now().checked_sub(PING_EVERY).unwrap();
            w.idle_tick();
            if tick < MISSED_PINGS_GONE {
                assert!(w.conn.is_some(), "tick {tick}: one missed ping is not a disconnect");
            }
        }
        assert!(w.conn.is_none(), "after {MISSED_PINGS_GONE} in a row it counts as unplugged");
        let events = events.borrow();
        assert!(events.iter().any(|e| matches!(e, Event::Connection { connected: false, .. })), "the UI is told: {events:?}");
        assert!(
            events.iter().any(|e| matches!(e, Event::ApplyError(Some(m)) if m.contains("didn't answer"))),
            "and every earlier miss was visible, instead of the message being thrown away"
        );
        assert!(events.iter().any(|e| matches!(e, Event::Search(Some(m)) if m.contains("stopped answering"))));
    }

    #[test]
    fn an_unplugged_keyboard_drops_the_connection_at_once() {
        // Unlike a timeout, an I/O error means it is gone: no waiting for three pings.
        let (dev, _) = fake(|_| Answer::Lost);
        let (mut w, events) = worker(conn(dev));
        w.conn.as_mut().unwrap().last_ping = Instant::now().checked_sub(PING_EVERY).unwrap();
        w.idle_tick();
        assert!(w.conn.is_none());
        let events = events.borrow();
        assert!(events.iter().any(|e| matches!(e, Event::Connection { connected: false, .. })), "{events:?}");
    }

    #[test]
    fn a_keymap_re_read_that_keeps_failing_backs_off_and_then_stops() {
        let (dev, seen) = fake(|_| Answer::Silent);
        let (mut w, _) = worker(conn(dev));
        // The keyboard said its default layer is 3; the keymap on show was read from layer 2.
        w.conn.as_mut().unwrap().seen_layer = Some(3);

        w.follow_default_layer();
        let after_first = seen.lock().unwrap().len();
        assert!(after_first > 0, "it tried");
        assert_eq!(w.conn.as_ref().unwrap().base_failures, 1);

        // Straight away again: it waits instead of hammering the keyboard on every idle tick.
        w.follow_default_layer();
        assert_eq!(seen.lock().unwrap().len(), after_first, "nothing was sent while backing off");

        // After enough failures it gives up until the keyboard reports a different layer again.
        for _ in 0..BASE_RETRY.len() {
            w.conn.as_mut().unwrap().base_retry_at = None;
            w.follow_default_layer();
        }
        let c = w.conn.as_ref().unwrap();
        assert_eq!(c.base_layer, Some(3), "the loop is stopped");
        assert_eq!(c.base_failures, 0);
        let settled = seen.lock().unwrap().len();
        w.follow_default_layer();
        assert_eq!(seen.lock().unwrap().len(), settled, "and it stays stopped");
    }

    #[test]
    fn the_worker_is_restarted_after_a_panic() {
        // Panics once, then runs normally: the worker comes back and the app keeps the keyboard.
        let runs = Cell::new(0);
        let panics = Cell::new(0);
        let ok = restarting(
            MAX_RESTARTS,
            || {
                runs.set(runs.get() + 1);
                if runs.get() == 1 {
                    panic!("device thread went wrong");
                }
            },
            |_| panics.set(panics.get() + 1),
        );
        assert!(ok);
        assert_eq!((runs.get(), panics.get()), (2, 1));

        // Panics every time: it gives up rather than looping, so the UI can say so.
        let runs = Cell::new(0);
        let ok = restarting(
            MAX_RESTARTS,
            || {
                runs.set(runs.get() + 1);
                panic!("again");
            },
            |_| {},
        );
        assert!(!ok);
        assert_eq!(runs.get(), MAX_RESTARTS + 1, "the first attempt plus the restarts");
    }

    #[test]
    fn explains_why_the_keyboard_is_unusable() {
        assert_eq!(missing_reason(&[]), None);
        // Keyboard interface only: firmware built without VIA / Raw HID.
        assert!(missing_reason(&[(0x0F61, 0x0001, 0x06)]).unwrap().contains("Raw HID"));
        assert_eq!(unreachable_board(&[(0x0F61, 0x0001, 0x06)]).as_deref(), Some("v6_8k_iso_encoder"));
        assert_eq!(unreachable_board(&[(0x0F61, 0x0001, 0x06), (0x0F61, 0xFF60, 0x61)]), None, "it has Raw HID");
        assert_eq!(unreachable_board(&[(0xD030, 0x0001, 0x06)]), None, "not a keyboard the app knows");
        assert!(missing_reason(&[(0x0F61, 0x0001, 0x06)]).unwrap().contains("V6 8K ISO Knob"));
        // A dongle, or a board newer than the app.
        assert!(missing_reason(&[(0xD030, 0xFF60, 0x61)]).unwrap().contains("0xD030"));
    }
}
