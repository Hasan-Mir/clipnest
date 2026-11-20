//! Paste Queue & File/Image Drop Basket (Collector):
//! 1. Queue mode: copy several things, then paste them one by one in order (FIFO) or reversed (LIFO).
//!    While the queue holds items in Queue mode, Ctrl+V is intercepted globally and pastes the next item.
//! 2. Basket (Collector) mode: collect files (CF_HDROP) and images across folders/web pages while ignoring
//!    plain text copies, then batch-paste all at once via CF_HDROP or directly into a picked destination folder
//!    with verified safe move (Cut) support, live progress reporting, and non-destructive error handling.

use crate::capture::build_hdrop;
use crate::classify;
use crate::db::{self, ClipRow, NewClip, StoredFormat};
use crate::platform::win;
use crate::state::{AppState, BasketEntry};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn changed(app: &AppHandle) {
    let _ = app.emit("queue-changed", ());
    let _ = app.emit("status-changed", ());
}

/// Registers/unregisters the global Ctrl+V interception depending on the queue state.
pub fn sync_intercept(app: &AppHandle) {
    let st = app.state::<AppState>();
    if st.queue_pasting.load(Ordering::SeqCst) {
        return;
    }
    let want = {
        let q = st.queue.lock();
        q.active && q.mode == "queue" && !q.items.is_empty()
    } && st.settings.read().queue_intercept;
    let gs = app.global_shortcut();
    let mut slot = st.queue_sc.lock();
    if want {
        if slot.is_none() {
            if let Ok(sc) = "Ctrl+V".parse::<Shortcut>() {
                if gs.register(sc.clone()).is_ok() {
                    *slot = Some(sc);
                }
            }
        }
    } else if let Some(sc) = slot.take() {
        let _ = gs.unregister(sc);
    }
}

/// Stable identity of a basket entry: `<clip id>|<path>` (path is empty for images).
pub fn entry_key(id: i64, path: &Option<String>) -> String {
    format!("{}|{}", id, path.as_deref().unwrap_or(""))
}

fn parse_key(k: &str) -> Option<(i64, Option<String>)> {
    let (id, path) = k.split_once('|')?;
    let id = id.parse::<i64>().ok()?;
    Some((id, if path.is_empty() { None } else { Some(path.to_string()) }))
}

fn split_paths(plain: &str) -> Vec<String> {
    plain.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).map(|l| l.to_string()).collect()
}

pub fn push_basket_paths(
    basket: &mut Vec<BasketEntry>,
    id: i64,
    paths: Vec<Option<String>>,
    cut_flag: bool,
    update_existing: bool,
) {
    for path in paths {
        let dup = match &path {
            Some(p) => {
                basket.iter_mut().find(|e| e.path.as_deref().map(|x| x.eq_ignore_ascii_case(p)).unwrap_or(false))
            }
            None => basket.iter_mut().find(|e| e.id == id && e.path.is_none()),
        };
        if let Some(existing) = dup {
            if update_existing {
                existing.id = id;
                existing.cut = cut_flag;
            }
        } else {
            basket.push(BasketEntry { id, cut: cut_flag, path });
        }
    }
}

pub fn push_captured(app: &AppHandle, id: i64, kind: &str, is_cut: bool) {
    let st = app.state::<AppState>();
    let allow_cut = st.settings.read().basket_allow_cut;
    let is_basket = {
        let q = st.queue.lock();
        if !q.active {
            return;
        }
        q.mode == "basket"
    };
    if is_basket {
        // Smart Context Filtering: only file and image clips enter the Drop Basket.
        if kind != "file" && kind != "image" {
            return;
        }
        let cut_flag = is_cut && allow_cut && kind == "file";
        // One basket entry per collected path, so a multi-file copy shows every file individually.
        let paths: Vec<Option<String>> = if kind == "file" {
            let plain = { db::get_plain(&st.db.lock(), id).map(|(_, p)| p).unwrap_or_default() };
            split_paths(&plain).into_iter().map(Some).collect()
        } else {
            vec![None]
        };
        let mut q = st.queue.lock();
        push_basket_paths(&mut q.basket, id, paths, cut_flag, true);
    } else {
        st.queue.lock().items.push(id);
    }
    changed(app);
    sync_intercept(app);
}

pub fn close_queue(app: &AppHandle) {
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        q.active = false;
        q.items.clear();
        q.basket.clear();
    }
    crate::windowing::hide_queue(app);
    changed(app);
    sync_intercept(app);
}

pub fn toggle(app: &AppHandle) {
    let active = app.state::<AppState>().queue.lock().active;
    if active {
        close_queue(app);
    } else {
        app.state::<AppState>().queue.lock().active = true;
        crate::windowing::show_queue(app);
        changed(app);
        sync_intercept(app);
    }
}

pub fn set_mode(app: &AppHandle, mode: &str) {
    let norm = if mode == "basket" { "basket" } else { "queue" };
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        q.mode = norm.to_string();
    }
    changed(app);
    sync_intercept(app);
}

/// Sets the Copy/Cut flag of the given entries. The flag is read again at paste time, so changing it
/// while the folder dialog is open is honoured.
pub fn set_cut(app: &AppHandle, keys: &[String], cut: bool) {
    let allow_cut = app.state::<AppState>().settings.read().basket_allow_cut;
    let parsed: Vec<(i64, Option<String>)> = keys.iter().filter_map(|k| parse_key(k)).collect();
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        for e in q.basket.iter_mut() {
            if e.path.is_some() && parsed.iter().any(|(id, p)| *id == e.id && *p == e.path) {
                e.cut = cut && allow_cut;
            }
        }
    }
    changed(app);
}

/// Toggles Copy/Cut of every entry that belongs to the clip (legacy/CLI command).
pub fn toggle_cut(app: &AppHandle, id: i64) {
    let allow_cut = app.state::<AppState>().settings.read().basket_allow_cut;
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        let next = !q.basket.iter().filter(|e| e.id == id && e.path.is_some()).all(|e| e.cut);
        for e in q.basket.iter_mut().filter(|e| e.id == id && e.path.is_some()) {
            e.cut = next && allow_cut;
        }
    }
    changed(app);
}

pub fn get_items(state: &AppState) -> Vec<ClipRow> {
    let (mode, ids, basket) = {
        let q = state.queue.lock();
        (q.mode.clone(), q.items.clone(), q.basket.clone())
    };
    let conn = state.db.lock();
    if mode == "basket" {
        let mut out: Vec<ClipRow> = Vec::new();
        for e in &basket {
            if out.iter().any(|r| r.id == e.id) {
                continue;
            }
            if let Some(mut row) = db::get_row(&conn, e.id) {
                row.cut = e.cut;
                out.push(row);
            }
        }
        out
    } else {
        db::get_rows(&conn, &ids)
    }
}

/// One row of the Drop Basket as shown in the UI: a single file, folder or image.
#[derive(Serialize, Clone, Debug)]
pub struct BasketRow {
    pub key: String,
    pub id: i64,
    pub kind: String,
    pub path: Option<String>,
    pub name: String,
    pub parent: Option<String>,
    pub is_dir: bool,
    pub exists: bool,
    pub cut: bool,
    pub img_w: Option<i64>,
    pub img_h: Option<i64>,
}

pub fn get_basket_rows(state: &AppState) -> Vec<BasketRow> {
    let basket = state.queue.lock().basket.clone();
    // Read the database first, then touch the file system without holding the DB lock.
    let metas: Vec<(BasketEntry, String, Option<i64>, Option<i64>)> = {
        let conn = state.db.lock();
        basket
            .into_iter()
            .filter_map(|e| db::get_row(&conn, e.id).map(|r| (e, r.kind.clone(), r.img_w, r.img_h)))
            .collect()
    };
    let mut out = Vec::with_capacity(metas.len());
    for (e, kind, img_w, img_h) in metas {
        let key = entry_key(e.id, &e.path);
        match &e.path {
            Some(p) => {
                let path = Path::new(p);
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
                let parent = path.parent().map(|x| x.to_string_lossy().to_string()).filter(|x| !x.is_empty());
                out.push(BasketRow {
                    key,
                    id: e.id,
                    kind: "file".into(),
                    path: Some(p.clone()),
                    name,
                    parent,
                    is_dir: path.is_dir(),
                    exists: path.exists(),
                    cut: e.cut,
                    img_w: None,
                    img_h: None,
                });
            }
            None => out.push(BasketRow {
                key,
                id: e.id,
                kind,
                path: None,
                name: String::new(),
                parent: None,
                is_dir: false,
                exists: true,
                cut: false,
                img_w,
                img_h,
            }),
        }
    }
    out
}

pub fn remove(app: &AppHandle, id: i64) {
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        if let Some(pos) = q.items.iter().position(|x| *x == id) {
            q.items.remove(pos);
        }
        q.basket.retain(|e| e.id != id);
    }
    changed(app);
    sync_intercept(app);
}

/// Removes individual basket entries (a file, or a whole folder group) by key.
pub fn remove_keys(app: &AppHandle, keys: &[String]) {
    let parsed: Vec<(i64, Option<String>)> = keys.iter().filter_map(|k| parse_key(k)).collect();
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        q.basket.retain(|e| !parsed.iter().any(|(id, p)| *id == e.id && *p == e.path));
    }
    changed(app);
}

pub fn clear(app: &AppHandle) {
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        if q.mode == "basket" {
            q.basket.clear();
        } else {
            q.items.clear();
        }
    }
    changed(app);
    sync_intercept(app);
}

/// Materializes an image clip to `%TEMP%\ClipNestDrops\clipnest-image-<id>-<ts>.png`.
fn materialize_image_bytes(id: i64, png: &[u8], dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file_path = dir.join(format!("clipnest-image-{id}-{}.png", db::now_ms()));
    std::fs::write(&file_path, png).map_err(|e| e.to_string())?;
    Ok(file_path)
}

/// Batch "Paste All Here": materializes collected images in `%TEMP%\\ClipNestDrops\\`, builds a
/// single combined `CF_HDROP` with `Preferred DropEffect`, writes to the OS clipboard, and sends Ctrl+V.
/// The Copy/Cut flags are read NOW (at paste time). A "move" effect is only used when every collected
/// file is marked Cut, so a file marked Copy can never be moved by accident.
pub fn basket_paste_here(app: &AppHandle) -> Result<usize, String> {
    let st = app.state::<AppState>();
    if st.transfer_busy.load(Ordering::SeqCst) {
        return Err("A transfer is already running".into());
    }
    let allow_cut = st.settings.read().basket_allow_cut;
    let basket = st.queue.lock().basket.clone();
    if basket.is_empty() {
        return Ok(0);
    }
    let temp_drops = std::env::temp_dir().join("ClipNestDrops");
    let mut all_paths: Vec<String> = Vec::new();
    let mut file_entries = 0usize;
    let mut cut_entries = 0usize;
    let mut has_temp_image = false;
    let image_blobs: std::collections::HashMap<i64, Vec<u8>> = {
        let conn = st.db.lock();
        basket
            .iter()
            .filter(|e| e.path.is_none())
            .filter_map(|e| db::get_format_data(&conn, e.id, "PNG").map(|b| (e.id, b)))
            .collect()
    };
    for entry in &basket {
        match &entry.path {
            Some(p) => {
                if Path::new(p).exists() {
                    file_entries += 1;
                    if entry.cut && allow_cut {
                        cut_entries += 1;
                    }
                    if !all_paths.iter().any(|x| x.eq_ignore_ascii_case(p)) {
                        all_paths.push(p.clone());
                    }
                }
            }
            None => {
                if let Some(png) = image_blobs.get(&entry.id) {
                    if let Ok(p) = materialize_image_bytes(entry.id, png, &temp_drops) {
                        all_paths.push(p.to_string_lossy().to_string());
                        has_temp_image = true;
                    }
                }
            }
        }
    }
    if all_paths.is_empty() {
        return Err("No valid files or images found in Drop Basket".into());
    }
    let all_cut = allow_cut && file_entries > 0 && cut_entries == file_entries && !has_temp_image;
    let hdrop_bytes = build_hdrop(&all_paths);
    let drop_effect: u32 = if all_cut { 2 } else { 1 };
    let pref_id = win::register_format("Preferred DropEffect");
    let mut clip_items = vec![(win::CF_HDROP_ID, "CF_HDROP".to_string(), hdrop_bytes)];
    if pref_id != 0 {
        clip_items.push((pref_id, "Preferred DropEffect".to_string(), drop_effect.to_le_bytes().to_vec()));
    }
    st.self_write_at.store(db::now_ms(), Ordering::SeqCst);
    let seq = win::write_clipboard(&clip_items)?;
    st.self_seq.store(seq, Ordering::SeqCst);
    st.self_write_at.store(db::now_ms(), Ordering::SeqCst);

    let fg = win::foreground();
    let target = if fg != 0 && !win::is_own_window(fg) { fg } else { st.target_hwnd.load(Ordering::SeqCst) };
    let count = all_paths.len();
    if target != 0 {
        std::thread::spawn(move || {
            win::focus_window(target);
            let mut focused = win::foreground() == target;
            for _ in 0..30 {
                if focused {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
                focused = win::foreground() == target;
            }
            if focused {
                std::thread::sleep(Duration::from_millis(40));
                win::send_paste_keys("ctrl+v");
            }
        });
    }
    if all_cut {
        st.queue.lock().basket.retain(|e| {
            e.path.as_deref().map(|p| !all_paths.iter().any(|x| x.eq_ignore_ascii_case(p))).unwrap_or(true)
        });
        changed(app);
    }
    Ok(count)
}

fn unique_dest_path(dest_dir: &Path, file_name: &str, src_path: Option<&Path>) -> PathBuf {
    let candidate = dest_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    if let Some(src) = src_path {
        if same_canonical_path(src, &candidate) {
            return candidate;
        }
    }
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = Path::new(file_name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..10_000 {
        let next = dest_dir.join(format!("{stem} ({i}){ext}"));
        if !next.exists() {
            return next;
        }
    }
    candidate
}

fn same_canonical_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Byte counter of the item currently being copied; reports a 0..1 fraction through `cb`.
struct ByteProgress<'a> {
    total: u64,
    done: u64,
    cb: &'a mut dyn FnMut(f64),
}

impl<'a> ByteProgress<'a> {
    fn add(&mut self, n: u64) {
        self.done += n;
        let f = if self.total == 0 { 1.0 } else { self.done as f64 / self.total as f64 };
        (self.cb)(f);
    }
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for entry in rd.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    total += dir_size(&entry.path());
                } else if ft.is_file() {
                    total += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    total
}

fn copy_file_verified(src: &Path, dst: &Path, prog: &mut ByteProgress) -> Result<(), String> {
    use std::io::{Read, Write};
    let src_meta = std::fs::metadata(src).map_err(|e| format!("Cannot read {}: {e}", src.display()))?;
    let expected_len = src_meta.len();
    {
        let mut reader = std::fs::File::open(src).map_err(|e| format!("Cannot open {}: {e}", src.display()))?;
        let mut writer = std::fs::File::create(dst).map_err(|e| format!("Cannot create {}: {e}", dst.display()))?;
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(format!("Copy failed for {}: {e}", src.display())),
            };
            writer.write_all(&buf[..n]).map_err(|e| format!("Write failed for {}: {e}", dst.display()))?;
            prog.add(n as u64);
        }
        writer.sync_all().map_err(|e| format!("Disk sync failed for {}: {e}", dst.display()))?;
    }
    let dst_meta = std::fs::metadata(dst).map_err(|e| format!("Verification failed for {}: {e}", dst.display()))?;
    if !dst_meta.is_file() || dst_meta.len() != expected_len {
        return Err(format!(
            "Size verification mismatch for {}: expected {} bytes, got {} bytes",
            dst.display(),
            expected_len,
            dst_meta.len()
        ));
    }
    Ok(())
}

fn copy_dir_verified(src: &Path, dst: &Path, prog: &mut ByteProgress) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("Cannot create directory {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Cannot read directory {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let sp = entry.path();
        let dp = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir_verified(&sp, &dp, prog)?;
        } else if ft.is_file() {
            copy_file_verified(&sp, &dp, prog)?;
        } else {
            // Symlinks / junctions / special files are never silently skipped: a Cut would otherwise
            // delete something that was not copied.
            return Err(format!("Unsupported entry (link or special file): {}", sp.display()));
        }
    }
    Ok(())
}

fn write_image_verified(dest_dir: &Path, id: i64, png: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write;
    let fname = format!("clipnest-image-{}-{}.png", id, db::now_ms());
    let dst = unique_dest_path(dest_dir, &fname, None);
    let res = (|| -> Result<(), String> {
        let mut f = std::fs::File::create(&dst).map_err(|e| e.to_string())?;
        f.write_all(png).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&dst).map_err(|e| e.to_string())?;
        if meta.len() != png.len() as u64 {
            return Err(format!("Image verification failed for {}", dst.display()));
        }
        Ok(())
    })();
    match res {
        Ok(()) => Ok(dst),
        Err(e) => {
            let _ = std::fs::remove_file(&dst);
            Err(e)
        }
    }
}

/// Live progress of a Drop Basket transfer (event `basket-progress`).
#[derive(Serialize, Clone, Debug)]
pub struct TransferProgress {
    pub done: usize,
    pub failed: usize,
    pub total: usize,
    pub current: String,
    /// 0..1 fraction of the item that is being copied right now.
    pub fraction: f64,
    /// "copy" | "finalize"
    pub phase: String,
}

/// An item that could not be transferred.
#[derive(Serialize, Clone, Debug)]
pub struct TransferFailure {
    pub key: String,
    pub id: i64,
    pub path: Option<String>,
    pub name: String,
    pub is_dir: bool,
    pub exists: bool,
    /// Machine-readable cause (translated by the UI): source_missing | invalid_path | dest_inside_source |
    /// dest_create | image_missing | copy_failed | reverify_failed | cut_not_removed.
    pub code: String,
    /// Raw technical detail (usually the OS error), may be empty.
    pub reason: String,
}

/// Final result of a Drop Basket transfer (event `basket-finished`).
#[derive(Serialize, Clone, Debug)]
pub struct TransferReport {
    pub total: usize,
    pub done: usize,
    pub failed: Vec<TransferFailure>,
    /// True when at least one item was marked Cut but no original was deleted because something failed.
    pub cut_skipped: bool,
    pub dest: String,
}

struct Reporter {
    app: AppHandle,
    _total: usize,
    last: Instant,
}

impl Reporter {
    fn new(app: AppHandle, total: usize) -> Self {
        let last = Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now);
        Reporter { app, _total: total, last }
    }

    fn emit(&mut self, p: TransferProgress, force: bool) {
        if !force && self.last.elapsed() < Duration::from_millis(60) {
            return;
        }
        self.last = Instant::now();
        *self.app.state::<AppState>().transfer_progress.lock() = Some(p.clone());
        let _ = self.app.emit("basket-progress", p);
    }
}

fn failure_for(en: &BasketEntry, code: &str, reason: String) -> TransferFailure {
    let (name, is_dir, exists) = match &en.path {
        Some(p) => {
            let path = Path::new(p);
            (
                path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone()),
                path.is_dir(),
                path.exists(),
            )
        }
        None => ("image".to_string(), false, false),
    };
    TransferFailure {
        key: entry_key(en.id, &en.path),
        id: en.id,
        path: en.path.clone(),
        name,
        is_dir,
        exists,
        code: code.to_string(),
        reason,
    }
}

fn dest_inside_source(src: &Path, dest_dir: &Path) -> bool {
    match (std::fs::canonicalize(src), std::fs::canonicalize(dest_dir)) {
        (Ok(cs), Ok(cd)) => cd.starts_with(&cs),
        _ => false,
    }
}

struct Copied {
    id: i64,
    path: Option<String>,
    src: PathBuf,
    dst: PathBuf,
    is_dir: bool,
    cut: bool,
}

/// Core two-phase transfer engine (independent of Tauri `AppHandle` for deterministic unit testing):
///  1. copy + verify every item (a failure never stops the remaining items), reporting live progress;
///  2. ONLY if phase 1 had no failure at all, the originals of items marked Cut are removed.
/// Returns `(TransferReport, completed_cut_entries)`.
pub fn transfer_core<F, P>(
    mut get_png: F,
    allow_cut: bool,
    entries: &[BasketEntry],
    dest_dir: &Path,
    mut on_progress: P,
) -> (TransferReport, Vec<(i64, Option<String>)>)
where
    F: FnMut(i64) -> Option<Vec<u8>>,
    P: FnMut(TransferProgress, bool),
{
    let total = entries.len();
    let mut report = TransferReport {
        total,
        done: 0,
        failed: Vec::new(),
        cut_skipped: false,
        dest: dest_dir.to_string_lossy().to_string(),
    };
    on_progress(
        TransferProgress { done: 0, failed: 0, total, current: String::new(), fraction: 0.0, phase: "copy".into() },
        true,
    );

    if let Err(e) = std::fs::create_dir_all(dest_dir) {
        for en in entries {
            report.failed.push(failure_for(en, "dest_create", e.to_string()));
        }
        return (report, Vec::new());
    }

    let mut copied: Vec<Copied> = Vec::new();
    for en in entries {
        let label = en
            .path
            .as_deref()
            .and_then(|p| Path::new(p).file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".to_string());
        on_progress(
            TransferProgress {
                done: report.done,
                failed: report.failed.len(),
                total,
                current: label.clone(),
                fraction: 0.0,
                phase: "copy".into(),
            },
            true,
        );

        let Some(p) = &en.path else {
            // Browser image stored in the database.
            match get_png(en.id) {
                None => report.failed.push(failure_for(en, "image_missing", String::new())),
                Some(png) => match write_image_verified(dest_dir, en.id, &png) {
                    Ok(_) => report.done += 1,
                    Err(e) => report.failed.push(failure_for(en, "copy_failed", e)),
                },
            }
            continue;
        };

        let src = PathBuf::from(p);
        if !src.exists() {
            report.failed.push(failure_for(en, "source_missing", String::new()));
            continue;
        }
        let Some(fname) = src.file_name().map(|n| n.to_string_lossy().to_string()) else {
            report.failed.push(failure_for(en, "invalid_path", String::new()));
            continue;
        };
        let is_dir = src.is_dir();
        if is_dir && dest_inside_source(&src, dest_dir) {
            report.failed.push(failure_for(en, "dest_inside_source", String::new()));
            continue;
        }
        let dst = unique_dest_path(dest_dir, &fname, Some(&src));
        if same_canonical_path(&src, &dst) {
            // Already lives in the destination folder: nothing to copy, and never delete it for a Cut.
            report.done += 1;
            continue;
        }
        let total_bytes = if is_dir { dir_size(&src) } else { std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0) };
        let res = {
            let done_now = report.done;
            let failed_now = report.failed.len();
            let mut cb = |f: f64| {
                on_progress(
                    TransferProgress {
                        done: done_now,
                        failed: failed_now,
                        total,
                        current: label.clone(),
                        fraction: f.clamp(0.0, 1.0),
                        phase: "copy".into(),
                    },
                    false,
                );
            };
            let mut prog = ByteProgress { total: total_bytes, done: 0, cb: &mut cb };
            if is_dir {
                copy_dir_verified(&src, &dst, &mut prog)
            } else {
                copy_file_verified(&src, &dst, &mut prog)
            }
        };
        match res {
            Ok(()) => {
                report.done += 1;
                copied.push(Copied { id: en.id, path: en.path.clone(), src, dst, is_dir, cut: en.cut && allow_cut });
            }
            Err(e) => {
                // Remove only what this operation created (the destination name was unique).
                if is_dir {
                    let _ = std::fs::remove_dir_all(&dst);
                } else {
                    let _ = std::fs::remove_file(&dst);
                }
                report.failed.push(failure_for(en, "copy_failed", e));
            }
        }
    }

    // Phase 2: move semantics — only when EVERYTHING copied fine.
    let mut completed: Vec<(i64, Option<String>)> = Vec::new();
    if copied.iter().any(|c| c.cut) {
        if !report.failed.is_empty() {
            report.cut_skipped = true;
        } else {
            on_progress(
                TransferProgress {
                    done: report.done,
                    failed: 0,
                    total,
                    current: String::new(),
                    fraction: 1.0,
                    phase: "finalize".into(),
                },
                true,
            );
            for c in copied.iter().filter(|c| c.cut) {
                let en = BasketEntry { id: c.id, cut: true, path: c.path.clone() };
                let intact = if c.is_dir {
                    c.dst.is_dir()
                } else {
                    match (std::fs::metadata(&c.src), std::fs::metadata(&c.dst)) {
                        (Ok(a), Ok(b)) => b.is_file() && a.len() == b.len(),
                        _ => false,
                    }
                };
                if !intact {
                    report.failed.push(failure_for(&en, "reverify_failed", String::new()));
                    continue;
                }
                let removed = if c.is_dir { std::fs::remove_dir_all(&c.src) } else { std::fs::remove_file(&c.src) };
                match removed {
                    Ok(()) => completed.push((c.id, c.path.clone())),
                    Err(e) => report.failed.push(failure_for(&en, "cut_not_removed", e.to_string())),
                }
            }
        }
    }
    (report, completed)
}

fn run_transfer_inner(app: &AppHandle, entries: &[BasketEntry], dest_dir: &Path) -> TransferReport {
    let st = app.state::<AppState>();
    let allow_cut = st.settings.read().basket_allow_cut;
    let mut reporter = Reporter::new(app.clone(), entries.len());
    let (report, completed) = transfer_core(
        |id| {
            let conn = st.db.lock();
            db::get_format_data(&conn, id, "PNG")
        },
        allow_cut,
        entries,
        dest_dir,
        |p, force| reporter.emit(p, force),
    );
    if !completed.is_empty() {
        st.queue.lock().basket.retain(|e| !completed.iter().any(|(id, p)| *id == e.id && *p == e.path));
        changed(app);
    }
    report
}

/// Runs a transfer and announces the result (`basket-finished`) to the UI.
pub fn run_transfer(app: &AppHandle, entries: &[BasketEntry], dest_dir: &Path) -> TransferReport {
    let report = run_transfer_inner(app, entries, dest_dir);
    {
        let st = app.state::<AppState>();
        *st.transfer_progress.lock() = None;
        *st.transfer_report.lock() = Some(report.clone());
        st.transfer_busy.store(false, Ordering::SeqCst);
    }
    let _ = app.emit("basket-finished", report.clone());
    report
}

/// Returns the current live progress (if a transfer is running) and takes any finished report.
#[derive(Serialize, Clone, Debug)]
pub struct TransferStatus {
    pub busy: bool,
    pub progress: Option<TransferProgress>,
    pub report: Option<TransferReport>,
}

pub fn get_transfer_status(state: &AppState) -> TransferStatus {
    let busy = state.transfer_busy.load(Ordering::SeqCst);
    let progress = state.transfer_progress.lock().clone();
    let report = if busy { None } else { state.transfer_report.lock().take() };
    TransferStatus { busy, progress, report }
}

/// Synchronous variant for callers that want a plain result (Explorer context menu, popup paste to folder).
pub fn transfer_entries_to_dir(app: &AppHandle, entries: &[BasketEntry], dest_dir: &Path) -> Result<usize, String> {
    let st = app.state::<AppState>();
    if st.transfer_busy.swap(true, Ordering::SeqCst) {
        return Err("A transfer is already running".into());
    }
    let _guard = BusyGuard(app.clone());
    let report = run_transfer(app, entries, dest_dir);
    if report.failed.is_empty() {
        Ok(report.done)
    } else {
        Err(format!(
            "{} of {} item(s) failed ({}: {})",
            report.failed.len(),
            report.total,
            report.failed[0].code,
            report.failed[0].reason
        ))
    }
}

/// Builds one basket entry per path of a clip (or one image entry).
fn entries_for_clip(app: &AppHandle, id: i64) -> Vec<BasketEntry> {
    let st = app.state::<AppState>();
    let Some((kind, plain)) = db::get_plain(&st.db.lock(), id) else {
        return Vec::new();
    };
    if kind == "image" {
        vec![BasketEntry { id, cut: false, path: None }]
    } else if kind == "file" {
        split_paths(&plain).into_iter().map(|p| BasketEntry { id, cut: false, path: Some(p) }).collect()
    } else {
        Vec::new()
    }
}

/// Copies the specified clip IDs (files, folders, or images) directly into `dest_dir`.
pub fn paste_clips_to_dir(app: &AppHandle, ids: &[i64], dest_dir: &Path) -> Result<usize, String> {
    let entries: Vec<BasketEntry> = ids.iter().flat_map(|&id| entries_for_clip(app, id)).collect();
    if entries.is_empty() {
        return Ok(0);
    }
    transfer_entries_to_dir(app, &entries, dest_dir)
}

/// Pastes all items currently in the Drop Basket into `dest_dir` (or falls back to the most recent file/image clip).
pub fn paste_basket_to_dir(app: &AppHandle, dest_dir: &Path) -> Result<usize, String> {
    let st = app.state::<AppState>();
    let basket = st.queue.lock().basket.clone();
    if !basket.is_empty() {
        return transfer_entries_to_dir(app, &basket, dest_dir);
    }
    let latest_id: Option<i64> = st
        .db
        .lock()
        .query_row("SELECT id FROM clips WHERE kind IN ('file','image') ORDER BY sort_ts DESC LIMIT 1", [], |r| {
            r.get(0)
        })
        .ok();
    if let Some(id) = latest_id {
        return paste_clips_to_dir(app, &[id], dest_dir);
    }
    Ok(0)
}

/// Adds a file/folder path selected from Windows File Explorer context menu into the Drop Basket.
pub fn collect_file_from_explorer(app: &AppHandle, path_str: &str) -> Result<i64, String> {
    let p = Path::new(path_str.trim());
    if !p.exists() {
        return Err(format!("Path does not exist: {path_str}"));
    }
    let clean_path = p.to_string_lossy().to_string();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"f\0");
    hasher.update(clean_path.as_bytes());
    let hash = hasher.finalize().to_hex().to_string();
    let preview: String = clean_path.chars().take(800).collect();
    let hdrop = build_hdrop(&[clean_path.clone()]);
    let clip = NewClip {
        hash,
        kind: "file".into(),
        plain: clean_path.clone(),
        preview,
        search: classify::normalize(&clean_path),
        app_name: "Explorer".into(),
        app_exe: "explorer.exe".into(),
        lang: None,
        img_w: None,
        img_h: None,
        color: None,
        chars: clean_path.chars().count() as i64,
        file_count: Some(1),
        sensitive: false,
        has_rich: false,
        expires_at: None,
        thumb: None,
    };
    let fmts = vec![StoredFormat { fmt_id: win::CF_HDROP_ID, name: "CF_HDROP".into(), data: hdrop }];
    let st = app.state::<AppState>();
    let id = {
        let mut conn = st.db.lock();
        let (id, _) = db::insert_clip(&mut conn, &clip, &fmts)?;
        id
    };
    {
        let mut q = st.queue.lock();
        q.active = true;
        q.mode = "basket".into();
        push_basket_paths(&mut q.basket, id, vec![Some(clean_path)], false, false);
    }
    crate::windowing::show_queue(app);
    let _ = app.emit("items-changed", ());
    changed(app);
    sync_intercept(app);
    Ok(id)
}

/// Clears the "transfer running" flag even if the worker thread panics.
struct BusyGuard(AppHandle);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let st = self.0.state::<AppState>();
        *st.transfer_progress.lock() = None;
        st.transfer_busy.store(false, Ordering::SeqCst);
    }
}

/// Batch "Paste All to Folder…": opens a native folder picker, then copies/moves all collected files,
/// directories and browser images in a background thread while the UI shows live progress
/// (`basket-progress`) and the final report (`basket-finished`).
///
/// The basket (including every Copy/Cut flag) is read AFTER the dialog closes, so toggling Copy/Cut or
/// removing items while the dialog is open is honoured. Originals are deleted only after every copy
/// succeeded and was verified.
pub fn basket_paste_to_folder(app: &AppHandle) -> Result<Option<usize>, String> {
    use tauri_plugin_dialog::DialogExt;
    let st = app.state::<AppState>();
    if st.queue.lock().basket.is_empty() {
        return Ok(Some(0));
    }
    if st.transfer_busy.load(Ordering::SeqCst) {
        return Err("A transfer is already running".into());
    }
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest_dir = picked.into_path().map_err(|e| e.to_string())?;
    let basket = st.queue.lock().basket.clone();
    if basket.is_empty() {
        return Ok(Some(0));
    }
    if st.transfer_busy.swap(true, Ordering::SeqCst) {
        return Err("A transfer is already running".into());
    }
    let total = basket.len();
    let first_label = basket
        .first()
        .and_then(|e| e.path.as_deref())
        .and_then(|p| Path::new(p).file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let init_prog =
        TransferProgress { done: 0, failed: 0, total, current: first_label, fraction: 0.0, phase: "copy".into() };
    *st.transfer_report.lock() = None;
    *st.transfer_progress.lock() = Some(init_prog.clone());
    let _ = app.emit("basket-progress", init_prog);

    let app2 = app.clone();
    std::thread::spawn(move || {
        let _guard = BusyGuard(app2.clone());
        // Brief yield so the command response reaches the webview before fast transfers finish.
        std::thread::sleep(Duration::from_millis(35));
        let _ = run_transfer(&app2, &basket, &dest_dir);
    });
    Ok(Some(total))
}

/// Called when the intercepted Ctrl+V is pressed.
pub fn on_paste_hotkey(app: &AppHandle) {
    struct PastingGuard(AppHandle);
    impl Drop for PastingGuard {
        fn drop(&mut self) {
            self.0.state::<AppState>().queue_pasting.store(false, Ordering::SeqCst);
            sync_intercept(&self.0);
        }
    }

    if app.state::<AppState>().queue_pasting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _guard = PastingGuard(app.clone());
        let st = app.state::<AppState>();
        let fifo = st.settings.read().queue_fifo;
        let id = {
            let mut q = st.queue.lock();
            if q.mode != "queue" || q.items.is_empty() {
                None
            } else if fifo {
                Some(q.items.remove(0))
            } else {
                q.items.pop()
            }
        };
        let Some(id) = id else {
            return;
        };
        // Release the hotkey so the synthesized Ctrl+V reaches the target app instead of us.
        if let Some(sc) = st.queue_sc.lock().take() {
            let _ = app.global_shortcut().unregister(sc);
        }
        let exe = win::exe_of_hwnd(win::foreground());
        let (plain, keys) = crate::paste::resolve(&app, "auto", &exe, Some(id));
        if crate::paste::write_item(&app, id, plain).is_ok() {
            std::thread::sleep(Duration::from_millis(20));
            win::send_paste_keys(&keys);
        }
        std::thread::sleep(Duration::from_millis(150));
        changed(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("clipnest_basket_test_{}_{}_{}", tag, std::process::id(), db::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn entry_key_and_parse_key_roundtrip() {
        let p = Some(r"C:\Users\me\file.txt".to_string());
        let k = entry_key(42, &p);
        assert_eq!(k, r"42|C:\Users\me\file.txt");
        assert_eq!(parse_key(&k), Some((42, p)));

        let k_img = entry_key(7, &None);
        assert_eq!(k_img, "7|");
        assert_eq!(parse_key(&k_img), Some((7, None)));
    }

    #[test]
    fn split_paths_handles_multiline_hdrop_text() {
        let raw = "  C:\\a\\one.txt \r\n\n C:\\a\\two.txt  \n";
        assert_eq!(split_paths(raw), vec!["C:\\a\\one.txt".to_string(), "C:\\a\\two.txt".to_string()]);
    }

    #[test]
    fn transfer_core_copies_files_dirs_and_images_and_moves_cut_when_all_succeed() {
        let root = temp_test_dir("ok");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        std::fs::create_dir_all(&src_dir).unwrap();

        let f1 = src_dir.join("alpha.txt");
        let f2 = src_dir.join("beta.txt");
        let sub = src_dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(&f1, b"alpha-bytes").unwrap();
        std::fs::write(&f2, b"beta-bytes-12345").unwrap();
        std::fs::write(sub.join("inside.txt"), b"nested-content").unwrap();

        let entries = vec![
            BasketEntry { id: 1, cut: false, path: Some(f1.to_string_lossy().to_string()) },
            BasketEntry { id: 2, cut: true, path: Some(f2.to_string_lossy().to_string()) },
            BasketEntry { id: 3, cut: false, path: Some(sub.to_string_lossy().to_string()) },
            BasketEntry { id: 4, cut: false, path: None },
        ];
        let mut progress_events = 0usize;
        let (report, completed_cuts) = transfer_core(
            |id| if id == 4 { Some(vec![137, 80, 78, 71, 13, 10, 26, 10]) } else { None },
            true,
            &entries,
            &dst_dir,
            |_p, _force| progress_events += 1,
        );

        assert_eq!(report.total, 4);
        assert_eq!(report.done, 4);
        assert!(report.failed.is_empty());
        assert!(!report.cut_skipped);
        assert!(progress_events >= 4);
        assert_eq!(completed_cuts.len(), 1);
        assert!(f1.exists(), "Copy item must remain at source");
        assert!(!f2.exists(), "Cut item must be removed from source after verified copy");
        assert_eq!(std::fs::read(dst_dir.join("alpha.txt")).unwrap(), b"alpha-bytes");
        assert_eq!(std::fs::read(dst_dir.join("beta.txt")).unwrap(), b"beta-bytes-12345");
        assert_eq!(std::fs::read(dst_dir.join("nested").join("inside.txt")).unwrap(), b"nested-content");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn transfer_core_continues_on_error_and_never_deletes_cut_originals() {
        let root = temp_test_dir("err_safe");
        let src_dir = root.join("src");
        let _dst_dir = root.join("dst");
        std::fs::create_dir_all(&src_dir).unwrap();

        let cut_file = src_dir.join("important.txt");
        let missing_file = src_dir.join("gone.txt");
        std::fs::write(&cut_file, b"must-never-be-lost").unwrap();

        let entries = vec![
            BasketEntry { id: 10, cut: true, path: Some(cut_file.to_string_lossy().to_string()) },
            BasketEntry { id: 11, cut: true, path: Some(missing_file.to_string_lossy().to_string()) },
            BasketEntry { id: 12, cut: false, path: Some(src_dir.to_string_lossy().to_string()) },
        ];
        // Copying `src_dir` into `src_dir/sub_dest` must fail with `dest_inside_source`
        let sub_dest = src_dir.join("sub_dest");
        let (report, completed_cuts) = transfer_core(|_| None, true, &entries, &sub_dest, |_, _| {});

        assert_eq!(report.total, 3);
        assert_eq!(report.done, 1, "Valid file should still be copied");
        assert_eq!(report.failed.len(), 2);
        assert_eq!(report.failed[0].code, "source_missing");
        assert_eq!(report.failed[1].code, "dest_inside_source");
        assert!(report.cut_skipped, "Cut deletion must be skipped when any item fails");
        assert!(completed_cuts.is_empty());
        assert!(cut_file.exists(), "Original Cut file must remain untouched on disk");
        assert_eq!(std::fs::read(sub_dest.join("important.txt")).unwrap(), b"must-never-be-lost");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn basket_deduplication_and_transfer_core_cut_with_unique_paths() {
        let root = temp_test_dir("dup_path");
        let src_dir = root.join("src");
        let dst_dir = root.join("dst");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dst_dir).unwrap();

        let file = src_dir.join("report.pdf");
        std::fs::write(&file, b"pdf-data").unwrap();

        let mut basket: Vec<BasketEntry> = Vec::new();
        push_basket_paths(&mut basket, 10, vec![Some(file.to_string_lossy().to_string())], true, true);
        push_basket_paths(&mut basket, 11, vec![Some(file.to_string_lossy().to_uppercase())], true, true);
        assert_eq!(basket.len(), 1, "Duplicate paths across clips must be deduplicated in basket");
        assert_eq!(basket[0].id, 11);
        assert!(basket[0].cut);

        let (report, completed_cuts) = transfer_core(|_| None, true, &basket, &dst_dir, |_, _| {});
        assert_eq!(report.done, 1);
        assert!(report.failed.is_empty());
        assert_eq!(completed_cuts.len(), 1);
        assert!(!file.exists(), "Original file must be removed after successful cut");
        assert_eq!(std::fs::read(dst_dir.join("report.pdf")).unwrap(), b"pdf-data");

        let _ = std::fs::remove_dir_all(&root);
    }
}
