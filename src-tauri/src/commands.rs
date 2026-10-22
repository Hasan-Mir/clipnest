//! Commands callable from the React UI.

use crate::capture::{build_text_clip, text_format};
use crate::db::{self, AppInfo, ClipRow, FormatMeta, Pinboard};
use crate::search::{self, ListArgs, ListResult};
use crate::state::{AppState, Settings};
use base64::Engine;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

fn changed(app: &AppHandle) {
    let _ = app.emit("items-changed", ());
}

fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ───────────── listing / reading ─────────────

#[tauri::command]
pub async fn list_items(state: State<'_, AppState>, args: ListArgs) -> Res<ListResult> {
    let conn = state.db.lock();
    Ok(search::list(&conn, &args))
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
    let seq = crate::platform::win::write_clipboard(&[(
        crate::platform::win::CF_UNICODETEXT_ID,
        "CF_UNICODETEXT".into(),
        crate::capture::utf16_bytes(&text),
    )])?;
    state.self_seq.store(seq, Ordering::SeqCst);
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
pub async fn set_pinboard(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, board: Option<i64>) -> Res<()> {
    db::set_pinboard(&state.db.lock(), &ids, board)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_pinned(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, pinned: bool) -> Res<()> {
    db::set_pinned(&state.db.lock(), &ids, pinned)?;
    changed(&app);
    Ok(())
}

fn store_text(app: &AppHandle, state: &AppState, text: &str) -> Res<i64> {
    if text.is_empty() {
        return Err("empty text".into());
    }
    let nc = build_text_clip(text, None, "ClipNest", "clipnest.exe", false);
    let (id, _) = db::insert_clip(&mut state.db.lock(), &nc, &[text_format(text)])?;
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
    let nc = build_text_clip(&text, None, "", "", false);
    let sens = state.settings.read().detect_sensitive
        && matches!(nc.kind.as_str(), "text" | "code")
        && crate::classify::is_sensitive(&text);
    {
        let mut conn = state.db.lock();
        let (kind, _) = db::get_plain(&conn, id).ok_or("item not found")?;
        if kind == "image" || kind == "file" {
            return Err("only text items can be edited".into());
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE clips SET hash=?1,kind=?2,plain=?3,preview=?4,search=?5,lang=?6,color=?7,chars=?8,has_rich=0,sensitive=?11,expires_at=CASE WHEN ?11=1 THEN expires_at ELSE NULL END,ts=?9,sort_ts=?9 WHERE id=?10",
            rusqlite::params![nc.hash, nc.kind, nc.plain, nc.preview, nc.search, nc.lang, nc.color, nc.chars, db::now_ms(), id, sens as i64],
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

// ───────────── pinboards ─────────────

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
    // chcp 65001: pipes carry UTF-8 (Persian text survives). /S /C "..." + raw_arg keeps the user's
    // own quotes intact (Rust's normal argument escaping uses \" which cmd.exe does not understand).
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
            // timed out: kill the whole process tree so nothing keeps running in the background
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
            let seq = crate::platform::win::write_clipboard(&[(
                crate::platform::win::CF_UNICODETEXT_ID,
                "CF_UNICODETEXT".into(),
                crate::capture::utf16_bytes(&out),
            )])?;
            state.self_seq.store(seq, Ordering::SeqCst);
            Ok(None)
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn run_action(app: AppHandle, id: i64, action: String) -> Res<Option<i64>> {
    exec_action(&app, id, &action)
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

#[tauri::command]
pub async fn reveal_item(state: State<'_, AppState>, id: i64) -> Res<()> {
    let (kind, target) = first_target(&state, id).ok_or("item not found")?;
    if kind == "file" {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{target}\""))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

#[tauri::command]
pub async fn basket_paste_here(app: AppHandle) -> Res<usize> {
    crate::queue::basket_paste_here(&app)
}

#[tauri::command]
pub async fn basket_paste_to_folder(app: AppHandle) -> Res<Option<usize>> {
    crate::queue::basket_paste_to_folder(&app)
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
pub async fn request_erase_from_tray(app: AppHandle) -> Res<()> {
    crate::windowing::hide_tray(&app);
    std::thread::spawn(move || {
        crate::windowing::show_popup(&app, Some("center"), true);
        std::thread::sleep(std::time::Duration::from_millis(350));
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
pub async fn erase_history(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    db::erase_history(&state.db.lock())?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>) -> Res<String> {
    let keep = state.settings.read().backup_keep;
    let p = db::backup(&state.db, &state.data_dir, keep)?;
    Ok(p.to_string_lossy().to_string())
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
pub async fn quit_app(app: AppHandle) -> Res<()> {
    app.exit(0);
    Ok(())
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

/// Export = a fresh compressed snapshot copied to a place of the user's choosing.
#[tauri::command]
pub async fn export_data(app: AppHandle, state: State<'_, AppState>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
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
    std::fs::copy(&snapshot, &dest).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Import = merge a backup/export into the current history (nothing is overwritten or deleted).
#[tauri::command]
pub async fn import_data(app: AppHandle, state: State<'_, AppState>) -> Res<Option<usize>> {
    use std::io::Read;
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("ClipNest backup", &["gz", "db"])
        .set_directory(state.data_dir.join("backups"))
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let bytes = if raw.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out).map_err(|e| e.to_string())?;
        out
    } else {
        raw
    };
    let tmp = state.data_dir.join("import.tmp.db");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let result = db::merge_from(&state.db.lock(), &tmp);
    let _ = std::fs::remove_file(&tmp);
    let n = result?;
    changed(&app);
    Ok(Some(n))
}

#[tauri::command]
pub async fn export_settings(app: AppHandle, state: State<'_, AppState>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let json = serde_json::to_string_pretty(&*state.settings.read()).map_err(|e| e.to_string())?;
    let dest =
        app.dialog().file().add_filter("JSON", &["json"]).set_file_name("clipnest-settings.json").blocking_save_file();
    let Some(dest) = dest else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&dest, json).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn import_settings(app: AppHandle) -> Res<bool> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file();
    let Some(picked) = picked else { return Ok(false) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let s: Settings = serde_json::from_str(&text).map_err(|e| format!("not a ClipNest settings file: {e}"))?;
    crate::apply_settings(&app, s);
    Ok(true)
}
