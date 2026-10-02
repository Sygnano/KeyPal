//! Decides which profile is active and what the keyboard should hold.

use crate::device::{Command, Desired, DeviceHandle, Event};
use crate::model::{
    AppConfig, BaseKeymap, EngineState, Firmware, FocusState, Lighting, Mode, Profile, ProgramMatch, ProgramRule, DEFAULT_PROFILE_ID,
};
use crate::protocol;
use crate::storage::Storage;
use crate::watcher::{file_name, Focus};

/// Receives the engine state and the active profile's name.
pub type StateListener = Box<dyn Fn(&EngineState, &str) + Send>;

/// What the tray menu shows: every saved profile, which one is active, and whether it's forced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayState {
    /// (id, name), Default first.
    pub profiles: Vec<(String, String)>,
    pub active_id: String,
    pub forced: bool,
}

/// Where the engine reports changes: the frontend events, the tray tooltip and menu.
pub struct Notifier {
    pub state: StateListener,
    pub base: Box<dyn Fn(&BaseKeymap) + Send>,
    /// The saved profiles changed without the UI asking (Default adopted the keyboard's lighting).
    pub config: Box<dyn Fn(&AppConfig) + Send>,
    /// The keyboard's own lighting was read (on connect): the UI can show it without polling.
    pub lighting: Box<dyn Fn(&Lighting) + Send>,
    /// The focused window changed (its title changes up to four times a second): sent on its own
    /// so it doesn't re-render every `EngineState` subscriber.
    pub focus: Box<dyn Fn(&FocusState) + Send>,
    pub tray: Box<dyn Fn(&TrayState) + Send>,
}

pub struct Engine {
    config: AppConfig,
    storage: Storage,
    device: DeviceHandle,
    notify: Notifier,
    override_id: Option<String>,
    foreground: Option<Focus>,
    connected: bool,
    firmware: Firmware,
    firmware_version: u8,
    /// Which firmware project the keyboard's build came from (0 when unknown).
    build_id: u32,
    mix_regions: u8,
    /// The keyboard plugged in (`board.rs` id).
    board: Option<String>,
    device_error: Option<String>,
    /// A problem with the saved profiles themselves (unreadable file, profile too big…).
    config_error: Option<String>,
    load_error: Option<String>,
    /// Why the keyboard can't be used while it isn't connected.
    search_note: Option<String>,
    /// A known keyboard plugged in without Raw HID (see `device::Event::Unreachable`).
    unreachable: Option<String>,
    base: BaseKeymap,
    /// The keyboard's own lighting, read when it last connected.
    keyboard_lighting: Option<Lighting>,
    last_sent: Option<Desired>,
    last_state: Option<EngineState>,
    last_focus: Option<FocusState>,
    last_tray: Option<TrayState>,
    /// What `sync` last worked out, and for which profile of which version of the config.
    /// `sync` runs on every change of the focused window's *title* — up to four times a second,
    /// for ever — and building the keymap sorts every key id and re-encodes every macro, while
    /// `Lighting::for_keyboard` clones, flattens and sorts the colour layers. Neither depends on
    /// the window, so they are worked out again only when the profile or the config does change.
    desired_for: Option<(u64, String)>,
    /// Bumped whenever the config is replaced.
    config_gen: u64,
    /// The PC's gap for macros without their own (`Settings::macro_gap`).
    macro_gap: u16,
}

impl Engine {
    pub fn new(storage: Storage, device: DeviceHandle, notify: Notifier) -> Self {
        let (mut config, load_error) = storage.load_config();
        if let Some(e) = &load_error {
            log::error!("{e}");
        }
        let base = storage.load_base_keymap().unwrap_or_else(BaseKeymap::fallback);
        // Remaps saved before layers were chosen: on the default layer the keyboard last had.
        config.put_binds_on_layers(base.layer);
        let mut engine = Engine {
            config,
            storage,
            device,
            notify,
            override_id: None,
            foreground: None,
            connected: false,
            firmware: Firmware::Unknown,
            firmware_version: 0,
            build_id: 0,
            mix_regions: 0,
            board: None,
            device_error: None,
            config_error: None,
            load_error,
            search_note: None,
            unreachable: None,
            base,
            keyboard_lighting: None,
            last_sent: None,
            last_state: None,
            last_focus: None,
            last_tray: None,
            desired_for: None,
            macro_gap: protocol::DEFAULT_MACRO_GAP,
            config_gen: 0,
        };
        engine.sync();
        engine
    }

    pub fn config(&self) -> AppConfig {
        self.config.clone()
    }

    pub fn base(&self) -> BaseKeymap {
        self.base.clone()
    }

    /// Profiles from a file, their remaps put on layers like this config's.
    pub fn place_imported(&self, profiles: Vec<Profile>) -> Vec<Profile> {
        let mut cfg = AppConfig { version: crate::model::CONFIG_VERSION, profiles, macros: vec![] };
        cfg.put_binds_on_layers(self.base.layer);
        cfg.profiles
    }

    pub fn save_config(&mut self, mut config: AppConfig) -> Result<(), String> {
        config.version = crate::model::CONFIG_VERSION;
        config.profiles.iter_mut().for_each(Profile::migrate);
        config.put_binds_on_layers(self.base.layer);
        config.validate()?;
        for p in &config.profiles {
            protocol::build_keymap(p, self.macro_gap)?;
        }
        self.storage.save_config(&config)?;
        log::info!("profiles saved ({} profile(s))", config.profiles.len());
        self.config = config;
        self.config_gen += 1;
        self.load_error = None;
        if let Some(id) = &self.override_id {
            if self.config.profile(id).is_none() {
                self.override_id = None;
            }
        }
        self.sync();
        Ok(())
    }

    /// The PC's default gap between macro steps changed (Settings): macros without their own are
    /// sent again with it.
    pub fn set_macro_gap(&mut self, ms: u16) {
        if self.macro_gap == ms {
            return;
        }
        self.macro_gap = ms;
        self.desired_for = None;
        self.sync();
    }

    /// Some(id) forces that profile (Default included); None returns to automatic switching.
    pub fn set_override(&mut self, id: Option<String>) -> Result<(), String> {
        if let Some(id) = &id {
            if self.config.profile(id).is_none() {
                return Err("That profile hasn't been applied yet.".into());
            }
        }
        log::info!("forced profile: {}", id.as_deref().unwrap_or("none (automatic)"));
        self.override_id = id;
        self.sync();
        Ok(())
    }

    pub fn set_foreground(&mut self, focus: Focus) {
        log::debug!("focused: {}", focus.exe());
        self.foreground = Some(focus);
        self.sync();
    }

    pub fn keyboard_lighting(&self) -> Option<Lighting> {
        self.keyboard_lighting.clone()
    }

    pub fn preview_lighting(&self, lighting: Option<Lighting>) {
        self.device.send(Command::Preview(lighting.map(|l| l.for_keyboard())));
    }

    pub fn on_device(&mut self, event: Event) {
        match event {
            Event::Connection { connected, firmware, version, mix_regions, board, build_id } => {
                self.connected = connected;
                self.firmware = firmware;
                self.firmware_version = version;
                self.build_id = build_id;
                self.mix_regions = mix_regions;
                if connected {
                    self.board = board;
                }
                if !connected {
                    self.device_error = None;
                }
            }
            Event::ApplyError(e) => self.device_error = e,
            Event::Search(note) => self.search_note = note,
            Event::Unreachable(board) => self.unreachable = board,
            Event::KeyboardLighting(l) => self.adopt_keyboard_lighting(l),
            // The keyboard tester's: lib.rs passes them to the UI without taking the engine lock.
            Event::Keys(_) => return,
            Event::BaseKeymap(b) => {
                if let Err(e) = self.storage.save_base_keymap(&b) {
                    log::warn!("base keymap cache: {e}");
                }
                (self.notify.base)(&b);
                self.base = b;
            }
        }
        self.sync();
    }

    /// Default with no lighting of its own takes whatever the keyboard shows (its saved effect,
    /// e.g. a rainbow wave) the first time it connects. From then on every profile's lighting is
    /// explicit and switching profiles always lands on known settings.
    fn adopt_keyboard_lighting(&mut self, l: Lighting) {
        self.keyboard_lighting = Some(l.clone());
        (self.notify.lighting)(&l);
        if self.config.profiles[0].lighting.is_some() {
            return;
        }
        let mut config = self.config.clone();
        config.profiles[0].lighting = Some(l);
        match self.storage.save_config(&config) {
            Ok(()) => {
                log::info!("Default adopted the keyboard's own lighting");
                self.config = config;
                self.config_gen += 1;
                (self.notify.config)(&self.config);
            }
            Err(e) => log::error!("could not save Default's lighting: {e}"),
        }
    }

    pub fn state(&self) -> EngineState {
        EngineState {
            connected: self.connected,
            firmware: self.firmware,
            firmware_version: if self.connected { self.firmware_version } else { 0 },
            build_id: if self.connected { self.build_id } else { 0 },
            mix_rgb: self.connected && self.mix_regions > 0,
            mix_regions: if self.connected { self.mix_regions } else { 0 },
            board: if self.connected { self.board.clone() } else { None },
            unreachable: if self.connected { None } else { self.unreachable.clone() },
            mode: if self.override_id.is_some() { Mode::Manual } else { Mode::Auto },
            active_profile_id: self.active().id.clone(),
            last_error: self.load_error.clone().or(self.config_error.clone()).or(self.device_error.clone()).or(if self.connected {
                None
            } else {
                self.search_note.clone()
            }),
        }
    }

    /// The focused window, as the UI shows it.
    pub fn focus_state(&self) -> FocusState {
        FocusState {
            exe: self.foreground.as_ref().map(|f| f.exe().to_string()),
            path: self.foreground.as_ref().map(|f| f.path.clone()),
            title: self.foreground.as_ref().map(|f| f.title.clone()),
        }
    }

    fn active(&self) -> &Profile {
        select_profile(&self.config, self.override_id.as_deref(), self.foreground.as_ref())
    }

    fn tray_state(&self) -> TrayState {
        TrayState {
            profiles: self.config.profiles.iter().map(|p| (p.id.clone(), p.name.clone())).collect(),
            active_id: self.active().id.clone(),
            forced: self.override_id.is_some(),
        }
    }

    /// Recompute the desired keyboard state, send it if it changed, and report the engine state.
    fn sync(&mut self) {
        let profile = self.active();
        let key = (self.config_gen, profile.id.clone());
        if self.desired_for.as_ref() != Some(&key) {
            let lighting = resolve_lighting(&self.config, profile);
            let (keymap, config_error) = match protocol::build_keymap(profile, self.macro_gap) {
                Ok(k) => (k, None),
                // Can't happen for configs saved by this app; clear the overlay rather than keep a stale one.
                Err(e) => (Default::default(), Some(e)),
            };
            self.config_error = config_error;
            let desired = Desired { keymap, lighting };
            if self.last_sent.as_ref() != Some(&desired) {
                self.device.send(Command::SetDesired(desired.clone()));
                self.last_sent = Some(desired);
            }
            self.desired_for = Some(key);
        }

        let state = self.state();
        if self.last_state.as_ref() != Some(&state) {
            if self.last_state.as_ref().map(|s| &s.active_profile_id) != Some(&state.active_profile_id) {
                log::info!("active profile: {}", self.active().name);
            }
            (self.notify.state)(&state, &self.active().name);
            self.last_state = Some(state);
        }
        // The focused window goes on its own: its title changes up to four times a second, and
        // every `EngineState` subscriber would re-render with it.
        let focus = self.focus_state();
        if self.last_focus.as_ref() != Some(&focus) {
            (self.notify.focus)(&focus);
            self.last_focus = Some(focus);
        }
        let tray = self.tray_state();
        if self.last_tray.as_ref() != Some(&tray) {
            (self.notify.tray)(&tray);
            self.last_tray = Some(tray);
        }
    }
}

/// How well a rule fits the focused window, None if it doesn't. A title condition beats a
/// program alone; among programs, an exact path beats a folder, which beats a file name.
pub fn rule_score(rule: &ProgramRule, focus: &Focus) -> Option<u8> {
    let path = rule.path.trim();
    let title = rule.title.trim();
    if path.is_empty() && title.is_empty() {
        return None;
    }
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let program = if path.is_empty() {
        0
    } else {
        let hit = match rule.match_by {
            ProgramMatch::Name => file_name(path).to_lowercase() == focus.exe().to_lowercase(),
            ProgramMatch::Folder => norm(&focus.path).starts_with(&format!("{}\\", norm(path))),
            ProgramMatch::Path => norm(&focus.path) == norm(path),
        };
        if !hit {
            return None;
        }
        match rule.match_by {
            ProgramMatch::Name => 1,
            ProgramMatch::Folder => 2,
            ProgramMatch::Path => 3,
        }
    };
    if title.is_empty() {
        return Some(program);
    }
    focus.title.to_lowercase().contains(&title.to_lowercase()).then_some(program + 4)
}

/// Override, else the custom profile whose rule fits the focused window best (the first one in
/// the list on a tie), else Default.
pub fn select_profile<'a>(config: &'a AppConfig, override_id: Option<&str>, focus: Option<&Focus>) -> &'a Profile {
    if let Some(p) = override_id.and_then(|id| config.profile(id)) {
        return p;
    }
    let mut best: Option<(u8, &Profile)> = None;
    if let Some(focus) = focus {
        for p in config.profiles.iter().filter(|p| p.id != DEFAULT_PROFILE_ID) {
            let score = p.programs.iter().filter_map(|r| rule_score(r, focus)).max();
            if let Some(s) = score {
                if best.is_none_or(|(b, _)| s > b) {
                    best = Some((s, p));
                }
            }
        }
    }
    best.map_or(config.default_profile(), |(_, p)| p)
}

/// The profile's own lighting, else Default's, else None (leave the keyboard alone), with its
/// colour layers flattened for the keyboard.
pub fn resolve_lighting(config: &AppConfig, profile: &Profile) -> Option<Lighting> {
    profile.lighting.as_ref().or(config.default_profile().lighting.as_ref()).map(Lighting::for_keyboard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device;
    use crate::model::{Bind, ColorLayer, Hsv};
    use std::sync::{Arc, Mutex};

    fn solid(hue: u8) -> Lighting {
        Lighting { effect: 1, speed: 0, brightness: 255, hue, sat: 255, ..Default::default() }
    }

    fn focus(path: &str, title: &str) -> Focus {
        Focus { path: path.into(), title: title.into() }
    }

    fn rule(path: &str, match_by: ProgramMatch, title: &str) -> ProgramRule {
        ProgramRule { path: path.into(), match_by, title: title.into() }
    }

    fn config() -> AppConfig {
        let mut cfg = AppConfig::default();
        let mut add = |id: &str, exes: &[&str]| {
            let mut p = cfg.profiles[0].clone();
            p.id = id.into();
            p.name = id.to_uppercase();
            p.programs = exes.iter().map(|s| ProgramRule::by_name(*s)).collect();
            cfg.profiles.push(p);
        };
        add("a", &["C:\\Games\\CS2.exe"]);
        add("b", &["D:/other/cs2.exe", "D:\\x\\notepad.exe"]);
        cfg
    }

    #[test]
    fn picks_override_then_first_match_then_default() {
        let cfg = config();
        let at = |exe: &str| focus(&format!("C:\\Somewhere\\{exe}"), "");
        assert_eq!(select_profile(&cfg, None, None).id, "default");
        assert_eq!(select_profile(&cfg, None, Some(&at("cs2.exe"))).id, "a");
        assert_eq!(select_profile(&cfg, None, Some(&at("NOTEPAD.EXE"))).id, "b");
        assert_eq!(select_profile(&cfg, None, Some(&at("explorer.exe"))).id, "default");
        assert_eq!(select_profile(&cfg, Some("default"), Some(&at("cs2.exe"))).id, "default");
        assert_eq!(select_profile(&cfg, Some("b"), None).id, "b");
        assert_eq!(select_profile(&cfg, Some("gone"), Some(&at("cs2.exe"))).id, "a");
    }

    #[test]
    fn default_profile_never_matches_by_program() {
        let mut cfg = config();
        cfg.profiles[0].programs.push(ProgramRule::by_name("C:\\vim.exe"));
        assert_eq!(select_profile(&cfg, None, Some(&focus("C:\\vim.exe", ""))).id, "default");
    }

    #[test]
    fn rules_by_path_folder_and_title() {
        let game = focus("D:\\Games\\Foo\\bin\\Game.exe", "Foo — Main Menu");
        assert_eq!(rule_score(&rule("C:\\elsewhere\\game.exe", ProgramMatch::Name, ""), &game), Some(1));
        assert_eq!(rule_score(&rule("D:/games/foo", ProgramMatch::Folder, ""), &game), Some(2));
        assert_eq!(rule_score(&rule("D:\\Games\\Foo\\", ProgramMatch::Folder, ""), &game), Some(2));
        assert_eq!(rule_score(&rule("D:\\Games\\Fo", ProgramMatch::Folder, ""), &game), None, "not a folder prefix");
        assert_eq!(rule_score(&rule("d:\\games\\foo\\bin\\game.exe", ProgramMatch::Path, ""), &game), Some(3));
        assert_eq!(rule_score(&rule("C:\\Games\\Foo\\bin\\Game.exe", ProgramMatch::Path, ""), &game), None);
        assert_eq!(rule_score(&rule("", ProgramMatch::Name, "main menu"), &game), Some(4));
        assert_eq!(rule_score(&rule("Game.exe", ProgramMatch::Name, "MENU"), &game), Some(5));
        assert_eq!(rule_score(&rule("Game.exe", ProgramMatch::Name, "lobby"), &game), None);
        assert_eq!(rule_score(&rule("", ProgramMatch::Name, "  "), &game), None, "an empty rule matches nothing");
    }

    #[test]
    fn the_most_specific_rule_wins() {
        let mut cfg = config();
        // "a" has chrome.exe; "b" has chrome.exe while the title says Figma.
        cfg.profiles[1].programs = vec![ProgramRule::by_name("chrome.exe")];
        cfg.profiles[2].programs = vec![rule("chrome.exe", ProgramMatch::Name, "Figma")];
        let chrome = |title: &str| focus("C:\\Program Files\\Google\\chrome.exe", title);
        assert_eq!(select_profile(&cfg, None, Some(&chrome("News"))).id, "a");
        assert_eq!(select_profile(&cfg, None, Some(&chrome("Design – Figma"))).id, "b");
        // Same score: the first in the list wins.
        cfg.profiles[2].programs = vec![ProgramRule::by_name("chrome.exe")];
        assert_eq!(select_profile(&cfg, None, Some(&chrome("x"))).id, "a");
    }

    #[test]
    fn lighting_falls_back_to_default() {
        let mut cfg = config();
        assert_eq!(resolve_lighting(&cfg, &cfg.profiles[1]), None);
        cfg.profiles[0].lighting = Some(solid(0));
        assert_eq!(resolve_lighting(&cfg, &cfg.profiles[1]), Some(solid(0)));
        cfg.profiles[1].lighting = Some(solid(170));
        assert_eq!(resolve_lighting(&cfg, &cfg.profiles[1]), Some(solid(170)));

        // Colour layers reach the keyboard flattened; renaming one changes nothing it gets.
        let red = Hsv { h: 0, s: 255, v: 255 };
        let layer = ColorLayer {
            id: "l".into(),
            name: "A".into(),
            color: red,
            keys: vec!["1,1".into()],
            hidden: false,
            anim: Default::default(),
            speed: None,
        };
        cfg.profiles[1].lighting.as_mut().unwrap().layers = vec![layer];
        let sent = resolve_lighting(&cfg, &cfg.profiles[1]).unwrap();
        assert!(sent.layers.is_empty());
        assert_eq!(sent.keys["1,1"], red);
        cfg.profiles[1].lighting.as_mut().unwrap().layers[0].name = "B".into();
        assert_eq!(resolve_lighting(&cfg, &cfg.profiles[1]).unwrap(), sent);
    }

    type Log<T> = Arc<Mutex<Vec<T>>>;

    fn engine(dir: &str) -> (Engine, std::sync::mpsc::Receiver<Command>, Log<EngineState>, Log<FocusState>, Log<TrayState>) {
        let path = std::env::temp_dir().join(format!("v6ps-engine-{dir}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let storage = Storage::new(path);
        storage.save_config(&config()).unwrap();
        let (handle, rx) = device::channel();
        let states = Arc::new(Mutex::new(vec![]));
        let focuses = Arc::new(Mutex::new(vec![]));
        let trays = Arc::new(Mutex::new(vec![]));
        let (s2, f2, t2) = (states.clone(), focuses.clone(), trays.clone());
        let notify = Notifier {
            state: Box::new(move |s, _| s2.lock().unwrap().push(s.clone())),
            base: Box::new(|_| {}),
            lighting: Box::new(|_| {}),
            config: Box::new(|_| {}),
            focus: Box::new(move |f| f2.lock().unwrap().push(f.clone())),
            tray: Box::new(move |t| t2.lock().unwrap().push(t.clone())),
        };
        (Engine::new(storage, handle, notify), rx, states, focuses, trays)
    }

    fn sent(rx: &std::sync::mpsc::Receiver<Command>) -> Vec<Desired> {
        rx.try_iter()
            .filter_map(|c| match c {
                Command::SetDesired(d) => Some(d),
                _ => None,
            })
            .collect()
    }

    fn connected(firmware: Firmware) -> Event {
        Event::Connection { connected: true, firmware, version: 4, mix_regions: 2, board: Some("v6_8k_iso_encoder".into()), build_id: 0 }
    }

    #[test]
    fn sends_only_when_the_payload_changes() {
        let (mut e, rx, states, focuses, _) = engine("dedupe");
        assert_eq!(sent(&rx).len(), 1); // initial Default
                                        // "b" has the same (empty) keymap and lighting as Default: nothing to send…
        e.set_foreground(focus("D:\\x\\notepad.exe", "notes.txt"));
        assert!(sent(&rx).is_empty());
        // …but the UI still hears about the new active profile.
        let last = states.lock().unwrap().last().unwrap().clone();
        assert_eq!(last.active_profile_id, "b");
        let f = focuses.lock().unwrap().last().unwrap().clone();
        assert_eq!(f.exe.as_deref(), Some("notepad.exe"));
        assert_eq!(f.title.as_deref(), Some("notes.txt"));

        let mut cfg = e.config();
        cfg.profiles[2].binds.insert("3,1".into(), Bind::Key { keycode: 0x14 });
        e.save_config(cfg).unwrap();
        let d = sent(&rx);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].keymap.keys, vec![(2, 3, 1, 0x14)], "saved on the default layer (2, the fallback)");

        e.set_override(Some("default".into())).unwrap();
        assert_eq!(e.state().mode, Mode::Manual);
        assert_eq!(e.state().active_profile_id, "default");
        assert!(sent(&rx)[0].keymap.keys.is_empty());
        e.set_override(None).unwrap();
        assert_eq!(e.state().active_profile_id, "b");
        assert!(e.set_override(Some("nope".into())).is_err());
    }

    #[test]
    fn tray_hears_about_names_and_forcing() {
        let (mut e, _rx, _, _, trays) = engine("tray");
        let first = trays.lock().unwrap().last().unwrap().clone();
        assert_eq!(first.profiles.len(), 3);
        assert!(!first.forced);
        let count = trays.lock().unwrap().len();
        e.set_foreground(focus("C:\\x\\explorer.exe", "")); // same profile, same menu
        assert_eq!(trays.lock().unwrap().len(), count);
        e.set_override(Some("a".into())).unwrap();
        let t = trays.lock().unwrap().last().unwrap().clone();
        assert!(t.forced && t.active_id == "a");
        let mut cfg = e.config();
        cfg.profiles[2].name = "Renamed".into();
        e.save_config(cfg).unwrap();
        assert_eq!(trays.lock().unwrap().last().unwrap().profiles[2].1, "Renamed");
    }

    #[test]
    fn deleting_the_forced_profile_ends_forcing() {
        let (mut e, _rx, _, _, _) = engine("override");
        e.set_override(Some("a".into())).unwrap();
        let mut cfg = e.config();
        cfg.profiles.retain(|p| p.id != "a");
        e.save_config(cfg).unwrap();
        assert_eq!(e.state().mode, Mode::Auto);
    }

    #[test]
    fn rejects_invalid_configs() {
        let (mut e, _rx, _, _, _) = engine("invalid");
        let mut cfg = e.config();
        cfg.profiles[1].name = "  ".into();
        assert!(e.save_config(cfg).is_err());
        let mut cfg = e.config();
        cfg.profiles.swap(0, 1);
        assert!(e.save_config(cfg).is_err());
    }

    #[test]
    fn default_adopts_the_keyboards_own_lighting_once() {
        let (mut e, rx, _, _, _) = engine("adopt");
        sent(&rx);
        let rainbow = Lighting { effect: 4, speed: 128, brightness: 200, hue: 0, sat: 255, ..Default::default() };
        e.on_device(Event::KeyboardLighting(rainbow.clone()));
        assert_eq!(e.config().profiles[0].lighting, Some(rainbow.clone()), "Default takes it");
        assert_eq!(sent(&rx).last().unwrap().lighting, Some(rainbow.clone()), "and it's what the keyboard shows");
        // Saved: a restart keeps it.
        let (again, _) = e.storage.load_config();
        assert_eq!(again.profiles[0].lighting, Some(rainbow.clone()));

        // Later connects never overwrite what the user set.
        e.on_device(Event::KeyboardLighting(solid(90)));
        assert_eq!(e.config().profiles[0].lighting, Some(rainbow));
        assert_eq!(e.keyboard_lighting(), Some(solid(90)));
    }

    #[test]
    fn switching_profiles_always_lands_on_their_own_lighting() {
        let (mut e, rx, _, _, _) = engine("switch");
        let mut cfg = e.config();
        cfg.profiles[0].lighting = Some(solid(0));
        cfg.profiles[1].lighting = Some(solid(128));
        e.save_config(cfg).unwrap();
        for (exe, want) in [("cs2.exe", 128), ("explorer.exe", 0), ("cs2.exe", 128), ("explorer.exe", 0)] {
            e.set_foreground(focus(&format!("C:\\{exe}"), ""));
            assert_eq!(sent(&rx).last().unwrap().lighting.as_ref().unwrap().hue, want);
        }
    }

    #[test]
    fn disconnect_clears_device_errors_and_versions() {
        let (mut e, _rx, _, _, _) = engine("errors");
        e.on_device(connected(Firmware::Ok));
        assert_eq!(e.state().firmware_version, 4);
        assert!(e.state().mix_rgb);
        e.on_device(Event::ApplyError(Some("boom".into())));
        assert_eq!(e.state().last_error.as_deref(), Some("boom"));
        e.on_device(Event::Connection {
            connected: false,
            firmware: Firmware::Unknown,
            version: 0,
            mix_regions: 0,
            board: None,
            build_id: 0,
        });
        assert_eq!(e.state().last_error, None);
        assert_eq!(e.state().firmware_version, 0);
    }
}
