mod board;
mod device;
mod engine;
mod firmware;
mod icons;
mod layouts;
mod migrate;
mod model;
mod protocol;
mod storage;
mod watcher;

use device::{Command, DeviceHandle};
use engine::{Engine, Notifier, TrayState};
use model::{AppConfig, BaseKeymap, EngineState, FocusState, Lighting, Profile, Settings};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use storage::Storage;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";
const APP_NAME: &str = "KBoard Companion";
/// Tray menu ids: "force:<profile id>" forces a profile, "auto" goes back to switching by program.
const FORCE_PREFIX: &str = "force:";

type Shared = Arc<Mutex<Engine>>;

/// This PC's settings and where they're saved.
struct SettingsState {
    storage: Storage,
    current: Mutex<Settings>,
}

impl SettingsState {
    fn get(&self) -> Settings {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

fn lock(engine: &Shared) -> MutexGuard<'_, Engine> {
    engine.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Every command is async so it runs off the main thread: the engine lock is never taken there,
// which keeps tray updates (they block on the main thread) from deadlocking against it.

#[tauri::command]
async fn load_config(engine: State<'_, Shared>) -> Result<AppConfig, String> {
    Ok(lock(&engine).config())
}

#[tauri::command]
async fn save_config(engine: State<'_, Shared>, config: AppConfig) -> Result<(), String> {
    lock(&engine).save_config(config)
}

#[tauri::command]
async fn get_engine_state(engine: State<'_, Shared>) -> Result<EngineState, String> {
    Ok(lock(&engine).state())
}

#[tauri::command]
async fn get_focus_state(engine: State<'_, Shared>) -> Result<FocusState, String> {
    Ok(lock(&engine).focus_state())
}

#[tauri::command]
async fn set_override(engine: State<'_, Shared>, profile_id: Option<String>) -> Result<(), String> {
    lock(&engine).set_override(profile_id)
}

#[tauri::command]
async fn get_base_keymap(engine: State<'_, Shared>) -> Result<BaseKeymap, String> {
    Ok(lock(&engine).base())
}

#[tauri::command]
async fn refresh_base_keymap(device: State<'_, DeviceHandle>) -> Result<BaseKeymap, String> {
    let device = device.inner().clone();
    tauri::async_runtime::spawn_blocking(move || device.read_base()).await.map_err(|e| e.to_string())?
}

/// Keyboard layouts Windows knows, for the key legends.
#[tauri::command]
async fn list_keyboard_layouts() -> Result<layouts::LayoutList, String> {
    tauri::async_runtime::spawn_blocking(layouts::list).await.map_err(|e| e.to_string())
}

/// What each key types in a layout: legend per keycode.
#[tauri::command]
async fn get_layout_legends(id: String) -> Result<std::collections::BTreeMap<String, layouts::Legend>, String> {
    tauri::async_runtime::spawn_blocking(move || layouts::legends(&id)).await.map_err(|e| e.to_string())?
}

/// The keyboard's own lighting as read when it connected (None if it hasn't yet).
#[tauri::command]
async fn get_keyboard_lighting(engine: State<'_, Shared>) -> Result<Option<Lighting>, String> {
    Ok(lock(&engine).keyboard_lighting())
}

#[tauri::command]
async fn preview_lighting(engine: State<'_, Shared>, lighting: Option<Lighting>) -> Result<(), String> {
    lock(&engine).preview_lighting(lighting);
    Ok(())
}

#[tauri::command]
async fn get_settings(settings: State<'_, SettingsState>) -> Result<Settings, String> {
    Ok(settings.get())
}

/// Saved and applied at once (no Apply needed: these belong to the PC, not to a profile).
#[tauri::command]
async fn save_settings(settings: State<'_, SettingsState>, engine: State<'_, Shared>, new: Settings) -> Result<(), String> {
    settings.storage.save_settings(&new)?;
    apply_log_level(&new);
    lock(&engine).set_macro_gap(new.macro_gap);
    log::info!(
        "settings: notify {}, close to tray {}, verbose log {}, key labels {}",
        new.notify_on_switch,
        new.close_to_tray,
        new.verbose_log,
        new.key_labels
    );
    *settings.current.lock().unwrap_or_else(|p| p.into_inner()) = new;
    Ok(())
}

#[tauri::command]
async fn export_profiles(path: PathBuf, profiles: Vec<Profile>, keyboard: Option<String>) -> Result<(), String> {
    // The keyboard the key ids refer to (the one shown); a board id, `board.rs`.
    let keyboard = keyboard.filter(|k| board::by_id(k).is_some()).unwrap_or_else(|| storage::EXPORT_KEYBOARD.into());
    storage::export_profiles(&path, &profiles, &keyboard)?;
    log::info!("exported {} profile(s) to {}", profiles.len(), path.display());
    Ok(())
}

#[tauri::command]
async fn import_profiles(engine: State<'_, Shared>, path: PathBuf) -> Result<Vec<Profile>, String> {
    let profiles = storage::import_profiles(&path)?;
    log::info!("read {} profile(s) from {}", profiles.len(), path.display());
    Ok(lock(&engine).place_imported(profiles))
}

/// Programs with a window open, for the program picker.
#[tauri::command]
async fn list_running_programs() -> Result<Vec<watcher::RunningProgram>, String> {
    tauri::async_runtime::spawn_blocking(watcher::running_programs).await.map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ Firmware tab

type FwState<'a> = State<'a, firmware::Firmware>;

fn chosen(settings: &SettingsState) -> firmware::Chosen {
    let s = settings.get();
    firmware::Chosen { msys: s.fw_msys_path, source: s.fw_source_path }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Preflight: build tools, Keychron's firmware, drivers, keyboards plugged in, the running task.
#[tauri::command]
async fn fw_status(app: AppHandle) -> Result<firmware::FirmwareStatus, String> {
    blocking(move || app.state::<firmware::Firmware>().status(&chosen(&app.state::<SettingsState>()))).await
}

/// Asks GitHub for the latest versions (cached 30 minutes unless `force`), then the status.
#[tauri::command]
async fn fw_check_updates(app: AppHandle, force: bool) -> Result<firmware::FirmwareStatus, String> {
    blocking(move || {
        let fw = app.state::<firmware::Firmware>();
        fw.check_updates(force);
        fw.status(&chosen(&app.state::<SettingsState>()))
    })
    .await
}

#[tauri::command]
async fn fw_install_toolchain(fw: FwState<'_>, settings: State<'_, SettingsState>) -> Result<u64, String> {
    fw.install_toolchain(&chosen(&settings))
}

#[tauri::command]
async fn fw_download_source(fw: FwState<'_>, settings: State<'_, SettingsState>) -> Result<u64, String> {
    fw.download_source(&chosen(&settings))
}

#[tauri::command]
async fn fw_install_drivers(fw: FwState<'_>, settings: State<'_, SettingsState>) -> Result<u64, String> {
    fw.install_drivers(&chosen(&settings))
}

/// Downloads the small flashing tools ahead of time (the Basic path's only install).
#[tauri::command]
async fn fw_get_tools(fw: FwState<'_>) -> Result<u64, String> {
    fw.get_tools()
}

/// What ready-made firmware the app has for a keyboard (goes online, cached 30 minutes).
#[tauri::command]
async fn fw_prebuilt_info(app: AppHandle, board: String, force: bool) -> Result<firmware::quick::PrebuiltInfo, String> {
    let b = board::by_id(&board).ok_or(format!("Unknown keyboard {board}."))?;
    blocking(move || app.state::<firmware::Firmware>().prebuilt_info(b, force)).await?
}

/// Writes the app's ready-made firmware (Keychron's keymap + the module) to a keyboard, without
/// QMK MSYS. `board`: a `board.rs` id. `device`: the instance id of a device already in
/// bootloader mode that the user picked as their keyboard; the checks in `quick` refuse any other
/// device the app can't attribute, and they run here so the UI can't be talked past.
#[tauri::command]
async fn fw_flash_prebuilt(fw: FwState<'_>, board: String, device: Option<String>) -> Result<u64, String> {
    let b = board::by_id(&board).ok_or(format!("Unknown keyboard {board}."))?;
    fw.flash_prebuilt(b, device)
}

#[tauri::command]
async fn fw_cancel(fw: FwState<'_>) -> Result<(), String> {
    if fw.jobs.cancel() {
        Ok(())
    } else {
        Err("The firmware is being written: stopping now would leave the keyboard without any. It takes a few seconds.".into())
    }
}

#[tauri::command]
async fn fw_build(fw: FwState<'_>, settings: State<'_, SettingsState>, id: String) -> Result<u64, String> {
    fw.build(&chosen(&settings), &id)
}

/// Flashes a project (building it first when its last build is outdated) through the same guarded
/// path as the ready-made firmware.
/// `device`: the instance id of a device already in bootloader mode that the user picked.
#[tauri::command]
async fn fw_flash(fw: FwState<'_>, settings: State<'_, SettingsState>, id: String, device: Option<String>) -> Result<u64, String> {
    fw.flash_project(&chosen(&settings), &id, device)
}

/// The keyboard tester's `key-event`: a key went down or up.
#[derive(Clone, Serialize)]
struct KeyEventPayload {
    key: String,
    down: bool,
}

/// The keyboard tester: `true` asks the keyboard to report every key event (the UI repeats it every
/// 2 s, and reporting stops 5 s after the last one), `false` stops it. Answers whether the keyboard
/// is reporting.
#[tauri::command]
async fn set_key_report(device: State<'_, DeviceHandle>, on: bool) -> Result<bool, String> {
    let device = device.inner().clone();
    blocking(move || device.key_report(on)).await?
}

/// Restarts the keyboard into its bootloader. Needs the profile switcher; `device.rs` refuses
/// without it and says what to do instead.
#[tauri::command]
async fn fw_enter_bootloader(device: State<'_, DeviceHandle>) -> Result<(), String> {
    let device = device.inner().clone();
    blocking(move || device.enter_bootloader()).await?
}

#[tauri::command]
async fn fw_projects(fw: FwState<'_>) -> Result<Vec<firmware::projects::Project>, String> {
    Ok(fw.list())
}

/// The sidebar's order of the projects.
#[tauri::command]
async fn fw_reorder_projects(fw: FwState<'_>, ids: Vec<String>) -> Result<(), String> {
    fw.store().set_order(&ids)
}

/// Keychron's keyboards in the firmware tree.
#[tauri::command]
async fn fw_keyboards(app: AppHandle) -> Result<Vec<firmware::projects::KeyboardInfo>, String> {
    blocking(move || {
        let (root, _) = app.state::<firmware::Firmware>().source_root(&chosen(&app.state::<SettingsState>()));
        firmware::projects::keyboards(&root)
    })
    .await
}

/// The keymaps a keyboard has, to start a project from.
#[tauri::command]
async fn fw_templates(fw: FwState<'_>, settings: State<'_, SettingsState>, keyboard: String) -> Result<Vec<String>, String> {
    let (root, _) = fw.source_root(&chosen(&settings));
    Ok(firmware::projects::keymaps_of(&root, &keyboard))
}

#[tauri::command]
async fn fw_create_project(
    fw: FwState<'_>,
    settings: State<'_, SettingsState>,
    name: String,
    keyboard: String,
    template: firmware::projects::Template,
    with_module: bool,
) -> Result<firmware::projects::Project, String> {
    let (root, _) = fw.source_root(&chosen(&settings));
    let source = firmware::tools::source_usable(&root).then_some(root);
    let p = fw.store().create(&name, &keyboard, &template, with_module, source.as_deref())?;
    log::info!("firmware project {} created for {}", p.id, p.keyboard);
    Ok(p)
}

#[tauri::command]
async fn fw_rename_project(fw: FwState<'_>, id: String, name: String) -> Result<firmware::projects::Project, String> {
    fw.store().rename(&id, &name)
}

#[tauri::command]
async fn fw_duplicate_project(fw: FwState<'_>, id: String) -> Result<firmware::projects::Project, String> {
    fw.store().duplicate(&id)
}

/// Marks a project as the firmware on its keyboard (or unmarks it): for firmware flashed outside
/// the app, where the keyboard can't say which one it runs.
#[tauri::command]
async fn fw_set_flashed(fw: FwState<'_>, id: String, flashed: bool) -> Result<(), String> {
    fw.store().set_flashed(&id, flashed)
}

#[tauri::command]
async fn fw_delete_project(fw: FwState<'_>, id: String) -> Result<firmware::projects::Snapshot, String> {
    fw.store().delete(&id)
}

#[tauri::command]
async fn fw_restore_project(fw: FwState<'_>, snapshot: firmware::projects::Snapshot) -> Result<firmware::projects::Project, String> {
    fw.store().restore(&snapshot)
}

#[tauri::command]
async fn fw_get_project(fw: FwState<'_>, id: String) -> Result<firmware::projects::Project, String> {
    fw.store().get(&id)
}

#[tauri::command]
async fn fw_read_file(fw: FwState<'_>, id: String, path: String) -> Result<String, String> {
    fw.store().read(&id, &path)
}

#[tauri::command]
async fn fw_write_file(fw: FwState<'_>, id: String, path: String, text: String) -> Result<(), String> {
    fw.store().write(&id, &path, &text)
}

#[tauri::command]
async fn fw_create_file(fw: FwState<'_>, id: String, path: String, text: String) -> Result<(), String> {
    fw.store().create_file(&id, &path, &text)
}

#[tauri::command]
async fn fw_delete_file(fw: FwState<'_>, id: String, path: String) -> Result<String, String> {
    fw.store().delete_file(&id, &path)
}

#[tauri::command]
async fn fw_rename_file(fw: FwState<'_>, id: String, from: String, to: String) -> Result<(), String> {
    fw.store().rename_file(&id, &from, &to)
}

#[tauri::command]
async fn fw_add_module(fw: FwState<'_>, id: String) -> Result<(), String> {
    fw.store().add_module(&id)
}

/// Opens a project's folder (its keymap files and builds), or with no id the downloads folder.
#[tauri::command]
async fn fw_open_folder(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let fw = app.state::<firmware::Firmware>();
    let dir = match id {
        Some(id) => fw.store().keymap_dir(&id)?.parent().map(|p| p.to_path_buf()).ok_or("bad project")?,
        None => fw.paths.qmk.clone(),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// A program's (or folder's) icon as a PNG data URL, None if Windows has none.
#[tauri::command]
async fn get_program_icon(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || icons::icon_data_url(&path)).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    /// profiles.json, settings.json and the keymap cache.
    config_dir: String,
    log_dir: String,
}

/// A newer release found by `check_update`, kept to install it.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

/// Asks GitHub Releases for a newer version (`latest.json`, signed with the updater key). None when
/// this is the latest; an error when it can't tell (offline, no release yet).
#[tauri::command]
async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info =
        update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone(), date: u.date.map(|d| d.to_string()) });
    if let Some(i) = &info {
        log::info!("update available: {} (running {})", i.version, app.package_info().version);
    }
    *pending.0.lock().unwrap_or_else(|p| p.into_inner()) = update;
    Ok(info)
}

/// Downloads the update found by `check_update` (its signature is checked), runs its installer
/// and restarts the app.
#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("No update to install: check for one first.")?;
    log::info!("installing version {}", update.version);
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

#[tauri::command]
async fn get_app_info(app: AppHandle) -> Result<AppInfo, String> {
    let path = app.path();
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        config_dir: path.app_config_dir().map_err(|e| e.to_string())?.display().to_string(),
        log_dir: path.app_log_dir().map_err(|e| e.to_string())?.display().to_string(),
    })
}

/// Opens the settings folder ("config") or the logs folder ("logs") in Explorer.
#[tauri::command]
async fn open_folder(app: AppHandle, which: String) -> Result<(), String> {
    let dir = match which.as_str() {
        "config" => app.path().app_config_dir(),
        "logs" => app.path().app_log_dir(),
        _ => return Err(format!("unknown folder {which:?}")),
    }
    .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Lets the UI write to the log file (its errors, mostly).
#[tauri::command]
async fn log_message(level: String, message: String) -> Result<(), String> {
    match level.as_str() {
        "error" => log::error!(target: "ui", "{message}"),
        "warn" => log::warn!(target: "ui", "{message}"),
        _ => log::info!(target: "ui", "{message}"),
    }
    Ok(())
}

fn apply_log_level(settings: &Settings) {
    log::set_max_level(if settings.verbose_log { log::LevelFilter::Debug } else { log::LevelFilter::Info });
}

/// Show the main window, recreating it if it was closed (closing destroys it to free the webview).
fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == MAIN_WINDOW) else { return };
    match WebviewWindowBuilder::from_config(app, config).and_then(|b| b.build()) {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log::error!("could not open the window: {e}"),
    }
}

/// Open, then one entry per profile to force it and "Automatic" to go back to switching by
/// program, then Quit.
fn tray_menu(app: &AppHandle, state: &TrayState) -> tauri::Result<Menu<Wry>> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let active_name = state.profiles.iter().find(|(id, _)| *id == state.active_id).map_or("Default", |(_, name)| name.as_str());
    let auto_label = if state.forced { "Automatic (by program)".to_string() } else { format!("Automatic (now: {active_name})") };
    let auto = CheckMenuItem::with_id(app, "auto", auto_label, true, !state.forced, None::<&str>)?;
    let mut profiles = vec![];
    for (id, name) in &state.profiles {
        let forced = state.forced && *id == state.active_id;
        profiles.push(CheckMenuItem::with_id(app, format!("{FORCE_PREFIX}{id}"), name, true, forced, None::<&str>)?);
    }
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&open, &sep1, &auto];
    items.extend(profiles.iter().map(|p| p as &dyn IsMenuItem<Wry>));
    items.push(&sep2);
    items.push(&quit);
    Menu::with_items(app, &items)
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    let force = match id {
        "open" => return show_window(app),
        "quit" => return app.exit(0),
        "auto" => None,
        _ => match id.strip_prefix(FORCE_PREFIX) {
            Some(profile) => Some(profile.to_string()),
            None => return,
        },
    };
    // This runs on the main thread, which must never wait for the engine lock (see above).
    let engine = app.state::<Shared>().inner().clone();
    std::thread::spawn(move || {
        if let Err(e) = lock(&engine).set_override(force) {
            log::warn!("tray: {e}");
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, &TrayState { profiles: vec![], active_id: String::new(), forced: false })?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// A Windows notification for a profile switch, unless the app's own window is in front (the
/// user can see it there) or notifications are off. Runs on the main thread.
fn notify_switch(app: &AppHandle, profile_name: &str) {
    let enabled = app.state::<SettingsState>().get().notify_on_switch;
    let focused = app.get_webview_window(MAIN_WINDOW).is_some_and(|w| w.is_focused().unwrap_or(false));
    if !enabled || focused {
        return;
    }
    if let Err(e) = app.notification().builder().title(APP_NAME).body(format!("Profile: {profile_name}")).show() {
        log::warn!("notification: {e}");
    }
}

fn notifier(app: &AppHandle) -> Notifier {
    let for_state = app.clone();
    let for_base = app.clone();
    let for_config = app.clone();
    let for_lighting = app.clone();
    let for_focus = app.clone();
    let for_tray = app.clone();
    // The first state isn't a switch; after that, every change of active profile is.
    let last_active: Mutex<Option<String>> = Mutex::new(None);
    Notifier {
        state: Box::new(move |state, profile_name| {
            let _ = for_state.emit("engine-state", state);
            let switched = {
                let mut last = last_active.lock().unwrap_or_else(|p| p.into_inner());
                let switched = last.as_ref().is_some_and(|l| *l != state.active_profile_id);
                *last = Some(state.active_profile_id.clone());
                switched
            };
            let tooltip = format!("{APP_NAME}: {profile_name}");
            let name = profile_name.to_string();
            let app = for_state.clone();
            let _ = for_state.run_on_main_thread(move || {
                if let Some(tray) = app.tray_by_id(TRAY_ID) {
                    let _ = tray.set_tooltip(Some(tooltip));
                }
                if switched {
                    notify_switch(&app, &name);
                }
            });
        }),
        base: Box::new(move |base| {
            let _ = for_base.emit("base-keymap", base);
        }),
        config: Box::new(move |config| {
            let _ = for_config.emit("config-changed", config);
        }),
        lighting: Box::new(move |lighting| {
            let _ = for_lighting.emit("keyboard-lighting", lighting);
        }),
        focus: Box::new(move |focus| {
            let _ = for_focus.emit("focus-state", focus);
        }),
        tray: Box::new(move |state| {
            let app = for_tray.clone();
            let state = state.clone();
            let _ = for_tray.run_on_main_thread(move || match tray_menu(&app, &state) {
                Ok(menu) => {
                    if let Some(tray) = app.tray_by_id(TRAY_ID) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
                Err(e) => log::warn!("tray menu: {e}"),
            });
        }),
    }
}

fn log_plugin() -> tauri::plugin::TauriPlugin<Wry> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([Target::new(TargetKind::Stdout), Target::new(TargetKind::LogDir { file_name: Some("v6ps".into()) })])
        // The file keeps Debug when verbose logging is on (see apply_log_level).
        .level(log::LevelFilter::Debug)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("tracing", log::LevelFilter::Warn)
        .max_file_size(1_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}

pub fn run() {
    // Autostart launches with --hidden: stay in the tray.
    let hidden = std::env::args().any(|a| a == "--hidden");

    tauri::Builder::default()
        // Must be first: a second launch just shows the running instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(log_plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(move |app| {
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                log::error!("panic: {info}");
                default_hook(info);
            }));

            // After a rename, the data under the old identifier moves over first.
            migrate::move_old_folders(&app.path().app_config_dir()?, &app.path().app_local_data_dir()?);
            // …and "Start with Windows", which the old name's entry held.
            if migrate::take_old_autostart() {
                use tauri_plugin_autostart::ManagerExt;
                if let Err(e) = app.autolaunch().enable() {
                    log::warn!("could not turn start with Windows back on: {e}");
                }
            }

            let config_dir = app.path().app_config_dir()?;
            let settings = SettingsState { storage: Storage::new(config_dir.clone()), current: Mutex::default() };
            let loaded = settings.storage.load_settings();
            apply_log_level(&loaded);
            let macro_gap = loaded.macro_gap;
            *settings.current.lock().unwrap() = loaded;
            app.manage(settings);
            log::info!("{APP_NAME} {} starting{}", app.package_info().version, if hidden { " in the tray" } else { "" });

            build_tray(app.handle())?;

            let (device, device_rx) = device::channel();
            let storage = Storage::new(config_dir);
            let engine: Shared = Arc::new(Mutex::new(Engine::new(storage, device.clone(), notifier(app.handle()))));
            lock(&engine).set_macro_gap(macro_gap);
            app.manage(engine.clone());
            app.manage(device);

            let for_device = engine.clone();
            let for_keys = app.handle().clone();
            device::spawn(device_rx, move |event| match event {
                // Up to hundreds a second while the tester is open: straight to the UI.
                device::Event::Keys(keys) => {
                    for k in keys {
                        let _ = for_keys.emit("key-event", KeyEventPayload { key: k.key, down: k.down });
                    }
                }
                event => lock(&for_device).on_device(event),
            });
            let for_watcher = engine;
            watcher::spawn(move |focus| lock(&for_watcher).set_foreground(focus));

            let fw_paths = firmware::tools::Paths {
                // QMK can't build under a path with a space (a user name like "Jean Dupont").
                qmk: firmware::tools::qmk_home(&app.path().app_local_data_dir()?.join("qmk")),
                projects: app.path().app_config_dir()?.join("firmware"),
            };
            let for_fw = app.handle().clone();
            let emit: firmware::jobs::Emit = Arc::new(move |event| {
                let _ = match event {
                    firmware::jobs::FwEvent::Job(j) => for_fw.emit("fw-job", j),
                    firmware::jobs::FwEvent::Log(l) => for_fw.emit("fw-log", l),
                };
            });
            app.manage(firmware::Firmware::new(fw_paths, emit));

            if !hidden {
                show_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let app = window.app_handle();
                // A lighting preview only lasts while the window is open.
                if let Some(device) = app.try_state::<DeviceHandle>() {
                    device.send(Command::Preview(None));
                }
                // Setting "Closing the window keeps the app in the tray" off: closing quits.
                if app.try_state::<SettingsState>().is_some_and(|s| !s.get().close_to_tray) {
                    log::info!("window closed: quitting (close to tray is off)");
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            get_engine_state,
            get_focus_state,
            set_override,
            get_base_keymap,
            refresh_base_keymap,
            preview_lighting,
            get_keyboard_lighting,
            list_keyboard_layouts,
            get_layout_legends,
            get_settings,
            save_settings,
            export_profiles,
            import_profiles,
            list_running_programs,
            get_program_icon,
            fw_status,
            fw_check_updates,
            fw_install_toolchain,
            fw_download_source,
            fw_install_drivers,
            fw_flash_prebuilt,
            fw_get_tools,
            fw_prebuilt_info,
            fw_cancel,
            fw_build,
            fw_flash,
            fw_enter_bootloader,
            set_key_report,
            fw_projects,
            fw_reorder_projects,
            fw_keyboards,
            fw_templates,
            fw_create_project,
            fw_rename_project,
            fw_duplicate_project,
            fw_set_flashed,
            fw_delete_project,
            fw_restore_project,
            fw_get_project,
            fw_read_file,
            fw_write_file,
            fw_create_file,
            fw_delete_file,
            fw_rename_file,
            fw_add_module,
            fw_open_folder,
            get_app_info,
            check_update,
            install_update,
            open_folder,
            log_message,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|_app, event| {
            // Closing the last window keeps the app running in the tray; only Quit (code Some) exits.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
