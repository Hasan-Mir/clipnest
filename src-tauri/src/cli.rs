//! ClipNest CLI & Local IPC Server/Client (`clipnest` & `clipn`).
//!
//! Provides a command-first, pipeline-friendly CLI inspired by CopyQ, sharing 100% of business
//! logic with the Tauri desktop app via an authenticated local IPC server (`127.0.0.1` + token
//! in `<data_dir>/cli-rpc.json`) with seamless offline SQLite fallback when the GUI is closed.

use crate::capture::{build_text_clip, text_format, utf16_bytes};
use crate::classify;
use crate::db::{self, ClipRow, Pinboard};
use crate::platform::win;
use crate::rules;
use crate::search::{self, ListArgs};
use crate::state::{AppState, AutoRule, BasketEntry, CustomAction, Settings};
use crate::transforms::{self, TRANSFORM_LIST};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const PROTOCOL_VERSION: u32 = 1;
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_STDIN_BYTES: usize = 64 * 1024 * 1024; // 64 MB

pub const EXIT_OK: i32 = 0;
pub const EXIT_ERROR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_NOT_FOUND: i32 = 3;
pub const EXIT_OFFLINE: i32 = 4;
pub const EXIT_PARTIAL: i32 = 5;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IpcEndpoint {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
    pub port: u16,
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IpcRequest {
    pub protocol: u32,
    pub version: String,
    pub token: String,
    pub op: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IpcResponse {
    pub ok: bool,
    pub exit_code: i32,
    #[serde(default)]
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl IpcResponse {
    pub fn success(data: Value) -> Self {
        IpcResponse { ok: true, exit_code: EXIT_OK, data, error: None, hint: None }
    }

    pub fn fail(exit_code: i32, msg: impl Into<String>, hint: Option<String>) -> Self {
        IpcResponse { ok: false, exit_code, data: Value::Null, error: Some(msg.into()), hint }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct JsonExportBundle {
    pub app: String,
    pub version: String,
    pub exported_at: i64,
    pub pinboards: Vec<Pinboard>,
    pub items: Vec<JsonExportItem>,
    pub settings: Settings,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct JsonExportItem {
    pub id: i64,
    pub kind: String,
    pub plain: String,
    pub title: Option<String>,
    pub tags: String,
    pub app_name: String,
    pub app_exe: String,
    pub lang: Option<String>,
    pub color: Option<String>,
    pub pinboard_id: Option<i64>,
    pub pinned: bool,
    pub sensitive: bool,
    pub ts: i64,
    pub created_at: i64,
}

pub fn resolve_cli_data_dir(explicit: Option<&str>) -> PathBuf {
    if let Some(p) = explicit {
        let pb = PathBuf::from(p);
        let _ = std::fs::create_dir_all(&pb);
        return pb;
    }
    if let Ok(env_dir) = std::env::var("CLIPNEST_DATA_DIR") {
        if !env_dir.trim().is_empty() {
            let pb = PathBuf::from(env_dir.trim());
            let _ = std::fs::create_dir_all(&pb);
            return pb;
        }
    }
    let args: Vec<String> = std::env::args().collect();
    let flag_portable = args.iter().any(|a| a.eq_ignore_ascii_case("--portable"));
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_name = exe_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if let Some(exe_dir) = exe_path.parent() {
            for candidate_dir in [Some(exe_dir), exe_dir.parent()].into_iter().flatten() {
                let marker = candidate_dir.join("portable.txt").exists()
                    || candidate_dir.join(".portable").exists()
                    || candidate_dir.join("portable_data").exists()
                    || exe_name.contains("portable");
                if flag_portable || marker {
                    let pdir = if candidate_dir.join("portable_data").exists() {
                        candidate_dir.join("portable_data")
                    } else {
                        candidate_dir.join("data")
                    };
                    if std::fs::create_dir_all(&pdir).is_ok() {
                        return pdir;
                    }
                }
            }
        }
    }
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("com.clipnest.app");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn endpoint_file(data_dir: &Path) -> PathBuf {
    data_dir.join("cli-rpc.json")
}

pub fn remove_endpoint_file(data_dir: &Path) {
    let _ = std::fs::remove_file(endpoint_file(data_dir));
}

pub fn spawn_ipc_server(app: AppHandle) {
    let data_dir = app.state::<AppState>().data_dir.clone();
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("clipnest: could not bind local CLI IPC server: {e}");
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(_) => return,
        };
        let pid = std::process::id();
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"clipnest-ipc-token-v1:");
        hasher.update(&db::now_ms().to_le_bytes());
        hasher.update(&pid.to_le_bytes());
        hasher.update(&port.to_le_bytes());
        let token = hasher.finalize().to_hex().to_string();

        let ep = IpcEndpoint {
            protocol: PROTOCOL_VERSION,
            version: APP_VERSION.to_string(),
            pid,
            port,
            token: token.clone(),
        };
        if let Ok(json_bytes) = serde_json::to_vec_pretty(&ep) {
            let _ = db::write_atomic(&endpoint_file(&data_dir), &json_bytes);
        }

        for incoming in listener.incoming() {
            let Ok(stream) = incoming else {
                continue;
            };
            let app_clone = app.clone();
            let expected_token = token.clone();
            std::thread::spawn(move || {
                handle_ipc_client(stream, &app_clone, &expected_token);
            });
        }
    });
}

fn handle_ipc_client(mut stream: TcpStream, app: &AppHandle, expected_token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

    let mut line = String::new();
    {
        let reader = BufReader::new(&stream);
        let mut limited = reader.take((MAX_STDIN_BYTES as u64) + 1024 * 1024);
        if limited.read_line(&mut line).is_err() || line.trim().is_empty() {
            return;
        }
    }

    let resp = match serde_json::from_str::<IpcRequest>(&line) {
        Ok(req) => {
            if req.token != expected_token {
                IpcResponse::fail(EXIT_OFFLINE, "IPC authentication failed (invalid token)", None)
            } else if req.protocol != PROTOCOL_VERSION {
                IpcResponse::fail(
                    EXIT_OFFLINE,
                    format!(
                        "CLI protocol version mismatch: CLI uses protocol v{}, but ClipNest desktop app (v{}) uses protocol v{}",
                        req.protocol, APP_VERSION, PROTOCOL_VERSION
                    ),
                    Some("Update both ClipNest desktop and clipnest CLI to matching versions.".into()),
                )
            } else {
                dispatch_online(app, &req.op, &req.params)
            }
        }
        Err(e) => IpcResponse::fail(EXIT_USAGE, format!("Malformed IPC request: {e}"), None),
    };

    if let Ok(mut out) = serde_json::to_vec(&resp) {
        out.push(b'\n');
        let _ = stream.write_all(&out);
        let _ = stream.flush();
    }
}

fn resolve_board_id(conn: &Connection, spec: &Value) -> Result<Option<i64>, String> {
    if spec.is_null() {
        return Ok(None);
    }
    if let Some(n) = spec.as_i64() {
        if n <= 0 {
            return Ok(None);
        }
        let boards = db::list_pinboards(conn)?;
        if boards.iter().any(|b| b.id == n) {
            return Ok(Some(n));
        }
        return Err(format!("category (pinboard) #{n} not found"));
    }
    if let Some(s) = spec.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("main")
            || trimmed.eq_ignore_ascii_case("none")
            || trimmed == "0"
        {
            return Ok(None);
        }
        if let Ok(id) = trimmed.parse::<i64>() {
            let boards = db::list_pinboards(conn)?;
            if boards.iter().any(|b| b.id == id) {
                return Ok(Some(id));
            }
        }
        let boards = db::list_pinboards(conn)?;
        if let Some(found) = boards.iter().find(|b| b.name.eq_ignore_ascii_case(trimmed)) {
            return Ok(Some(found.id));
        }
        return Err(format!("category (pinboard) '{trimmed}' not found"));
    }
    Ok(None)
}

fn resolve_item_id(conn: &Connection, spec: &Value) -> Result<i64, String> {
    if let Some(id) = spec.as_i64() {
        return Ok(id);
    }
    if let Some(s) = spec.as_str() {
        let t = s.trim();
        if t.eq_ignore_ascii_case("latest") || t.eq_ignore_ascii_case("last") || t == "@0" || t == "0" {
            let latest: Option<i64> = conn
                .query_row("SELECT id FROM clips ORDER BY pinned DESC, sort_ts DESC LIMIT 1", [], |r| r.get(0))
                .ok();
            return latest.ok_or_else(|| "history is empty".to_string());
        }
        if let Some(idx_str) = t.strip_prefix('@') {
            if let Ok(offset) = idx_str.parse::<usize>() {
                let id: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM clips ORDER BY pinned DESC, sort_ts DESC LIMIT 1 OFFSET ?1",
                        params![offset as i64],
                        |r| r.get(0),
                    )
                    .ok();
                return id.ok_or_else(|| format!("no item at index @{offset}"));
            }
        }
        if let Ok(id) = t.parse::<i64>() {
            return Ok(id);
        }
        return Err(format!("invalid item ID '{t}' (expected a numeric ID or @0 / latest)"));
    }
    Err("missing item ID".into())
}

fn add_item_shared(
    conn: &mut Connection,
    settings: &Settings,
    text: &str,
    board_spec: &Value,
    pinned: bool,
    tags: Option<&str>,
    title: Option<&str>,
) -> Result<(ClipRow, bool), String> {
    if text.is_empty() {
        return Err("cannot add empty text to history".into());
    }
    let mut clip = build_text_clip(text, None, "ClipNest CLI", "clipnest.exe", false);
    if settings.detect_sensitive && matches!(clip.kind.as_str(), "text" | "code") && classify::is_sensitive(text) {
        match settings.sensitive_action.as_str() {
            "skip" => return Err("skipped by sensitive data policy (sensitive_action = skip)".into()),
            "mask_delete" => {
                clip.sensitive = true;
                clip.expires_at = Some(db::now_ms() + (settings.sensitive_ttl_min.max(1) as i64) * 60_000);
            }
            _ => clip.sensitive = true,
        }
    }
    let mut fmts = vec![text_format(text)];
    let outcome = rules::apply(&settings.rules, &mut clip, &mut fmts);
    if outcome.ignore {
        return Err("ignored by automatic rule".into());
    }

    let explicit_board = if board_spec.is_null() { None } else { resolve_board_id(conn, board_spec)? };
    let (id, is_new) = db::insert_clip(conn, &clip, &fmts)?;
    let target_board = explicit_board.or(outcome.board).or(if is_new { settings.active_pinboard } else { None });
    if let Some(b) = target_board {
        db::assign_category(conn, &[id], Some(b), None, false)?;
    }
    if pinned {
        db::set_pinned_scoped(conn, &[id], true, target_board, false)?;
    }
    if let Some(t) = title {
        if !t.is_empty() {
            db::rename(conn, id, t)?;
        }
    }
    let mut combined_tags = outcome.tags;
    if let Some(t) = tags {
        for part in t.split(|c: char| c == ',' || c.is_whitespace()).filter(|x| !x.is_empty()) {
            combined_tags.push(part.trim_start_matches('#').to_string());
        }
    }
    if !combined_tags.is_empty() {
        db::set_tags(conn, id, &combined_tags.join(" "))?;
    }
    let _ = db::apply_limits(conn, settings);
    let row = db::get_row(conn, id).ok_or("failed to load created item")?;
    Ok((row, is_new))
}

fn edit_item_shared(
    conn: &mut Connection,
    settings: &Settings,
    id: i64,
    new_text: Option<&str>,
    title: Option<&str>,
    tags: Option<&str>,
) -> Result<ClipRow, String> {
    let existing = db::get_row(conn, id).ok_or_else(|| format!("item #{id} not found"))?;
    if let Some(text) = new_text {
        if text.trim().is_empty() {
            return Err("text cannot be empty".into());
        }
        if existing.kind == "image" || existing.kind == "file" {
            return Err("only text, code, link, or color items can have their text edited".into());
        }
        let nc = build_text_clip(text, existing.lang.clone(), &existing.app_name, &existing.app_exe, false);
        let sens =
            settings.detect_sensitive && matches!(nc.kind.as_str(), "text" | "code") && classify::is_sensitive(text);
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE clips SET hash=?1,kind=?2,plain=?3,preview=?4,search=?5,lang=?6,color=?7,chars=?8,has_rich=0,sensitive=?11,expires_at=CASE WHEN ?11=1 THEN expires_at ELSE NULL END,ts=?9,sort_ts=?9 WHERE id=?10",
            params![
                nc.hash,
                nc.kind,
                nc.plain,
                nc.preview,
                nc.search,
                nc.lang,
                nc.color,
                nc.chars,
                db::now_ms(),
                id,
                sens as i64
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "An item with identical content already exists".to_string()
            } else {
                e.to_string()
            }
        })?;
        tx.execute("DELETE FROM clip_formats WHERE clip_id=?1", params![id]).map_err(|e| e.to_string())?;
        let f = text_format(text);
        tx.execute(
            "INSERT INTO clip_formats(clip_id,fmt_id,name,size,data) VALUES(?1,?2,?3,?4,?5)",
            params![id, f.fmt_id, f.name, f.data.len() as i64, f.data],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    if let Some(t) = title {
        db::rename(conn, id, t)?;
    }
    if let Some(tg) = tags {
        db::set_tags(conn, id, tg)?;
    }
    db::get_row(conn, id).ok_or_else(|| format!("item #{id} not found"))
}

fn export_json_bundle(conn: &Connection, settings: &Settings, dest: &Path) -> Result<usize, String> {
    let boards = db::list_pinboards(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,kind,plain,title,tags,app_name,app_exe,lang,color,pinboard_id,pinned,sensitive,ts,created_at
             FROM clips ORDER BY pinned DESC, sort_ts DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(JsonExportItem {
                id: r.get(0)?,
                kind: r.get(1)?,
                plain: r.get(2)?,
                title: r.get(3)?,
                tags: r.get(4)?,
                app_name: r.get(5)?,
                app_exe: r.get(6)?,
                lang: r.get(7)?,
                color: r.get(8)?,
                pinboard_id: r.get(9)?,
                pinned: r.get::<_, i64>(10)? != 0,
                sensitive: r.get::<_, i64>(11)? != 0,
                ts: r.get(12)?,
                created_at: r.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<JsonExportItem> = rows.filter_map(|r| r.ok()).collect();
    let count = items.len();
    let bundle = JsonExportBundle {
        app: "ClipNest".into(),
        version: APP_VERSION.into(),
        exported_at: db::now_ms(),
        pinboards: boards,
        items,
        settings: settings.clone(),
    };
    let json_bytes = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    db::write_atomic(dest, &json_bytes).map_err(|e| e.to_string())?;
    Ok(count)
}

fn import_json_bundle(conn: &mut Connection, settings: &Settings, src: &Path) -> Result<usize, String> {
    let raw = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    let bundle: JsonExportBundle =
        serde_json::from_str(&raw).map_err(|e| format!("not a valid ClipNest JSON export: {e}"))?;
    let mut board_map = std::collections::HashMap::<i64, i64>::new();
    let existing_boards = db::list_pinboards(conn)?;
    for b in &bundle.pinboards {
        if let Some(found) = existing_boards.iter().find(|eb| eb.name.eq_ignore_ascii_case(&b.name)) {
            board_map.insert(b.id, found.id);
        } else if let Ok(new_id) = db::create_pinboard(conn, &b.name, &b.color) {
            let _ = db::update_pinboard(conn, new_id, &b.name, &b.color, b.max_items, &b.list_style, &b.paste_mode);
            board_map.insert(b.id, new_id);
        }
    }
    let mut added = 0usize;
    for item in bundle.items.iter().rev() {
        if item.plain.is_empty() {
            continue;
        }
        let mut nc = build_text_clip(&item.plain, item.lang.clone(), &item.app_name, &item.app_exe, false);
        nc.sensitive = item.sensitive;
        if let Ok((id, is_new)) = db::insert_clip(conn, &nc, &[text_format(&item.plain)]) {
            if is_new {
                added += 1;
            }
            if let Some(old_bid) = item.pinboard_id {
                if let Some(&new_bid) = board_map.get(&old_bid) {
                    let _ = db::assign_category(conn, &[id], Some(new_bid), None, false);
                }
            }
            if item.pinned {
                let _ = db::set_pinned(conn, &[id], true);
            }
            if let Some(t) = &item.title {
                let _ = db::rename(conn, id, t);
            }
            if !item.tags.is_empty() {
                let _ = db::set_tags(conn, id, &item.tags);
            }
        }
    }
    let _ = db::apply_limits(conn, settings);
    Ok(added)
}

fn dispatch_online(app: &AppHandle, op: &str, p: &Value) -> IpcResponse {
    let state = app.state::<AppState>();
    let emit_items = || {
        let _ = app.emit("items-changed", ());
    };
    let emit_status = || {
        let _ = app.emit("status-changed", ());
        let _ = app.emit("queue-changed", ());
    };

    match op {
        "ping" | "status" => {
            let q = state.queue.lock();
            let q_len = if q.mode == "basket" { q.basket.len() } else { q.items.len() };
            let total_items: i64 =
                state.db.lock().query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0)).unwrap_or(0);
            let boards = db::list_pinboards(&state.db.lock()).unwrap_or_default();
            let s = state.settings.read().clone();
            IpcResponse::success(json!({
                "running": true,
                "version": APP_VERSION,
                "protocol": PROTOCOL_VERSION,
                "pid": std::process::id(),
                "data_dir": state.data_dir.to_string_lossy(),
                "total_items": total_items,
                "pinboards_count": boards.len(),
                "categories_count": boards.len(),
                "active_pinboard": s.active_pinboard,
                "paused_until": if state.is_paused() { state.paused_until.load(Ordering::SeqCst) } else { 0 },
                "plain_default": s.default_mode == "plain",
                "queue_active": q.active,
                "queue_mode": q.mode,
                "queue_len": q_len,
                "popup_pinned": state.popup_pinned.load(Ordering::SeqCst),
            }))
        }

        "add" => {
            let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let also_copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            let pinned = p.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            let tags = p.get("tags").and_then(|v| v.as_str());
            let title = p.get("title").and_then(|v| v.as_str());
            let board_spec = p.get("board").unwrap_or(&Value::Null);

            if text.is_empty() {
                return IpcResponse::fail(
                    EXIT_USAGE,
                    "Cannot add empty text",
                    Some("Provide non-empty text or pipe input to 'clipnest add -'.".into()),
                );
            }

            let s = state.settings.read().clone();
            let add_res = {
                let mut conn = state.db.lock();
                add_item_shared(&mut conn, &s, text, board_spec, pinned, tags, title)
            };
            match add_res {
                Ok((row, is_new)) => {
                    emit_items();
                    if also_copy {
                        match win::write_clipboard(&[(
                            win::CF_UNICODETEXT_ID,
                            "CF_UNICODETEXT".into(),
                            utf16_bytes(text),
                        )]) {
                            Ok(seq) => {
                                state.self_seq.store(seq, Ordering::SeqCst);
                                IpcResponse::success(json!({
                                    "item": row,
                                    "created": is_new,
                                    "copied": true
                                }))
                            }
                            Err(copy_err) => IpcResponse {
                                ok: false,
                                exit_code: EXIT_PARTIAL,
                                data: json!({
                                    "item": row,
                                    "created": is_new,
                                    "copied": false
                                }),
                                error: Some(format!(
                                    "Added item #{} to history, but failed to copy to system clipboard: {}",
                                    row.id, copy_err
                                )),
                                hint: None,
                            },
                        }
                    } else {
                        IpcResponse::success(json!({
                            "item": row,
                            "created": is_new,
                            "copied": false
                        }))
                    }
                }
                Err(e) => {
                    let code = if e.contains("not found") { EXIT_NOT_FOUND } else { EXIT_ERROR };
                    IpcResponse::fail(code, e, None)
                }
            }
        }

        "list" | "search" => {
            let query = p.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("smart").to_string();
            let limit = p.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let kind_filter = p.get("kind").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
            let pinned_only = p.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            let board_spec = p.get("board").unwrap_or(&Value::Null);

            let indep = state.settings.read().independent_pinning;
            let conn = state.db.lock();
            let pinboard = match resolve_board_id(&conn, board_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let res = search::list_scoped(
                &conn,
                &ListArgs {
                    pinboard,
                    query,
                    mode,
                    limit: if kind_filter.is_some() || pinned_only { limit.saturating_mul(4).max(200) } else { limit },
                },
                indep,
            );
            if let Some(err) = res.error {
                return IpcResponse::fail(EXIT_USAGE, err, None);
            }
            let mut items = res.items;
            if let Some(kf) = kind_filter {
                items.retain(|it| it.kind.eq_ignore_ascii_case(&kf));
            }
            if pinned_only {
                items.retain(|it| it.pinned);
            }
            items.truncate(limit);
            IpcResponse::success(json!({
                "items": items,
                "total": res.total,
                "shown": items.len(),
                "pinboard": pinboard
            }))
        }

        "get" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let fmt = p.get("format").and_then(|v| v.as_str()).unwrap_or("plain");
            if id_val.is_null() {
                match win::read_clipboard_text() {
                    Ok(text) => IpcResponse::success(json!({
                        "source": "clipboard",
                        "text": text,
                        "chars": text.chars().count()
                    })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                let conn = state.db.lock();
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                let Some(row) = db::get_row(&conn, id) else {
                    return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                };
                match fmt {
                    "meta" => IpcResponse::success(json!({ "item": row })),
                    "formats" => {
                        let metas = db::get_format_metas(&conn, id);
                        IpcResponse::success(json!({ "id": id, "formats": metas }))
                    }
                    "html" => {
                        let html = db::get_format_data(&conn, id, "HTML Format")
                            .and_then(|d| crate::capture::extract_cf_html(&d))
                            .unwrap_or_default();
                        IpcResponse::success(json!({ "id": id, "kind": row.kind, "text": html, "item": row }))
                    }
                    _ => {
                        let plain = db::get_plain(&conn, id).map(|(_, t)| t).unwrap_or_default();
                        IpcResponse::success(json!({
                            "source": "history",
                            "id": id,
                            "kind": row.kind,
                            "text": plain,
                            "item": row
                        }))
                    }
                }
            }
        }

        "copy" => {
            if let Some(id_val) = p.get("id").filter(|v| !v.is_null()) {
                let id = {
                    let conn = state.db.lock();
                    match resolve_item_id(&conn, id_val) {
                        Ok(i) => i,
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    }
                };
                let mode = if p.get("plain").and_then(|v| v.as_bool()).unwrap_or(false) { "plain" } else { "auto" };
                match crate::paste::copy_only(app, id, mode) {
                    Ok(()) => IpcResponse::success(json!({ "copied_id": id, "mode": mode })),
                    Err(e) => {
                        let code = if e.contains("not found") { EXIT_NOT_FOUND } else { EXIT_ERROR };
                        IpcResponse::fail(code, e, None)
                    }
                }
            } else {
                let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("");
                match win::write_clipboard(&[(win::CF_UNICODETEXT_ID, "CF_UNICODETEXT".into(), utf16_bytes(text))]) {
                    Ok(seq) => {
                        state.self_seq.store(seq, Ordering::SeqCst);
                        IpcResponse::success(json!({
                            "copied": true,
                            "chars": text.chars().count(),
                            "bytes": text.len()
                        }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
        }

        "paste" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("auto");
            let id = {
                let conn = state.db.lock();
                match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                }
            };
            match crate::paste::paste(app, id, mode) {
                Ok(()) => IpcResponse::success(json!({ "pasted_id": id, "mode": mode })),
                Err(e) => {
                    let code = if e.contains("not found") { EXIT_NOT_FOUND } else { EXIT_ERROR };
                    IpcResponse::fail(code, e, None)
                }
            }
        }

        "edit" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let new_text = p.get("text").and_then(|v| v.as_str());
            let title = p.get("title").and_then(|v| v.as_str());
            let tags = p.get("tags").and_then(|v| v.as_str());
            let s = state.settings.read().clone();
            let res = {
                let mut conn = state.db.lock();
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                edit_item_shared(&mut conn, &s, id, new_text, title, tags)
            };
            match res {
                Ok(row) => {
                    emit_items();
                    IpcResponse::success(json!({ "item": row }))
                }
                Err(e) => {
                    let code = if e.contains("not found") { EXIT_NOT_FOUND } else { EXIT_ERROR };
                    IpcResponse::fail(code, e, None)
                }
            }
        }

        "rename" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let title = p.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let res = {
                let conn = state.db.lock();
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                if db::get_row(&conn, id).is_none() {
                    return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                }
                db::rename(&conn, id, title).map(|_| db::get_row(&conn, id))
            };
            match res {
                Ok(row) => {
                    emit_items();
                    IpcResponse::success(json!({ "item": row }))
                }
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "delete" => {
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.is_empty() {
                return IpcResponse::fail(EXIT_USAGE, "Provide at least one item ID to delete", None);
            }
            let mut resolved_ids = Vec::new();
            {
                let conn = state.db.lock();
                for spec in &ids_arr {
                    match resolve_item_id(&conn, spec) {
                        Ok(id) => {
                            if db::get_row(&conn, id).is_none() {
                                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                            }
                            resolved_ids.push(id);
                        }
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    }
                }
            }
            if let Err(e) = db::delete_ids(&mut state.db.lock(), &resolved_ids) {
                return IpcResponse::fail(EXIT_ERROR, e, None);
            }
            for &id in &resolved_ids {
                crate::queue::remove(app, id);
            }
            emit_items();
            IpcResponse::success(json!({ "deleted": resolved_ids.len(), "ids": resolved_ids }))
        }

        "pin" | "unpin" => {
            let pinned = op == "pin";
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.is_empty() {
                return IpcResponse::fail(EXIT_USAGE, format!("Provide at least one item ID to {op}"), None);
            }
            let indep = state.settings.read().independent_pinning;
            let mut resolved = Vec::new();
            let scope_board = {
                let conn = state.db.lock();
                for spec in &ids_arr {
                    match resolve_item_id(&conn, spec) {
                        Ok(id) => {
                            if db::get_row(&conn, id).is_none() {
                                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                            }
                            resolved.push(id);
                        }
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    }
                }
                let b_spec = p.get("board").unwrap_or(&Value::Null);
                let sb = match resolve_board_id(&conn, b_spec) {
                    Ok(b) => b,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                if let Err(e) = db::set_pinned_scoped(&conn, &resolved, pinned, sb, indep) {
                    return IpcResponse::fail(EXIT_ERROR, e, None);
                }
                sb
            };
            emit_items();
            IpcResponse::success(json!({ "pinned": pinned, "ids": resolved, "board": scope_board }))
        }

        "tag" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let tags_str = p.get("tags").and_then(|v| v.as_str()).unwrap_or("");
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("set");
            let row = {
                let conn = state.db.lock();
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                let Some(cur) = db::get_row(&conn, id) else {
                    return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                };
                let next_tags = match mode {
                    "clear" => String::new(),
                    "add" => format!("{} {}", cur.tags, tags_str),
                    "remove" => {
                        let rem: Vec<String> = tags_str
                            .split(|c: char| c == ',' || c.is_whitespace())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.trim_start_matches('#').to_lowercase())
                            .collect();
                        cur.tags
                            .split_whitespace()
                            .filter(|t| !rem.contains(&t.to_lowercase()))
                            .collect::<Vec<_>>()
                            .join(" ")
                    }
                    _ => tags_str.to_string(),
                };
                if let Err(e) = db::set_tags(&conn, id, &next_tags) {
                    return IpcResponse::fail(EXIT_ERROR, e, None);
                }
                db::get_row(&conn, id)
            };
            emit_items();
            IpcResponse::success(json!({ "item": row }))
        }

        "move" => {
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.is_empty() {
                return IpcResponse::fail(EXIT_USAGE, "Provide at least one item ID to move", None);
            }
            let conn = state.db.lock();
            let mut resolved = Vec::new();
            for spec in &ids_arr {
                match resolve_item_id(&conn, spec) {
                    Ok(id) => {
                        if db::get_row(&conn, id).is_none() {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                        }
                        resolved.push(id);
                    }
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                }
            }
            if let Some(target_spec) = p.get("before").or_else(|| p.get("after")).filter(|v| !v.is_null()) {
                let after = p.get("after").filter(|v| !v.is_null()).is_some();
                let target_id = match resolve_item_id(&conn, target_spec) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                let scope = match resolve_board_id(&conn, p.get("board").unwrap_or(&Value::Null)) {
                    Ok(b) => b,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                if let Err(e) = db::move_item(&conn, resolved[0], target_id, after, scope) {
                    return IpcResponse::fail(EXIT_ERROR, e, None);
                }
                drop(conn);
                emit_items();
                return IpcResponse::success(json!({ "reordered": resolved[0], "target": target_id, "after": after }));
            }
            let board_spec = p.get("to").unwrap_or(&Value::Null);
            let board_id = match resolve_board_id(&conn, board_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let from_spec = p.get("from").unwrap_or(&Value::Null);
            let from_id = match resolve_board_id(&conn, from_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Err(e) = db::assign_category(&conn, &resolved, board_id, from_id, copy) {
                return IpcResponse::fail(EXIT_ERROR, e, None);
            }
            drop(conn);
            emit_items();
            IpcResponse::success(json!({ "moved": resolved, "pinboard_id": board_id, "copied": copy }))
        }

        "merge" => {
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.len() < 2 {
                return IpcResponse::fail(EXIT_USAGE, "Provide at least 2 item IDs to merge", None);
            }
            let sep = p.get("sep").and_then(|v| v.as_str()).unwrap_or("\n");
            let also_copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut parts = Vec::new();
            {
                let conn = state.db.lock();
                for spec in &ids_arr {
                    let id = match resolve_item_id(&conn, spec) {
                        Ok(i) => i,
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    };
                    match db::get_plain(&conn, id) {
                        Some((k, plain)) if k != "image" => parts.push(plain),
                        Some(_) => {
                            return IpcResponse::fail(
                                EXIT_USAGE,
                                format!("Item #{id} is an image and cannot be merged as text"),
                                None,
                            )
                        }
                        None => return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None),
                    }
                }
            }
            let merged_text = parts.join(sep);
            match crate::commands::store_text(app, &state, &merged_text) {
                Ok(new_id) => {
                    if also_copy {
                        let _ = crate::paste::copy_only(app, new_id, "auto");
                    }
                    let row = db::get_row(&state.db.lock(), new_id);
                    IpcResponse::success(json!({ "id": new_id, "item": row, "copied": also_copy }))
                }
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "formats" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let conn = state.db.lock();
            let id = match resolve_item_id(&conn, id_val) {
                Ok(i) => i,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            if db::get_row(&conn, id).is_none() {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
            }
            let metas = db::get_format_metas(&conn, id);
            IpcResponse::success(json!({ "id": id, "formats": metas }))
        }

        "transform" => {
            let tr_id = p.get("transform").and_then(|v| v.as_str()).unwrap_or("");
            if tr_id.is_empty() || tr_id == "list" {
                return IpcResponse::success(json!({ "transforms": TRANSFORM_LIST }));
            }
            let input = if let Some(txt) = p.get("text").and_then(|v| v.as_str()) {
                txt.to_string()
            } else if let Some(id_val) = p.get("id").filter(|v| !v.is_null()) {
                let conn = state.db.lock();
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                match db::get_plain(&conn, id) {
                    Some((_, t)) => t,
                    None => return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None),
                }
            } else {
                return IpcResponse::fail(EXIT_USAGE, "Provide an item ID, --text, or '-' (stdin) to transform", None);
            };
            let out = match transforms::apply_transform(tr_id, &input) {
                Ok(s) => s,
                Err(e) => return IpcResponse::fail(EXIT_USAGE, e, None),
            };
            let save = p.get("save").and_then(|v| v.as_bool()).unwrap_or(false);
            let copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut saved_id = None;
            if save && !out.is_empty() {
                match crate::commands::store_text(app, &state, &out) {
                    Ok(id) => saved_id = Some(id),
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
            if copy {
                match win::write_clipboard(&[(win::CF_UNICODETEXT_ID, "CF_UNICODETEXT".into(), utf16_bytes(&out))]) {
                    Ok(seq) => state.self_seq.store(seq, Ordering::SeqCst),
                    Err(e) => {
                        if saved_id.is_some() {
                            return IpcResponse::fail(
                                EXIT_PARTIAL,
                                format!(
                                    "Saved transformed item #{}, but failed to copy to clipboard: {e}",
                                    saved_id.unwrap()
                                ),
                                None,
                            );
                        }
                        return IpcResponse::fail(EXIT_ERROR, e, None);
                    }
                }
            }
            IpcResponse::success(json!({
                "transform": tr_id,
                "text": out,
                "saved_id": saved_id,
                "copied": copy
            }))
        }

        "pinboard" | "category" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            match sub {
                "list" => match db::list_pinboards(&state.db.lock()) {
                    Ok(boards) => IpcResponse::success(json!({
                        "pinboards": boards,
                        "categories": boards,
                        "active_pinboard": state.settings.read().active_pinboard
                    })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                },
                "create" => {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if name.is_empty() {
                        return IpcResponse::fail(EXIT_USAGE, "Category name cannot be empty", None);
                    }
                    let color = p.get("color").and_then(|v| v.as_str()).unwrap_or("#4f8cff");
                    let max_items = p.get("max_items").and_then(|v| v.as_i64()).unwrap_or(0);
                    let style = p.get("list_style").and_then(|v| v.as_str()).unwrap_or("inherit");
                    let pmode = p.get("paste_mode").and_then(|v| v.as_str()).unwrap_or("inherit");
                    let active = p.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                    let id = {
                        let conn = state.db.lock();
                        let id = match db::create_pinboard(&conn, name, color) {
                            Ok(i) => i,
                            Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                        };
                        let _ = db::update_pinboard(&conn, id, name, color, max_items, style, pmode);
                        id
                    };
                    if active {
                        let mut s = state.settings.read().clone();
                        s.active_pinboard = Some(id);
                        crate::apply_settings(app, s);
                    }
                    emit_items();
                    let board =
                        db::list_pinboards(&state.db.lock()).ok().and_then(|b| b.into_iter().find(|x| x.id == id));
                    IpcResponse::success(json!({ "id": id, "pinboard": board, "category": board }))
                }
                "update" => {
                    let target = p.get("board").unwrap_or(&Value::Null);
                    let id = {
                        let conn = state.db.lock();
                        match resolve_board_id(&conn, target) {
                            Ok(Some(i)) => i,
                            Ok(None) => {
                                return IpcResponse::fail(EXIT_USAGE, "Specify a category ID or name to update", None)
                            }
                            Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                        }
                    };
                    let cur = {
                        let conn = state.db.lock();
                        db::list_pinboards(&conn).ok().and_then(|b| b.into_iter().find(|x| x.id == id))
                    };
                    let Some(cur) = cur else {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Category #{id} not found"), None);
                    };
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or(&cur.name);
                    let color = p.get("color").and_then(|v| v.as_str()).unwrap_or(&cur.color);
                    let max_items = p.get("max_items").and_then(|v| v.as_i64()).unwrap_or(cur.max_items);
                    let style = p.get("list_style").and_then(|v| v.as_str()).unwrap_or(&cur.list_style);
                    let pmode = p.get("paste_mode").and_then(|v| v.as_str()).unwrap_or(&cur.paste_mode);
                    if let Err(e) = db::update_pinboard(&state.db.lock(), id, name, color, max_items, style, pmode) {
                        return IpcResponse::fail(EXIT_ERROR, e, None);
                    }
                    if let Some(act) = p.get("active").and_then(|v| v.as_bool()) {
                        let mut s = state.settings.read().clone();
                        s.active_pinboard = if act {
                            Some(id)
                        } else if s.active_pinboard == Some(id) {
                            None
                        } else {
                            s.active_pinboard
                        };
                        crate::apply_settings(app, s);
                    }
                    emit_items();
                    let updated =
                        db::list_pinboards(&state.db.lock()).ok().and_then(|b| b.into_iter().find(|x| x.id == id));
                    IpcResponse::success(json!({ "pinboard": updated, "category": updated }))
                }
                "delete" => {
                    let target = p.get("board").unwrap_or(&Value::Null);
                    let id = {
                        let conn = state.db.lock();
                        match resolve_board_id(&conn, target) {
                            Ok(Some(i)) => i,
                            Ok(None) => {
                                return IpcResponse::fail(EXIT_USAGE, "Specify a category ID or name to delete", None)
                            }
                            Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                        }
                    };
                    if let Err(e) = db::delete_pinboard(&state.db.lock(), id) {
                        return IpcResponse::fail(EXIT_ERROR, e, None);
                    }
                    let mut s = state.settings.read().clone();
                    if s.active_pinboard == Some(id) {
                        s.active_pinboard = None;
                        crate::apply_settings(app, s);
                    }
                    emit_items();
                    IpcResponse::success(json!({ "deleted_id": id }))
                }
                "activate" => {
                    let target = p.get("board").unwrap_or(&Value::Null);
                    let board_id = {
                        let conn = state.db.lock();
                        match resolve_board_id(&conn, target) {
                            Ok(b) => b,
                            Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                        }
                    };
                    let mut s = state.settings.read().clone();
                    s.active_pinboard = board_id;
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "active_pinboard": board_id }))
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown category subcommand '{other}'"), None),
            }
        }

        "queue" | "basket" => {
            let is_basket = op == "basket";
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            match sub {
                "status" | "list" => {
                    if is_basket && state.queue.lock().mode != "basket" {
                        crate::queue::set_mode(app, "basket");
                    }
                    let (active, mode) = {
                        let q = state.queue.lock();
                        (q.active, q.mode.clone())
                    };
                    let items = crate::queue::get_items(&state);
                    IpcResponse::success(json!({
                        "active": active,
                        "mode": mode,
                        "fifo": state.settings.read().queue_fifo,
                        "items": items
                    }))
                }
                "add" => {
                    let inputs = p.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    if inputs.is_empty() {
                        return IpcResponse::fail(EXIT_USAGE, "Provide at least one item ID or file path", None);
                    }
                    let mut added_ids = Vec::new();
                    for val in &inputs {
                        if let Some(s) = val.as_str() {
                            if is_basket && Path::new(s).exists() {
                                match crate::queue::collect_file_from_explorer(app, s) {
                                    Ok(id) => {
                                        added_ids.push(id);
                                        continue;
                                    }
                                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                                }
                            }
                        }
                        let id = {
                            let conn = state.db.lock();
                            match resolve_item_id(&conn, val) {
                                Ok(i) => i,
                                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                            }
                        };
                        let row = {
                            let conn = state.db.lock();
                            db::get_row(&conn, id)
                        };
                        let Some(row) = row else {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                        };
                        if is_basket {
                            if row.kind != "file" && row.kind != "image" {
                                return IpcResponse::fail(
                                    EXIT_USAGE,
                                    format!(
                                        "Item #{id} is '{}' (Drop Basket only accepts 'file' or 'image' items)",
                                        row.kind
                                    ),
                                    None,
                                );
                            }
                            let mut q = state.queue.lock();
                            q.active = true;
                            q.mode = "basket".into();
                            if !q.basket.iter().any(|e| e.id == id) {
                                q.basket.push(BasketEntry { id, cut: false });
                            }
                        } else {
                            let mut q = state.queue.lock();
                            q.active = true;
                            q.mode = "queue".into();
                            q.items.push(id);
                        }
                        added_ids.push(id);
                    }
                    crate::queue::sync_intercept(app);
                    emit_status();
                    IpcResponse::success(json!({ "added": added_ids }))
                }
                "remove" => {
                    let id_val = p.get("id").unwrap_or(&Value::Null);
                    let id = {
                        let conn = state.db.lock();
                        match resolve_item_id(&conn, id_val) {
                            Ok(i) => i,
                            Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                        }
                    };
                    crate::queue::remove(app, id);
                    IpcResponse::success(json!({ "removed": id }))
                }
                "clear" => {
                    if is_basket {
                        state.queue.lock().basket.clear();
                    } else {
                        state.queue.lock().items.clear();
                    }
                    crate::queue::sync_intercept(app);
                    emit_status();
                    IpcResponse::success(json!({ "cleared": true }))
                }
                "toggle" => {
                    crate::queue::toggle(app);
                    let active = state.queue.lock().active;
                    IpcResponse::success(json!({ "active": active }))
                }
                "close" => {
                    crate::queue::close_queue(app);
                    IpcResponse::success(json!({ "active": false }))
                }
                "mode" => {
                    let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("queue");
                    crate::queue::set_mode(app, mode);
                    IpcResponse::success(json!({ "mode": state.queue.lock().mode }))
                }
                "fifo" => {
                    let fifo = p.get("fifo").and_then(|v| v.as_bool()).unwrap_or(true);
                    let mut s = state.settings.read().clone();
                    s.queue_fifo = fifo;
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "fifo": fifo }))
                }
                "cut" => {
                    let id_val = p.get("id").unwrap_or(&Value::Null);
                    let id = {
                        let conn = state.db.lock();
                        match resolve_item_id(&conn, id_val) {
                            Ok(i) => i,
                            Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                        }
                    };
                    crate::queue::toggle_cut(app, id);
                    IpcResponse::success(json!({ "toggled_cut": id }))
                }
                "paste-to" => {
                    let folder = p.get("folder").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if folder.is_empty() {
                        return IpcResponse::fail(EXIT_USAGE, "Provide a destination folder path", None);
                    }
                    match crate::queue::paste_basket_to_dir(app, Path::new(folder)) {
                        Ok(n) => IpcResponse::success(json!({ "transferred": n, "folder": folder })),
                        Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                    }
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown {op} subcommand '{other}'"), None),
            }
        }

        "rule" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            let mut s = state.settings.read().clone();
            match sub {
                "list" => IpcResponse::success(json!({ "rules": s.rules })),
                "enable" | "disable" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let enabled = sub == "enable";
                    let Some(rule) = s.rules.iter_mut().find(|r| r.id == target || r.name.eq_ignore_ascii_case(target))
                    else {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Rule '{target}' not found"), None);
                    };
                    rule.enabled = enabled;
                    let updated = rule.clone();
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "rule": updated }))
                }
                "add" => {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("CLI Rule").to_string();
                    let action = p.get("action").and_then(|v| v.as_str()).unwrap_or("ignore").to_string();
                    let apps = p.get("apps").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let pattern = p.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let value = p.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let board = p.get("board").and_then(|v| v.as_i64()).unwrap_or(0);
                    let kinds: Vec<String> = p
                        .get("kinds")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    let new_rule = AutoRule {
                        id: format!("r{}", db::now_ms()),
                        name,
                        enabled: true,
                        apps,
                        kinds,
                        pattern,
                        action,
                        board,
                        value,
                    };
                    s.rules.push(new_rule.clone());
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "rule": new_rule }))
                }
                "delete" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let before = s.rules.len();
                    s.rules.retain(|r| r.id != target && !r.name.eq_ignore_ascii_case(target));
                    if s.rules.len() == before {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Rule '{target}' not found"), None);
                    }
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "deleted": target }))
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown rule subcommand '{other}'"), None),
            }
        }

        "action" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            let mut s = state.settings.read().clone();
            match sub {
                "list" => IpcResponse::success(json!({ "actions": s.actions })),
                "run" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let Some(act) =
                        s.actions.iter().find(|a| a.id == target || a.name.eq_ignore_ascii_case(target)).cloned()
                    else {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Custom action '{target}' not found"), None);
                    };
                    let id_val = p.get("id").unwrap_or(&Value::Null);
                    let id = {
                        let conn = state.db.lock();
                        match resolve_item_id(&conn, id_val) {
                            Ok(i) => i,
                            Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                        }
                    };
                    match crate::commands::exec_action(app, id, &act.id) {
                        Ok(new_id) => {
                            IpcResponse::success(json!({ "action": act.id, "item_id": id, "new_item_id": new_id }))
                        }
                        Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                    }
                }
                "add" => {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    let command = p.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    let output = p.get("output").and_then(|v| v.as_str()).unwrap_or("new_item").to_string();
                    if name.is_empty() || command.is_empty() {
                        return IpcResponse::fail(EXIT_USAGE, "Action requires both a name and --cmd <command>", None);
                    }
                    let act = CustomAction { id: format!("a{}", db::now_ms()), name, command, output };
                    s.actions.push(act.clone());
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "action": act }))
                }
                "delete" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let before = s.actions.len();
                    s.actions.retain(|a| a.id != target && !a.name.eq_ignore_ascii_case(target));
                    if s.actions.len() == before {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Custom action '{target}' not found"), None);
                    }
                    crate::apply_settings(app, s);
                    IpcResponse::success(json!({ "deleted": target }))
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown action subcommand '{other}'"), None),
            }
        }

        "config" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            let s = state.settings.read().clone();
            let mut val = serde_json::to_value(&s).unwrap_or(Value::Null);
            match sub {
                "list" => IpcResponse::success(val),
                "get" => {
                    let key = p.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    match val.get(key) {
                        Some(v) => IpcResponse::success(json!({ "key": key, "value": v })),
                        None => IpcResponse::fail(EXIT_NOT_FOUND, format!("Unknown setting key '{key}'"), None),
                    }
                }
                "set" => {
                    let key = p.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    let raw_val = p.get("value").cloned().unwrap_or(Value::Null);
                    let Some(obj) = val.as_object_mut() else {
                        return IpcResponse::fail(EXIT_ERROR, "Failed to serialize settings", None);
                    };
                    if !obj.contains_key(key) {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Unknown setting key '{key}'"), None);
                    }
                    obj.insert(key.to_string(), raw_val);
                    match serde_json::from_value::<Settings>(val) {
                        Ok(next_settings) => {
                            let updated_val =
                                serde_json::to_value(&next_settings).ok().and_then(|v| v.get(key).cloned());
                            crate::apply_settings(app, next_settings);
                            IpcResponse::success(json!({ "key": key, "value": updated_val }))
                        }
                        Err(e) => IpcResponse::fail(EXIT_USAGE, format!("Invalid value for '{key}': {e}"), None),
                    }
                }
                "reset" => {
                    let def = Settings::default();
                    if let Some(key) = p.get("key").and_then(|v| v.as_str()).filter(|k| !k.is_empty()) {
                        let def_val = serde_json::to_value(&def).unwrap_or(Value::Null);
                        let Some(dv) = def_val.get(key).cloned() else {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Unknown setting key '{key}'"), None);
                        };
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert(key.to_string(), dv.clone());
                        }
                        if let Ok(next_settings) = serde_json::from_value::<Settings>(val) {
                            crate::apply_settings(app, next_settings);
                        }
                        IpcResponse::success(json!({ "reset": key, "value": dv }))
                    } else {
                        crate::apply_settings(app, def.clone());
                        IpcResponse::success(json!({ "reset": "all" }))
                    }
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown config subcommand '{other}'"), None),
            }
        }

        "pause" => {
            let mins = p.get("minutes").and_then(|v| v.as_u64()).map(|m| m as u32);
            crate::set_pause(app, mins);
            IpcResponse::success(json!({
                "paused": true,
                "paused_until": state.paused_until.load(Ordering::SeqCst)
            }))
        }

        "resume" => {
            crate::resume(app);
            IpcResponse::success(json!({ "paused": false }))
        }

        "plain" => {
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("toggle");
            let mut s = state.settings.read().clone();
            s.default_mode = match mode {
                "on" | "true" | "plain" => "plain".into(),
                "off" | "false" | "rich" => "rich".into(),
                _ => {
                    if s.default_mode == "plain" {
                        "rich".into()
                    } else {
                        "plain".into()
                    }
                }
            };
            let is_plain = s.default_mode == "plain";
            crate::apply_settings(app, s);
            IpcResponse::success(json!({ "plain_default": is_plain }))
        }

        "open" => {
            crate::windowing::spawn_show_popup(app.clone(), Some("center".into()), true);
            IpcResponse::success(json!({ "window": "popup", "visible": true }))
        }

        "hide" => {
            crate::windowing::hide_popup(app);
            crate::windowing::hide_tray(app);
            IpcResponse::success(json!({ "window": "popup", "visible": false }))
        }

        "settings" => {
            crate::windowing::open_settings(app);
            IpcResponse::success(json!({ "window": "settings", "visible": true }))
        }

        "quit" => {
            remove_endpoint_file(&state.data_dir);
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(60));
                app_clone.exit(0);
            });
            IpcResponse::success(json!({ "quitting": true }))
        }

        "backup" => {
            let keep = state.settings.read().backup_keep;
            match db::backup(&state.db, &state.data_dir, keep) {
                Ok(snapshot) => {
                    if let Some(dest_str) = p.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        let dest = PathBuf::from(dest_str);
                        if let Some(parent) = dest.parent() {
                            if !parent.as_os_str().is_empty() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                        }
                        if let Err(e) = std::fs::copy(&snapshot, &dest) {
                            return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                        }
                        IpcResponse::success(json!({ "path": dest.to_string_lossy() }))
                    } else {
                        IpcResponse::success(json!({ "path": snapshot.to_string_lossy() }))
                    }
                }
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "export" => {
            let Some(dest_str) = p.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                return IpcResponse::fail(EXIT_USAGE, "Provide an output file path for export", None);
            };
            let dest = PathBuf::from(dest_str);
            let settings_only = p.get("settings").and_then(|v| v.as_bool()).unwrap_or(false);
            let fmt = p.get("format").and_then(|v| v.as_str()).unwrap_or("");
            let s = state.settings.read().clone();
            if settings_only {
                match serde_json::to_vec_pretty(&s) {
                    Ok(bytes) => match db::write_atomic(&dest, &bytes) {
                        Ok(()) => IpcResponse::success(json!({ "path": dest.to_string_lossy(), "kind": "settings" })),
                        Err(e) => IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                    },
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                }
            } else if fmt == "json" || dest_str.to_lowercase().ends_with(".json") {
                match export_json_bundle(&state.db.lock(), &s, &dest) {
                    Ok(count) => {
                        IpcResponse::success(json!({ "path": dest.to_string_lossy(), "kind": "json", "items": count }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                match db::backup(&state.db, &state.data_dir, s.backup_keep) {
                    Ok(snapshot) => {
                        if let Some(parent) = dest.parent() {
                            if !parent.as_os_str().is_empty() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                        }
                        if let Err(e) = std::fs::copy(&snapshot, &dest) {
                            return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                        }
                        IpcResponse::success(json!({ "path": dest.to_string_lossy(), "kind": "db" }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
        }

        "import" => {
            let Some(src_str) = p.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                return IpcResponse::fail(EXIT_USAGE, "Provide an input file path to import", None);
            };
            let src = PathBuf::from(src_str);
            if !src.exists() {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("File not found: {src_str}"), None);
            }
            let settings_only = p.get("settings").and_then(|v| v.as_bool()).unwrap_or(false);
            if settings_only {
                let text = match std::fs::read_to_string(&src) {
                    Ok(t) => t,
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                };
                match serde_json::from_str::<Settings>(&text) {
                    Ok(s) => {
                        crate::apply_settings(app, s);
                        IpcResponse::success(json!({ "imported_settings": true, "path": src_str }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_USAGE, format!("Invalid settings JSON: {e}"), None),
                }
            } else if src_str.to_lowercase().ends_with(".json") {
                let s = state.settings.read().clone();
                let res = import_json_bundle(&mut state.db.lock(), &s, &src);
                match res {
                    Ok(added) => {
                        emit_items();
                        IpcResponse::success(json!({ "imported_items": added, "path": src_str }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                let raw = match std::fs::read(&src) {
                    Ok(b) => b,
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                };
                let bytes = if raw.starts_with(&[0x1f, 0x8b]) {
                    let mut out = Vec::new();
                    if let Err(e) = flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out) {
                        return IpcResponse::fail(EXIT_ERROR, format!("Invalid gzip backup: {e}"), None);
                    }
                    out
                } else {
                    raw
                };
                let tmp = state.data_dir.join(format!("import-cli-{}.tmp.db", db::now_ms()));
                if let Err(e) = std::fs::write(&tmp, &bytes) {
                    return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                }
                let res = db::merge_from(&state.db.lock(), &tmp);
                let _ = std::fs::remove_file(&tmp);
                match res {
                    Ok(added) => {
                        emit_items();
                        IpcResponse::success(json!({ "imported_items": added, "path": src_str }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
        }

        "erase" => {
            let include_pinned = p.get("include_pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            let all_boards = p.get("all_boards").and_then(|v| v.as_bool()).unwrap_or(false);
            let board_spec = p.get("board").unwrap_or(&Value::Null);
            let deleted = {
                let conn = state.db.lock();
                let target_board = if all_boards {
                    None
                } else if !board_spec.is_null() {
                    match resolve_board_id(&conn, board_spec) {
                        Ok(b) => b,
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    }
                } else {
                    None
                };
                match db::erase_history(&conn, include_pinned, target_board, all_boards) {
                    Ok(n) => n,
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                }
            };
            {
                let mut q = state.queue.lock();
                let conn = state.db.lock();
                q.items.retain(|&id| db::get_row(&conn, id).is_some());
                q.basket.retain(|e| db::get_row(&conn, e.id).is_some());
            }
            crate::queue::sync_intercept(app);
            emit_status();
            emit_items();
            IpcResponse::success(json!({ "erased": deleted }))
        }

        other => IpcResponse::fail(EXIT_USAGE, format!("Unknown operation '{other}'"), None),
    }
}

pub fn dispatch_offline(data_dir: &Path, op: &str, p: &Value) -> IpcResponse {
    let settings_path = data_dir.join("settings.json");
    let mut settings = Settings::load(&settings_path);

    if matches!(op, "open" | "hide" | "settings" | "quit" | "pause" | "resume" | "queue" | "basket") {
        return IpcResponse::fail(
            EXIT_OFFLINE,
            format!("ClipNest desktop app is not running (command '{op}' requires the running desktop app)."),
            Some("Launch ClipNest first, then re-run this command.".into()),
        );
    }

    let mut conn = match db::open_with_recovery(data_dir) {
        Ok(c) => c,
        Err(e) => return IpcResponse::fail(EXIT_ERROR, format!("Cannot open ClipNest database: {e}"), None),
    };

    match op {
        "ping" | "status" => {
            let total_items: i64 = conn.query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0)).unwrap_or(0);
            let boards = db::list_pinboards(&conn).unwrap_or_default();
            IpcResponse::success(json!({
                "running": false,
                "version": APP_VERSION,
                "protocol": PROTOCOL_VERSION,
                "data_dir": data_dir.to_string_lossy(),
                "total_items": total_items,
                "pinboards_count": boards.len(),
                "categories_count": boards.len(),
                "active_pinboard": settings.active_pinboard,
                "paused_until": 0,
                "plain_default": settings.default_mode == "plain",
                "queue_active": false,
                "queue_mode": "queue",
                "queue_len": 0,
                "popup_pinned": false,
            }))
        }

        "add" => {
            let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let also_copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            let pinned = p.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            let tags = p.get("tags").and_then(|v| v.as_str());
            let title = p.get("title").and_then(|v| v.as_str());
            let board_spec = p.get("board").unwrap_or(&Value::Null);

            if text.is_empty() {
                return IpcResponse::fail(
                    EXIT_USAGE,
                    "Cannot add empty text",
                    Some("Provide non-empty text or pipe input to 'clipnest add -'.".into()),
                );
            }

            match add_item_shared(&mut conn, &settings, text, board_spec, pinned, tags, title) {
                Ok((row, is_new)) => {
                    if also_copy {
                        match win::write_clipboard(&[(
                            win::CF_UNICODETEXT_ID,
                            "CF_UNICODETEXT".into(),
                            utf16_bytes(text),
                        )]) {
                            Ok(_) => IpcResponse::success(json!({
                                "item": row,
                                "created": is_new,
                                "copied": true
                            })),
                            Err(copy_err) => IpcResponse {
                                ok: false,
                                exit_code: EXIT_PARTIAL,
                                data: json!({
                                    "item": row,
                                    "created": is_new,
                                    "copied": false
                                }),
                                error: Some(format!(
                                    "Added item #{} to history, but failed to copy to system clipboard: {}",
                                    row.id, copy_err
                                )),
                                hint: None,
                            },
                        }
                    } else {
                        IpcResponse::success(json!({
                            "item": row,
                            "created": is_new,
                            "copied": false
                        }))
                    }
                }
                Err(e) => {
                    let code = if e.contains("not found") { EXIT_NOT_FOUND } else { EXIT_ERROR };
                    IpcResponse::fail(code, e, None)
                }
            }
        }

        "list" | "search" => {
            let query = p.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("smart").to_string();
            let limit = p.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let kind_filter = p.get("kind").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
            let pinned_only = p.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            let board_spec = p.get("board").unwrap_or(&Value::Null);

            let pinboard = match resolve_board_id(&conn, board_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let res = search::list_scoped(
                &conn,
                &ListArgs {
                    pinboard,
                    query,
                    mode,
                    limit: if kind_filter.is_some() || pinned_only { limit.saturating_mul(4).max(200) } else { limit },
                },
                settings.independent_pinning,
            );
            if let Some(err) = res.error {
                return IpcResponse::fail(EXIT_USAGE, err, None);
            }
            let mut items = res.items;
            if let Some(kf) = kind_filter {
                items.retain(|it| it.kind.eq_ignore_ascii_case(&kf));
            }
            if pinned_only {
                items.retain(|it| it.pinned);
            }
            items.truncate(limit);
            IpcResponse::success(json!({
                "items": items,
                "total": res.total,
                "shown": items.len(),
                "pinboard": pinboard
            }))
        }

        "get" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let fmt = p.get("format").and_then(|v| v.as_str()).unwrap_or("plain");
            if id_val.is_null() {
                match win::read_clipboard_text() {
                    Ok(text) => IpcResponse::success(json!({
                        "source": "clipboard",
                        "text": text,
                        "chars": text.chars().count()
                    })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                let Some(row) = db::get_row(&conn, id) else {
                    return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                };
                match fmt {
                    "meta" => IpcResponse::success(json!({ "item": row })),
                    "formats" => {
                        let metas = db::get_format_metas(&conn, id);
                        IpcResponse::success(json!({ "id": id, "formats": metas }))
                    }
                    "html" => {
                        let html = db::get_format_data(&conn, id, "HTML Format")
                            .and_then(|d| crate::capture::extract_cf_html(&d))
                            .unwrap_or_default();
                        IpcResponse::success(json!({ "id": id, "kind": row.kind, "text": html, "item": row }))
                    }
                    _ => {
                        let plain = db::get_plain(&conn, id).map(|(_, t)| t).unwrap_or_default();
                        IpcResponse::success(json!({
                            "source": "history",
                            "id": id,
                            "kind": row.kind,
                            "text": plain,
                            "item": row
                        }))
                    }
                }
            }
        }

        "copy" => {
            if let Some(id_val) = p.get("id").filter(|v| !v.is_null()) {
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                let Some((_, plain_text)) = db::get_plain(&conn, id) else {
                    return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                };
                match win::write_clipboard(&[(
                    win::CF_UNICODETEXT_ID,
                    "CF_UNICODETEXT".into(),
                    utf16_bytes(&plain_text),
                )]) {
                    Ok(_) => {
                        if settings.move_to_top {
                            db::touch(&conn, id);
                        }
                        IpcResponse::success(json!({ "copied_id": id, "mode": "plain" }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("");
                match win::write_clipboard(&[(win::CF_UNICODETEXT_ID, "CF_UNICODETEXT".into(), utf16_bytes(text))]) {
                    Ok(_) => IpcResponse::success(json!({
                        "copied": true,
                        "chars": text.chars().count(),
                        "bytes": text.len()
                    })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
        }

        "paste" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let id = match resolve_item_id(&conn, id_val) {
                Ok(i) => i,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let Some((_, plain_text)) = db::get_plain(&conn, id) else {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
            };
            match win::write_clipboard(&[(win::CF_UNICODETEXT_ID, "CF_UNICODETEXT".into(), utf16_bytes(&plain_text))]) {
                Ok(_) => {
                    if settings.move_to_top {
                        db::touch(&conn, id);
                    }
                    IpcResponse::success(json!({ "pasted_id": id, "mode": "plain" }))
                }
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "edit" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let id = match resolve_item_id(&conn, id_val) {
                Ok(i) => i,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let new_text = p.get("text").and_then(|v| v.as_str());
            let title = p.get("title").and_then(|v| v.as_str());
            let tags = p.get("tags").and_then(|v| v.as_str());
            match edit_item_shared(&mut conn, &settings, id, new_text, title, tags) {
                Ok(row) => IpcResponse::success(json!({ "item": row })),
                Err(e) => {
                    let code = if e.contains("not found") { EXIT_NOT_FOUND } else { EXIT_ERROR };
                    IpcResponse::fail(code, e, None)
                }
            }
        }

        "rename" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let title = p.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let id = match resolve_item_id(&conn, id_val) {
                Ok(i) => i,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            if db::get_row(&conn, id).is_none() {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
            }
            match db::rename(&conn, id, title) {
                Ok(()) => IpcResponse::success(json!({ "item": db::get_row(&conn, id) })),
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "delete" => {
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.is_empty() {
                return IpcResponse::fail(EXIT_USAGE, "Provide at least one item ID to delete", None);
            }
            let mut resolved = Vec::new();
            for spec in &ids_arr {
                match resolve_item_id(&conn, spec) {
                    Ok(id) => {
                        if db::get_row(&conn, id).is_none() {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                        }
                        resolved.push(id);
                    }
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                }
            }
            match db::delete_ids(&mut conn, &resolved) {
                Ok(()) => IpcResponse::success(json!({ "deleted": resolved.len(), "ids": resolved })),
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "pin" | "unpin" => {
            let pinned = op == "pin";
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.is_empty() {
                return IpcResponse::fail(EXIT_USAGE, format!("Provide at least one item ID to {op}"), None);
            }
            let mut resolved = Vec::new();
            for spec in &ids_arr {
                match resolve_item_id(&conn, spec) {
                    Ok(id) => {
                        if db::get_row(&conn, id).is_none() {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                        }
                        resolved.push(id);
                    }
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                }
            }
            let b_spec = p.get("board").unwrap_or(&Value::Null);
            let scope_board = match resolve_board_id(&conn, b_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            match db::set_pinned_scoped(&conn, &resolved, pinned, scope_board, settings.independent_pinning) {
                Ok(()) => IpcResponse::success(json!({ "pinned": pinned, "ids": resolved, "board": scope_board })),
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "tag" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let tags_str = p.get("tags").and_then(|v| v.as_str()).unwrap_or("");
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("set");
            let id = match resolve_item_id(&conn, id_val) {
                Ok(i) => i,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let Some(cur) = db::get_row(&conn, id) else {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
            };
            let next_tags = match mode {
                "clear" => String::new(),
                "add" => format!("{} {}", cur.tags, tags_str),
                "remove" => {
                    let rem: Vec<String> = tags_str
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.trim_start_matches('#').to_lowercase())
                        .collect();
                    cur.tags
                        .split_whitespace()
                        .filter(|t| !rem.contains(&t.to_lowercase()))
                        .collect::<Vec<_>>()
                        .join(" ")
                }
                _ => tags_str.to_string(),
            };
            match db::set_tags(&conn, id, &next_tags) {
                Ok(()) => IpcResponse::success(json!({ "item": db::get_row(&conn, id) })),
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "move" => {
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.is_empty() {
                return IpcResponse::fail(EXIT_USAGE, "Provide at least one item ID to move", None);
            }
            let mut resolved = Vec::new();
            for spec in &ids_arr {
                match resolve_item_id(&conn, spec) {
                    Ok(id) => {
                        if db::get_row(&conn, id).is_none() {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
                        }
                        resolved.push(id);
                    }
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                }
            }
            if let Some(target_spec) = p.get("before").or_else(|| p.get("after")).filter(|v| !v.is_null()) {
                let after = p.get("after").filter(|v| !v.is_null()).is_some();
                let target_id = match resolve_item_id(&conn, target_spec) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                let scope = match resolve_board_id(&conn, p.get("board").unwrap_or(&Value::Null)) {
                    Ok(b) => b,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                if let Err(e) = db::move_item(&conn, resolved[0], target_id, after, scope) {
                    return IpcResponse::fail(EXIT_ERROR, e, None);
                }
                return IpcResponse::success(json!({ "reordered": resolved[0], "target": target_id, "after": after }));
            }
            let board_spec = p.get("to").unwrap_or(&Value::Null);
            let board_id = match resolve_board_id(&conn, board_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let from_spec = p.get("from").unwrap_or(&Value::Null);
            let from_id = match resolve_board_id(&conn, from_spec) {
                Ok(b) => b,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            let copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            match db::assign_category(&conn, &resolved, board_id, from_id, copy) {
                Ok(()) => IpcResponse::success(json!({ "moved": resolved, "pinboard_id": board_id, "copied": copy })),
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "merge" => {
            let ids_arr = p.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if ids_arr.len() < 2 {
                return IpcResponse::fail(EXIT_USAGE, "Provide at least 2 item IDs to merge", None);
            }
            let sep = p.get("sep").and_then(|v| v.as_str()).unwrap_or("\n");
            let also_copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut parts = Vec::new();
            for spec in &ids_arr {
                let id = match resolve_item_id(&conn, spec) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                match db::get_plain(&conn, id) {
                    Some((k, plain)) if k != "image" => parts.push(plain),
                    Some(_) => {
                        return IpcResponse::fail(
                            EXIT_USAGE,
                            format!("Item #{id} is an image and cannot be merged as text"),
                            None,
                        )
                    }
                    None => return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None),
                }
            }
            let merged_text = parts.join(sep);
            match add_item_shared(&mut conn, &settings, &merged_text, &Value::Null, false, None, None) {
                Ok((row, _)) => {
                    if also_copy {
                        let _ = win::write_clipboard(&[(
                            win::CF_UNICODETEXT_ID,
                            "CF_UNICODETEXT".into(),
                            utf16_bytes(&merged_text),
                        )]);
                    }
                    IpcResponse::success(json!({ "id": row.id, "item": row, "copied": also_copy }))
                }
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "formats" => {
            let id_val = p.get("id").unwrap_or(&Value::Null);
            let id = match resolve_item_id(&conn, id_val) {
                Ok(i) => i,
                Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
            };
            if db::get_row(&conn, id).is_none() {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None);
            }
            let metas = db::get_format_metas(&conn, id);
            IpcResponse::success(json!({ "id": id, "formats": metas }))
        }

        "transform" => {
            let tr_id = p.get("transform").and_then(|v| v.as_str()).unwrap_or("");
            if tr_id.is_empty() || tr_id == "list" {
                return IpcResponse::success(json!({ "transforms": TRANSFORM_LIST }));
            }
            let input = if let Some(txt) = p.get("text").and_then(|v| v.as_str()) {
                txt.to_string()
            } else if let Some(id_val) = p.get("id").filter(|v| !v.is_null()) {
                let id = match resolve_item_id(&conn, id_val) {
                    Ok(i) => i,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                };
                match db::get_plain(&conn, id) {
                    Some((_, t)) => t,
                    None => return IpcResponse::fail(EXIT_NOT_FOUND, format!("Item #{id} not found"), None),
                }
            } else {
                return IpcResponse::fail(EXIT_USAGE, "Provide an item ID, --text, or '-' (stdin) to transform", None);
            };
            let out = match transforms::apply_transform(tr_id, &input) {
                Ok(s) => s,
                Err(e) => return IpcResponse::fail(EXIT_USAGE, e, None),
            };
            let save = p.get("save").and_then(|v| v.as_bool()).unwrap_or(false);
            let copy = p.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut saved_id = None;
            if save && !out.is_empty() {
                match add_item_shared(&mut conn, &settings, &out, &Value::Null, false, None, None) {
                    Ok((row, _)) => saved_id = Some(row.id),
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
            if copy {
                if let Err(e) =
                    win::write_clipboard(&[(win::CF_UNICODETEXT_ID, "CF_UNICODETEXT".into(), utf16_bytes(&out))])
                {
                    if saved_id.is_some() {
                        return IpcResponse::fail(
                            EXIT_PARTIAL,
                            format!(
                                "Saved transformed item #{}, but failed to copy to clipboard: {e}",
                                saved_id.unwrap()
                            ),
                            None,
                        );
                    }
                    return IpcResponse::fail(EXIT_ERROR, e, None);
                }
            }
            IpcResponse::success(json!({
                "transform": tr_id,
                "text": out,
                "saved_id": saved_id,
                "copied": copy
            }))
        }

        "pinboard" | "category" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            match sub {
                "list" => match db::list_pinboards(&conn) {
                    Ok(boards) => IpcResponse::success(json!({
                        "pinboards": boards,
                        "categories": boards,
                        "active_pinboard": settings.active_pinboard
                    })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                },
                "create" => {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if name.is_empty() {
                        return IpcResponse::fail(EXIT_USAGE, "Category name cannot be empty", None);
                    }
                    let color = p.get("color").and_then(|v| v.as_str()).unwrap_or("#4f8cff");
                    let max_items = p.get("max_items").and_then(|v| v.as_i64()).unwrap_or(0);
                    let style = p.get("list_style").and_then(|v| v.as_str()).unwrap_or("inherit");
                    let pmode = p.get("paste_mode").and_then(|v| v.as_str()).unwrap_or("inherit");
                    let active = p.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                    let id = match db::create_pinboard(&conn, name, color) {
                        Ok(i) => i,
                        Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                    };
                    let _ = db::update_pinboard(&conn, id, name, color, max_items, style, pmode);
                    if active {
                        settings.active_pinboard = Some(id);
                        let _ = settings.save(&settings_path);
                    }
                    let board = db::list_pinboards(&conn).ok().and_then(|b| b.into_iter().find(|x| x.id == id));
                    IpcResponse::success(json!({ "id": id, "pinboard": board, "category": board }))
                }
                "update" => {
                    let target = p.get("board").unwrap_or(&Value::Null);
                    let id = match resolve_board_id(&conn, target) {
                        Ok(Some(i)) => i,
                        Ok(None) => {
                            return IpcResponse::fail(EXIT_USAGE, "Specify a category ID or name to update", None)
                        }
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    };
                    let cur = db::list_pinboards(&conn).ok().and_then(|b| b.into_iter().find(|x| x.id == id));
                    let Some(cur) = cur else {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Category #{id} not found"), None);
                    };
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or(&cur.name);
                    let color = p.get("color").and_then(|v| v.as_str()).unwrap_or(&cur.color);
                    let max_items = p.get("max_items").and_then(|v| v.as_i64()).unwrap_or(cur.max_items);
                    let style = p.get("list_style").and_then(|v| v.as_str()).unwrap_or(&cur.list_style);
                    let pmode = p.get("paste_mode").and_then(|v| v.as_str()).unwrap_or(&cur.paste_mode);
                    if let Err(e) = db::update_pinboard(&conn, id, name, color, max_items, style, pmode) {
                        return IpcResponse::fail(EXIT_ERROR, e, None);
                    }
                    if let Some(act) = p.get("active").and_then(|v| v.as_bool()) {
                        settings.active_pinboard = if act {
                            Some(id)
                        } else if settings.active_pinboard == Some(id) {
                            None
                        } else {
                            settings.active_pinboard
                        };
                        let _ = settings.save(&settings_path);
                    }
                    let updated = db::list_pinboards(&conn).ok().and_then(|b| b.into_iter().find(|x| x.id == id));
                    IpcResponse::success(json!({ "pinboard": updated, "category": updated }))
                }
                "delete" => {
                    let target = p.get("board").unwrap_or(&Value::Null);
                    let id = match resolve_board_id(&conn, target) {
                        Ok(Some(i)) => i,
                        Ok(None) => {
                            return IpcResponse::fail(EXIT_USAGE, "Specify a category ID or name to delete", None)
                        }
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    };
                    if let Err(e) = db::delete_pinboard(&conn, id) {
                        return IpcResponse::fail(EXIT_ERROR, e, None);
                    }
                    if settings.active_pinboard == Some(id) {
                        settings.active_pinboard = None;
                        let _ = settings.save(&settings_path);
                    }
                    IpcResponse::success(json!({ "deleted_id": id }))
                }
                "activate" => {
                    let target = p.get("board").unwrap_or(&Value::Null);
                    let board_id = match resolve_board_id(&conn, target) {
                        Ok(b) => b,
                        Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                    };
                    settings.active_pinboard = board_id;
                    let _ = settings.save(&settings_path);
                    IpcResponse::success(json!({ "active_pinboard": board_id }))
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown category subcommand '{other}'"), None),
            }
        }

        "rule" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            match sub {
                "list" => IpcResponse::success(json!({ "rules": settings.rules })),
                "enable" | "disable" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let enabled = sub == "enable";
                    let Some(rule) =
                        settings.rules.iter_mut().find(|r| r.id == target || r.name.eq_ignore_ascii_case(target))
                    else {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Rule '{target}' not found"), None);
                    };
                    rule.enabled = enabled;
                    let updated = rule.clone();
                    let _ = settings.save(&settings_path);
                    IpcResponse::success(json!({ "rule": updated }))
                }
                "add" => {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("CLI Rule").to_string();
                    let action = p.get("action").and_then(|v| v.as_str()).unwrap_or("ignore").to_string();
                    let apps = p.get("apps").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let pattern = p.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let value = p.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let board = p.get("board").and_then(|v| v.as_i64()).unwrap_or(0);
                    let kinds: Vec<String> = p
                        .get("kinds")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    let new_rule = AutoRule {
                        id: format!("r{}", db::now_ms()),
                        name,
                        enabled: true,
                        apps,
                        kinds,
                        pattern,
                        action,
                        board,
                        value,
                    };
                    settings.rules.push(new_rule.clone());
                    let _ = settings.save(&settings_path);
                    IpcResponse::success(json!({ "rule": new_rule }))
                }
                "delete" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let before = settings.rules.len();
                    settings.rules.retain(|r| r.id != target && !r.name.eq_ignore_ascii_case(target));
                    if settings.rules.len() == before {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Rule '{target}' not found"), None);
                    }
                    let _ = settings.save(&settings_path);
                    IpcResponse::success(json!({ "deleted": target }))
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown rule subcommand '{other}'"), None),
            }
        }

        "action" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            match sub {
                "list" => IpcResponse::success(json!({ "actions": settings.actions })),
                "add" => {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    let command = p.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    let output = p.get("output").and_then(|v| v.as_str()).unwrap_or("new_item").to_string();
                    if name.is_empty() || command.is_empty() {
                        return IpcResponse::fail(EXIT_USAGE, "Action requires both a name and --cmd <command>", None);
                    }
                    let act = CustomAction { id: format!("a{}", db::now_ms()), name, command, output };
                    settings.actions.push(act.clone());
                    let _ = settings.save(&settings_path);
                    IpcResponse::success(json!({ "action": act }))
                }
                "delete" => {
                    let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    let before = settings.actions.len();
                    settings.actions.retain(|a| a.id != target && !a.name.eq_ignore_ascii_case(target));
                    if settings.actions.len() == before {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Custom action '{target}' not found"), None);
                    }
                    let _ = settings.save(&settings_path);
                    IpcResponse::success(json!({ "deleted": target }))
                }
                "run" => IpcResponse::fail(
                    EXIT_OFFLINE,
                    "Running custom shell actions requires the ClipNest desktop app to be running.",
                    None,
                ),
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown action subcommand '{other}'"), None),
            }
        }

        "config" => {
            let sub = p.get("sub").and_then(|v| v.as_str()).unwrap_or("list");
            let mut val = serde_json::to_value(&settings).unwrap_or(Value::Null);
            match sub {
                "list" => IpcResponse::success(val),
                "get" => {
                    let key = p.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    match val.get(key) {
                        Some(v) => IpcResponse::success(json!({ "key": key, "value": v })),
                        None => IpcResponse::fail(EXIT_NOT_FOUND, format!("Unknown setting key '{key}'"), None),
                    }
                }
                "set" => {
                    let key = p.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    let raw_val = p.get("value").cloned().unwrap_or(Value::Null);
                    let Some(obj) = val.as_object_mut() else {
                        return IpcResponse::fail(EXIT_ERROR, "Failed to serialize settings", None);
                    };
                    if !obj.contains_key(key) {
                        return IpcResponse::fail(EXIT_NOT_FOUND, format!("Unknown setting key '{key}'"), None);
                    }
                    obj.insert(key.to_string(), raw_val);
                    match serde_json::from_value::<Settings>(val) {
                        Ok(next_settings) => {
                            if let Err(e) = next_settings.save(&settings_path) {
                                return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                            }
                            let _ = db::apply_limits(&conn, &next_settings);
                            let updated_val =
                                serde_json::to_value(&next_settings).ok().and_then(|v| v.get(key).cloned());
                            IpcResponse::success(json!({ "key": key, "value": updated_val }))
                        }
                        Err(e) => IpcResponse::fail(EXIT_USAGE, format!("Invalid value for '{key}': {e}"), None),
                    }
                }
                "reset" => {
                    let def = Settings::default();
                    if let Some(key) = p.get("key").and_then(|v| v.as_str()).filter(|k| !k.is_empty()) {
                        let def_val = serde_json::to_value(&def).unwrap_or(Value::Null);
                        let Some(dv) = def_val.get(key).cloned() else {
                            return IpcResponse::fail(EXIT_NOT_FOUND, format!("Unknown setting key '{key}'"), None);
                        };
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert(key.to_string(), dv.clone());
                        }
                        if let Ok(next_settings) = serde_json::from_value::<Settings>(val) {
                            let _ = next_settings.save(&settings_path);
                        }
                        IpcResponse::success(json!({ "reset": key, "value": dv }))
                    } else {
                        let _ = def.save(&settings_path);
                        IpcResponse::success(json!({ "reset": "all" }))
                    }
                }
                other => IpcResponse::fail(EXIT_USAGE, format!("Unknown config subcommand '{other}'"), None),
            }
        }

        "plain" => {
            let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("toggle");
            settings.default_mode = match mode {
                "on" | "true" | "plain" => "plain".into(),
                "off" | "false" | "rich" => "rich".into(),
                _ => {
                    if settings.default_mode == "plain" {
                        "rich".into()
                    } else {
                        "plain".into()
                    }
                }
            };
            let is_plain = settings.default_mode == "plain";
            let _ = settings.save(&settings_path);
            IpcResponse::success(json!({ "plain_default": is_plain }))
        }

        "backup" => {
            let keep = settings.backup_keep;
            let mutex = parking_lot::Mutex::new(conn);
            match db::backup(&mutex, data_dir, keep) {
                Ok(snapshot) => {
                    if let Some(dest_str) = p.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        let dest = PathBuf::from(dest_str);
                        if let Some(parent) = dest.parent() {
                            if !parent.as_os_str().is_empty() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                        }
                        if let Err(e) = std::fs::copy(&snapshot, &dest) {
                            return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                        }
                        IpcResponse::success(json!({ "path": dest.to_string_lossy() }))
                    } else {
                        IpcResponse::success(json!({ "path": snapshot.to_string_lossy() }))
                    }
                }
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        "export" => {
            let Some(dest_str) = p.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                return IpcResponse::fail(EXIT_USAGE, "Provide an output file path for export", None);
            };
            let dest = PathBuf::from(dest_str);
            let settings_only = p.get("settings").and_then(|v| v.as_bool()).unwrap_or(false);
            let fmt = p.get("format").and_then(|v| v.as_str()).unwrap_or("");
            if settings_only {
                match serde_json::to_vec_pretty(&settings) {
                    Ok(bytes) => match db::write_atomic(&dest, &bytes) {
                        Ok(()) => IpcResponse::success(json!({ "path": dest.to_string_lossy(), "kind": "settings" })),
                        Err(e) => IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                    },
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                }
            } else if fmt == "json" || dest_str.to_lowercase().ends_with(".json") {
                match export_json_bundle(&conn, &settings, &dest) {
                    Ok(count) => {
                        IpcResponse::success(json!({ "path": dest.to_string_lossy(), "kind": "json", "items": count }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                let mutex = parking_lot::Mutex::new(conn);
                match db::backup(&mutex, data_dir, settings.backup_keep) {
                    Ok(snapshot) => {
                        if let Some(parent) = dest.parent() {
                            if !parent.as_os_str().is_empty() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                        }
                        if let Err(e) = std::fs::copy(&snapshot, &dest) {
                            return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                        }
                        IpcResponse::success(json!({ "path": dest.to_string_lossy(), "kind": "db" }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
        }

        "import" => {
            let Some(src_str) = p.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                return IpcResponse::fail(EXIT_USAGE, "Provide an input file path to import", None);
            };
            let src = PathBuf::from(src_str);
            if !src.exists() {
                return IpcResponse::fail(EXIT_NOT_FOUND, format!("File not found: {src_str}"), None);
            }
            let settings_only = p.get("settings").and_then(|v| v.as_bool()).unwrap_or(false);
            if settings_only {
                let text = match std::fs::read_to_string(&src) {
                    Ok(t) => t,
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                };
                match serde_json::from_str::<Settings>(&text) {
                    Ok(s) => {
                        let _ = s.save(&settings_path);
                        IpcResponse::success(json!({ "imported_settings": true, "path": src_str }))
                    }
                    Err(e) => IpcResponse::fail(EXIT_USAGE, format!("Invalid settings JSON: {e}"), None),
                }
            } else if src_str.to_lowercase().ends_with(".json") {
                match import_json_bundle(&mut conn, &settings, &src) {
                    Ok(added) => IpcResponse::success(json!({ "imported_items": added, "path": src_str })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            } else {
                let raw = match std::fs::read(&src) {
                    Ok(b) => b,
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e.to_string(), None),
                };
                let bytes = if raw.starts_with(&[0x1f, 0x8b]) {
                    let mut out = Vec::new();
                    if let Err(e) = flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out) {
                        return IpcResponse::fail(EXIT_ERROR, format!("Invalid gzip backup: {e}"), None);
                    }
                    out
                } else {
                    raw
                };
                let tmp = data_dir.join(format!("import-cli-{}.tmp.db", db::now_ms()));
                if let Err(e) = std::fs::write(&tmp, &bytes) {
                    return IpcResponse::fail(EXIT_ERROR, e.to_string(), None);
                }
                let res = db::merge_from(&conn, &tmp);
                let _ = std::fs::remove_file(&tmp);
                match res {
                    Ok(added) => IpcResponse::success(json!({ "imported_items": added, "path": src_str })),
                    Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
                }
            }
        }

        "erase" => {
            let include_pinned = p.get("include_pinned").and_then(|v| v.as_bool()).unwrap_or(false);
            let all_boards = p.get("all_boards").and_then(|v| v.as_bool()).unwrap_or(false);
            let board_spec = p.get("board").unwrap_or(&Value::Null);
            let target_board = if all_boards {
                None
            } else if !board_spec.is_null() {
                match resolve_board_id(&conn, board_spec) {
                    Ok(b) => b,
                    Err(e) => return IpcResponse::fail(EXIT_NOT_FOUND, e, None),
                }
            } else {
                None
            };
            match db::erase_history(&conn, include_pinned, target_board, all_boards) {
                Ok(n) => IpcResponse::success(json!({ "erased": n })),
                Err(e) => IpcResponse::fail(EXIT_ERROR, e, None),
            }
        }

        other => IpcResponse::fail(EXIT_USAGE, format!("Unknown operation '{other}'"), None),
    }
}

pub fn call_ipc_or_offline(
    data_dir: &Path,
    op: &str,
    params: Value,
    timeout_ms: u64,
    online_only: bool,
) -> IpcResponse {
    let ep_path = endpoint_file(data_dir);
    if let Ok(raw) = std::fs::read_to_string(&ep_path) {
        if let Ok(ep) = serde_json::from_str::<IpcEndpoint>(&raw) {
            let addr = SocketAddr::from(([127, 0, 0, 1], ep.port));
            let timeout = Duration::from_millis(timeout_ms.max(200));
            if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(450)) {
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                let req = IpcRequest {
                    protocol: PROTOCOL_VERSION,
                    version: APP_VERSION.to_string(),
                    token: ep.token,
                    op: op.to_string(),
                    params: params.clone(),
                };
                if let Ok(mut bytes) = serde_json::to_vec(&req) {
                    bytes.push(b'\n');
                    if stream.write_all(&bytes).is_ok() && stream.flush().is_ok() {
                        let mut resp_line = String::new();
                        let mut reader = BufReader::new(&stream);
                        if reader.read_line(&mut resp_line).is_ok() && !resp_line.trim().is_empty() {
                            if let Ok(resp) = serde_json::from_str::<IpcResponse>(&resp_line) {
                                return resp;
                            }
                        }
                    }
                }
            } else {
                let _ = std::fs::remove_file(&ep_path);
            }
        }
    }

    if online_only {
        return IpcResponse::fail(
            EXIT_OFFLINE,
            "ClipNest desktop app is not running (and --online-only was specified).",
            Some("Start ClipNest desktop app or omit --online-only.".into()),
        );
    }

    dispatch_offline(data_dir, op, &params)
}

const KNOWN_COMMANDS: &[&str] = &[
    "add",
    "list",
    "ls",
    "search",
    "find",
    "get",
    "copy",
    "cp",
    "paste",
    "edit",
    "rename",
    "delete",
    "rm",
    "pin",
    "unpin",
    "tag",
    "move",
    "mv",
    "merge",
    "formats",
    "transform",
    "tr",
    "category",
    "cat",
    "categories",
    "pinboard",
    "board",
    "pinboards",
    "queue",
    "basket",
    "rule",
    "rules",
    "action",
    "actions",
    "config",
    "settings",
    "status",
    "pause",
    "resume",
    "plain",
    "open",
    "show",
    "hide",
    "quit",
    "backup",
    "export",
    "import",
    "erase",
    "clear-history",
    "path",
    "help",
    "version",
];

pub fn is_cli_invocation(args: &[String]) -> bool {
    let Some(first) = args.get(1).map(|s| s.as_str()) else {
        return false;
    };
    if matches!(first, "--explorer-files" | "--paste-basket" | "--collect-file" | "--portable") {
        return false;
    }
    if matches!(first, "-h" | "--help" | "-V" | "--version") {
        return true;
    }
    KNOWN_COMMANDS.iter().any(|c| c.eq_ignore_ascii_case(first))
}

fn edit_distance(a: &str, b: &str) -> usize {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let mut dp: Vec<usize> = (0..=bc.len()).collect();
    for (i, &ca) in ac.iter().enumerate() {
        let mut prev = dp[0];
        dp[0] = i + 1;
        for (j, &cb) in bc.iter().enumerate() {
            let temp = dp[j + 1];
            let cost = if ca == cb { 0 } else { 1 };
            dp[j + 1] = (dp[j] + 1).min(dp[j + 1] + 1).min(prev + cost);
            prev = temp;
        }
    }
    dp[bc.len()]
}

fn suggest_command(unknown: &str) -> Option<&'static str> {
    let lower = unknown.to_lowercase();
    let mut best: Option<(&'static str, usize)> = None;
    for &cmd in KNOWN_COMMANDS {
        let d = edit_distance(&lower, cmd);
        if d <= 2 && best.map(|(_, b)| d < b).unwrap_or(true) {
            best = Some((cmd, d));
        }
    }
    best.map(|(c, _)| c)
}

fn read_stdin_all() -> Result<String, String> {
    let stdin = std::io::stdin();
    let mut buf = Vec::new();
    let mut handle = stdin.lock().take((MAX_STDIN_BYTES as u64) + 1);
    handle.read_to_end(&mut buf).map_err(|e| format!("Failed to read from stdin: {e}"))?;
    if buf.len() > MAX_STDIN_BYTES {
        return Err(format!("Input from stdin exceeds maximum size limit ({} MB)", MAX_STDIN_BYTES / (1024 * 1024)));
    }
    String::from_utf8(buf).map_err(|e| format!("Input from stdin is not valid UTF-8: {e}"))
}

fn read_input_source(arg_text: Option<&str>, file_path: Option<&str>, allow_empty: bool) -> Result<String, String> {
    let raw = if let Some(fp) = file_path {
        if fp == "-" {
            read_stdin_all()?
        } else {
            std::fs::read_to_string(fp).map_err(|e| format!("Cannot read file '{fp}': {e}"))?
        }
    } else if let Some(t) = arg_text {
        if t == "-" {
            read_stdin_all()?
        } else {
            t.to_string()
        }
    } else {
        return Err("Missing input text (provide text argument, '-' for stdin, or --file <path>)".into());
    };
    if !allow_empty && raw.is_empty() {
        return Err("Input is empty".into());
    }
    Ok(raw)
}

pub fn print_help(topic: Option<&str>) {
    let key = topic.unwrap_or("").to_lowercase();
    match key.as_str() {
        "add" => println!(
            "Usage: clipnest add <text|-> [options]   (or: clipn add ...)\n\n\
             Add a new item to ClipNest history (and optionally copy to the system clipboard).\n\n\
             Options:\n  \
               -c, --copy                Also copy the text to the system clipboard (reads stdin once)\n  \
               -p, --pin                 Pin the item to the top of history\n  \
               -b, --category, --board   Target category (pinboard) ID or name\n  \
               -t, --tags <tags>         Space or comma-separated tags\n  \
               --title <title>           Custom title for the item\n  \
               -f, --file <path>         Read content from a file\n  \
               --json                    Output structured JSON"
        ),
        "list" | "ls" => println!(
            "Usage: clipnest list [options]   (alias: ls)\n\n\
             List recent clipboard history items.\n\n\
             Options:\n  \
               -n, --limit <count>       Maximum items to return (default: 30)\n  \
               -b, --category, --board   Filter by category ID or name\n  \
               -k, --kind <kind>         Filter by item kind (text, code, link, image, file, color)\n  \
               --pinned                  Only show pinned items\n  \
               --json                    Output structured JSON"
        ),
        "search" | "find" => println!(
            "Usage: clipnest search <query> [options]   (alias: find)\n\n\
             Search clipboard history by keyword, fuzzy subsequence, or regular expression.\n\n\
             Options:\n  \
               -m, --mode <mode>         Search mode: smart (default), fuzzy, or regex\n  \
               -r, --regex               Shorthand for --mode regex\n  \
               -z, --fuzzy               Shorthand for --mode fuzzy\n  \
               -b, --category, --board   Restrict search to a category ID or name\n  \
               -n, --limit <count>       Maximum items to return (default: 50)\n  \
               --json                    Output structured JSON"
        ),
        "get" => println!(
            "Usage: clipnest get [id] [options]\n\n\
             Retrieve raw content from a history item (when [id] is given, e.g. 12 or @0 / latest)\n\
             or from the system clipboard (when omitted).\n\n\
             Options:\n  \
               -f, --format <fmt>        plain (default), html, formats, or meta\n  \
               -o, --out <file>          Write output directly to a file\n  \
               --json                    Output structured JSON"
        ),
        "copy" | "cp" => println!(
            "Usage: clipnest copy <text|-> [options]   (alias: cp)\n       \
             clipnest copy --id <id> [--plain]\n\n\
             Write text, piped stdin (-), a file, or an existing history item to the OS clipboard.\n\n\
             Options:\n  \
               -i, --id <id>             Copy an existing history item by ID (or @0 / latest)\n  \
               -p, --plain               Copy as plain text only\n  \
               -f, --file <path>         Read text from a file into the clipboard\n  \
               --json                    Output structured JSON"
        ),
        "paste" => println!(
            "Usage: clipnest paste [id] [--plain|--rich|--auto]\n\n\
             Copy a history item (default: @0 / latest) to the clipboard and paste into the active window."
        ),
        "edit" => println!(
            "Usage: clipnest edit <id> [new_text|-] [--title <title>] [--tags <tags>] [--file <path>]\n\n\
             Replace the text content, title, or tags of an existing history item."
        ),
        "rename" => println!(
            "Usage: clipnest rename <id> <title>\n\n\
             Set or clear the custom title of a history item."
        ),
        "delete" | "rm" => println!(
            "Usage: clipnest delete <id...> [--yes]   (alias: rm)\n\n\
             Delete one or more items from history. Deleting more than 3 items requires --yes (-y)."
        ),
        "pin" | "unpin" => println!(
            "Usage: clipnest {key} <id...> [--category <name>]\n\n\
             Pin or unpin items at the top of the list (globally or scoped to a specific category)."
        ),
        "tag" => println!(
            "Usage: clipnest tag <id> [tags...] [--add | --remove | --clear]\n\n\
             Set, add, remove, or clear tags on a history item."
        ),
        "move" | "mv" => println!(
            "Usage: clipnest move <id...> --to <category|main> [--from <category>] [--copy]   (alias: mv)\n       \
             clipnest move <id> --before <target_id> | --after <target_id> [--scope <category>]\n\n\
             Move or copy items to a category (or remove from category with --to main), or reorder items."
        ),
        "merge" => println!(
            "Usage: clipnest merge <id1> <id2> [idN...] [--sep <separator>] [--copy]\n\n\
             Merge multiple text items into a new history item."
        ),
        "formats" => println!(
            "Usage: clipnest formats [id]\n\n\
             Inspect stored clipboard/MIME formats and byte sizes for an item (default: @0)."
        ),
        "transform" | "tr" => println!(
            "Usage: clipnest transform <transform_id|list> [id|-] [--save] [--copy]   (alias: tr)\n\n\
             Run a built-in text transformation on a history item, stdin (-), or --text."
        ),
        "category" | "cat" | "categories" | "pinboard" | "board" | "pinboards" => println!(
            "Usage: clipnest category <subcommand> [options]   (aliases: cat, pinboard, board)\n\n\
             Subcommands:\n  \
               list                                          List all categories and item counts\n  \
               create <name> [--color #hex] [--max N] [--active]  Create a new category\n  \
               update <id|name> [--name N] [--color C] [--max N] [--paste-mode auto|plain|rich]\n  \
               delete <id|name> --yes                        Delete a category and its items\n  \
               activate <id|name|none>                       Route new clipboard copies into this category"
        ),
        "queue" => println!(
            "Usage: clipnest queue <status|list|add|remove|clear|toggle|close|fifo>\n\n\
             Control the sequential Paste Queue (FIFO/LIFO)."
        ),
        "basket" => println!(
            "Usage: clipnest basket <list|add|remove|cut|paste-to|clear>\n\n\
             Control the file & image Drop Basket."
        ),
        "rule" | "rules" => println!(
            "Usage: clipnest rule <list|add|enable|disable|delete>\n\n\
             Manage automatic capture rules."
        ),
        "action" | "actions" => println!(
            "Usage: clipnest action <list|run|add|delete>\n\n\
             Manage and run custom shell actions on clipboard items."
        ),
        "config" => println!(
            "Usage: clipnest config <list|get|set|reset>\n\n\
             Read, update, or reset ClipNest settings."
        ),
        "status" => println!(
            "Usage: clipnest status [--check-running] [--json]\n\n\
             Show daemon status, capture state, paste mode, item/category counts, and data directory."
        ),
        "pause" | "resume" | "plain" | "open" | "show" | "hide" | "settings" | "quit" => println!(
            "Usage: clipnest {key}\n\n\
             Control ClipNest daemon capture state or window visibility."
        ),
        "export" | "import" | "backup" | "erase" | "clear-history" => println!(
            "Usage:\n  \
               clipnest export <file> [--format json|db] [--settings]\n  \
               clipnest import <file> [--settings]\n  \
               clipnest backup [file]\n  \
               clipnest erase --yes [--category <name|main>] [--include-pinned] [--all-boards]"
        ),
        "path" => println!(
            "Usage: clipnest path [status|install|uninstall]\n\n\
             Manage ClipNest CLI ('clipnest' and 'clipn') in the current Windows user's PATH."
        ),
        _ => {
            println!(
                "ClipNest CLI v{APP_VERSION} — Fast, pipeline-friendly command-line interface for ClipNest\n\n\
                 USAGE:\n  \
                   clipnest <command> [arguments] [options]\n  \
                   clipn <command> [arguments] [options]      (short alias)\n\n\
                 CORE HISTORY & CLIPBOARD COMMANDS:\n  \
                   add <text|-> [--copy]     Add text or stdin (-) to history (with --copy: also set OS clipboard)\n  \
                   list [-n <limit>]         List recent clipboard items (--category, --kind, --pinned)\n  \
                   search <query>            Search history (--mode smart|fuzzy|regex, --category, -n)\n  \
                   get [id]                  Print item content (e.g. 'get 12', 'get @0') or OS clipboard ('get')\n  \
                   copy <text|->             Set OS clipboard from text/stdin, or copy history item ('copy --id 12')\n  \
                   paste [id]                Copy item to clipboard and paste into active window (--plain|--rich)\n  \
                   edit <id> <text|->        Replace item text and/or metadata (--title, --tags)\n  \
                   rename <id> <title>       Set or clear custom title for an item\n  \
                   delete <id...> [--yes]    Delete one or more items from history\n  \
                   pin <id...> / unpin <id>  Pin or unpin items (supports --category <name>)\n  \
                   tag <id> [tags...]        Set, --add, --remove, or --clear tags on an item\n  \
                   move <id...> --to <cat>   Move or --copy items to a category (or 'main'), or reorder (--before/--after)\n  \
                   merge <id...> [--sep <s>] Merge multiple text items into a new item (--copy)\n  \
                   formats [id]              Inspect stored MIME/clipboard formats and byte sizes for an item\n  \
                   transform <tr|list> [id|-] Run a built-in text transform (e.g. upper, json-pretty, fa-normalize)\n\n\
                 CATEGORIES (PINBOARDS), QUEUE & DROP BASKET:\n  \
                   category <subcommand>     list | create <name> | update <id> | delete <id> | activate <id|none> (alias: pinboard)\n  \
                   queue <subcommand>        status | list | add <id...> | remove <id> | clear | toggle | fifo <on|off>\n  \
                   basket <subcommand>       list | add <file|id...> | remove <id> | clear | cut <id> | paste-to <dir>\n\n\
                 AUTOMATION, SETTINGS & MAINTENANCE:\n  \
                   rule <subcommand>         list | add | enable <id|name> | disable <id|name> | delete <id|name>\n  \
                   action <subcommand>       list | run <action> <item_id> | add <name> --cmd <cmd> | delete <id>\n  \
                   config <subcommand>       list | get <key> | set <key> <json_val> | reset [key] [--yes]\n  \
                   status                    Show daemon, capture, queue, and database status\n  \
                   pause [minutes] / resume  Pause or resume clipboard capture\n  \
                   plain [on|off|toggle]     Toggle or set global plain-text paste mode\n  \
                   export <file>             Export history/categories/settings (.db.gz or .json, or --settings)\n  \
                   import <file>             Import/merge backup or export (.db.gz, .db, or .json)\n  \
                   backup [file]             Create a compressed SQLite snapshot immediately\n  \
                   erase --yes               Erase history (--category <c|main>, --include-pinned, --all-boards)\n  \
                   open / hide / settings / quit  Show or hide popup, open settings, or quit ClipNest\n  \
                   path [status|install|uninstall] Manage 'clipnest' & 'clipn' in the current Windows user's PATH\n\n\
                 Run 'clipnest <command> --help' (or 'clipn help <command>') for detailed help on any command."
            );
        }
    }
}

pub fn run_from_env() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    run_cli(&args)
}

pub fn run_cli(raw_args: &[String]) -> i32 {
    let mut json_out = false;
    let mut assume_yes = false;
    let mut online_only = false;
    let mut timeout_ms: u64 = 5000;
    let mut custom_data_dir: Option<String> = None;
    let mut args: Vec<String> = Vec::new();

    let mut i = 0;
    while i < raw_args.len() {
        let a = &raw_args[i];
        match a.as_str() {
            "--json" => json_out = true,
            "-y" | "--yes" => assume_yes = true,
            "--online-only" | "--require-running" => online_only = true,
            "--timeout" => {
                if let Some(v) = raw_args.get(i + 1) {
                    timeout_ms = v.parse().unwrap_or(5000);
                    i += 1;
                }
            }
            "--data-dir" => {
                if let Some(v) = raw_args.get(i + 1) {
                    custom_data_dir = Some(v.clone());
                    i += 1;
                }
            }
            "--portable" => {}
            _ => args.push(a.clone()),
        }
        i += 1;
    }

    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        let topic =
            if args.first().map(|s| s == "help").unwrap_or(false) { args.get(1).map(|s| s.as_str()) } else { None };
        print_help(topic);
        return EXIT_OK;
    }

    if matches!(args[0].as_str(), "-V" | "--version" | "version") {
        if json_out {
            println!(
                "{}",
                json!({ "name": "clipnest", "alias": "clipn", "version": APP_VERSION, "protocol": PROTOCOL_VERSION })
            );
        } else {
            println!("clipnest {APP_VERSION}");
        }
        return EXIT_OK;
    }

    let cmd = args[0].to_lowercase();
    let rest = &args[1..];
    let data_dir = resolve_cli_data_dir(custom_data_dir.as_deref());

    if rest.iter().any(|a| a == "-h" || a == "--help") {
        print_help(Some(&cmd));
        return EXIT_OK;
    }

    if cmd == "path" {
        let sub = rest.first().map(|s| s.as_str()).unwrap_or("status");
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
            .unwrap_or_default();
        match sub {
            "status" => {
                let in_path = win::is_dir_in_user_path(&exe_dir);
                if json_out {
                    println!("{}", json!({ "ok": true, "dir": exe_dir, "in_user_path": in_path }));
                } else if in_path {
                    println!("ClipNest CLI directory is in user PATH: {exe_dir}");
                } else {
                    println!(
                        "ClipNest CLI directory is NOT in user PATH: {exe_dir}\nRun 'clipnest path install' to add it."
                    );
                }
                return EXIT_OK;
            }
            "install" | "add" => match win::sync_user_path(&exe_dir, true) {
                Ok(changed) => {
                    if json_out {
                        println!("{}", json!({ "ok": true, "dir": exe_dir, "added": changed }));
                    } else if changed {
                        println!("Added ClipNest ('clipnest' & 'clipn') to user PATH: {exe_dir}\nOpen a new terminal window to use 'clipnest' or 'clipn' anywhere.");
                    } else {
                        println!("ClipNest is already in user PATH: {exe_dir}");
                    }
                    return EXIT_OK;
                }
                Err(e) => {
                    emit_err(
                        json_out,
                        EXIT_ERROR,
                        &e,
                        Some(&format!("You can manually add '{exe_dir}' to your Windows user PATH.")),
                    );
                    return EXIT_ERROR;
                }
            },
            "uninstall" | "remove" => match win::sync_user_path(&exe_dir, false) {
                Ok(changed) => {
                    if json_out {
                        println!("{}", json!({ "ok": true, "dir": exe_dir, "removed": changed }));
                    } else if changed {
                        println!("Removed ClipNest from user PATH: {exe_dir}");
                    } else {
                        println!("ClipNest was not present in user PATH.");
                    }
                    return EXIT_OK;
                }
                Err(e) => {
                    emit_err(json_out, EXIT_ERROR, &e, None);
                    return EXIT_ERROR;
                }
            },
            other => {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    &format!("Unknown path subcommand '{other}' (expected status, install, or uninstall)"),
                    None,
                );
                return EXIT_USAGE;
            }
        }
    }

    let (op, params, raw_output_file): (String, Value, Option<String>) = match cmd.as_str() {
        "add" => {
            let mut copy = false;
            let mut pinned = false;
            let mut board: Value = Value::Null;
            let mut tags: Option<String> = None;
            let mut title: Option<String> = None;
            let mut file_path: Option<String> = None;
            let mut positional = Vec::new();
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "-c" | "--copy" => copy = true,
                    "-p" | "--pin" | "--pinned" => pinned = true,
                    "-b" | "--board" | "--pinboard" | "--category" => {
                        if let Some(v) = rest.get(j + 1) {
                            board = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "-t" | "--tags" | "--tag" => {
                        if let Some(v) = rest.get(j + 1) {
                            tags = Some(v.clone());
                            j += 1;
                        }
                    }
                    "--title" => {
                        if let Some(v) = rest.get(j + 1) {
                            title = Some(v.clone());
                            j += 1;
                        }
                    }
                    "-f" | "--file" => {
                        if let Some(v) = rest.get(j + 1) {
                            file_path = Some(v.clone());
                            j += 1;
                        }
                    }
                    arg => positional.push(arg.to_string()),
                }
                j += 1;
            }
            let joined = if positional.is_empty() { None } else { Some(positional.join(" ")) };
            let text = match read_input_source(joined.as_deref(), file_path.as_deref(), false) {
                Ok(t) => t,
                Err(e) => {
                    emit_err(
                        json_out,
                        EXIT_USAGE,
                        &e,
                        Some("Example: clipnest add \"my note\" or echo \"hi\" | clipnest add -"),
                    );
                    return EXIT_USAGE;
                }
            };
            (
                "add".into(),
                json!({ "text": text, "copy": copy, "pinned": pinned, "board": board, "tags": tags, "title": title }),
                None,
            )
        }

        "list" | "ls" => {
            let mut board: Value = Value::Null;
            let mut limit: u64 = 30;
            let mut kind: Option<String> = None;
            let mut pinned = false;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "-b" | "--board" | "--pinboard" | "--category" | "-c" => {
                        if let Some(v) = rest.get(j + 1) {
                            board = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "-n" | "--limit" => {
                        if let Some(v) = rest.get(j + 1) {
                            limit = v.parse().unwrap_or(30);
                            j += 1;
                        }
                    }
                    "-k" | "--kind" | "--type" => {
                        if let Some(v) = rest.get(j + 1) {
                            kind = Some(v.clone());
                            j += 1;
                        }
                    }
                    "--pinned" => pinned = true,
                    _ => {}
                }
                j += 1;
            }
            (
                "list".into(),
                json!({ "query": "", "mode": "smart", "board": board, "limit": limit, "kind": kind, "pinned": pinned }),
                None,
            )
        }

        "search" | "find" => {
            let mut board: Value = Value::Null;
            let mut limit: u64 = 50;
            let mut mode = String::from("smart");
            let mut terms = Vec::new();
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "-b" | "--board" | "--pinboard" | "--category" | "-c" => {
                        if let Some(v) = rest.get(j + 1) {
                            board = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "-n" | "--limit" => {
                        if let Some(v) = rest.get(j + 1) {
                            limit = v.parse().unwrap_or(50);
                            j += 1;
                        }
                    }
                    "-m" | "--mode" => {
                        if let Some(v) = rest.get(j + 1) {
                            mode = v.clone();
                            j += 1;
                        }
                    }
                    "--regex" | "-r" => mode = "regex".into(),
                    "--fuzzy" | "-z" => mode = "fuzzy".into(),
                    arg => terms.push(arg.to_string()),
                }
                j += 1;
            }
            let query = terms.join(" ");
            if query.trim().is_empty() {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    "Search query cannot be empty",
                    Some("Usage: clipnest search \"keyword\""),
                );
                return EXIT_USAGE;
            }
            ("search".into(), json!({ "query": query, "mode": mode, "board": board, "limit": limit }), None)
        }

        "get" => {
            let mut id_val = Value::Null;
            let mut fmt = String::from("plain");
            let mut out_file: Option<String> = None;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--format" | "-f" => {
                        if let Some(v) = rest.get(j + 1) {
                            fmt = v.clone();
                            j += 1;
                        }
                    }
                    "--html" => fmt = "html".into(),
                    "--meta" => fmt = "meta".into(),
                    "--formats" => fmt = "formats".into(),
                    "-o" | "--out" | "--output" => {
                        if let Some(v) = rest.get(j + 1) {
                            out_file = Some(v.clone());
                            j += 1;
                        }
                    }
                    arg if id_val.is_null() => id_val = Value::String(arg.to_string()),
                    _ => {}
                }
                j += 1;
            }
            ("get".into(), json!({ "id": id_val, "format": fmt }), out_file)
        }

        "copy" | "cp" => {
            let mut id_val: Value = Value::Null;
            let mut plain = false;
            let mut file_path: Option<String> = None;
            let mut positional = Vec::new();
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--id" | "-i" => {
                        if let Some(v) = rest.get(j + 1) {
                            id_val = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "--plain" | "-p" => plain = true,
                    "-f" | "--file" => {
                        if let Some(v) = rest.get(j + 1) {
                            file_path = Some(v.clone());
                            j += 1;
                        }
                    }
                    arg => positional.push(arg.to_string()),
                }
                j += 1;
            }
            if !id_val.is_null() {
                ("copy".into(), json!({ "id": id_val, "plain": plain }), None)
            } else {
                let joined = if positional.is_empty() { None } else { Some(positional.join(" ")) };
                let text = match read_input_source(joined.as_deref(), file_path.as_deref(), true) {
                    Ok(t) => t,
                    Err(e) => {
                        emit_err(
                            json_out,
                            EXIT_USAGE,
                            &e,
                            Some(
                                "Usage: clipnest copy \"text\" or git diff | clipnest copy - or clipnest copy --id 12",
                            ),
                        );
                        return EXIT_USAGE;
                    }
                };
                ("copy".into(), json!({ "text": text, "plain": plain }), None)
            }
        }

        "paste" => {
            let mut mode = String::from("auto");
            let mut id_val = Value::Null;
            for arg in rest {
                match arg.as_str() {
                    "--plain" | "-p" => mode = "plain".into(),
                    "--rich" | "-r" => mode = "rich".into(),
                    "--auto" => mode = "auto".into(),
                    other if id_val.is_null() => id_val = Value::String(other.to_string()),
                    _ => {}
                }
            }
            if id_val.is_null() {
                id_val = Value::String("@0".into());
            }
            ("paste".into(), json!({ "id": id_val, "mode": mode }), None)
        }

        "edit" => {
            let Some(id_str) = rest.first() else {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    "Provide an item ID to edit",
                    Some("Usage: clipnest edit <id> <new_text|->"),
                );
                return EXIT_USAGE;
            };
            let mut title: Option<String> = None;
            let mut tags: Option<String> = None;
            let mut file_path: Option<String> = None;
            let mut positional = Vec::new();
            let mut j = 1;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--title" => {
                        if let Some(v) = rest.get(j + 1) {
                            title = Some(v.clone());
                            j += 1;
                        }
                    }
                    "-t" | "--tags" => {
                        if let Some(v) = rest.get(j + 1) {
                            tags = Some(v.clone());
                            j += 1;
                        }
                    }
                    "-f" | "--file" => {
                        if let Some(v) = rest.get(j + 1) {
                            file_path = Some(v.clone());
                            j += 1;
                        }
                    }
                    arg => positional.push(arg.to_string()),
                }
                j += 1;
            }
            let text_opt = if !positional.is_empty() || file_path.is_some() {
                let joined = if positional.is_empty() { None } else { Some(positional.join(" ")) };
                match read_input_source(joined.as_deref(), file_path.as_deref(), false) {
                    Ok(t) => Some(t),
                    Err(e) => {
                        emit_err(json_out, EXIT_USAGE, &e, None);
                        return EXIT_USAGE;
                    }
                }
            } else {
                None
            };
            if text_opt.is_none() && title.is_none() && tags.is_none() {
                emit_err(json_out, EXIT_USAGE, "Provide new text, --title, or --tags to edit", None);
                return EXIT_USAGE;
            }
            ("edit".into(), json!({ "id": id_str, "text": text_opt, "title": title, "tags": tags }), None)
        }

        "rename" => {
            let Some(id_str) = rest.first() else {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    "Provide an item ID and new title",
                    Some("Usage: clipnest rename <id> \"New Title\""),
                );
                return EXIT_USAGE;
            };
            let title = rest.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
            ("rename".into(), json!({ "id": id_str, "title": title }), None)
        }

        "delete" | "rm" => {
            let ids: Vec<Value> =
                rest.iter().filter(|a| !a.starts_with('-')).map(|s| Value::String(s.clone())).collect();
            if ids.is_empty() {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    "Provide at least one item ID to delete",
                    Some("Usage: clipnest delete <id...>"),
                );
                return EXIT_USAGE;
            }
            if ids.len() > 3 && !assume_yes {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    &format!("Refusing to bulk-delete {} items without --yes confirmation.", ids.len()),
                    Some("Re-run with --yes (-y) to confirm deleting multiple items."),
                );
                return EXIT_USAGE;
            }
            ("delete".into(), json!({ "ids": ids }), None)
        }

        "pin" | "unpin" => {
            let mut ids: Vec<Value> = Vec::new();
            let mut board: Value = Value::Null;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "-b" | "--board" | "--pinboard" | "--category" | "-c" => {
                        if let Some(v) = rest.get(j + 1) {
                            board = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    arg if !arg.starts_with('-') => ids.push(Value::String(arg.to_string())),
                    _ => {}
                }
                j += 1;
            }
            if ids.is_empty() {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    &format!("Provide at least one item ID to {cmd}"),
                    Some(&format!("Usage: clipnest {cmd} <id...> [--category <name>]")),
                );
                return EXIT_USAGE;
            }
            (cmd.clone(), json!({ "ids": ids, "board": board }), None)
        }

        "tag" => {
            let Some(id_str) = rest.first() else {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    "Provide an item ID",
                    Some("Usage: clipnest tag <id> <tags...> [--add|--remove|--clear]"),
                );
                return EXIT_USAGE;
            };
            let mut mode = "set";
            let mut tag_parts = Vec::new();
            for a in rest.iter().skip(1) {
                match a.as_str() {
                    "--clear" => mode = "clear",
                    "--add" => mode = "add",
                    "--remove" | "--rm" => mode = "remove",
                    other => tag_parts.push(other.clone()),
                }
            }
            ("tag".into(), json!({ "id": id_str, "tags": tag_parts.join(" "), "mode": mode }), None)
        }

        "move" | "mv" => {
            let mut ids = Vec::new();
            let mut to = Value::Null;
            let mut from = Value::Null;
            let mut copy = false;
            let mut before = Value::Null;
            let mut after = Value::Null;
            let mut board = Value::Null;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--to" | "-b" | "--board" | "--pinboard" | "--category" => {
                        if let Some(v) = rest.get(j + 1) {
                            to = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "--from" => {
                        if let Some(v) = rest.get(j + 1) {
                            from = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "-c" | "--copy" => copy = true,
                    "--before" => {
                        if let Some(v) = rest.get(j + 1) {
                            before = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "--after" => {
                        if let Some(v) = rest.get(j + 1) {
                            after = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    "--scope" => {
                        if let Some(v) = rest.get(j + 1) {
                            board = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    arg => ids.push(Value::String(arg.to_string())),
                }
                j += 1;
            }
            if to.is_null() && before.is_null() && after.is_null() && ids.len() >= 2 {
                to = ids.pop().unwrap_or(Value::Null);
            }
            (
                "move".into(),
                json!({ "ids": ids, "to": to, "from": from, "copy": copy, "before": before, "after": after, "board": board }),
                None,
            )
        }

        "merge" => {
            let mut ids = Vec::new();
            let mut sep = String::from("\n");
            let mut copy = false;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "-s" | "--sep" | "--separator" => {
                        if let Some(v) = rest.get(j + 1) {
                            sep = v.replace("\\n", "\n").replace("\\t", "\t");
                            j += 1;
                        }
                    }
                    "-c" | "--copy" => copy = true,
                    arg => ids.push(Value::String(arg.to_string())),
                }
                j += 1;
            }
            ("merge".into(), json!({ "ids": ids, "sep": sep, "copy": copy }), None)
        }

        "formats" => {
            let id_val = rest.first().map(|s| Value::String(s.clone())).unwrap_or_else(|| Value::String("@0".into()));
            ("formats".into(), json!({ "id": id_val }), None)
        }

        "transform" | "tr" => {
            let tr_id = rest.first().map(|s| s.as_str()).unwrap_or("list");
            if tr_id == "list" {
                ("transform".into(), json!({ "transform": "list" }), None)
            } else {
                let mut id_val = Value::Null;
                let mut text_opt: Option<String> = None;
                let mut save = false;
                let mut copy = false;
                let mut j = 1;
                while j < rest.len() {
                    match rest[j].as_str() {
                        "--save" | "-s" => save = true,
                        "--copy" | "-c" => copy = true,
                        "--text" | "-t" => {
                            if let Some(v) = rest.get(j + 1) {
                                text_opt = Some(v.clone());
                                j += 1;
                            }
                        }
                        "-" => match read_stdin_all() {
                            Ok(s) => text_opt = Some(s),
                            Err(e) => {
                                emit_err(json_out, EXIT_USAGE, &e, None);
                                return EXIT_USAGE;
                            }
                        },
                        arg if id_val.is_null() => id_val = Value::String(arg.to_string()),
                        _ => {}
                    }
                    j += 1;
                }
                (
                    "transform".into(),
                    json!({ "transform": tr_id, "id": id_val, "text": text_opt, "save": save, "copy": copy }),
                    None,
                )
            }
        }

        "categories" | "pinboards" => ("pinboard".into(), json!({ "sub": "list" }), None),
        "category" | "cat" | "pinboard" | "board" => {
            let sub = rest.first().map(|s| s.as_str()).unwrap_or("list");
            match sub {
                "list" | "ls" => ("pinboard".into(), json!({ "sub": "list" }), None),
                "create" | "add" => {
                    let mut name = String::new();
                    let mut color = String::from("#4f8cff");
                    let mut max_items = 0i64;
                    let mut list_style = String::from("inherit");
                    let mut paste_mode = String::from("inherit");
                    let mut active = false;
                    let mut j = 1;
                    while j < rest.len() {
                        match rest[j].as_str() {
                            "--color" | "-c" => {
                                if let Some(v) = rest.get(j + 1) {
                                    color = v.clone();
                                    j += 1;
                                }
                            }
                            "--max" | "--max-items" => {
                                if let Some(v) = rest.get(j + 1) {
                                    max_items = v.parse().unwrap_or(0);
                                    j += 1;
                                }
                            }
                            "--style" => {
                                if let Some(v) = rest.get(j + 1) {
                                    list_style = v.clone();
                                    j += 1;
                                }
                            }
                            "--paste-mode" => {
                                if let Some(v) = rest.get(j + 1) {
                                    paste_mode = v.clone();
                                    j += 1;
                                }
                            }
                            "--active" => active = true,
                            arg if name.is_empty() => name = arg.to_string(),
                            _ => {}
                        }
                        j += 1;
                    }
                    (
                        "pinboard".into(),
                        json!({
                            "sub": "create",
                            "name": name,
                            "color": color,
                            "max_items": max_items,
                            "list_style": list_style,
                            "paste_mode": paste_mode,
                            "active": active,
                        }),
                        None,
                    )
                }
                "update" | "edit" => {
                    let target = rest.get(1).cloned().unwrap_or_default();
                    let mut params_obj = json!({ "sub": "update", "board": target });
                    let mut j = 2;
                    while j < rest.len() {
                        match rest[j].as_str() {
                            "--name" => {
                                if let Some(v) = rest.get(j + 1) {
                                    params_obj["name"] = Value::String(v.clone());
                                    j += 1;
                                }
                            }
                            "--color" | "-c" => {
                                if let Some(v) = rest.get(j + 1) {
                                    params_obj["color"] = Value::String(v.clone());
                                    j += 1;
                                }
                            }
                            "--max" | "--max-items" => {
                                if let Some(v) = rest.get(j + 1) {
                                    params_obj["max_items"] = json!(v.parse::<i64>().unwrap_or(0));
                                    j += 1;
                                }
                            }
                            "--style" => {
                                if let Some(v) = rest.get(j + 1) {
                                    params_obj["list_style"] = Value::String(v.clone());
                                    j += 1;
                                }
                            }
                            "--paste-mode" => {
                                if let Some(v) = rest.get(j + 1) {
                                    params_obj["paste_mode"] = Value::String(v.clone());
                                    j += 1;
                                }
                            }
                            "--active" => params_obj["active"] = Value::Bool(true),
                            "--inactive" => params_obj["active"] = Value::Bool(false),
                            _ => {}
                        }
                        j += 1;
                    }
                    ("pinboard".into(), params_obj, None)
                }
                "delete" | "rm" => {
                    if !assume_yes {
                        emit_err(
                            json_out,
                            EXIT_USAGE,
                            "Deleting a category also deletes its items. Pass --yes (-y) to confirm.",
                            Some("Usage: clipnest category delete <id|name> --yes"),
                        );
                        return EXIT_USAGE;
                    }
                    let target = rest.get(1).cloned().unwrap_or_default();
                    ("pinboard".into(), json!({ "sub": "delete", "board": target }), None)
                }
                "activate" | "use" => {
                    let target = rest.get(1).cloned().unwrap_or_else(|| "none".into());
                    ("pinboard".into(), json!({ "sub": "activate", "board": target }), None)
                }
                other => {
                    emit_err(json_out, EXIT_USAGE, &format!("Unknown category subcommand '{other}'"), None);
                    return EXIT_USAGE;
                }
            }
        }

        "queue" | "basket" => {
            let sub = rest.first().map(|s| s.as_str()).unwrap_or("list");
            match sub {
                "status" | "list" | "ls" | "clear" | "toggle" | "close" => {
                    (cmd.clone(), json!({ "sub": if sub == "ls" { "list" } else { sub } }), None)
                }
                "add" => {
                    let items: Vec<Value> = rest.iter().skip(1).map(|s| Value::String(s.clone())).collect();
                    (cmd.clone(), json!({ "sub": "add", "items": items }), None)
                }
                "remove" | "rm" | "cut" => {
                    let id = rest.get(1).cloned().unwrap_or_default();
                    let s_name = if sub == "rm" { "remove" } else { sub };
                    (cmd.clone(), json!({ "sub": s_name, "id": id }), None)
                }
                "mode" => {
                    let m = rest.get(1).cloned().unwrap_or_else(|| "queue".into());
                    (cmd.clone(), json!({ "sub": "mode", "mode": m }), None)
                }
                "fifo" => {
                    let v = rest.get(1).map(|s| !matches!(s.as_str(), "off" | "false" | "lifo" | "0")).unwrap_or(true);
                    (cmd.clone(), json!({ "sub": "fifo", "fifo": v }), None)
                }
                "paste-to" => {
                    let folder = rest.get(1).cloned().unwrap_or_default();
                    (cmd.clone(), json!({ "sub": "paste-to", "folder": folder }), None)
                }
                other => {
                    emit_err(json_out, EXIT_USAGE, &format!("Unknown {cmd} subcommand '{other}'"), None);
                    return EXIT_USAGE;
                }
            }
        }

        "rules" => ("rule".into(), json!({ "sub": "list" }), None),
        "rule" => {
            let sub = rest.first().map(|s| s.as_str()).unwrap_or("list");
            match sub {
                "list" | "ls" => ("rule".into(), json!({ "sub": "list" }), None),
                "enable" | "disable" | "delete" | "rm" => {
                    let target = rest.get(1).cloned().unwrap_or_default();
                    let s_name = if sub == "rm" { "delete" } else { sub };
                    ("rule".into(), json!({ "sub": s_name, "target": target }), None)
                }
                "add" => {
                    let mut name = String::from("CLI Rule");
                    let mut action = String::from("ignore");
                    let mut apps = String::new();
                    let mut pattern = String::new();
                    let mut value = String::new();
                    let mut board = 0i64;
                    let mut kinds = Vec::<String>::new();
                    let mut j = 1;
                    while j < rest.len() {
                        match rest[j].as_str() {
                            "--name" => {
                                if let Some(v) = rest.get(j + 1) {
                                    name = v.clone();
                                    j += 1;
                                }
                            }
                            "--action" => {
                                if let Some(v) = rest.get(j + 1) {
                                    action = v.clone();
                                    j += 1;
                                }
                            }
                            "--apps" => {
                                if let Some(v) = rest.get(j + 1) {
                                    apps = v.clone();
                                    j += 1;
                                }
                            }
                            "--pattern" => {
                                if let Some(v) = rest.get(j + 1) {
                                    pattern = v.clone();
                                    j += 1;
                                }
                            }
                            "--value" => {
                                if let Some(v) = rest.get(j + 1) {
                                    value = v.clone();
                                    j += 1;
                                }
                            }
                            "--board" | "--category" => {
                                if let Some(v) = rest.get(j + 1) {
                                    board = v.parse().unwrap_or(0);
                                    j += 1;
                                }
                            }
                            "--kind" => {
                                if let Some(v) = rest.get(j + 1) {
                                    kinds.push(v.clone());
                                    j += 1;
                                }
                            }
                            arg if name == "CLI Rule" => name = arg.to_string(),
                            _ => {}
                        }
                        j += 1;
                    }
                    (
                        "rule".into(),
                        json!({
                            "sub": "add",
                            "name": name,
                            "action": action,
                            "apps": apps,
                            "pattern": pattern,
                            "value": value,
                            "board": board,
                            "kinds": kinds,
                        }),
                        None,
                    )
                }
                other => {
                    emit_err(json_out, EXIT_USAGE, &format!("Unknown rule subcommand '{other}'"), None);
                    return EXIT_USAGE;
                }
            }
        }

        "actions" => ("action".into(), json!({ "sub": "list" }), None),
        "action" => {
            let sub = rest.first().map(|s| s.as_str()).unwrap_or("list");
            match sub {
                "list" | "ls" => ("action".into(), json!({ "sub": "list" }), None),
                "run" => {
                    let target = rest.get(1).cloned().unwrap_or_default();
                    let item_id = rest.get(2).cloned().unwrap_or_else(|| "@0".into());
                    ("action".into(), json!({ "sub": "run", "target": target, "id": item_id }), None)
                }
                "add" => {
                    let mut name = String::new();
                    let mut command = String::new();
                    let mut output = String::from("new_item");
                    let mut j = 1;
                    while j < rest.len() {
                        match rest[j].as_str() {
                            "--cmd" | "--command" | "-c" => {
                                if let Some(v) = rest.get(j + 1) {
                                    command = v.clone();
                                    j += 1;
                                }
                            }
                            "--output" | "-o" => {
                                if let Some(v) = rest.get(j + 1) {
                                    output = v.clone();
                                    j += 1;
                                }
                            }
                            arg if name.is_empty() => name = arg.to_string(),
                            _ => {}
                        }
                        j += 1;
                    }
                    ("action".into(), json!({ "sub": "add", "name": name, "command": command, "output": output }), None)
                }
                "delete" | "rm" => {
                    let target = rest.get(1).cloned().unwrap_or_default();
                    ("action".into(), json!({ "sub": "delete", "target": target }), None)
                }
                other => {
                    emit_err(json_out, EXIT_USAGE, &format!("Unknown action subcommand '{other}'"), None);
                    return EXIT_USAGE;
                }
            }
        }

        "config" => {
            let sub = rest.first().map(|s| s.as_str()).unwrap_or("list");
            match sub {
                "list" | "ls" => ("config".into(), json!({ "sub": "list" }), None),
                "get" => {
                    let key = rest.get(1).cloned().unwrap_or_default();
                    ("config".into(), json!({ "sub": "get", "key": key }), None)
                }
                "set" => {
                    let key = rest.get(1).cloned().unwrap_or_default();
                    let raw = rest.get(2).cloned().unwrap_or_default();
                    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
                    ("config".into(), json!({ "sub": "set", "key": key, "value": parsed }), None)
                }
                "reset" => {
                    let key = rest.get(1).cloned();
                    if key.is_none() && !assume_yes {
                        emit_err(
                            json_out,
                            EXIT_USAGE,
                            "Resetting all settings requires --yes (-y)",
                            Some("Usage: clipnest config reset --yes OR clipnest config reset <key>"),
                        );
                        return EXIT_USAGE;
                    }
                    ("config".into(), json!({ "sub": "reset", "key": key }), None)
                }
                other => {
                    emit_err(json_out, EXIT_USAGE, &format!("Unknown config subcommand '{other}'"), None);
                    return EXIT_USAGE;
                }
            }
        }

        "status" => ("status".into(), json!({}), None),
        "pause" => {
            let mins = rest.first().and_then(|s| s.parse::<u64>().ok());
            ("pause".into(), json!({ "minutes": mins }), None)
        }
        "resume" => ("resume".into(), json!({}), None),
        "plain" => {
            let mode = rest.first().cloned().unwrap_or_else(|| "toggle".into());
            ("plain".into(), json!({ "mode": mode }), None)
        }
        "open" | "show" => ("open".into(), json!({}), None),
        "hide" => ("hide".into(), json!({}), None),
        "settings" => ("settings".into(), json!({}), None),
        "quit" => ("quit".into(), json!({}), None),
        "backup" => {
            let path = rest.first().cloned();
            ("backup".into(), json!({ "path": path }), None)
        }
        "export" => {
            let mut path = String::new();
            let mut format = String::new();
            let mut settings_only = false;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--format" | "-f" => {
                        if let Some(v) = rest.get(j + 1) {
                            format = v.clone();
                            j += 1;
                        }
                    }
                    "--settings" => settings_only = true,
                    arg if path.is_empty() => path = arg.to_string(),
                    _ => {}
                }
                j += 1;
            }
            ("export".into(), json!({ "path": path, "format": format, "settings": settings_only }), None)
        }
        "import" => {
            let mut path = String::new();
            let mut settings_only = false;
            for a in rest {
                if a == "--settings" {
                    settings_only = true;
                } else if path.is_empty() {
                    path = a.clone();
                }
            }
            ("import".into(), json!({ "path": path, "settings": settings_only }), None)
        }
        "erase" | "clear-history" => {
            if !assume_yes {
                emit_err(
                    json_out,
                    EXIT_USAGE,
                    "Erasing history is permanent. Pass --yes (-y) to confirm.",
                    Some("Example: clipnest erase --yes [--category Work] [--include-pinned] [--all-boards]"),
                );
                return EXIT_USAGE;
            }
            let mut include_pinned = false;
            let mut all_boards = false;
            let mut board = Value::Null;
            let mut j = 0;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--include-pinned" | "--pinned" => include_pinned = true,
                    "--all-boards" | "--all" => all_boards = true,
                    "-b" | "--board" | "--pinboard" | "--category" | "-c" => {
                        if let Some(v) = rest.get(j + 1) {
                            board = Value::String(v.clone());
                            j += 1;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            (
                "erase".into(),
                json!({ "include_pinned": include_pinned, "all_boards": all_boards, "board": board }),
                None,
            )
        }

        unknown => {
            let hint = suggest_command(unknown)
                .map(|s| format!("Did you mean 'clipnest {s}'? Run 'clipnest --help' for all commands."));
            emit_err(json_out, EXIT_USAGE, &format!("Unknown command '{unknown}'"), hint.as_deref());
            return EXIT_USAGE;
        }
    };

    let check_running_flag = rest.iter().any(|a| a == "--check-running");
    let resp = call_ipc_or_offline(&data_dir, &op, params, timeout_ms, online_only);

    if !resp.ok {
        emit_err(json_out, resp.exit_code, resp.error.as_deref().unwrap_or("Operation failed"), resp.hint.as_deref());
        return resp.exit_code;
    }

    if op == "status" && check_running_flag && !resp.data.get("running").and_then(|v| v.as_bool()).unwrap_or(false) {
        if json_out {
            println!("{}", serde_json::to_string_pretty(&resp.data).unwrap_or_default());
        } else {
            println!(
                "ClipNest is offline (data_dir: {})",
                resp.data.get("data_dir").and_then(|v| v.as_str()).unwrap_or("")
            );
        }
        return EXIT_OFFLINE;
    }

    if json_out {
        println!("{}", serde_json::to_string_pretty(&resp.data).unwrap_or_default());
        return resp.exit_code;
    }

    render_human_output(&op, &resp.data, raw_output_file.as_deref())
}

fn emit_err(json_out: bool, code: i32, msg: &str, hint: Option<&str>) {
    if json_out {
        eprintln!(
            "{}",
            json!({
                "ok": false,
                "exit_code": code,
                "error": msg,
                "hint": hint,
            })
        );
    } else {
        eprintln!("Error: {msg}");
        if let Some(h) = hint {
            eprintln!("Hint:  {h}");
        }
    }
}

fn render_human_output(op: &str, data: &Value, raw_output_file: Option<&str>) -> i32 {
    match op {
        "get" => {
            if let Some(formats) = data.get("formats").and_then(|v| v.as_array()) {
                for f in formats {
                    println!(
                        "{:<28} {:<26} {} B",
                        f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        f.get("mime").and_then(|v| v.as_str()).unwrap_or(""),
                        f.get("size").and_then(|v| v.as_i64()).unwrap_or(0)
                    );
                }
                return EXIT_OK;
            }
            if let Some(item) = data.get("item").filter(|_| data.get("text").is_none()) {
                println!("{}", serde_json::to_string_pretty(item).unwrap_or_default());
                return EXIT_OK;
            }
            let text = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(out_path) = raw_output_file {
                if let Err(e) = db::write_atomic(Path::new(out_path), text.as_bytes()) {
                    eprintln!("Error: Cannot write to '{out_path}': {e}");
                    return EXIT_ERROR;
                }
                return EXIT_OK;
            }
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(text.as_bytes());
            let _ = stdout.flush();
            EXIT_OK
        }
        "transform" => {
            if let Some(list) = data.get("transforms").and_then(|v| v.as_array()) {
                println!("{:<18} {:<12} {}", "ID", "GROUP", "DESCRIPTION");
                for t in list {
                    println!(
                        "{:<18} {:<12} {}",
                        t.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        t.get("group").and_then(|v| v.as_str()).unwrap_or(""),
                        t.get("label").and_then(|v| v.as_str()).unwrap_or("")
                    );
                }
                return EXIT_OK;
            }
            let text = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(text.as_bytes());
            let _ = stdout.flush();
            EXIT_OK
        }
        "add" => {
            let id = data.get("item").and_then(|i| i.get("id")).and_then(|v| v.as_i64()).unwrap_or(0);
            let copied = data.get("copied").and_then(|v| v.as_bool()).unwrap_or(false);
            if copied {
                println!("Added item #{id} and copied to clipboard.");
            } else {
                println!("{id}");
            }
            EXIT_OK
        }
        "list" | "search" => {
            let items = data.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if items.is_empty() {
                println!("No items found.");
                return EXIT_OK;
            }
            println!("{:<6} {:<7} {:<5} {:<14} {}", "ID", "KIND", "PIN", "APP", "PREVIEW");
            for it in items {
                let id = it.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                let kind = it.get("kind").and_then(|v| v.as_str()).unwrap_or("text");
                let pinned = if it.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false) { "★" } else { "" };
                let app = it.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
                let preview = it.get("preview").and_then(|v| v.as_str()).unwrap_or("").replace(['\r', '\n', '\t'], " ");
                let short: String = preview.chars().take(68).collect();
                println!("{:<6} {:<7} {:<5} {:<14} {}", id, kind, pinned, app, short);
            }
            EXIT_OK
        }
        "formats" => {
            let fmts = data.get("formats").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if fmts.is_empty() {
                println!("No stored formats.");
                return EXIT_OK;
            }
            println!("{:<28} {:<28} {}", "FORMAT", "MIME", "BYTES");
            for f in fmts {
                println!(
                    "{:<28} {:<28} {}",
                    f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    f.get("mime").and_then(|v| v.as_str()).unwrap_or(""),
                    f.get("size").and_then(|v| v.as_i64()).unwrap_or(0)
                );
            }
            EXIT_OK
        }
        "status" => {
            let running = data.get("running").and_then(|v| v.as_bool()).unwrap_or(false);
            let total = data.get("total_items").and_then(|v| v.as_i64()).unwrap_or(0);
            let boards = data.get("pinboards_count").and_then(|v| v.as_i64()).unwrap_or(0);
            let paused = data.get("paused_until").and_then(|v| v.as_i64()).unwrap_or(0) > 0;
            let plain = data.get("plain_default").and_then(|v| v.as_bool()).unwrap_or(false);
            let q_active = data.get("queue_active").and_then(|v| v.as_bool()).unwrap_or(false);
            let q_mode = data.get("queue_mode").and_then(|v| v.as_str()).unwrap_or("queue");
            let q_len = data.get("queue_len").and_then(|v| v.as_i64()).unwrap_or(0);
            let dir = data.get("data_dir").and_then(|v| v.as_str()).unwrap_or("");
            println!("ClipNest v{APP_VERSION}");
            println!("  Daemon:        {}", if running { "running" } else { "offline (direct DB mode)" });
            println!("  Capture:       {}", if paused { "paused" } else { "active" });
            println!("  Paste mode:    {}", if plain { "plain text" } else { "rich (keep formatting)" });
            println!("  History items: {total} ({boards} categories)");
            println!("  Queue/Basket:  {} ({q_mode}, {q_len} items)", if q_active { "active" } else { "inactive" });
            println!("  Data folder:   {dir}");
            EXIT_OK
        }
        "pinboard" | "category" => {
            if let Some(boards) = data.get("pinboards").and_then(|v| v.as_array()) {
                let active = data.get("active_pinboard").and_then(|v| v.as_i64());
                if boards.is_empty() {
                    println!("No categories created.");
                    return EXIT_OK;
                }
                println!("{:<5} {:<8} {:<18} {:<8} {:<10} {}", "ID", "ACTIVE", "NAME", "ITEMS", "COLOR", "PASTE");
                for b in boards {
                    let id = b.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                    let is_act = if active == Some(id) { "●" } else { "" };
                    println!(
                        "{:<5} {:<8} {:<18} {:<8} {:<10} {}",
                        id,
                        is_act,
                        b.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        b.get("count").and_then(|v| v.as_i64()).unwrap_or(0),
                        b.get("color").and_then(|v| v.as_str()).unwrap_or(""),
                        b.get("paste_mode").and_then(|v| v.as_str()).unwrap_or("inherit")
                    );
                }
            } else {
                println!("{}", serde_json::to_string_pretty(data).unwrap_or_default());
            }
            EXIT_OK
        }
        _ => {
            println!("{}", serde_json::to_string_pretty(data).unwrap_or_default());
            EXIT_OK
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_cli_crud_search_pinboards_and_export_roundtrip() {
        let dir = std::env::temp_dir().join(format!("clipnest_cli_test_{}", db::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();

        let r_add = dispatch_offline(
            &dir,
            "add",
            &json!({ "text": "First CLI Line\nSecond CLI Line\n", "pinned": true, "tags": "cli,test", "title": "Greeting" }),
        );
        assert!(r_add.ok);
        let id1 = r_add.data["item"]["id"].as_i64().unwrap();
        assert_eq!(r_add.data["item"]["pinned"], true);
        assert_eq!(r_add.data["item"]["tags"], "cli test");

        let r_get = dispatch_offline(&dir, "get", &json!({ "id": id1, "format": "plain" }));
        assert!(r_get.ok);
        assert_eq!(r_get.data["text"].as_str().unwrap(), "First CLI Line\nSecond CLI Line\n");

        let r_edit = dispatch_offline(&dir, "edit", &json!({ "id": id1, "text": "Updated CLI Content" }));
        assert!(r_edit.ok);
        assert_eq!(r_edit.data["item"]["preview"], "Updated CLI Content");

        let r_pb =
            dispatch_offline(&dir, "pinboard", &json!({ "sub": "create", "name": "DevBoard", "color": "#34c759" }));
        assert!(r_pb.ok);
        let bid = r_pb.data["id"].as_i64().unwrap();

        let r_mv = dispatch_offline(&dir, "move", &json!({ "ids": [id1], "to": "DevBoard" }));
        assert!(r_mv.ok);
        assert_eq!(r_mv.data["pinboard_id"].as_i64().unwrap(), bid);

        let r_search = dispatch_offline(&dir, "search", &json!({ "query": "Updated", "mode": "smart", "limit": 10 }));
        assert!(r_search.ok);
        assert_eq!(r_search.data["items"].as_array().unwrap().len(), 1);

        let r_tr = dispatch_offline(
            &dir,
            "transform",
            &json!({ "transform": "fa-normalize", "text": "كتاب ٢", "save": false }),
        );
        assert!(r_tr.ok);
        assert_eq!(r_tr.data["text"], "کتاب 2");

        let export_file = dir.join("backup.json");
        let r_exp = dispatch_offline(&dir, "export", &json!({ "path": export_file.to_string_lossy() }));
        assert!(r_exp.ok);
        assert!(export_file.exists());

        let r_erase = dispatch_offline(&dir, "erase", &json!({ "include_pinned": true, "all_boards": true }));
        assert!(r_erase.ok);

        let r_imp = dispatch_offline(&dir, "import", &json!({ "path": export_file.to_string_lossy() }));
        assert!(r_imp.ok);
        assert_eq!(r_imp.data["imported_items"].as_u64().unwrap(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
