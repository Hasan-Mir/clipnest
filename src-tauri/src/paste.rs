//! Writing a clip back to the clipboard and pasting it into the previously focused app.

use crate::capture::{png_to_dib, text_format, utf16_bytes};
use crate::db;
use crate::platform::win;
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Decides plain vs rich and which key combination to send.
/// `mode`: "auto" (settings + per-app rules + per-pinboard paste_mode) | "plain" | "rich".
pub fn resolve(app: &AppHandle, mode: &str, target_exe: &str, item_id: Option<i64>) -> (bool, String) {
    let st = app.state::<AppState>();
    let s = st.settings.read().clone();
    let exe = target_exe.to_lowercase();
    let rule = s.app_rules.iter().find(|r| r.exe.eq_ignore_ascii_case(&exe));
    let keys = rule
        .map(|r| if r.keys.is_empty() { "ctrl+v".to_string() } else { r.keys.clone() })
        .unwrap_or_else(|| "ctrl+v".into());
    let board_pmode = item_id.and_then(|id| db::get_board_paste_mode(&st.db.lock(), id));
    let plain = match mode {
        "plain" => true,
        "rich" => false,
        _ => match rule.map(|r| r.mode.as_str()) {
            Some("plain") => true,
            Some("rich") => false,
            _ => match board_pmode.as_deref() {
                Some("plain") => true,
                Some("rich") => false,
                _ => s.default_mode == "plain",
            },
        },
    };
    (plain, keys)
}

/// Puts the clip on the system clipboard (all stored formats, or only plain text).
pub fn write_item(app: &AppHandle, id: i64, plain: bool) -> Result<(), String> {
    let st = app.state::<AppState>();
    let (kind, plain_text, fmts) = {
        let conn = st.db.lock();
        let (k, p) = db::get_plain(&conn, id).ok_or("item not found")?;
        (k, p, db::get_formats(&conn, id))
    };
    let mut items: Vec<(u32, String, Vec<u8>)> = Vec::new();
    let use_plain = (plain && kind != "image") || fmts.is_empty();
    if use_plain {
        items.push((win::CF_UNICODETEXT_ID, "CF_UNICODETEXT".into(), utf16_bytes(&plain_text)));
    } else {
        let mut has_dib = false;
        let mut png: Option<&Vec<u8>> = None;
        for f in &fmts {
            if f.fmt_id == win::CF_DIB_ID || f.fmt_id == win::CF_DIBV5_ID {
                has_dib = true;
            }
            if f.name == "PNG" {
                png = Some(&f.data);
            }
        }
        for f in &fmts {
            items.push((f.fmt_id, f.name.clone(), f.data.clone()));
        }
        if kind == "image" && !has_dib {
            if let Some(p) = png {
                if let Some(dib) = png_to_dib(p) {
                    items.push((win::CF_DIB_ID, "CF_DIB".into(), dib));
                }
            }
        }
        if !items.iter().any(|i| i.0 == win::CF_UNICODETEXT_ID) && !plain_text.is_empty() {
            let t = text_format(&plain_text);
            items.push((t.fmt_id, t.name, t.data));
        }
    }
    st.self_write_at.store(db::now_ms(), Ordering::SeqCst);
    let seq = win::write_clipboard(&items)?;
    st.self_seq.store(seq, Ordering::SeqCst);
    st.self_write_at.store(db::now_ms(), Ordering::SeqCst);
    Ok(())
}

fn bump(app: &AppHandle, id: i64) {
    let st = app.state::<AppState>();
    if st.settings.read().move_to_top {
        db::touch(&st.db.lock(), id);
        let _ = app.emit("items-changed", ());
    }
}

/// Copy to the clipboard, hide the popup (unless pinned), and (if enabled) send the paste keystroke to the target app.
pub fn paste(app: &AppHandle, id: i64, mode: &str) -> Result<(), String> {
    let st = app.state::<AppState>();
    let target = st.target_hwnd.load(Ordering::SeqCst);
    let exe = win::exe_of_hwnd(target);
    let (plain, keys) = resolve(app, mode, &exe, Some(id));
    write_item(app, id, plain)?;
    bump(app, id);
    if !st.popup_pinned.load(Ordering::SeqCst) {
        crate::windowing::hide_popup(app);
    }
    // Opened from the tray there is no target window: only copy, never fire Ctrl+V at random windows.
    let direct = st.settings.read().direct_paste && target != 0;
    if direct {
        send_to_target(app.clone(), keys);
    }
    Ok(())
}

pub fn copy_only(app: &AppHandle, id: i64, mode: &str) -> Result<(), String> {
    let st = app.state::<AppState>();
    let (plain, _) = resolve(app, mode, "", Some(id));
    write_item(app, id, plain)?;
    bump(app, id);
    if !st.popup_pinned.load(Ordering::SeqCst) {
        crate::windowing::hide_popup(app);
    }
    Ok(())
}

/// Returns focus to the app that was active before the popup, then sends the keys.
pub fn send_to_target(app: AppHandle, keys: String) {
    struct InterceptSuspendGuard {
        app: AppHandle,
        acquired: bool,
    }
    impl Drop for InterceptSuspendGuard {
        fn drop(&mut self) {
            if self.acquired {
                self.app.state::<AppState>().queue_pasting.store(false, Ordering::SeqCst);
                crate::queue::sync_intercept(&self.app);
            }
        }
    }

    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        let target = st.target_hwnd.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(30));
        if target == 0 {
            return;
        }
        win::focus_window(target);
        let mut focused = win::foreground() == target;
        for _ in 0..40 {
            if focused {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            focused = win::foreground() == target;
        }
        if focused {
            let needs_suspend = keys.eq_ignore_ascii_case("ctrl+v");
            let _guard = if needs_suspend && !st.queue_pasting.swap(true, Ordering::SeqCst) {
                if let Some(sc) = st.queue_sc.lock().take() {
                    let _ = app.global_shortcut().unregister(sc);
                }
                Some(InterceptSuspendGuard { app: app.clone(), acquired: true })
            } else {
                None
            };
            std::thread::sleep(Duration::from_millis(40));
            win::send_paste_keys(&keys);
            if _guard.is_some() {
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    });
}
