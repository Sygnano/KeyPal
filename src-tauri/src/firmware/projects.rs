//! Firmware projects: a keymap folder of the user's own (keymap.c, rules.mk, config.h…) for one
//! keyboard, kept in the app's data folder. A build copies it into Keychron's firmware tree as the
//! keymap `v6ps_<id>`.
//!
//! On disk: `<projects>/<id>/project.json`, `<id>/keymap/…` (the files), `<id>/build/` (results).

use crate::storage::write_json_atomic;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// The firmware module, bundled so a project can include it in one click.
pub const MODULE_SOURCE: &str = include_str!("../../../firmware/profile_switcher.c");
pub const MODULE_FILE: &str = "profile_switcher.c";
const MODULE_RULES: [&str; 3] = ["VIA_ENABLE = yes", "DEFERRED_EXEC_ENABLE = yes", "SRC += profile_switcher.c"];
/// The files an empty project starts with (empty).
const EMPTY_FILES: [&str; 3] = ["keymap.c", "config.h", "rules.mk"];
/// The order of the projects in the sidebar: ids, first to last.
const ORDER_FILE: &str = "order.json";
/// Deleted projects are moved here (not read into memory), so undo is a move back.
const TRASH_DIR: &str = "trash";
/// Which project the user last put on each keyboard: `{ "<qmk keyboard path>": "<project id>" }`.
/// Written when the app flashes one, or when the user says so; the keyboard itself is the better
/// answer when its firmware reports a build id (the app's builds do).
const FLASHED_FILE: &str = "flashed.json";

/// The protocol version a copy of the module speaks (`#define PS_PROTO_VERSION n`).
pub fn module_version(source: &str) -> Option<u8> {
    source.lines().find_map(|l| l.trim().strip_prefix("#define PS_PROTO_VERSION")?.trim().parse().ok())
}

/// The version of the module bundled with the app.
pub fn bundled_module_version() -> u8 {
    module_version(MODULE_SOURCE).unwrap_or(0)
}
/// Files bigger than this aren't keymap sources; the editor refuses them.
const MAX_FILE: u64 = 1 << 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Meta {
    name: String,
    keyboard: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    /// The firmware file, in the project's build folder.
    pub file: String,
    pub size: u64,
    /// Seconds since 1970.
    pub at: u64,
    /// `fingerprint` of the project's files this was built from (None: built before it existed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<String>,
}

/// What flashed.json says is on one keyboard: the project, and the `fingerprint` of the files that
/// were put on it. Older files hold just the id (a string): what was flashed is then unknown.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
enum OnKeyboard {
    Id(String),
    Project { id: String, sources: Option<String> },
}

impl OnKeyboard {
    fn id(&self) -> &str {
        match self {
            OnKeyboard::Id(id) | OnKeyboard::Project { id, .. } => id,
        }
    }
    fn sources(&self) -> Option<&str> {
        match self {
            OnKeyboard::Id(_) => None,
            OnKeyboard::Project { sources, .. } => sources.as_deref(),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// QMK keyboard path, e.g. "keychron/v6_8k/iso_encoder".
    pub keyboard: String,
    /// The keymap name it's built as in the firmware tree.
    pub keymap: String,
    /// Files relative to the keymap folder, "/"-separated, sorted.
    pub files: Vec<String>,
    pub last_build: Option<BuildInfo>,
    /// The profile switcher module's protocol version, when the project has it.
    pub module_version: Option<u8>,
    /// The id a build of this project stamps into its firmware (`-DPS_BUILD_ID`), so the keyboard
    /// can say it is running this one.
    pub build_id: u32,
    /// The app last put this one on its keyboard (it flashed it, or the user said so). Only one
    /// project per keyboard is marked.
    pub flashed: bool,
    /// It is the one on the keyboard, but its files changed since they were put there: the
    /// keyboard runs an older version of it. False when that isn't known (marks from before).
    pub unflashed_changes: bool,
    /// Its last build isn't of the files as they are: none yet, made from other files (or before
    /// builds recorded theirs), or its firmware file is gone. Flashing builds it first.
    pub build_outdated: bool,
}

/// Everything needed to put a deleted project back: its folder is moved to `trash/<id>` and moved
/// back on undo, so a project holding a binary or a large file can still be deleted (the old
/// snapshot read every file as UTF-8 text under 1 MB, and failed on anything else).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub name: String,
    pub keyboard: String,
}

/// How a new project starts.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Template {
    /// A keymap of the keyboard in Keychron's tree ("keychron", "default", "via"…).
    Keymap { name: String },
    /// A keymap folder on the PC (e.g. one made in QMK MSYS before).
    Folder { path: String },
    /// Empty keymap.c, config.h and rules.mk, to fill in by hand.
    Empty,
}

pub fn keymap_name(id: &str) -> String {
    format!("v6ps_{id}")
}

/// "My V6 (Numpad)" → "my_v6_numpad": a folder and keymap name QMK accepts.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let out = out.trim_end_matches('_').to_string();
    if out.is_empty() {
        "firmware".into()
    } else {
        out.chars().take(40).collect()
    }
}

/// A relative path inside a project: no "..", no drive, no leading slash.
pub fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') {
        return Err("Give the file a name.".into());
    }
    let p = PathBuf::from(&rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("\"{rel}\" isn't a file name inside the project."));
    }
    if rel.chars().any(|c| "<>:\"|?*".contains(c) || c.is_control()) {
        return Err(format!("\"{rel}\" has characters Windows doesn't allow in file names."));
    }
    for part in rel.split('/') {
        if part.ends_with('.') || part.ends_with(' ') {
            return Err(format!("\"{rel}\": Windows file names can't end with a dot or a space."));
        }
        if is_reserved(part) {
            return Err(format!("\"{rel}\" uses a name Windows keeps for devices (CON, NUL, COM1\u{2026})."));
        }
    }
    Ok(p)
}

/// Windows reserves these names, with or without an extension: `CON.c` opens the console, not a
/// file, so a project must not be able to ask for one.
fn is_reserved(part: &str) -> bool {
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let stem = part.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return true;
    }
    // COM1\u{2026}COM9, LPT1\u{2026}LPT9 (and the COM\u{00B9}/\u{00B2}/\u{00B3} superscript forms Windows also reserves).
    let (prefix, rest) = stem.split_at(stem.len().min(3));
    matches!(prefix, "COM" | "LPT")
        && matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "\u{00B9}" | "\u{00B2}" | "\u{00B3}")
}

/// A `keyboard` or `keymap` value from a project file, checked to be a path *inside* the firmware
/// tree: plain segments only. An absolute value would pass a `..` check and then, because
/// `Path::join` with an absolute path replaces the base, send `sync_into`'s `remove_dir_all` and
/// `copy_dir` anywhere on the disk.
pub fn safe_segments(value: &str, what: &str) -> Result<(), String> {
    let cleaned = value.trim().replace('\\', "/");
    if cleaned.is_empty() {
        return Err(format!("Choose a {what}."));
    }
    let p = PathBuf::from(&cleaned);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("\"{value}\" isn't a {what} inside Keychron's firmware."));
    }
    if cleaned.chars().any(|c| "<>:\"|?*".contains(c) || c.is_control()) {
        return Err(format!("\"{value}\" isn't a {what} inside Keychron's firmware."));
    }
    Ok(())
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Store { root }
    }

    fn dir(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || slug(id) != id {
            return Err(format!("No project \"{id}\"."));
        }
        Ok(self.root.join(id))
    }

    pub fn keymap_dir(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.dir(id)?.join("keymap"))
    }

    pub fn build_dir(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.dir(id)?.join("build"))
    }

    fn file(&self, id: &str, rel: &str) -> Result<PathBuf, String> {
        Ok(self.keymap_dir(id)?.join(safe_rel(rel)?))
    }

    pub fn list(&self) -> Vec<Project> {
        let Ok(entries) = std::fs::read_dir(&self.root) else { return vec![] };
        let mut out: Vec<Project> = entries
            .flatten()
            .filter(|e| e.path().is_dir() && e.file_name() != TRASH_DIR)
            .filter_map(|e| self.get(&e.file_name().to_string_lossy()).ok())
            .collect();
        // In the user's order; projects it doesn't know (made by hand in the folder) go last, by name.
        let order = self.order();
        out.sort_by_key(|p| (order.iter().position(|id| *id == p.id).unwrap_or(usize::MAX), p.name.to_lowercase()));
        out
    }

    fn order(&self) -> Vec<String> {
        std::fs::read(self.root.join(ORDER_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Puts the projects in this order (ids of projects that aren't there are dropped).
    pub fn set_order(&self, ids: &[String]) -> Result<(), String> {
        let ids: Vec<&String> = ids.iter().filter(|id| self.dir(id).is_ok_and(|d| d.is_dir())).collect();
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        write_json_atomic(&self.root.join(ORDER_FILE), &ids)
    }

    /// A new project goes last. (A deleted one keeps its place in the file, so undo puts it back there.)
    fn append_to_order(&self, id: &str) {
        let mut order = self.order();
        if !order.iter().any(|x| x == id) {
            order.push(id.into());
            let _ = write_json_atomic(&self.root.join(ORDER_FILE), &order);
        }
    }

    pub fn get(&self, id: &str) -> Result<Project, String> {
        let dir = self.dir(id)?;
        let meta: Meta = serde_json::from_slice(&std::fs::read(dir.join("project.json")).map_err(|_| format!("No project \"{id}\"."))?)
            .map_err(|e| format!("{id}/project.json: {e}"))?;
        let last_build = std::fs::read(dir.join("build/last.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let module_version = std::fs::read_to_string(dir.join("keymap").join(MODULE_FILE)).ok().and_then(|s| module_version(&s));
        let mark = self.flashed_map().get(&meta.keyboard).filter(|f| f.id() == id).cloned();
        let now = fingerprint(&dir.join("keymap"));
        let unflashed_changes = mark.as_ref().and_then(|m| m.sources()).is_some_and(|s| s != now);
        let build_outdated = last_build
            .as_ref()
            .is_none_or(|b: &BuildInfo| b.sources.as_deref() != Some(now.as_str()) || !dir.join("build").join(&b.file).exists());
        Ok(Project {
            id: id.into(),
            name: meta.name,
            keyboard: meta.keyboard,
            keymap: keymap_name(id),
            files: list_files(&dir.join("keymap")),
            last_build,
            module_version,
            build_id: crate::protocol::build_id(id),
            flashed: mark.is_some(),
            unflashed_changes,
            build_outdated,
        })
    }

    fn flashed_map(&self) -> std::collections::BTreeMap<String, OnKeyboard> {
        std::fs::read(self.root.join(FLASHED_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Says this project is the one on its keyboard (`on`), or that none is (`off`). Any other
    /// project for the same keyboard loses the mark: only one firmware can be on a keyboard. The
    /// user saying so means the project as it is now: its files' fingerprint is what's on it.
    pub fn set_flashed(&self, id: &str, on: bool) -> Result<(), String> {
        let sources = fingerprint(&self.keymap_dir(id)?);
        self.mark(id, on, Some(sources))
    }

    /// After the app flashed this project's last build: what's on the keyboard is what that build
    /// was made from, which the files may have moved on from since.
    pub fn set_flashed_build(&self, id: &str) -> Result<(), String> {
        let sources = self.get(id)?.last_build.and_then(|b| b.sources);
        self.mark(id, true, sources)
    }

    fn mark(&self, id: &str, on: bool, sources: Option<String>) -> Result<(), String> {
        let p = self.get(id)?;
        let mut map = self.flashed_map();
        if on {
            map.insert(p.keyboard.clone(), OnKeyboard::Project { id: id.to_string(), sources });
        } else if map.get(&p.keyboard).is_some_and(|f| f.id() == id) {
            map.remove(&p.keyboard);
        }
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        write_json_atomic(&self.root.join(FLASHED_FILE), &map)
    }

    /// Forgets which firmware is on `keyboard` (the app flashed something that isn't a project).
    pub fn clear_flashed(&self, keyboard: &str) {
        let mut map = self.flashed_map();
        if map.remove(keyboard).is_some() {
            let _ = write_json_atomic(&self.root.join(FLASHED_FILE), &map);
        }
    }

    fn write_meta(&self, id: &str, name: &str, keyboard: &str) -> Result<(), String> {
        let meta = Meta { name: name.into(), keyboard: keyboard.into() };
        let dir = self.dir(id)?;
        std::fs::create_dir_all(dir.join("keymap")).map_err(|e| e.to_string())?;
        write_json_atomic(&dir.join("project.json"), &meta)
    }

    /// A free id for a name: its slug, numbered if taken.
    fn free_id(&self, name: &str) -> String {
        let base = slug(name);
        let mut id = base.clone();
        let mut n = 2;
        while self.root.join(&id).exists() {
            id = format!("{base}_{n}");
            n += 1;
        }
        id
    }

    /// A new project from a template, optionally with the profile switcher module added.
    pub fn create(
        &self,
        name: &str,
        keyboard: &str,
        template: &Template,
        with_module: bool,
        source: Option<&Path>,
    ) -> Result<Project, String> {
        if name.trim().is_empty() {
            return Err("Give the firmware a name.".into());
        }
        safe_segments(keyboard, "keyboard")?;
        let id = self.free_id(name);
        let from: Option<PathBuf> = match template {
            Template::Keymap { name: km } => {
                let src = source.ok_or("Download Keychron's firmware first: the keymaps come from it.")?;
                Some(find_keymap(src, keyboard, km).ok_or(format!("{keyboard} has no keymap \"{km}\"."))?)
            }
            Template::Folder { path } => {
                let dir = PathBuf::from(path);
                if !is_keymap_folder(&dir) {
                    return Err(format!("{} has no keymap.c or keymap.json in it: that isn't a keymap folder.", dir.display()));
                }
                Some(dir)
            }
            Template::Empty => None,
        };
        self.write_meta(&id, name.trim(), keyboard)?;
        let dest = self.keymap_dir(&id)?;
        if let Some(from) = from {
            if let Err(e) = copy_dir(&from, &dest) {
                let _ = std::fs::remove_dir_all(self.dir(&id)?);
                return Err(e);
            }
        } else {
            for f in EMPTY_FILES {
                std::fs::write(dest.join(f), "").map_err(|e| e.to_string())?;
            }
        }
        if with_module {
            add_module(&dest)?;
        }
        self.append_to_order(&id);
        self.get(&id)
    }

    /// A copy of a project, with every file, right after it in the sidebar. Its own id, so it
    /// builds as its own keymap and carries its own build id.
    pub fn duplicate(&self, id: &str) -> Result<Project, String> {
        let p = self.get(id)?;
        let name = format!("{} (copy)", p.name);
        let new_id = self.free_id(&name);
        // A folder copy, not a read-every-file-as-text round trip: a project made from a folder
        // holding a binary or a large file can still be duplicated.
        copy_dir(&self.dir(id)?, &self.dir(&new_id)?)?;
        self.write_meta(&new_id, &name, &p.keyboard)?;
        let mut order = self.order();
        order.retain(|x| x != &new_id);
        let at = order.iter().position(|x| x == id).map_or(order.len(), |i| i + 1);
        order.insert(at, new_id.clone());
        let _ = write_json_atomic(&self.root.join(ORDER_FILE), &order);
        self.get(&new_id)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<Project, String> {
        if name.trim().is_empty() {
            return Err("Give the firmware a name.".into());
        }
        let p = self.get(id)?;
        self.write_meta(id, name.trim(), &p.keyboard)?;
        self.get(id)
    }

    /// Deletes a project by moving its folder to `trash/<id>`, returning what's needed to put it
    /// back. The folder is kept (not read into memory), so a project with a binary or a large file
    /// can be deleted too, and undo is a move back.
    pub fn delete(&self, id: &str) -> Result<Snapshot, String> {
        let p = self.get(id)?;
        let trash = self.root.join(TRASH_DIR);
        std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let dest = trash.join(id);
        // A previous delete of the same id that was never undone: replace it.
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        std::fs::rename(self.dir(id)?, &dest).map_err(|e| e.to_string())?;
        Ok(Snapshot { id: p.id, name: p.name, keyboard: p.keyboard })
    }

    /// Puts a deleted project back (same id if it's free), by moving its folder out of the trash.
    pub fn restore(&self, snap: &Snapshot) -> Result<Project, String> {
        safe_segments(&snap.keyboard, "keyboard")?;
        let from = self.root.join(TRASH_DIR).join(&snap.id);
        if !from.is_dir() {
            return Err(format!("The deleted \"{}\" is no longer in the trash.", snap.name));
        }
        let id = if self.dir(&snap.id).is_ok_and(|d| !d.exists()) { snap.id.clone() } else { self.free_id(&snap.name) };
        std::fs::rename(&from, self.dir(&id)?).map_err(|e| e.to_string())?;
        self.append_to_order(&id);
        self.get(&id)
    }

    pub fn read(&self, id: &str, rel: &str) -> Result<String, String> {
        let path = self.file(id, rel)?;
        let len = std::fs::metadata(&path).map_err(|_| format!("{rel} doesn't exist."))?.len();
        if len > MAX_FILE {
            return Err(format!("{rel} is too big to edit here ({} KB).", len / 1024));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|_| format!("{rel} isn't a text file."))
    }

    pub fn write(&self, id: &str, rel: &str, text: &str) -> Result<(), String> {
        let path = self.file(id, rel)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, text).map_err(|e| format!("Could not save {rel}: {e}"))
    }

    /// A new file; refused if it exists.
    pub fn create_file(&self, id: &str, rel: &str, text: &str) -> Result<(), String> {
        if self.file(id, rel)?.exists() {
            return Err(format!("{rel} already exists."));
        }
        self.write(id, rel, text)
    }

    /// Deletes a file, returning what it held (for undo).
    pub fn delete_file(&self, id: &str, rel: &str) -> Result<String, String> {
        let text = self.read(id, rel)?;
        let path = self.file(id, rel)?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        // Folders it leaves empty go too.
        let root = self.keymap_dir(id)?;
        let mut dir = path.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == root || std::fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        Ok(text)
    }

    pub fn rename_file(&self, id: &str, from: &str, to: &str) -> Result<(), String> {
        let (a, b) = (self.file(id, from)?, self.file(id, to)?);
        if b.exists() && !a.as_os_str().eq_ignore_ascii_case(b.as_os_str()) {
            return Err(format!("{to} already exists."));
        }
        if let Some(dir) = b.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&a, &b).map_err(|e| e.to_string())
    }

    /// Adds the profile switcher module (file and rules.mk lines) to a project.
    pub fn add_module(&self, id: &str) -> Result<(), String> {
        add_module(&self.keymap_dir(id)?)
    }

    /// Copies the project into the firmware tree as keymap `v6ps_<id>` (replacing an older copy).
    /// Returns the keymap name.
    pub fn sync_into(&self, id: &str, source: &Path) -> Result<(String, Project), String> {
        let p = self.get(id)?;
        // project.json is a file on disk: check it again here, because what follows deletes a
        // folder and writes over it. `find_keymap` and `keymaps_of` already guard this way.
        safe_segments(&p.keyboard, "keyboard")?;
        safe_segments(&p.keymap, "keymap")?;
        let top = source.join("keyboards");
        let kb_dir = top.join(&p.keyboard);
        if !kb_dir.starts_with(&top) || !kb_dir.is_dir() {
            return Err(format!("Keychron's firmware has no keyboard {}. Update it, or pick another keyboard.", p.keyboard));
        }
        if p.files.is_empty() {
            return Err("The project has no files: add a keymap.c (or start from a template).".into());
        }
        let dest = kb_dir.join("keymaps").join(&p.keymap);
        if !dest.starts_with(&top) {
            return Err(format!("\"{}\" isn't a keymap inside Keychron's firmware.", p.keymap));
        }
        let _ = std::fs::remove_dir_all(&dest);
        copy_dir(&self.keymap_dir(id)?, &dest)?;
        if dest.join(MODULE_FILE).exists() {
            // Only in the copy that gets built: the project's rules.mk stays as the user wrote it.
            let rules = dest.join("rules.mk");
            let mut text = std::fs::read_to_string(&rules).unwrap_or_default();
            // A line the user wrote themselves (the marker is already there) is left alone.
            let mut add = |marker: &str, line: String| {
                if !text.contains(marker) {
                    if !text.is_empty() && !text.ends_with('\n') {
                        text.push('\n');
                    }
                    text.push_str(&line);
                    text.push('\n');
                }
            };
            if board_owns_indicators(source, &p.keyboard) {
                add(
                    "PS_INDICATORS_USER",
                    "# This keyboard's own code takes the indicators _kb hook: the module uses _user.\nOPT_DEFS += -DPS_INDICATORS_USER"
                        .into(),
                );
            }
            // So the keyboard can tell the app which firmware is on it (STATUS's build id).
            add(
                "PS_BUILD_ID",
                format!("# Which firmware project this is, for the app to recognise.\nOPT_DEFS += -DPS_BUILD_ID={:#010x}", p.build_id),
            );
            std::fs::write(&rules, text).map_err(|e| e.to_string())?;
        }
        Ok((p.keymap.clone(), p))
    }

    /// After a build: copies the firmware file out of the tree into the project's build folder.
    pub fn keep_build(&self, id: &str, source: &Path) -> Result<BuildInfo, String> {
        let p = self.get(id)?;
        let stem = format!("{}_{}", p.keyboard.replace('/', "_"), p.keymap);
        let built = ["bin", "uf2", "hex"]
            .iter()
            .map(|ext| source.join(format!("{stem}.{ext}")))
            .find(|f| f.exists())
            .ok_or("The build finished but its firmware file isn't there.")?;
        let dir = self.build_dir(id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = built.file_name().unwrap().to_string_lossy().to_string();
        std::fs::copy(&built, dir.join(&name)).map_err(|e| e.to_string())?;
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let info = BuildInfo {
            size: std::fs::metadata(&built).map(|m| m.len()).unwrap_or(0),
            file: name,
            at,
            sources: Some(fingerprint(&self.keymap_dir(id)?)),
        };
        let _ = write_json_atomic(&dir.join("last.json"), &info);
        Ok(info)
    }
}

/// Whether the keyboard's own C files (its folder and the ones above it) define
/// `rgb_matrix_indicators_advanced_kb` or `led_matrix_indicators_advanced_kb`, the hook the module
/// otherwise takes (C1 Pro, Q1 v1, Q9, Q9 Plus, Q11, S1 in Keychron's 2025q3).
fn board_owns_indicators(source: &Path, keyboard: &str) -> bool {
    let top = source.join("keyboards");
    let mut dir = top.join(keyboard);
    while dir.starts_with(&top) && dir != top {
        let Ok(entries) = std::fs::read_dir(&dir) else { return false };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "c")
                && std::fs::read_to_string(&p)
                    .is_ok_and(|t| t.contains("rgb_matrix_indicators_advanced_kb(") || t.contains("led_matrix_indicators_advanced_kb("))
            {
                return true;
            }
        }
        if !dir.pop() {
            break;
        }
    }
    false
}

fn add_module(keymap: &Path) -> Result<(), String> {
    std::fs::create_dir_all(keymap).map_err(|e| e.to_string())?;
    std::fs::write(keymap.join(MODULE_FILE), MODULE_SOURCE).map_err(|e| e.to_string())?;
    let rules_path = keymap.join("rules.mk");
    let mut rules = std::fs::read_to_string(&rules_path).unwrap_or_default();
    let has = |rules: &str, line: &str| {
        let key = line.split('=').next().unwrap().trim();
        rules.lines().any(|l| {
            let l = l.trim();
            if key == "SRC +" {
                l.starts_with("SRC") && l.contains(MODULE_FILE)
            } else {
                l.starts_with(key) && l.to_ascii_lowercase().ends_with("yes")
            }
        })
    };
    let missing: Vec<&str> = MODULE_RULES.iter().copied().filter(|l| !has(&rules, l)).collect();
    if !missing.is_empty() {
        if !rules.is_empty() && !rules.ends_with('\n') {
            rules.push('\n');
        }
        rules.push_str("# Profile switcher (KBoard Companion)\n");
        for l in missing {
            rules.push_str(l);
            rules.push('\n');
        }
        std::fs::write(&rules_path, rules).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// FNV-1a (64-bit) over a keymap folder's files: each one's relative path, then its bytes, in path
/// order. Same files, same fingerprint; any edit, new file, rename or deletion changes it.
fn fingerprint(keymap: &Path) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for rel in list_files(keymap) {
        eat(rel.as_bytes());
        eat(&[0]);
        eat(&std::fs::read(keymap.join(&rel)).unwrap_or_default());
        eat(&[0xFF]);
    }
    format!("{h:016x}")
}

fn list_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = vec![];
    walk(root, root, &mut out);
    out.sort();
    out
}

/// What a keymap folder may hold. A keymap is a handful of small source files; these numbers are
/// far above any real one and far below "the user picked C:\\ by mistake". Without them a
/// directory junction that points at its own parent recurses until the stack or the disk gives out.
const COPY_MAX_FILES: usize = 2_000;
const COPY_MAX_BYTES: u64 = 64 * 1024 * 1024;
const COPY_MAX_DEPTH: usize = 12;

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    let mut budget = Budget { files: 0, bytes: 0 };
    copy_dir_within(from, to, 0, &mut budget)
}

struct Budget {
    files: usize,
    bytes: u64,
}

fn copy_dir_within(from: &Path, to: &Path, depth: usize, budget: &mut Budget) -> Result<(), String> {
    if !from.is_dir() {
        return Err(format!("{} isn't a folder.", from.display()));
    }
    if depth > COPY_MAX_DEPTH {
        return Err(format!(
            "{} has folders nested more than {COPY_MAX_DEPTH} deep. That isn't a keymap folder \u{2014} pick the folder that holds keymap.c.",
            from.display()
        ));
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        // `is_dir` follows junctions and symlinks; the file type here doesn't.
        let kind = e.file_type().map_err(|err| format!("{}: {err}", src.display()))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_dir_within(&src, &dst, depth + 1, budget)?;
        } else {
            budget.files += 1;
            budget.bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            if budget.files > COPY_MAX_FILES || budget.bytes > COPY_MAX_BYTES {
                return Err(format!(
                    "{} holds more than {COPY_MAX_FILES} files or {} MB. That isn't a keymap folder \u{2014} pick the folder that holds keymap.c.",
                    from.display(),
                    COPY_MAX_BYTES / (1024 * 1024)
                ));
            }
            std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// A folder the user picked as a template really is a keymap.
fn is_keymap_folder(dir: &Path) -> bool {
    dir.join("keymap.c").is_file() || dir.join("keymap.json").is_file()
}

/// A keymap of a keyboard: QMK looks in the keyboard's folder, then in its parents.
pub fn find_keymap(source: &Path, keyboard: &str, keymap: &str) -> Option<PathBuf> {
    let mut dir = source.join("keyboards").join(keyboard);
    let top = source.join("keyboards");
    while dir.starts_with(&top) && dir != top {
        let k = dir.join("keymaps").join(keymap);
        if k.join("keymap.c").exists() || k.join("keymap.json").exists() {
            return Some(k);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// The keymaps a keyboard offers as templates (the app's own `v6ps_*` copies left out).
pub fn keymaps_of(source: &Path, keyboard: &str) -> Vec<String> {
    let mut out = vec![];
    let mut dir = source.join("keyboards").join(keyboard);
    let top = source.join("keyboards");
    while dir.starts_with(&top) && dir != top {
        if let Ok(entries) = std::fs::read_dir(dir.join("keymaps")) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if e.path().is_dir() && !name.starts_with("v6ps_") && !out.contains(&name) {
                    out.push(name);
                }
            }
        }
        let Some(parent) = dir.parent() else { break };
        dir = parent.to_path_buf();
    }
    out.sort_by_key(|n| (n != "keychron", n != "via", n != "default", n.clone()));
    out
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardInfo {
    /// QMK path, e.g. "keychron/v6_8k/iso_encoder".
    pub path: String,
    pub name: String,
    pub pid: Option<u16>,
    pub bootloader: Option<String>,
}

/// Every Keychron keyboard in the firmware tree that can be built: folders with a keyboard.json,
/// or with an info.json and a rules.mk. Name, USB id and bootloader come from those files and
/// their parents' info.json.
pub fn keyboards(source: &Path) -> Vec<KeyboardInfo> {
    let top = source.join("keyboards");
    let mut out = vec![];
    fn json(p: &Path) -> Option<serde_json::Value> {
        serde_json::from_slice(&std::fs::read(p).ok()?).ok()
    }
    fn walk(dir: &Path, top: &Path, inherited: &[serde_json::Value], out: &mut Vec<KeyboardInfo>) {
        let mut chain = inherited.to_vec();
        if let Some(j) = json(&dir.join("info.json")) {
            chain.push(j);
        }
        let leaf = json(&dir.join("keyboard.json"));
        if let Some(j) = &leaf {
            chain.push(j.clone());
        }
        let buildable = leaf.is_some() || (dir.join("info.json").exists() && dir.join("rules.mk").exists());
        let pick = |f: &dyn Fn(&serde_json::Value) -> Option<String>| chain.iter().rev().find_map(f);
        if buildable {
            if let Ok(rel) = dir.strip_prefix(top) {
                let path = rel.to_string_lossy().replace('\\', "/");
                out.push(KeyboardInfo {
                    name: pick(&|j| j["keyboard_name"].as_str().map(String::from)).unwrap_or_else(|| path.clone()),
                    pid: pick(&|j| j["usb"]["pid"].as_str().map(String::from))
                        .and_then(|p| u16::from_str_radix(p.trim_start_matches("0x").trim_start_matches("0X"), 16).ok()),
                    bootloader: pick(&|j| j["bootloader"].as_str().map(String::from)),
                    path,
                });
            }
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut subdirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        subdirs.sort();
        for sub in subdirs {
            let name = sub.file_name().unwrap().to_string_lossy().to_string();
            if name == "keymaps" || name.starts_with('.') || name == "via_json" {
                continue;
            }
            walk(&sub, top, &chain, out);
        }
    }
    walk(&top.join("keychron"), &top, &[], &mut out);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn file_names_windows_would_refuse_or_reinterpret() {
        assert!(safe_rel("keymap.c").is_ok());
        assert!(safe_rel("sub/keymap.c").is_ok());
        assert!(safe_rel("../keymap.c").is_err());
        assert!(safe_rel("/keymap.c").is_err());
        // Reserved device names: "CON.c" opens the console, not a file.
        for bad in ["CON", "con.c", "NUL.h", "aux", "COM1.c", "lpt9", "PRN"] {
            assert!(safe_rel(bad).is_err(), "{bad} should be refused");
        }
        assert!(safe_rel("console.c").is_ok(), "only the exact reserved names");
        assert!(safe_rel("comet.c").is_ok());
        // Trailing dots and spaces: Windows silently drops them, so the file isn't where we think.
        assert!(safe_rel("keymap.c ").is_ok(), "the name itself is trimmed");
        assert!(safe_rel("sub /keymap.c").is_err());
        assert!(safe_rel("sub./keymap.c").is_err());
    }

    #[test]
    fn a_keyboard_must_be_a_path_inside_the_firmware_tree() {
        assert!(safe_segments("keychron/v6_8k/iso_encoder", "keyboard").is_ok());
        assert!(safe_segments("", "keyboard").is_err());
        assert!(safe_segments("../../windows", "keyboard").is_err());
        // An absolute path passes a ".." check, and Path::join replaces the base with it.
        assert!(safe_segments(r"C:\Windows\System32", "keyboard").is_err());
        assert!(safe_segments(r"\\server\share", "keyboard").is_err());
        assert!(safe_segments("/etc", "keyboard").is_err());
        assert!(safe_segments("keychron/../../..", "keyboard").is_err());

        // And create refuses one, rather than letting sync_into delete a folder outside the tree.
        let dir = std::env::temp_dir().join(format!("v6ps_safe_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        assert!(store.create("Bad", r"C:\Windows", &Template::Empty, false, None).is_err());
        assert!(store.create("Bad", "../../x", &Template::Empty, false, None).is_err());
        assert!(store.create("Good", "keychron/v6_8k/iso_encoder", &Template::Empty, false, None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_template_folder_must_look_like_a_keymap() {
        let dir = std::env::temp_dir().join(format!("v6ps_tpl_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let not_a_keymap = dir.join("elsewhere");
        std::fs::create_dir_all(&not_a_keymap).unwrap();
        std::fs::write(not_a_keymap.join("notes.txt"), "hello").unwrap();
        let store = Store::new(dir.join("projects"));
        let template = Template::Folder { path: not_a_keymap.display().to_string() };
        let err = store.create("From a folder", "keychron/v6_8k/iso_encoder", &template, false, None).unwrap_err();
        assert!(err.contains("keymap.c"), "{err}");
        // With a keymap.c it is copied.
        std::fs::write(not_a_keymap.join("keymap.c"), "// hi\n").unwrap();
        let p = store.create("From a folder", "keychron/v6_8k/iso_encoder", &template, false, None).unwrap();
        assert!(p.files.contains(&"keymap.c".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("v6ps-proj-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn names_and_paths() {
        assert_eq!(slug("My V6 (Gaming)"), "my_v6_gaming");
        assert_eq!(slug("  ***  "), "firmware");
        assert!(safe_rel("keymap.c").is_ok());
        assert!(safe_rel("sub/dir/a.h").is_ok());
        assert!(safe_rel("../x").is_err());
        assert!(safe_rel("C:\\x").is_err());
        assert!(safe_rel("/etc/passwd").is_err());
        assert!(safe_rel("a?b").is_err());
    }

    /// A fake firmware tree: keychron/demo with its keymaps one level up, like the V6 8K.
    fn fake_source(root: &Path) {
        let kb = root.join("keyboards/keychron/demo");
        std::fs::create_dir_all(kb.join("iso/keymaps/keychron")).unwrap();
        std::fs::create_dir_all(kb.join("keymaps/default")).unwrap();
        std::fs::write(kb.join("info.json"), r#"{"keyboard_name": "Demo", "bootloader": "at32-dfu"}"#).unwrap();
        std::fs::write(kb.join("iso/keyboard.json"), r#"{"usb": {"pid": "0x0F61"}}"#).unwrap();
        std::fs::write(kb.join("iso/keymaps/keychron/keymap.c"), "// keychron\n").unwrap();
        std::fs::write(kb.join("iso/keymaps/keychron/rules.mk"), "VIA_ENABLE = yes\n").unwrap();
        std::fs::write(kb.join("keymaps/default/keymap.c"), "// default\n").unwrap();
    }

    #[test]
    fn keyboards_and_templates() {
        let src = temp("src");
        fake_source(&src);
        let kbs = keyboards(&src);
        assert_eq!(
            kbs,
            vec![KeyboardInfo {
                path: "keychron/demo/iso".into(),
                name: "Demo".into(),
                pid: Some(0x0F61),
                bootloader: Some("at32-dfu".into())
            }]
        );
        assert_eq!(keymaps_of(&src, "keychron/demo/iso"), ["keychron", "default"]);
        assert!(find_keymap(&src, "keychron/demo/iso", "default").unwrap().ends_with("demo/keymaps/default"));
        std::fs::remove_dir_all(src).unwrap();
    }

    #[test]
    fn project_lifecycle() {
        let (src, root) = (temp("src2"), temp("projects"));
        fake_source(&src);
        let store = Store::new(root.clone());
        let t = Template::Keymap { name: "keychron".into() };
        let p = store.create("My V6", "keychron/demo/iso", &t, true, Some(&src)).unwrap();
        assert_eq!((p.id.as_str(), p.keymap.as_str()), ("my_v6", "v6ps_my_v6"));
        assert_eq!(p.files, ["keymap.c", "profile_switcher.c", "rules.mk"]);
        let rules = store.read("my_v6", "rules.mk").unwrap();
        assert_eq!(rules.matches("VIA_ENABLE").count(), 1, "already there: not added twice");
        assert!(rules.contains("DEFERRED_EXEC_ENABLE = yes") && rules.contains("SRC += profile_switcher.c"));
        store.add_module("my_v6").unwrap();
        assert_eq!(store.read("my_v6", "rules.mk").unwrap(), rules, "adding again changes nothing");
        assert_eq!(p.module_version, Some(bundled_module_version()));
        assert_eq!(bundled_module_version(), crate::protocol::PS_PROTO_VERSION, "the bundled module speaks the app's protocol");
        let empty = store.create("My V6", "keychron/demo/iso", &Template::Empty, false, None).unwrap();
        assert_eq!((empty.id.as_str(), empty.module_version), ("my_v6_2", None));
        assert_eq!(empty.files, ["config.h", "keymap.c", "rules.mk"]);
        assert_eq!(store.read("my_v6_2", "keymap.c").unwrap(), "");
        assert_eq!(store.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["my_v6", "my_v6_2"], "in the order they were made");
        store.set_order(&["my_v6_2".into(), "gone".into(), "my_v6".into()]).unwrap();
        assert_eq!(store.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["my_v6_2", "my_v6"]);

        store.create_file("my_v6", "config.h", "#pragma once\n").unwrap();
        assert!(store.create_file("my_v6", "config.h", "").is_err());
        store.rename_file("my_v6", "config.h", "inc/config.h").unwrap();
        assert!(store.get("my_v6").unwrap().files.contains(&"inc/config.h".to_string()));
        assert_eq!(store.delete_file("my_v6", "inc/config.h").unwrap(), "#pragma once\n");
        assert!(!store.keymap_dir("my_v6").unwrap().join("inc").exists(), "empty folder removed");
        assert!(store.read("my_v6", "../project.json").is_err());

        let (keymap, _) = store.sync_into("my_v6", &src).unwrap();
        let copied = src.join("keyboards/keychron/demo/iso/keymaps/v6ps_my_v6/keymap.c");
        assert!(copied.exists() && keymap == "v6ps_my_v6");
        let built_rules = || std::fs::read_to_string(src.join("keyboards/keychron/demo/iso/keymaps/v6ps_my_v6/rules.mk")).unwrap();
        assert!(!built_rules().contains("PS_INDICATORS_USER"));
        // A board whose own code takes the indicators hook (one folder up, like Keychron's S1).
        std::fs::write(src.join("keyboards/keychron/demo/demo.c"), "bool led_matrix_indicators_advanced_kb(uint8_t a, uint8_t b) {}\n")
            .unwrap();
        store.sync_into("my_v6", &src).unwrap();
        assert_eq!(built_rules().matches("OPT_DEFS += -DPS_INDICATORS_USER").count(), 1);
        assert!(!store.read("my_v6", "rules.mk").unwrap().contains("PS_INDICATORS_USER"), "the project's own file is left alone");
        // The build is stamped with the project's id, so the keyboard can name it.
        let stamp = format!("OPT_DEFS += -DPS_BUILD_ID={:#010x}", crate::protocol::build_id("my_v6"));
        assert_eq!(built_rules().matches(&stamp).count(), 1, "stamped once, not again on the next build");
        assert!(!store.read("my_v6", "rules.mk").unwrap().contains("PS_BUILD_ID"), "the project's own file is left alone");
        std::fs::remove_file(src.join("keyboards/keychron/demo/demo.c")).unwrap();
        assert_eq!(keymaps_of(&src, "keychron/demo/iso"), ["keychron", "default"], "its own copy isn't a template");
        std::fs::write(src.join("keychron_demo_iso_v6ps_my_v6.bin"), [0u8; 100]).unwrap();
        let b = store.keep_build("my_v6", &src).unwrap();
        assert_eq!((b.file.as_str(), b.size), ("keychron_demo_iso_v6ps_my_v6.bin", 100));
        assert_eq!(store.get("my_v6").unwrap().last_build, Some(b));

        let snap = store.delete("my_v6").unwrap();
        assert!(store.get("my_v6").is_err());
        let back = store.restore(&snap).unwrap();
        assert_eq!(back.id, "my_v6");
        assert_eq!(store.list().last().unwrap().id, "my_v6", "back in its place");
        assert_eq!(store.read("my_v6", "keymap.c").unwrap(), "// keychron\n");
        assert_eq!(store.rename("my_v6", "Renamed").unwrap().name, "Renamed");
        assert_eq!(store.list().len(), 2);

        // Which firmware is on the keyboard: one project per keyboard, kept over a restart.
        assert!(!store.get("my_v6").unwrap().flashed);
        store.set_flashed("my_v6", true).unwrap();
        assert!(store.get("my_v6").unwrap().flashed && !store.get("my_v6_2").unwrap().flashed);
        store.set_flashed("my_v6_2", true).unwrap();
        assert!(!store.get("my_v6").unwrap().flashed, "only one firmware fits on a keyboard");
        store.clear_flashed("keychron/demo/iso");
        assert!(!store.get("my_v6_2").unwrap().flashed);

        // What's on the keyboard is the files as they were put there: an edit since isn't on it.
        store.set_flashed("my_v6", true).unwrap();
        assert!(!store.get("my_v6").unwrap().unflashed_changes);
        store.write("my_v6", "keymap.c", "// edited\n").unwrap();
        assert!(store.get("my_v6").unwrap().unflashed_changes, "edited since it was put on the keyboard");
        assert!(store.get("my_v6").unwrap().build_outdated, "and since its last build: a flash builds it first");
        store.set_flashed("my_v6", true).unwrap();
        assert!(!store.get("my_v6").unwrap().unflashed_changes, "marked again: this version is on it");
        // A flash puts the last build on it, made from "// keychron": the edit isn't on the keyboard.
        store.set_flashed_build("my_v6").unwrap();
        assert!(store.get("my_v6").unwrap().unflashed_changes);
        store.write("my_v6", "keymap.c", "// keychron\n").unwrap();
        assert!(!store.get("my_v6").unwrap().unflashed_changes, "back to what was built");
        assert!(!store.get("my_v6").unwrap().build_outdated, "the last build is of these files");
        // A mark from before fingerprints (just the id): on the keyboard, changes unknown.
        std::fs::write(store.root.join(FLASHED_FILE), r#"{"keychron/demo/iso":"my_v6"}"#).unwrap();
        let old = store.get("my_v6").unwrap();
        assert!(old.flashed && !old.unflashed_changes);
        store.clear_flashed("keychron/demo/iso");

        let copy = store.duplicate("my_v6").unwrap();
        assert_eq!((copy.name.as_str(), copy.id.as_str()), ("Renamed (copy)", "renamed_copy"));
        assert_eq!(store.read(&copy.id, "keymap.c").unwrap(), "// keychron\n");
        assert_ne!(copy.build_id, store.get("my_v6").unwrap().build_id, "its own build, told apart from the original");
        assert_eq!(store.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["my_v6_2", "my_v6", "renamed_copy"], "right after it");
        std::fs::remove_dir_all(src).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
