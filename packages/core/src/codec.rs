//! Clipboard format encoding/decoding helpers (UTF-16LE, CF_HDROP, CF_HTML, DIB/PNG)
//! shared across ClipNest GUI capture, paste, and CLI.

use crate::classify;
use crate::db::{NewClip, StoredFormat};
use crate::platform::win;
use std::io::Cursor;

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

pub fn hash_of(prefix: &[u8], data: &[u8]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(prefix);
    h.update(data);
    h.finalize().to_hex().to_string()
}

/// Shared by capture, "new item", merge and inline-edit.
pub fn build_text_clip(
    text: &str,
    vscode_lang: Option<String>,
    app_name: &str,
    app_exe: &str,
    has_rich: bool,
) -> NewClip {
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
            if part.is_empty() {
                break;
            }
            out.push(String::from_utf16_lossy(part));
        }
    } else {
        for part in body.split(|&b| b == 0) {
            if part.is_empty() {
                break;
            }
            out.push(String::from_utf8_lossy(part).to_string());
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

pub fn decode_image(png: Option<&[u8]>, dib: Option<&[u8]>) -> Option<image::DynamicImage> {
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
    if hsize < 40 || hsize > dib.len() {
        return None;
    }
    let bits = u16::from_le_bytes([dib[14], dib[15]]) as u32;
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
    let clr_used = u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]);
    let mut extra = 0usize;
    if bits > 0 && bits <= 8 {
        let n = if clr_used > 0 { clr_used } else { 1u32 << bits };
        extra = extra.checked_add((n as usize).checked_mul(4)?)?;
    }
    if compression == 3 && hsize == 40 {
        extra = extra.checked_add(12)?;
    }
    let total_len = 14usize.checked_add(dib.len())?;
    let total_len_u32 = u32::try_from(total_len).ok()?;
    let offset = 14usize.checked_add(hsize)?.checked_add(extra)?;
    if offset > total_len {
        return None;
    }
    let offset_u32 = u32::try_from(offset).ok()?;
    let mut bmp = Vec::with_capacity(total_len);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&total_len_u32.to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&offset_u32.to_le_bytes());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_encode_decode_roundtrip() {
        let original = "سلام ClipNest 🚀\nLine 2";
        let bytes = utf16_bytes(original);
        assert_eq!(decode_utf16(&bytes), original);
    }

    #[test]
    fn hdrop_build_and_parse_roundtrip() {
        let paths =
            vec![r"C:\Users\Ali\Documents\فایل اول.txt".to_string(), r"D:\Projects\ClipNest\README.md".to_string()];
        let raw = build_hdrop(&paths);
        let parsed = parse_hdrop(&raw);
        assert_eq!(parsed, paths);
        assert!(parse_hdrop(&[0u8; 10]).is_empty());
    }

    #[test]
    fn cf_html_extraction_with_and_without_offsets() {
        let html = "<html><body><span>Hello</span></body></html>";
        let start = 51usize;
        let header = format!("Version:0.9\r\nStartHTML:{:08}\r\nEndHTML:{:08}\r\n", start, start + html.len());
        assert_eq!(header.len(), start);
        let mut payload = header.into_bytes();
        payload.extend_from_slice(html.as_bytes());
        payload.extend_from_slice(&[0, 0]);
        assert_eq!(extract_cf_html(&payload).as_deref(), Some(html));

        let fallback = b"Version:0.9\r\n<div>Fallback</div>\0";
        assert_eq!(extract_cf_html(fallback).as_deref(), Some("<div>Fallback</div>"));
    }

    #[test]
    fn png_to_dib_and_decode_image_roundtrip() {
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4, 3, image::Rgba([20, 120, 220, 255])));
        let png = encode_png(&img).expect("encode png");
        let dib = png_to_dib(&png).expect("png to dib");
        let decoded = decode_image(None, Some(&dib)).expect("decode dib");
        assert_eq!(decoded.width(), 4);
        assert_eq!(decoded.height(), 3);
    }

    #[test]
    fn parse_hdrop_terminates_on_double_nul_ignoring_trailing_garbage() {
        let paths = vec![r"C:\test\file1.txt".to_string(), r"C:\test\file2.txt".to_string()];
        let mut raw = build_hdrop(&paths);
        // Append uninitialized heap garbage past the double-NUL boundary
        raw.extend_from_slice(b"TRAINLING_GARBAGE_DATA_12345");
        let parsed = parse_hdrop(&raw);
        assert_eq!(parsed, paths);
    }

    #[test]
    fn decode_image_rejects_malformed_headers_without_panic() {
        // hsize < 40
        let mut bad_hsize = vec![0u8; 64];
        bad_hsize[0..4].copy_from_slice(&20u32.to_le_bytes());
        assert!(decode_image(None, Some(&bad_hsize)).is_none());

        // hsize = 40, bits = 8, clr_used = u32::MAX (arithmetic overflow scenario)
        let mut overflow_dib = vec![0u8; 64];
        overflow_dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        overflow_dib[14..16].copy_from_slice(&8u16.to_le_bytes());
        overflow_dib[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_image(None, Some(&overflow_dib)).is_none());
    }
}
