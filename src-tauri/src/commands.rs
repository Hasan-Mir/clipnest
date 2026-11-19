//! Commands callable from the React UI.

use crate::capture::{build_text_clip, text_format};
use crate::db::{self, AppInfo, ClipRow, FormatMeta, Pinboard};
use crate::search::{self, ListArgs, ListResult};
use crate::state::{AppState, Settings};
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

fn changed(app: &AppHandle) {
    let _ = app.emit("items-changed", ());
}

fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(Serialize, Clone, Debug)]
pub struct ShortcutConflict {
    pub status: String,
    pub message: String,
}

// ───────────── listing / reading ─────────────

#[tauri::command]
pub async fn list_items(state: State<'_, AppState>, args: ListArgs) -> Res<ListResult> {
    let indep = state.settings.read().independent_pinning;
    let conn = state.db.lock();
    Ok(search::list_scoped(&conn, &args, indep))
}

#[tauri::command]
pub async fn list_pinboards(state: State<'_, AppState>) -> Res<Vec<Pinboard>> {
    db::list_pinboards(&state.db.lock())
}

#[tauri::command]
pub async fn get_text(state: State<'_, AppState>, id: i64) -> Res<String> {
    Ok(db::get_plain(&state.db.lock(), id).map(|(_, p)| p).unwrap_or_default())
}

#[tauri::command]
pub async fn get_thumb(state: State<'_, AppState>, id: i64) -> Res<Option<String>> {
    Ok(db::get_thumb(&state.db.lock(), id).map(|b| data_url(&b)))
}

#[tauri::command]
pub async fn get_image(state: State<'_, AppState>, id: i64) -> Res<Option<String>> {
    Ok(db::get_format_data(&state.db.lock(), id, "PNG").map(|b| data_url(&b)))
}

#[tauri::command]
pub async fn get_formats(state: State<'_, AppState>, id: i64) -> Res<Vec<FormatMeta>> {
    Ok(db::get_format_metas(&state.db.lock(), id))
}

// ───────────── paste / copy ─────────────

#[tauri::command]
pub async fn paste_item(app: AppHandle, id: i64, mode: String) -> Res<()> {
    crate::paste::paste(&app, id, &mode)
}

#[tauri::command]
pub async fn copy_item(app: AppHandle, id: i64, mode: String) -> Res<()> {
    crate::paste::copy_only(&app, id, &mode)
}

/// Copies arbitrary text (e.g. a colour value) and marks it as our own write.
#[tauri::command]
pub async fn copy_text(state: State<'_, AppState>, text: String) -> Res<()> {
    state.write_clipboard_self(&[(
        crate::platform::win::CF_UNICODETEXT_ID,
        "CF_UNICODETEXT".into(),
        crate::capture::utf16_bytes(&text),
    )])?;
    Ok(())
}

// ───────────── editing ─────────────

#[tauri::command]
pub async fn delete_items(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> Res<()> {
    db::delete_ids(&mut state.db.lock(), &ids)?;
    for id in &ids {
        crate::queue::remove(&app, *id);
    }
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn rename_item(app: AppHandle, state: State<'_, AppState>, id: i64, title: String) -> Res<()> {
    db::rename(&state.db.lock(), id, &title)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_tags(app: AppHandle, state: State<'_, AppState>, id: i64, tags: String) -> Res<()> {
    db::set_tags(&state.db.lock(), id, &tags)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_pinboard(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    board: Option<i64>,
    source_board: Option<i64>,
    copy: Option<bool>,
) -> Res<()> {
    db::assign_category(&state.db.lock(), &ids, board, source_board, copy.unwrap_or(false))?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_pinned(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    pinned: bool,
    board: Option<i64>,
) -> Res<()> {
    let indep = state.settings.read().independent_pinning;
    db::set_pinned_scoped(&state.db.lock(), &ids, pinned, board, indep)?;
    changed(&app);
    Ok(())
}

pub fn store_text(app: &AppHandle, state: &AppState, text: &str) -> Res<i64> {
    if text.is_empty() {
        return Err("empty text".into());
    }
    let s = state.settings.read().clone();
    let mut nc = build_text_clip(text, None, "ClipNest", "clipnest.exe", false);
    if s.detect_sensitive && matches!(nc.kind.as_str(), "text" | "code") && crate::classify::is_sensitive(text) {
        if s.sensitive_action == "mask_delete" {
            nc.sensitive = true;
            nc.expires_at = Some(db::now_ms() + (s.sensitive_ttl_min.max(1) as i64) * 60_000);
        } else if s.sensitive_action != "skip" {
            nc.sensitive = true;
        }
    }
    let id = {
        let mut conn = state.db.lock();
        let (id, is_new) = db::insert_clip(&mut conn, &nc, &[text_format(text)])?;
        if is_new {
            if let Some(b) = s.active_pinboard {
                let _ = db::assign_category(&conn, &[id], Some(b), None, true);
            }
        }
        let _ = db::apply_limits(&conn, &s);
        id
    };
    changed(app);
    Ok(id)
}

#[tauri::command]
pub async fn create_text_item(app: AppHandle, state: State<'_, AppState>, text: String) -> Res<i64> {
    store_text(&app, &state, &text)
}

#[tauri::command]
pub async fn merge_items(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, sep: String) -> Res<i64> {
    let parts: Vec<String> = {
        let conn = state.db.lock();
        ids.iter().filter_map(|id| db::get_plain(&conn, *id)).filter(|(k, _)| k != "image").map(|(_, p)| p).collect()
    };
    store_text(&app, &state, &parts.join(&sep))
}

/// Inline editor: replaces the text of a text/code/link/color item (rich formats are dropped).
#[tauri::command]
pub async fn update_item_text(app: AppHandle, state: State<'_, AppState>, id: i64, text: String) -> Res<()> {
    if text.trim().is_empty() {
        return Err("text is empty".into());
    }
    {
        let mut conn = state.db.lock();
        let existing_row = db::get_row(&conn, id).ok_or("item not found")?;
        if existing_row.kind == "image" || existing_row.kind == "file" {
            return Err("only text items can be edited".into());
        }
        let nc = build_text_clip(&text, existing_row.lang.clone(), "", "", false);
        let s = state.settings.read().clone();
        let sens =
            s.detect_sensitive && matches!(nc.kind.as_str(), "text" | "code") && crate::classify::is_sensitive(&text);
        let now = db::now_ms();
        let next_expiry: Option<i64> = if sens && s.sensitive_action == "mask_delete" {
            Some(now + (s.sensitive_ttl_min.max(1) as i64) * 60_000)
        } else {
            None
        };
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE clips SET hash=?1,kind=?2,plain=?3,preview=?4,search=?5,lang=?6,color=?7,chars=?8,has_rich=0,sensitive=?11,expires_at=CASE WHEN ?11=1 THEN COALESCE(expires_at, ?12) ELSE NULL END,ts=?9,sort_ts=?9 WHERE id=?10",
            rusqlite::params![nc.hash, nc.kind, nc.plain, nc.preview, nc.search, nc.lang, nc.color, nc.chars, now, id, sens as i64, next_expiry],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "An item with identical content already exists".to_string()
            } else {
                e.to_string()
            }
        })?;
        tx.execute("DELETE FROM clip_formats WHERE clip_id=?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        let f = text_format(&text);
        tx.execute(
            "INSERT INTO clip_formats(clip_id,fmt_id,name,size,data) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![id, f.fmt_id, f.name, f.data.len() as i64, f.data],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    changed(&app);
    Ok(())
}

// ───────────── categories (pinboards) ─────────────

#[tauri::command]
pub async fn create_pinboard(app: AppHandle, state: State<'_, AppState>, name: String, color: String) -> Res<i64> {
    let id = db::create_pinboard(&state.db.lock(), &name, &color)?;
    changed(&app);
    Ok(id)
}

#[tauri::command]
pub async fn update_pinboard(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    name: String,
    color: String,
    max_items: i64,
    list_style: String,
    paste_mode: Option<String>,
) -> Res<()> {
    let pmode = paste_mode.unwrap_or_else(|| "inherit".into());
    db::update_pinboard(&state.db.lock(), id, &name, &color, max_items, &list_style, &pmode)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn delete_pinboard(app: AppHandle, state: State<'_, AppState>, id: i64) -> Res<()> {
    db::delete_pinboard(&state.db.lock(), id)?;
    let mut s = state.settings.read().clone();
    if s.active_pinboard == Some(id) {
        s.active_pinboard = None;
        crate::apply_settings(&app, s);
    }
    changed(&app);
    Ok(())
}

// ───────────── custom actions ─────────────

fn run_shell(cmd: &str, input: &str, timeout: std::time::Duration) -> Res<String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let line = format!("/S /C \"chcp 65001 >nul & {cmd}\"");
    let mut child = Command::new("cmd")
        .raw_arg(line)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.id();
    if let Some(mut si) = child.stdin.take() {
        let data = input.to_string();
        std::thread::spawn(move || {
            let _ = si.write_all(data.as_bytes());
        });
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => {
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            while s.ends_with('\n') || s.ends_with('\r') {
                s.pop();
            }
            if !out.status.success() && s.is_empty() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(s)
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .spawn();
            Err("action timed out".into())
        }
    }
}

/// Runs a custom action on an item (used by the item menu and by automatic rules).
pub fn exec_action(app: &AppHandle, id: i64, action: &str) -> Res<Option<i64>> {
    let state = app.state::<AppState>();
    let act = state.settings.read().actions.iter().find(|a| a.id == action).cloned().ok_or("action not found")?;
    let text = db::get_plain(&state.db.lock(), id).map(|(_, p)| p).unwrap_or_default();
    let out = run_shell(&act.command, &text, std::time::Duration::from_secs(20))?;
    match act.output.as_str() {
        "new_item" => Ok(Some(store_text(app, &state, &out)?)),
        "clipboard" => {
            state.write_clipboard_self(&[(
                crate::platform::win::CF_UNICODETEXT_ID,
                "CF_UNICODETEXT".into(),
                crate::capture::utf16_bytes(&out),
            )])?;
            Ok(None)
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn run_action(app: AppHandle, id: i64, action: String) -> Res<Option<i64>> {
    tauri::async_runtime::spawn_blocking(move || exec_action(&app, id, &action)).await.map_err(|e| e.to_string())?
}

// ───────────── open / reveal ─────────────

fn first_target(state: &AppState, id: i64) -> Option<(String, String)> {
    db::get_plain(&state.db.lock(), id).map(|(k, p)| (k, p.lines().next().unwrap_or("").trim().to_string()))
}

#[tauri::command]
pub async fn open_item(state: State<'_, AppState>, id: i64) -> Res<()> {
    let (kind, target) = first_target(&state, id).ok_or("item not found")?;
    if kind == "link" || kind == "file" {
        std::process::Command::new("explorer").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Opens Windows File Explorer and selects ALL files belonging to the target item(s)
/// using `SHOpenFolderAndSelectItems` so multi-file cards and multi-selected file cards
/// highlight every file in the destination folder.
#[tauri::command]
pub async fn reveal_item(state: State<'_, AppState>, id: i64, ids: Option<Vec<i64>>) -> Res<()> {
    let target_ids = match ids {
        Some(list) if !list.is_empty() => list,
        _ => vec![id],
    };
    let mut paths: Vec<String> = Vec::new();
    {
        let conn = state.db.lock();
        for tid in target_ids {
            if let Some((kind, plain)) = db::get_plain(&conn, tid) {
                if kind == "file" {
                    for line in plain.lines() {
                        let p = line.trim();
                        if !p.is_empty() {
                            paths.push(p.to_string());
                        }
                    }
                }
            }
        }
    }
    if paths.is_empty() {
        return Err("item not found".into());
    }
    crate::platform::win::reveal_files_in_explorer(&paths)
}

// ───────────── settings / status / app ─────────────

#[derive(Serialize)]
pub struct Status {
    pub paused_until: i64,
    pub plain_default: bool,
    pub queue_active: bool,
    pub queue_mode: String,
    pub queue_len: usize,
    pub popup_pinned: bool,
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Res<Settings> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: Settings) -> Res<()> {
    crate::apply_settings(&app, settings);
    Ok(())
}

#[tauri::command]
pub async fn app_status(state: State<'_, AppState>) -> Res<Status> {
    let q = state.queue.lock();
    let len = if q.mode == "basket" { q.basket.len() } else { q.items.len() };
    Ok(Status {
        paused_until: if state.is_paused() { state.paused_until.load(Ordering::SeqCst) } else { 0 },
        plain_default: state.settings.read().default_mode == "plain",
        queue_active: q.active,
        queue_mode: q.mode.clone(),
        queue_len: len,
        popup_pinned: state.popup_pinned.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub async fn set_popup_pinned(app: AppHandle, state: State<'_, AppState>, pinned: bool) -> Res<bool> {
    state.popup_pinned.store(pinned, Ordering::SeqCst);
    let _ = app.emit("status-changed", ());
    Ok(pinned)
}

#[tauri::command]
pub async fn pause_capture(app: AppHandle, minutes: Option<u32>) -> Res<()> {
    crate::set_pause(&app, minutes);
    Ok(())
}

#[tauri::command]
pub async fn resume_capture(app: AppHandle) -> Res<()> {
    crate::resume(&app);
    Ok(())
}

#[tauri::command]
pub async fn toggle_plain_mode(app: AppHandle) -> Res<()> {
    crate::toggle_plain(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_toggle(app: AppHandle) -> Res<()> {
    crate::queue::toggle(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_set_mode(app: AppHandle, mode: String) -> Res<()> {
    crate::queue::set_mode(&app, &mode);
    Ok(())
}

#[tauri::command]
pub async fn queue_get(state: State<'_, AppState>) -> Res<Vec<ClipRow>> {
    Ok(crate::queue::get_items(&state))
}

#[tauri::command]
pub async fn queue_remove(app: AppHandle, id: i64) -> Res<()> {
    crate::queue::remove(&app, id);
    Ok(())
}

#[tauri::command]
pub async fn queue_clear(app: AppHandle) -> Res<()> {
    crate::queue::clear(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_set_fifo(app: AppHandle, fifo: bool) -> Res<()> {
    let mut s = app.state::<AppState>().settings.read().clone();
    s.queue_fifo = fifo;
    crate::apply_settings(&app, s);
    Ok(())
}

#[tauri::command]
pub async fn basket_toggle_cut(app: AppHandle, id: i64) -> Res<()> {
    crate::queue::toggle_cut(&app, id);
    Ok(())
}

/// Every file / folder / image of the Drop Basket as its own row (grouping is done by the UI).
#[tauri::command]
pub async fn basket_get(state: State<'_, AppState>) -> Res<Vec<crate::queue::BasketRow>> {
    Ok(crate::queue::get_basket_rows(&state))
}

#[tauri::command]
pub async fn basket_transfer_status(state: State<'_, AppState>) -> Res<crate::queue::TransferStatus> {
    Ok(crate::queue::get_transfer_status(&state))
}

#[tauri::command]
pub async fn basket_remove_keys(app: AppHandle, keys: Vec<String>) -> Res<()> {
    crate::queue::remove_keys(&app, &keys);
    Ok(())
}

#[tauri::command]
pub async fn basket_set_cut(app: AppHandle, keys: Vec<String>, cut: bool) -> Res<()> {
    crate::queue::set_cut(&app, &keys, cut);
    Ok(())
}

/// The icon Windows Explorer shows for a path (file-type icon, folder icon, …) as a PNG data URL.
#[tauri::command]
pub async fn basket_file_icon(path: String) -> Res<Option<String>> {
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (w, h, rgba) = crate::platform::win::extract_shell_icon_rgba(&path, 48)?;
        let img = image::RgbaImage::from_raw(w, h, rgba)?;
        let png = crate::capture::encode_png(&image::DynamicImage::ImageRgba8(img))?;
        Some(data_url(&png))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res)
}

/// "Open file location": selects the files/folders in Windows Explorer. Items that no longer exist fall
/// back to opening their closest existing parent folder.
#[tauri::command]
pub async fn reveal_paths(paths: Vec<String>) -> Res<()> {
    let existing: Vec<String> =
        paths.iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty() && Path::new(p).exists()).collect();
    if !existing.is_empty() {
        return crate::platform::win::reveal_files_in_explorer(&existing);
    }
    for raw in &paths {
        let mut cur = Path::new(raw.trim()).parent();
        while let Some(dir) = cur {
            if dir.exists() {
                let _ = std::process::Command::new("explorer").arg(dir).spawn();
                return Ok(());
            }
            cur = dir.parent();
        }
    }
    Err("The location no longer exists".into())
}

/// The queue webview calls this once it has rendered, so the window can be shown without a black flash.
#[tauri::command]
pub async fn queue_ready(app: AppHandle) -> Res<()> {
    crate::windowing::queue_frontend_ready(&app);
    Ok(())
}

#[tauri::command]
pub async fn basket_paste_here(app: AppHandle) -> Res<usize> {
    tauri::async_runtime::spawn_blocking(move || crate::queue::basket_paste_here(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn basket_paste_to_folder(app: AppHandle) -> Res<Option<usize>> {
    tauri::async_runtime::spawn_blocking(move || crate::queue::basket_paste_to_folder(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn show_popup_cmd(app: AppHandle) -> Res<()> {
    crate::windowing::hide_tray(&app);
    crate::windowing::spawn_show_popup(app, Some("center".into()), true);
    Ok(())
}

#[tauri::command]
pub async fn hide_popup(app: AppHandle) -> Res<()> {
    crate::windowing::hide_popup(&app);
    Ok(())
}

#[tauri::command]
pub async fn hide_tray(app: AppHandle) -> Res<()> {
    crate::windowing::hide_tray(&app);
    Ok(())
}

#[tauri::command]
pub async fn resize_tray(app: AppHandle, height: u32) -> Res<()> {
    crate::windowing::resize_tray(&app, height);
    Ok(())
}

#[tauri::command]
pub async fn request_erase_from_tray(app: AppHandle) -> Res<()> {
    crate::windowing::hide_tray(&app);
    std::thread::spawn(move || {
        crate::windowing::show_popup(&app, Some("center"), true);
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = app.emit("erase-request", ());
    });
    Ok(())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Res<()> {
    crate::windowing::open_settings(&app);
    Ok(())
}

#[tauri::command]
pub async fn erase_history(
    app: AppHandle,
    state: State<'_, AppState>,
    include_pinned: Option<bool>,
    pinboard: Option<i64>,
    all_pinboards: Option<bool>,
) -> Res<usize> {
    let inc = include_pinned.unwrap_or(false);
    let all_boards = all_pinboards.unwrap_or(false);
    let target_board = if all_boards { None } else { pinboard };
    let deleted = db::erase_history(&state.db.lock(), inc, target_board, all_boards)?;
    {
        let mut q = state.queue.lock();
        if inc && all_boards {
            q.items.clear();
            q.basket.clear();
        } else {
            let conn = state.db.lock();
            q.items.retain(|&id| db::get_row(&conn, id).is_some());
            q.basket.retain(|e| db::get_row(&conn, e.id).is_some());
        }
    }
    crate::queue::sync_intercept(&app);
    let _ = app.emit("queue-changed", ());
    let _ = app.emit("status-changed", ());
    changed(&app);
    Ok(deleted)
}

#[tauri::command]
pub async fn backup_now(app: AppHandle) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let keep = state.settings.read().backup_keep;
        let p = db::backup(&state.db, &state.data_dir, keep)?;
        Ok(p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_data_dir(state: State<'_, AppState>) -> Res<()> {
    std::process::Command::new("explorer").arg(&state.data_dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn recent_apps(state: State<'_, AppState>) -> Res<Vec<AppInfo>> {
    Ok(db::recent_apps(&state.db.lock()))
}

#[tauri::command]
pub async fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    crate::cli::remove_endpoint_file(&state.data_dir);
    app.exit(0);
    Ok(())
}

// ───────────── system fonts, shortcut conflict check, Explorer integration ─────────────

#[tauri::command]
pub async fn list_system_fonts() -> Res<Vec<String>> {
    Ok(crate::platform::win::list_system_fonts())
}

#[tauri::command]
pub async fn check_shortcut_conflict(
    state: State<'_, AppState>,
    shortcut: String,
    role: String,
) -> Res<ShortcutConflict> {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return Ok(ShortcutConflict { status: "ok".into(), message: String::new() });
    }
    let Some((mods, vk)) = crate::platform::win::parse_shortcut(trimmed) else {
        return Ok(ShortcutConflict { status: "invalid".into(), message: "Invalid shortcut combination".into() });
    };

    // 1. Check against other ClipNest shortcuts
    let s = state.settings.read().clone();
    let app_shortcuts = [
        ("open", &s.shortcut_open, "Open ClipNest"),
        ("queue", &s.shortcut_queue, "Paste queue on/off"),
        ("plain", &s.shortcut_plain_toggle, "Toggle plain-text mode"),
        ("pause", &s.shortcut_pause, "Pause / resume capture"),
    ];
    for (r, val, label) in app_shortcuts {
        if r != role && !val.trim().is_empty() {
            if let Some((om, ovk)) = crate::platform::win::parse_shortcut(val) {
                if om == mods && ovk == vk {
                    return Ok(ShortcutConflict {
                        status: "conflict_app".into(),
                        message: format!("Conflicts with ClipNest shortcut: {label}"),
                    });
                }
            }
        }
    }

    // 2. Check standard editing and system shortcuts
    let m_ctrl = (mods & crate::platform::win::MOD_CTRL) != 0;
    let m_alt = (mods & crate::platform::win::MOD_ALT) != 0;
    let m_shift = (mods & crate::platform::win::MOD_SHIFT) != 0;
    let m_win = (mods & crate::platform::win::MOD_WIN) != 0;

    if m_ctrl && !m_alt && !m_shift && !m_win {
        let standard = match vk {
            0x43 => Some("Ctrl+C (Copy)"),
            0x56 => Some("Ctrl+V (Paste)"),
            0x58 => Some("Ctrl+X (Cut)"),
            0x5A => Some("Ctrl+Z (Undo)"),
            0x59 => Some("Ctrl+Y (Redo)"),
            0x41 => Some("Ctrl+A (Select All)"),
            0x53 => Some("Ctrl+S (Save)"),
            0x46 => Some("Ctrl+F (Find)"),
            0x50 => Some("Ctrl+P (Print)"),
            0x57 => Some("Ctrl+W (Close Tab)"),
            0x54 => Some("Ctrl+T (New Tab)"),
            0x4E => Some("Ctrl+N (New Window)"),
            _ => None,
        };
        if let Some(desc) = standard {
            return Ok(ShortcutConflict {
                status: "conflict_os".into(),
                message: format!("Conflicts with standard editing shortcut: {desc}"),
            });
        }
    }

    if m_alt && !m_ctrl && !m_shift && !m_win && (vk == 0x09 || vk == 0x73) {
        return Ok(ShortcutConflict {
            status: "conflict_os".into(),
            message: "Conflicts with Windows system shortcut (Alt+Tab / Alt+F4)".into(),
        });
    }

    if m_win {
        if !m_ctrl && !m_alt && !m_shift && vk == 0x56 {
            return Ok(ShortcutConflict {
                status: "hook_override".into(),
                message: "Overrides Windows Clipboard History (Win+V) via low-level keyboard hook".into(),
            });
        }
        let win_reserved = match (m_ctrl, m_alt, m_shift, vk) {
            (false, false, false, 0x4C) => Some("Win+L (Lock PC — enforced by Windows kernel)"),
            (false, false, false, 0x44) => Some("Win+D (Show Desktop)"),
            (false, false, false, 0x45) => Some("Win+E (File Explorer)"),
            (false, false, false, 0x52) => Some("Win+R (Run Dialog)"),
            (false, false, false, 0x49) => Some("Win+I (Windows Settings)"),
            (false, false, false, 0x58) => Some("Win+X (Power User Menu)"),
            (false, false, false, 0x53) => Some("Win+S (Windows Search)"),
            (false, false, false, 0x09) => Some("Win+Tab (Task View)"),
            (false, false, false, 0x50) => Some("Win+P (Project Display)"),
            (false, false, false, 0x41) => Some("Win+A (Quick Settings)"),
            (false, false, false, 0x4E) => Some("Win+N (Notification Center)"),
            (false, false, false, 0x47) => Some("Win+G (Xbox Game Bar)"),
            (false, false, false, 0x20) => Some("Win+Space (Input Language)"),
            (false, false, true, 0x53) => Some("Win+Shift+S (Snipping Tool)"),
            _ => None,
        };
        if let Some(desc) = win_reserved {
            return Ok(ShortcutConflict {
                status: "conflict_os".into(),
                message: format!("Conflicts with Windows shortcut: {desc}"),
            });
        }
        return Ok(ShortcutConflict {
            status: "ok".into(),
            message: "Available (captured via low-level keyboard hook)".into(),
        });
    }

    // 3. Check if already registered by this exact role in our own process
    let current_val = match role.as_str() {
        "open" => &s.shortcut_open,
        "queue" => &s.shortcut_queue,
        "plain" => &s.shortcut_plain_toggle,
        "pause" => &s.shortcut_pause,
        _ => "",
    };
    if let Some((cm, cvk)) = crate::platform::win::parse_shortcut(current_val) {
        if cm == mods && cvk == vk {
            return Ok(ShortcutConflict { status: "ok".into(), message: "Active and available".into() });
        }
    }

    // 4. Probe Windows RegisterHotKey to detect if another app has claimed it
    match crate::platform::win::probe_hotkey_available(trimmed) {
        Ok(true) => Ok(ShortcutConflict { status: "ok".into(), message: "Available (no conflict in Windows)".into() }),
        Ok(false) => Ok(ShortcutConflict {
            status: "conflict_os".into(),
            message: "Already registered by another running application or Windows".into(),
        }),
        Err(e) => Ok(ShortcutConflict { status: "invalid".into(), message: e }),
    }
}

#[tauri::command]
pub async fn get_explorer_target(state: State<'_, AppState>) -> Res<Option<String>> {
    Ok(state.explorer_target_dir.lock().clone())
}

#[tauri::command]
pub async fn clear_explorer_target(state: State<'_, AppState>) -> Res<()> {
    *state.explorer_target_dir.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn paste_files_to_folder(app: AppHandle, ids: Vec<i64>, folder: String) -> Res<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = Path::new(folder.trim());
        crate::queue::paste_clips_to_dir(&app, &ids, dest)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────── rich display, icons, ordering ─────────────

/// The original HTML of a clip (for showing it exactly as it was copied).
#[tauri::command]
pub async fn get_html(state: State<'_, AppState>, id: i64) -> Res<Option<String>> {
    let data = db::get_format_data(&state.db.lock(), id, "HTML Format");
    Ok(data.and_then(|d| crate::capture::extract_cf_html(&d)))
}

#[tauri::command]
pub async fn get_app_icon(state: State<'_, AppState>, exe: String) -> Res<Option<String>> {
    Ok(db::get_icon(&state.db.lock(), &exe).map(|b| data_url(&b)))
}

#[tauri::command]
pub async fn move_item(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    target: i64,
    after: bool,
    scope: Option<i64>,
) -> Res<()> {
    db::move_item(&state.db.lock(), id, target, after, scope)?;
    changed(&app);
    Ok(())
}

// ───────────── import / export ─────────────

/// Export = a fresh compressed snapshot copied crash-safely to a place of the user's choosing.
#[tauri::command]
pub async fn export_data(app: AppHandle) -> Res<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let state = app.state::<AppState>();
        let keep = state.settings.read().backup_keep;
        let snapshot = db::backup(&state.db, &state.data_dir, keep)?;
        let dest = app
            .dialog()
            .file()
            .add_filter("ClipNest backup", &["gz"])
            .set_file_name(format!("clipnest-{}.db.gz", db::today_string()))
            .blocking_save_file();
        let Some(dest) = dest else { return Ok(None) };
        let dest = dest.into_path().map_err(|e| e.to_string())?;
        let tmp_dest = PathBuf::from(format!("{}.tmp", dest.to_string_lossy()));
        std::fs::copy(&snapshot, &tmp_dest).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_dest, &dest).map_err(|e| e.to_string())?;
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import = merge a backup/export into the current history (nothing is overwritten or deleted).
#[tauri::command]
pub async fn import_data(app: AppHandle) -> Res<Option<usize>> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let state = app.state::<AppState>();
        let picked = app
            .dialog()
            .file()
            .add_filter("ClipNest backup", &["gz", "db"])
            .set_directory(state.data_dir.join("backups"))
            .blocking_pick_file();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let tmp = clipnest_core::ipc::prepare_import_db_temp(&path, &state.data_dir)?;
        let result = db::merge_from(&state.db.lock(), &tmp);
        let _ = std::fs::remove_file(&tmp);
        let n = result?;
        changed(&app);
        Ok(Some(n))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_settings(app: AppHandle) -> Res<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let state = app.state::<AppState>();
        let json = serde_json::to_string_pretty(&*state.settings.read()).map_err(|e| e.to_string())?;
        let dest = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name("clipnest-settings.json")
            .blocking_save_file();
        let Some(dest) = dest else { return Ok(None) };
        let dest = dest.into_path().map_err(|e| e.to_string())?;
        db::write_atomic(&dest, json.as_bytes()).map_err(|e| e.to_string())?;
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_settings(app: AppHandle) -> Res<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file();
        let Some(picked) = picked else { return Ok(false) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let s: Settings = serde_json::from_str(&text).map_err(|e| format!("not a ClipNest settings file: {e}"))?;
        crate::apply_settings(&app, s);
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
