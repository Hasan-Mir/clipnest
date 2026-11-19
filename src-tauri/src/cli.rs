//! Online IPC Server for the running Tauri desktop app (`src-tauri/src/cli.rs`).
//! Re-exports the shared IPC & offline CLI engine from `clipnest_core::ipc`.

pub use clipnest_core::ipc::*;

use crate::capture::{extract_cf_html, utf16_bytes};
use crate::db;
use crate::platform::win;
use crate::search::{self, ListArgs};
use crate::state::{AppState, AutoRule, CustomAction, Settings};
use crate::transforms::{self, TRANSFORM_LIST};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const MAX_CONCURRENT_IPC_CLIENTS: usize = 16;
const MAX_IPC_FRAME_BYTES: usize = MAX_STDIN_BYTES + 1024 * 1024;
const IPC_TOTAL_READ_DEADLINE: Duration = Duration::from_secs(15);

struct ActiveConnGuard(Arc<AtomicUsize>);
impl Drop for ActiveConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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
        let token = match win::random_bytes(32) {
            Ok(bytes) => bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            Err(e) => {
                eprintln!("clipnest: could not generate secure IPC token: {e}");
                return;
            }
        };

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

        let active_conns = Arc::new(AtomicUsize::new(0));
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else {
                continue;
            };
            if active_conns.fetch_add(1, Ordering::AcqRel) >= MAX_CONCURRENT_IPC_CLIENTS {
                active_conns.fetch_sub(1, Ordering::AcqRel);
                drop(stream);
                continue;
            }
            let guard = ActiveConnGuard(Arc::clone(&active_conns));
            let app_clone = app.clone();
            let expected_token = token.clone();
            std::thread::spawn(move || {
                let _guard = guard;
                handle_ipc_client(stream, &app_clone, &expected_token);
            });
        }
    });
}

fn read_ipc_line(stream: &TcpStream, max_bytes: usize, deadline: Instant) -> Result<Option<String>, String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let mut reader = stream;
    loop {
        let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
            return Err("IPC read deadline exceeded".into());
        };
        let _ = stream.set_read_timeout(Some(rem));
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(nl) = chunk[..n].iter().position(|&b| b == b'\n') {
                    buf.extend_from_slice(&chunk[..nl]);
                    break;
                }
                if buf.len().saturating_add(n) > max_bytes {
                    return Err(format!("IPC request exceeds maximum frame size ({max_bytes} bytes)"));
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(e) => return Err(format!("IPC read failed: {e}")),
        }
    }
    if buf.is_empty() {
        return Ok(None);
    }
    String::from_utf8(buf).map(Some).map_err(|e| format!("Invalid UTF-8 in IPC request: {e}"))
}

fn handle_ipc_client(mut stream: TcpStream, app: &AppHandle, expected_token: &str) {
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

    let line = match read_ipc_line(&stream, MAX_IPC_FRAME_BYTES, Instant::now() + IPC_TOTAL_READ_DEADLINE) {
        Ok(Some(l)) if !l.trim().is_empty() => l,
        Ok(_) => return,
        Err(msg) => {
            let resp = IpcResponse::fail(EXIT_USAGE, msg, None);
            if let Ok(mut out) = serde_json::to_vec(&resp) {
                out.push(b'\n');
                let _ = stream.write_all(&out);
                let _ = stream.flush();
            }
            return;
        }
    };

    let resp = match serde_json::from_str::<IpcRequest>(&line) {
        Ok(req) => {
            if !constant_time_eq(req.token.as_bytes(), expected_token.as_bytes()) {
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
                        match state.write_clipboard_self(&[(
                            win::CF_UNICODETEXT_ID,
                            "CF_UNICODETEXT".into(),
                            utf16_bytes(text),
                        )]) {
                            Ok(_seq) => IpcResponse::success(json!({
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
                            .and_then(|d| extract_cf_html(&d))
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
                match state.write_clipboard_self(&[(
                    win::CF_UNICODETEXT_ID,
                    "CF_UNICODETEXT".into(),
                    utf16_bytes(text),
                )]) {
                    Ok(_seq) => IpcResponse::success(json!({
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
                    let row = db::get_row(&state.db.lock(), new_id);
                    if also_copy {
                        if let Err(e) = crate::paste::copy_only(app, new_id, "auto") {
                            return IpcResponse {
                                ok: false,
                                exit_code: EXIT_PARTIAL,
                                data: json!({ "id": new_id, "item": row, "copied": false }),
                                error: Some(format!(
                                    "Merged item #{new_id} saved, but failed to copy to clipboard: {e}"
                                )),
                                hint: None,
                            };
                        }
                    }
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
                match state.write_clipboard_self(&[(
                    win::CF_UNICODETEXT_ID,
                    "CF_UNICODETEXT".into(),
                    utf16_bytes(&out),
                )]) {
                    Ok(_seq) => {}
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
                    let (active, mode, ids, basket) = {
                        let q = state.queue.lock();
                        (q.active, q.mode.clone(), q.items.clone(), q.basket.clone())
                    };
                    let items = {
                        let conn = state.db.lock();
                        if is_basket {
                            let mut out = Vec::new();
                            for e in &basket {
                                if !out.iter().any(|r: &db::ClipRow| r.id == e.id) {
                                    if let Some(mut row) = db::get_row(&conn, e.id) {
                                        row.cut = e.cut;
                                        out.push(row);
                                    }
                                }
                            }
                            out
                        } else {
                            db::get_rows(&conn, &ids)
                        }
                    };
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
                            let paths: Vec<Option<String>> = if row.kind == "file" {
                                let plain = { db::get_plain(&state.db.lock(), id).map(|(_, p)| p).unwrap_or_default() };
                                plain
                                    .lines()
                                    .map(|l| l.trim())
                                    .filter(|l| !l.is_empty())
                                    .map(|l| Some(l.to_string()))
                                    .collect()
                            } else {
                                vec![None]
                            };
                            let mut q = state.queue.lock();
                            q.active = true;
                            q.mode = "basket".into();
                            crate::queue::push_basket_paths(&mut q.basket, id, paths, false, false);
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
                let tmp = match prepare_import_db_temp(&src, &state.data_dir) {
                    Ok(p) => p,
                    Err(e) => return IpcResponse::fail(EXIT_ERROR, e, None),
                };
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
