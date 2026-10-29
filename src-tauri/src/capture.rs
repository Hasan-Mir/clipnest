//! Clipboard capture: OS event -> read every format -> filter -> classify -> write-through to SQLite.

pub use clipnest_core::codec::{
    build_hdrop, build_text_clip, decode_image, decode_utf16, encode_png, extract_cf_html, hash_of, parse_hdrop,
    png_to_dib, text_format, utf16_bytes,
};

use crate::classify;
use crate::db::{self, NewClip, StoredFormat};
use crate::platform::win::{self, RawFormat};
use crate::rules;
use crate::state::{AppState, Settings};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub fn spawn(app: AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    win::spawn_clipboard_listener(tx);
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // Apps often fire several updates for a single copy: wait briefly and coalesce.
            std::thread::sleep(Duration::from_millis(40));
            // Ctrl+C immediately followed by Ctrl+V: while Ctrl or V is physically held, the user is most
            // likely about to paste. Reading the clipboard now would keep it open (and force the source app
            // to render delayed formats) right when the target app wants it, making the first Ctrl+V fail
            // intermittently. Wait for Ctrl/V to be released before opening the clipboard.
            wait_for_ctrl_release();
            while rx.try_recv().is_ok() {}
            let a = app.clone();
            let res = std::panic::catch_unwind(AssertUnwindSafe(|| process(&a)));
            match res {
                Ok(Err(e)) => eprintln!("clipnest: capture skipped: {e}"),
                Err(_) => eprintln!("clipnest: capture panicked (ignored)"),
                _ => {}
            }
        }
    });
}

/// Blocks (up to ~1.2 s) while Ctrl or V is physically held, then leaves a short grace period
/// (re-checking that neither key was pressed again) so an immediate Ctrl+V paste completes first.
fn wait_for_ctrl_release() {
    const VK_CONTROL: u16 = 0x11;
    const VK_LCONTROL: u16 = 0xA2;
    const VK_RCONTROL: u16 = 0xA3;
    const VK_V: u16 = 0x56;
    let is_busy_key =
        || win::is_down(VK_CONTROL) || win::is_down(VK_LCONTROL) || win::is_down(VK_RCONTROL) || win::is_down(VK_V);
    let mut waited = false;
    for _ in 0..80 {
        if !is_busy_key() {
            break;
        }
        waited = true;
        std::thread::sleep(Duration::from_millis(15));
    }
    if waited {
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(15));
            if is_busy_key() {
                for _ in 0..40 {
                    if !is_busy_key() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(15));
                }
                break;
            }
        }
    }
}

fn has_name(fmts: &[RawFormat], name: &str) -> bool {
    fmts.iter().any(|f| f.name == name)
}

fn find<'a>(fmts: &'a [RawFormat], name: &str) -> Option<&'a RawFormat> {
    fmts.iter().find(|f| f.name == name)
}

/// Checks if the "Preferred DropEffect" clipboard format indicates a Cut (DROPEFFECT_MOVE = 2).
fn is_cut_drop_effect(fmts: &[RawFormat]) -> bool {
    if let Some(f) = fmts.iter().find(|f| f.name.eq_ignore_ascii_case("Preferred DropEffect")) {
        if f.data.len() >= 4 {
            let val = u32::from_le_bytes([f.data[0], f.data[1], f.data[2], f.data[3]]);
            return (val & 2) != 0;
        }
    }
    false
}

fn process(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    let now = db::now_ms();
    if win::sequence_number() == st.self_seq.load(Ordering::SeqCst)
        || (now - st.self_write_at.load(Ordering::SeqCst)).abs() < 450
    {
        return Ok(()); // our own write (paste)
    }
    if st.is_paused() {
        return Ok(());
    }
    let s: Settings = st.settings.read().clone();
    let snap = win::read_clipboard(s.ignore_confidential, 96 * 1024 * 1024)?;
    if snap.excluded || snap.formats.is_empty() {
        return Ok(());
    }
    let exe_l = snap.exe.to_lowercase();
    if s.ignore_apps.iter().any(|a| a.trim().eq_ignore_ascii_case(&exe_l)) {
        return Ok(());
    }
    let app_name = classify::friendly_app_name(&snap.exe);
    let is_cut = is_cut_drop_effect(&snap.formats);

    let (mut clip, mut fmts) = match build_from_snapshot(&snap.formats, &app_name, &snap.exe, &s)? {
        Some(b) => b,
        None => return Ok(()),
    };

    // Automatic rules (ignore / move to pinboard / tag / plain only / trim / expire / run action).
    let outcome = rules::apply(&s.rules, &mut clip, &mut fmts);
    if outcome.ignore {
        return Ok(());
    }

    // Real application icon (extracted once per executable before emitting items-changed).
    if !snap.exe.is_empty() && !snap.exe_path.is_empty() && !db::has_icon(&st.db.lock(), &snap.exe) {
        if let Some((w, h, rgba)) = win::extract_icon_rgba(&snap.exe_path) {
            if let Some(img) = image::RgbaImage::from_raw(w, h, rgba) {
                if let Some(png) = encode_png(&image::DynamicImage::ImageRgba8(img)) {
                    db::put_icon(&st.db.lock(), &snap.exe, &png);
                    let _ = app.emit("icon-changed", ());
                }
            }
        }
    }

    let kind_str = clip.kind.clone();
    let id = {
        let mut conn = st.db.lock();
        let (id, is_new) = db::insert_clip(&mut conn, &clip, &fmts)?;
        let target_board = outcome.board.or(if is_new { s.active_pinboard } else { None });
        if let Some(b) = target_board {
            let _ = db::assign_category(&conn, &[id], Some(b), None, false);
        }
        if !outcome.tags.is_empty() {
            let _ = db::set_tags(&conn, id, &outcome.tags.join(" "));
        }
        let _ = db::apply_limits(&conn, &s);
        id
    };
    let _ = app.emit("items-changed", ());

    for action in outcome.run {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let _ = crate::commands::exec_action(&app2, id, &action);
        });
    }

    let queue_active = st.queue.lock().active;
    if queue_active {
        crate::queue::push_captured(app, id, &kind_str, is_cut);
    }
    Ok(())
}

type Built = (NewClip, Vec<StoredFormat>);

fn extract_file_thumb(path: &str) -> Option<Vec<u8>> {
    let lower = path.to_lowercase();
    let is_media = [
        ".png", ".bmp", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".tif", ".tiff", ".heic", ".mp4", ".mkv", ".mov",
        ".avi", ".webm", ".wmv", ".m4v", ".pdf",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext));
    if !is_media {
        return None;
    }
    if lower.ends_with(".png") || lower.ends_with(".bmp") {
        if let Ok(img) = image::open(path) {
            let t = img.thumbnail(400, 220);
            if let Some(png) = encode_png(&t) {
                return Some(png);
            }
        }
    }
    if let Some((w, h, rgba)) = win::extract_shell_thumbnail_rgba(path, 320) {
        if let Some(img) = image::RgbaImage::from_raw(w, h, rgba) {
            let dyn_img = image::DynamicImage::ImageRgba8(img).thumbnail(400, 220);
            return encode_png(&dyn_img);
        }
    }
    None
}

fn build_from_snapshot(
    fmts: &[RawFormat],
    app_name: &str,
    app_exe: &str,
    s: &Settings,
) -> Result<Option<Built>, String> {
    let text_raw =
        fmts.iter().find(|f| f.id == win::CF_UNICODETEXT_ID).map(|f| decode_utf16(&f.data)).unwrap_or_default();
    let has_text = !text_raw.trim().is_empty();
    let hdrop = fmts.iter().find(|f| f.id == win::CF_HDROP_ID);
    let png = find(fmts, "PNG");
    let dib = fmts.iter().find(|f| f.id == win::CF_DIB_ID).or_else(|| fmts.iter().find(|f| f.id == win::CF_DIBV5_ID));
    let has_rich = has_name(fmts, "HTML Format") || has_name(fmts, "Rich Text Format");

    // ── files ──
    if let Some(h) = hdrop {
        let paths = parse_hdrop(&h.data);
        if !paths.is_empty() {
            let thumb = extract_file_thumb(&paths[0]);
            let plain = paths.join("\n");
            let preview: String = plain.chars().take(800).collect();
            let hash = hash_of(b"f\0", plain.as_bytes());
            let clip = NewClip {
                hash,
                kind: "file".into(),
                search: classify::normalize(&plain.chars().take(100_000).collect::<String>()),
                chars: plain.chars().count() as i64,
                file_count: Some(paths.len() as i64),
                plain,
                preview,
                app_name: app_name.into(),
                app_exe: app_exe.into(),
                lang: None,
                img_w: None,
                img_h: None,
                color: None,
                sensitive: false,
                has_rich: false,
                expires_at: None,
                thumb,
            };
            return Ok(Some((clip, stored(fmts, |_| true))));
        }
    }

    // ── text ──
    if has_text {
        let vs_lang = find(fmts, "vscode-editor-data").and_then(|f| classify::vscode_language(&f.data));
        let mut clip = build_text_clip(&text_raw, vs_lang, app_name, app_exe, has_rich);
        if s.detect_sensitive && matches!(clip.kind.as_str(), "text" | "code") && classify::is_sensitive(&text_raw) {
            match s.sensitive_action.as_str() {
                "skip" => return Ok(None),
                "mask_delete" => {
                    clip.sensitive = true;
                    clip.expires_at = Some(db::now_ms() + (s.sensitive_ttl_min.max(1) as i64) * 60_000);
                }
                _ => clip.sensitive = true,
            }
        }
        if !s.store_rich {
            clip.has_rich = false;
            return Ok(Some((clip, stored(fmts, |f| f.id == win::CF_UNICODETEXT_ID))));
        }
        let keep = |f: &RawFormat| !(f.id == win::CF_DIB_ID || f.id == win::CF_DIBV5_ID || f.name == "PNG");
        return Ok(Some((clip, stored(fmts, keep))));
    }

    // ── image ──
    if png.is_some() || dib.is_some() {
        let primary: &[u8] = match (png, dib) {
            (Some(p), _) => &p.data,
            (None, Some(d)) => &d.data,
            _ => return Ok(None),
        };
        if primary.len() > (s.max_image_mb as usize) * 1024 * 1024 {
            return Ok(None);
        }
        let hash = hash_of(b"i\0", primary);
        let img = match decode_image(png.map(|p| p.data.as_slice()), dib.map(|d| d.data.as_slice())) {
            Some(i) => i,
            None => return Ok(None),
        };
        let (w, h) = (img.width() as i64, img.height() as i64);
        let png_bytes = match png {
            Some(p) => p.data.clone(),
            None => encode_png(&img).ok_or("png encode failed")?,
        };
        let thumb = {
            let t = img.thumbnail(664, 280);
            encode_png(&t)
        };
        let mut fmts_out = vec![StoredFormat { fmt_id: 0xC000, name: "PNG".into(), data: png_bytes }];
        fmts_out.extend(stored(fmts, |f| !(f.id == win::CF_DIB_ID || f.id == win::CF_DIBV5_ID || f.name == "PNG")));
        let clip = NewClip {
            hash,
            kind: "image".into(),
            plain: String::new(),
            preview: String::new(),
            search: String::new(),
            app_name: app_name.into(),
            app_exe: app_exe.into(),
            lang: None,
            img_w: Some(w),
            img_h: Some(h),
            color: None,
            chars: 0,
            file_count: None,
            sensitive: false,
            has_rich,
            expires_at: None,
            thumb,
        };
        return Ok(Some((clip, fmts_out)));
    }
    Ok(None)
}

fn stored(fmts: &[RawFormat], keep: impl Fn(&RawFormat) -> bool) -> Vec<StoredFormat> {
    fmts.iter()
        .filter(|f| keep(f))
        .map(|f| StoredFormat { fmt_id: f.id, name: f.name.clone(), data: f.data.clone() })
        .collect()
}
