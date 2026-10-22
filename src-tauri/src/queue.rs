//! Paste Queue & File/Image Drop Basket (Collector):
//! 1. Queue mode: copy several things, then paste them one by one in order (FIFO) or reversed (LIFO).
//!    While the queue holds items in Queue mode, Ctrl+V is intercepted globally and pastes the next item.
//! 2. Basket (Collector) mode: collect files (CF_HDROP) and images across folders/web pages while ignoring
//!    plain text copies, then batch-paste all at once via CF_HDROP or directly into a picked destination folder
//!    with verified safe move (Cut) support.

use crate::capture::build_hdrop;
use crate::db::{self, ClipRow};
use crate::platform::win;
use crate::state::{AppState, BasketEntry};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn changed(app: &AppHandle) {
    let _ = app.emit("queue-changed", ());
    let _ = app.emit("status-changed", ());
}

/// Registers/unregisters the global Ctrl+V interception depending on the queue state.
pub fn sync_intercept(app: &AppHandle) {
    let st = app.state::<AppState>();
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

pub fn push_captured(app: &AppHandle, id: i64, kind: &str, is_cut: bool) {
    let allow_cut = app.state::<AppState>().settings.read().basket_allow_cut;
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        if !q.active {
            return;
        }
        if q.mode == "basket" {
            // Smart Context Filtering: only file and image clips enter the Drop Basket.
            if kind != "file" && kind != "image" {
                return;
            }
            let cut_flag = is_cut && allow_cut && kind == "file";
            if let Some(existing) = q.basket.iter_mut().find(|e| e.id == id) {
                existing.cut = cut_flag;
            } else {
                q.basket.push(BasketEntry { id, cut: cut_flag });
            }
        } else {
            q.items.push(id);
        }
    }
    changed(app);
    sync_intercept(app);
}

pub fn toggle(app: &AppHandle) {
    let active = app.state::<AppState>().queue.lock().active;
    if active {
        {
            let st = app.state::<AppState>();
            let mut q = st.queue.lock();
            q.active = false;
            q.items.clear();
            q.basket.clear();
        }
        crate::windowing::hide_queue(app);
    } else {
        app.state::<AppState>().queue.lock().active = true;
        crate::windowing::show_queue(app);
    }
    changed(app);
    sync_intercept(app);
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

pub fn toggle_cut(app: &AppHandle, id: i64) {
    let allow_cut = app.state::<AppState>().settings.read().basket_allow_cut;
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        if let Some(entry) = q.basket.iter_mut().find(|e| e.id == id) {
            entry.cut = if allow_cut { !entry.cut } else { false };
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
        basket
            .iter()
            .filter_map(|e| {
                let mut row = db::get_row(&conn, e.id)?;
                row.cut = e.cut;
                Some(row)
            })
            .collect()
    } else {
        db::get_rows(&conn, &ids)
    }
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

/// Materializes an image clip to `%TEMP%\ClipNestDrops\clipnest_image_<id>_<ts>.png`.
fn materialize_image(conn: &rusqlite::Connection, id: i64, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let png = db::get_format_data(conn, id, "PNG").ok_or("image data not found")?;
    let file_path = dir.join(format!("clipnest-image-{id}-{}.png", db::now_ms()));
    std::fs::write(&file_path, &png).map_err(|e| e.to_string())?;
    Ok(file_path)
}

/// Batch "Paste All Here": materializes collected images in `%TEMP%\ClipNestDrops\`, builds a
/// single combined `CF_HDROP` with `Preferred DropEffect`, writes to the OS clipboard, and sends Ctrl+V.
pub fn basket_paste_here(app: &AppHandle) -> Result<usize, String> {
    let st = app.state::<AppState>();
    let allow_cut = st.settings.read().basket_allow_cut;
    let basket = st.queue.lock().basket.clone();
    if basket.is_empty() {
        return Ok(0);
    }
    let temp_drops = std::env::temp_dir().join("ClipNestDrops");
    let mut all_paths: Vec<String> = Vec::new();
    let mut any_cut = false;
    let mut has_temp_image = false;
    {
        let conn = st.db.lock();
        for entry in &basket {
            let Some((kind, plain)) = db::get_plain(&conn, entry.id) else {
                continue;
            };
            if kind == "file" {
                for line in plain.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                    if Path::new(line).exists() && !all_paths.iter().any(|p| p.eq_ignore_ascii_case(line)) {
                        all_paths.push(line.to_string());
                    }
                }
                if entry.cut && allow_cut {
                    any_cut = true;
                }
            } else if kind == "image" {
                if let Ok(p) = materialize_image(&conn, entry.id, &temp_drops) {
                    all_paths.push(p.to_string_lossy().to_string());
                    has_temp_image = true;
                }
            }
        }
    }
    if all_paths.is_empty() {
        return Err("No valid files or images found in Drop Basket".into());
    }
    let hdrop_bytes = build_hdrop(&all_paths);
    // DROPEFFECT_MOVE = 2, DROPEFFECT_COPY = 1. Use MOVE only when cut is requested and no temp images are mixed in, or when all items can be moved.
    let drop_effect: u32 = if any_cut && allow_cut && !has_temp_image { 2 } else { 1 };
    let pref_id = win::register_format("Preferred DropEffect");
    let mut clip_items = vec![(win::CF_HDROP_ID, "CF_HDROP".to_string(), hdrop_bytes)];
    if pref_id != 0 {
        clip_items.push((pref_id, "Preferred DropEffect".to_string(), drop_effect.to_le_bytes().to_vec()));
    }
    let seq = win::write_clipboard(&clip_items)?;
    st.self_seq.store(seq, Ordering::SeqCst);

    let fg = win::foreground();
    let target = if fg != 0 && !win::is_own_window(fg) {
        fg
    } else {
        st.target_hwnd.load(Ordering::SeqCst)
    };
    let count = all_paths.len();
    std::thread::spawn(move || {
        if target != 0 {
            win::focus_window(target);
            std::thread::sleep(Duration::from_millis(35));
        }
        win::send_paste_keys("ctrl+v");
    });
    if any_cut && allow_cut && !has_temp_image {
        st.queue.lock().basket.clear();
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
    let ext = Path::new(file_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
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

fn copy_file_verified(src: &Path, dst: &Path) -> Result<(), String> {
    let src_meta = std::fs::metadata(src).map_err(|e| format!("Cannot read {}: {e}", src.display()))?;
    let expected_len = src_meta.len();
    {
        let mut reader = std::fs::File::open(src).map_err(|e| format!("Cannot open {}: {e}", src.display()))?;
        let mut writer = std::fs::File::create(dst).map_err(|e| format!("Cannot create {}: {e}", dst.display()))?;
        std::io::copy(&mut reader, &mut writer).map_err(|e| format!("Copy failed for {}: {e}", src.display()))?;
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

fn copy_dir_verified(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("Cannot create directory {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Cannot read directory {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let sp = entry.path();
        let dp = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir_verified(&sp, &dp)?;
        } else if ft.is_file() {
            copy_file_verified(&sp, &dp)?;
        }
    }
    Ok(())
}

/// Batch "Paste All to Folder…": opens a native folder picker dialog and copies/moves all
/// collected files, directories, and browser images into that folder. Original files marked CUT
/// are deleted ONLY after the destination copy completes and its exact byte size is verified on disk.
pub fn basket_paste_to_folder(app: &AppHandle) -> Result<Option<usize>, String> {
    use tauri_plugin_dialog::DialogExt;
    let st = app.state::<AppState>();
    let allow_cut = st.settings.read().basket_allow_cut;
    let basket = st.queue.lock().basket.clone();
    if basket.is_empty() {
        return Ok(Some(0));
    }
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest_dir = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let mut transferred = 0usize;
    let mut completed_cut_ids: Vec<i64> = Vec::new();

    for entry in &basket {
        let item_data = {
            let conn = st.db.lock();
            db::get_plain(&conn, entry.id).map(|(k, p)| {
                let png = if k == "image" { db::get_format_data(&conn, entry.id, "PNG") } else { None };
                (k, p, png)
            })
        };
        let Some((kind, plain, png_opt)) = item_data else {
            continue;
        };
        if kind == "image" {
            let Some(png) = png_opt else {
                continue;
            };
            let fname = format!("clipnest-image-{}-{}.png", entry.id, db::now_ms());
            let dst = unique_dest_path(&dest_dir, &fname, None);
            {
                use std::io::Write;
                let mut f = std::fs::File::create(&dst).map_err(|e| e.to_string())?;
                f.write_all(&png).map_err(|e| e.to_string())?;
                f.sync_all().map_err(|e| e.to_string())?;
            }
            let meta = std::fs::metadata(&dst).map_err(|e| e.to_string())?;
            if meta.len() != png.len() as u64 {
                return Err(format!("Image verification failed for {}", dst.display()));
            }
            transferred += 1;
        } else if kind == "file" {
            let mut all_paths_ok = true;
            for line in plain.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                let src = PathBuf::from(line);
                if !src.exists() {
                    all_paths_ok = false;
                    continue;
                }
                let Some(fname) = src.file_name().map(|n| n.to_string_lossy().to_string()) else {
                    all_paths_ok = false;
                    continue;
                };
                let dst = unique_dest_path(&dest_dir, &fname, Some(&src));
                if same_canonical_path(&src, &dst) {
                    transferred += 1;
                    continue;
                }
                if src.is_dir() {
                    copy_dir_verified(&src, &dst)?;
                    if entry.cut && allow_cut {
                        std::fs::remove_dir_all(&src)
                            .map_err(|e| format!("Verified copy succeeded, but could not remove source folder {}: {e}", src.display()))?;
                    }
                    transferred += 1;
                } else if src.is_file() {
                    copy_file_verified(&src, &dst)?;
                    if entry.cut && allow_cut {
                        std::fs::remove_file(&src)
                            .map_err(|e| format!("Verified copy succeeded, but could not remove source file {}: {e}", src.display()))?;
                    }
                    transferred += 1;
                }
            }
            if entry.cut && allow_cut && all_paths_ok {
                completed_cut_ids.push(entry.id);
            }
        }
    }

    if !completed_cut_ids.is_empty() {
        let mut q = st.queue.lock();
        q.basket.retain(|e| !completed_cut_ids.contains(&e.id));
        drop(q);
        changed(app);
    }

    Ok(Some(transferred))
}

/// Called when the intercepted Ctrl+V is pressed.
pub fn on_paste_hotkey(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
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
            sync_intercept(&app);
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
        sync_intercept(&app);
    });
}
