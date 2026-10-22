//! Clipboard capture: OS event -> read every format -> filter -> classify -> write-through to SQLite.

use crate::classify;
use crate::db::{self, NewClip, StoredFormat};
use crate::platform::win::{self, RawFormat};
use crate::rules;
use crate::state::{AppState, Settings};
use std::io::Cursor;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub fn utf16_bytes(s: &str) -> Vec<u8> {
    let mut v: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    v.extend_from_slice(&[0, 0]);
    v
}

pub fn decode_utf16(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

pub fn spawn(app: AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    win::spawn_clipboard_listener(tx);
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // Apps often fire several updates for a single copy: wait briefly and coalesce.
            std::thread::sleep(Duration::from_millis(40));
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
    if win::sequence_number() == st.self_seq.load(Ordering::SeqCst) {
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
            let _ = db::set_pinboard(&conn, &[id], Some(b));
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
        ".png", ".bmp", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".tif", ".tiff", ".heic",
        ".mp4", ".mkv", ".mov", ".avi", ".webm", ".wmv", ".m4v", ".pdf",
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

fn build_from_snapshot(fmts: &[RawFormat], app_name: &str, app_exe: &str, s: &Settings) -> Result<Option<Built>, String> {
    let text_raw = fmts.iter().find(|f| f.id == win::CF_UNICODETEXT_ID).map(|f| decode_utf16(&f.data)).unwrap_or_default();
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
            // "Plain text only" mode: no HTML/RTF/etc. is kept at all.
            clip.has_rich = false;
            return Ok(Some((clip, stored(fmts, |f| f.id == win::CF_UNICODETEXT_ID))));
        }
        // Drop bitmap duplicates (Excel/Word attach a picture of the text).
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

fn hash_of(prefix: &[u8], data: &[u8]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(prefix);
    h.update(data);
    h.finalize().to_hex().to_string()
}

/// Shared by capture, "new item", merge and inline-edit.
pub fn build_text_clip(text: &str, vscode_lang: Option<String>, app_name: &str, app_exe: &str, has_rich: bool) -> NewClip {
    let (kind, lang, color) = classify::text_kind(text, vscode_lang.as_deref());
    let preview: String = text.trim_start().chars().take(800).collect();
    let search = classify::normalize(&text.chars().take(100_000).collect::<String>());
    NewClip {
        hash: hash_of(b"t\0", text.as_bytes()),
        kind: kind.into(),
        plain: text.to_string(),
        preview,
        search,
        app_name: app_name.into(),
        app_exe: app_exe.into(),
        lang,
        img_w: None,
        img_h: None,
        color,
        chars: text.chars().count() as i64,
        file_count: None,
        sensitive: false,
        has_rich,
        expires_at: None,
        thumb: None,
    }
}

pub fn text_format(text: &str) -> StoredFormat {
    StoredFormat { fmt_id: win::CF_UNICODETEXT_ID, name: "CF_UNICODETEXT".into(), data: utf16_bytes(text) }
}

/// CF_HDROP -> list of paths (DROPFILES header: u32 offset at 0, u32 fWide at 16).
pub fn parse_hdrop(d: &[u8]) -> Vec<String> {
    if d.len() < 20 {
        return vec![];
    }
    let off = u32::from_le_bytes([d[0], d[1], d[2], d[3]]) as usize;
    let wide = u32::from_le_bytes([d[16], d[17], d[18], d[19]]) != 0;
    if off >= d.len() {
        return vec![];
    }
    let body = &d[off..];
    let mut out = vec![];
    if wide {
        let units: Vec<u16> = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        for part in units.split(|&u| u == 0) {
            if !part.is_empty() {
                out.push(String::from_utf16_lossy(part));
            }
        }
    } else {
        for part in body.split(|&b| b == 0) {
            if !part.is_empty() {
                out.push(String::from_utf8_lossy(part).to_string());
            }
        }
    }
    out
}

/// Builds a combined CF_HDROP payload from a slice of file/folder paths.
pub fn build_hdrop(paths: &[String]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(20 + paths.len() * 64);
    buf.extend_from_slice(&20u32.to_le_bytes()); // pFiles = 20
    buf.extend_from_slice(&0i32.to_le_bytes()); // pt.x = 0
    buf.extend_from_slice(&0i32.to_le_bytes()); // pt.y = 0
    buf.extend_from_slice(&0u32.to_le_bytes()); // fNC = FALSE
    buf.extend_from_slice(&1u32.to_le_bytes()); // fWide = TRUE (UTF-16LE)
    for p in paths {
        for u in p.encode_utf16() {
            buf.extend_from_slice(&u.to_le_bytes());
        }
        buf.extend_from_slice(&0u16.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes()); // terminating double-NUL
    buf
}

// ───────────────────────────── images ─────────────────────────────

pub fn encode_png(img: &image::DynamicImage) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png).ok()?;
    Some(buf)
}

fn decode_image(png: Option<&[u8]>, dib: Option<&[u8]>) -> Option<image::DynamicImage> {
    if let Some(p) = png {
        if let Ok(i) = image::load_from_memory(p) {
            return Some(i);
        }
    }
    let dib = dib?;
    if dib.len() < 40 {
        return None;
    }
    // CF_DIB has no BITMAPFILEHEADER: build one so the BMP decoder accepts it.
    let hsize = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]) as usize;
    let bits = u16::from_le_bytes([dib[14], dib[15]]) as u32;
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    let clr_used = u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]);
    let mut extra = 0usize;
    if bits <= 8 {
        let n = if clr_used > 0 { clr_used } else { 1u32 << bits };
        extra += (n as usize) * 4;
    }
    if compression == 3 && hsize == 40 {
        extra += 12;
    }
    let offset = 14 + hsize + extra;
    let mut bmp = Vec::with_capacity(14 + dib.len());
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&((14 + dib.len()) as u32).to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&(offset as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    let img = image::load_from_memory(&bmp).ok()?;
    // Many apps leave the alpha channel of 32-bit DIBs at 0: treat that as fully opaque.
    let mut rgba = img.to_rgba8();
    if rgba.pixels().all(|p| p[3] == 0) {
        for p in rgba.pixels_mut() {
            p[3] = 255;
        }
    }
    Some(image::DynamicImage::ImageRgba8(rgba))
}

/// PNG -> 24-bit bottom-up CF_DIB, understood by every Windows app (Paint, Word, Office…).
pub fn png_to_dib(png: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(png).ok()?.to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let stride = (w * 3 + 3) & !3;
    let mut out = Vec::with_capacity(40 + stride * h);
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&((stride * h) as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    let raw = img.as_raw();
    for y in (0..h).rev() {
        let row = &raw[y * w * 3..(y + 1) * w * 3];
        for px in row.chunks_exact(3) {
            out.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        out.extend(std::iter::repeat(0u8).take(stride - w * 3));
    }
    Some(out)
}

/// Windows "HTML Format": a text header (StartHTML/EndHTML offsets) followed by the HTML document.
/// Returns the HTML (head styles included) so it can be rendered exactly as it was copied.
pub fn extract_cf_html(d: &[u8]) -> Option<String> {
    let head_len = d.len().min(400);
    let head = String::from_utf8_lossy(&d[..head_len]).to_string();
    let num = |key: &str| -> Option<usize> {
        let i = head.find(key)?;
        let rest = &head[i + key.len()..];
        let end = rest.find(|c: char| !c.is_ascii_digit())?;
        rest[..end].parse().ok()
    };
    let slice: &[u8] = match (num("StartHTML:"), num("EndHTML:")) {
        (Some(s), Some(e)) if s < e && e <= d.len() => &d[s..e],
        _ => {
            let pos = d.windows(1).position(|w| w[0] == b'<')?;
            &d[pos..]
        }
    };
    let end = slice.iter().rposition(|&b| b != 0).map(|i| i + 1).unwrap_or(0);
    let slice = &slice[..end.min(1_500_000)];
    if slice.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(slice).to_string())
}
