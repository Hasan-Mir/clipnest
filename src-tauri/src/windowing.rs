//! Popup / settings / queue / tray windows: positioning at the caret, focus handling, capture protection.

use crate::platform::{self, win};
use crate::state::AppState;
use std::sync::atomic::Ordering;
use tauri::{
    window::Color, AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const BG_LIGHT: Color = Color(0xf6, 0xf6, 0xf8, 0xff);
const BG_OLED: Color = Color(0x00, 0x00, 0x00, 0xff);
const BG_DARK: Color = Color(0x1d, 0x1e, 0x21, 0xff);
const BG_CARD_DARK: Color = Color(0x2a, 0x2b, 0x30, 0xff);
const BG_CARD_LIGHT: Color = Color(0xff, 0xff, 0xff, 0xff);
const BG_CARD_OLED: Color = Color(0x14, 0x14, 0x16, 0xff);

pub fn hwnd_of(w: &WebviewWindow) -> Option<isize> {
    w.hwnd().ok().map(|h| h.0 as isize)
}

fn window_bg_for_theme(theme: &str) -> Color {
    match theme {
        "light" => BG_LIGHT,
        "oled" => BG_OLED,
        _ => BG_DARK,
    }
}

fn card_bg_for_theme(theme: &str) -> Color {
    match theme {
        "light" => BG_CARD_LIGHT,
        "oled" => BG_CARD_OLED,
        _ => BG_CARD_DARK,
    }
}

/// Configures native DWM rounded corners on startup for pre-created frameless windows (`popup` and `tray`).
pub fn init_startup_windows(app: &AppHandle) {
    let theme = app.state::<AppState>().settings.read().theme.clone();
    // Pre-create the (hidden) Paste Queue window so its webview is already loaded the first time it is
    // opened, instead of showing a black window for a moment.
    let _ = ensure_window(app, "queue");
    for label in ["popup", "tray", "queue"] {
        if let Some(w) = app.get_webview_window(label) {
            if label == "tray" {
                let _ = w.set_background_color(Some(card_bg_for_theme(&theme)));
            } else {
                let _ = w.set_background_color(Some(window_bg_for_theme(&theme)));
            }
            if let Some(h) = hwnd_of(&w) {
                win::round_window_corners(h);
            }
        }
    }
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.set_background_color(Some(window_bg_for_theme(&theme)));
    }
}

pub fn apply_protection_to(app: &AppHandle, w: &WebviewWindow) {
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    let mode = app.state::<AppState>().settings.read().capture_protection.clone();
    if let Some(h) = hwnd_of(w) {
        win::set_capture_protection(h, &mode);
    }
}

/// Applies the capture-protection setting to every visible window (takes effect immediately).
pub fn apply_capture_protection(app: &AppHandle) {
    for (_, w) in app.webview_windows() {
        if w.is_visible().unwrap_or(false) {
            apply_protection_to(app, &w);
        }
    }
}

pub fn hide_popup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popup") {
        if w.is_visible().unwrap_or(false) {
            let had_focus = win::is_own_window(win::foreground());
            let _ = w.hide();
            let _ = app.emit("popup-hidden", ());
            // If the popup itself held focus when hidden (e.g. Escape, Copy only, or direct_paste=false),
            // return focus to the previously active target window so the user's first Ctrl+V works immediately.
            if had_focus {
                let target = app.state::<AppState>().target_hwnd.load(Ordering::SeqCst);
                if target != 0 && !win::is_own_window(target) {
                    win::focus_window(target);
                }
            }
        }
    }
}

pub fn toggle_popup(app: &AppHandle) {
    let visible = app.get_webview_window("popup").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if visible {
        hide_popup(app);
    } else {
        spawn_show_popup(app.clone(), None, false);
    }
}

/// Runs on a worker thread: locating the caret through UI Automation may take a few ms.
pub fn spawn_show_popup(app: AppHandle, mode: Option<String>, from_tray: bool) {
    std::thread::spawn(move || show_popup(&app, mode.as_deref(), from_tray));
}

pub fn show_popup(app: &AppHandle, mode: Option<&str>, from_tray: bool) {
    let st = app.state::<AppState>();
    let Some(w) = app.get_webview_window("popup") else { return };

    // Remember who has the focus: that is where "paste" goes.
    let fg = win::foreground();
    if from_tray {
        st.target_hwnd.store(0, Ordering::SeqCst);
    } else if fg != 0 && !win::is_own_window(fg) {
        st.target_hwnd.store(fg, Ordering::SeqCst);
    }

    let s = st.settings.read().clone();
    let mode = mode.unwrap_or(&s.popup_position).to_string();
    let anchor = |m: &str| -> (i32, i32, i32) {
        match m {
            "mouse" | "center" => {
                let (x, y) = win::cursor_pos();
                (x, y, y + 2)
            }
            _ => platform::locate_anchor(),
        }
    };
    let (ax, atop, abot) = if mode == "last" {
        match *st.last_pos.lock() {
            Some((x, y)) => (x, y, y),
            None => anchor("caret"),
        }
    } else {
        anchor(&mode)
    };

    let pw = s.popup_width.max(260) as f64;
    let ph = s.popup_height.max(320) as f64;
    let _ = w.set_min_size(Some(LogicalSize::new(260.0, 320.0)));
    let _ = w.set_size(LogicalSize::new(pw, ph));
    let size = w.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((420, 600));
    let (l, t, r, b) = win::work_area_at(ax, atop);
    let place = |size: (i32, i32)| -> (i32, i32) {
        let mut x: i32;
        let mut y: i32;
        match mode.as_str() {
            "center" => {
                x = l + (r - l - size.0) / 2;
                y = t + (b - t - size.1) / 2;
            }
            "last" => {
                x = ax;
                y = atop;
            }
            _ => {
                x = ax;
                y = abot + 6;
                if y + size.1 > b {
                    y = atop - size.1 - 6; // flip above the caret when there is no room below
                }
            }
        }
        x = x.min(r - size.0 - 8).max(l + 8);
        y = y.min(b - size.1 - 8).max(t + 8);
        (x, y)
    };
    let (x, y) = place(size);
    let _ = w.set_position(PhysicalPosition::new(x, y));
    // Moving to a monitor with another DPI changes the pixel size: measure again and re-place.
    if let Ok(s2) = w.outer_size() {
        let size2 = (s2.width as i32, s2.height as i32);
        if size2 != size {
            let (x2, y2) = place(size2);
            let _ = w.set_position(PhysicalPosition::new(x2, y2));
        }
    }
    st.popup_shown_at.store(crate::db::now_ms(), Ordering::SeqCst);
    if let Some(h) = hwnd_of(&w) {
        win::round_window_corners(h);
    }
    let _ = w.show();
    apply_protection_to(app, &w);
    if let Some(h) = hwnd_of(&w) {
        win::focus_window(h);
    }
    let _ = w.set_focus();
    st.popup_shown_at.store(crate::db::now_ms(), Ordering::SeqCst);
    let _ = app.emit("popup-shown", ());
}

fn ensure_window(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Some(w);
    }
    let theme = app.state::<AppState>().settings.read().theme.clone();
    let bg = if label == "tray" {
        card_bg_for_theme(&theme)
    } else if label == "queue" {
        window_bg_for_theme(&theme)
    } else {
        BG_DARK
    };
    let base = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into())).background_color(bg);
    let built = if label == "settings" {
        base.title("ClipNest Settings").inner_size(900.0, 680.0).min_inner_size(740.0, 520.0).center().build()
    } else if label == "tray" {
        base.title("ClipNest Menu")
            .inner_size(246.0, 268.0)
            .decorations(false)
            .resizable(false)
            .shadow(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
    } else {
        base.title("Paste Queue")
            .inner_size(360.0, 380.0)
            .min_inner_size(330.0, 280.0)
            .decorations(false)
            .resizable(true)
            .shadow(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
    };
    match built {
        Ok(w) => {
            if let Some(h) = hwnd_of(&w) {
                if label == "tray" || label == "queue" {
                    win::round_window_corners(h);
                }
                if label == "queue" {
                    win::make_no_activate(h);
                }
            }
            Some(w)
        }
        Err(e) => {
            eprintln!("clipnest: cannot create window {label}: {e}");
            None
        }
    }
}

pub fn open_settings(app: &AppHandle) {
    hide_tray(app);
    if !app.state::<AppState>().popup_pinned.load(Ordering::SeqCst) {
        hide_popup(app);
    }
    let w = ensure_window(app, "settings");
    if let Some(w) = w {
        let _ = w.unminimize();
        let _ = w.show();
        apply_protection_to(app, &w);
        let _ = w.set_focus();
    }
}

/// Shows the Paste Queue window. The window is created hidden (`visible(false)`) and is only made visible
/// once its webview reported that it has rendered (`queue_ready` command), so it never appears as an empty
/// black rectangle. A timeout makes sure it is shown even if the page never reports in.
pub fn show_queue(app: &AppHandle) {
    if ensure_window(app, "queue").is_none() {
        return;
    }
    let st = app.state::<AppState>();
    if st.queue_ready.load(Ordering::SeqCst) {
        present_queue(app);
        return;
    }
    st.queue_show_pending.store(true, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if app2.state::<AppState>().queue_show_pending.swap(false, Ordering::SeqCst) {
            present_queue(&app2);
        }
    });
}

/// Called by the queue webview once its first frame has been rendered.
pub fn queue_frontend_ready(app: &AppHandle) {
    let st = app.state::<AppState>();
    st.queue_ready.store(true, Ordering::SeqCst);
    if st.queue_show_pending.swap(false, Ordering::SeqCst) {
        present_queue(app);
    }
}

fn present_queue(app: &AppHandle) {
    let Some(w) = app.get_webview_window("queue") else { return };
    if let Some(h) = hwnd_of(&w) {
        win::round_window_corners(h);
        win::make_no_activate(h);
        let (x, y) = win::cursor_pos();
        let (_, t, r, _) = win::work_area_at(x, y);
        let width = w.outer_size().map(|s| s.width as i32).unwrap_or(360);
        let _ = w.set_position(PhysicalPosition::new(r - width - 16, t + 16));
        if let Ok(s2) = w.outer_size() {
            let width2 = s2.width as i32;
            if width2 != width {
                let _ = w.set_position(PhysicalPosition::new(r - width2 - 16, t + 16));
            }
        }
        win::show_no_activate(h);
        apply_protection_to(app, &w);
    }
}

pub fn hide_queue(app: &AppHandle) {
    app.state::<AppState>().queue_show_pending.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("queue") {
        if let Some(h) = hwnd_of(&w) {
            win::hide_window(h);
        }
        let _ = w.hide();
    }
}

pub fn show_tray(app: &AppHandle) {
    let Some(w) = ensure_window(app, "tray") else { return };
    let st = app.state::<AppState>();
    let theme = st.settings.read().theme.clone();
    let _ = w.set_background_color(Some(card_bg_for_theme(&theme)));
    if let Some(h) = hwnd_of(&w) {
        win::round_window_corners(h);
    }
    st.tray_shown_at.store(crate::db::now_ms(), Ordering::SeqCst);

    let (cx, cy) = win::cursor_pos();
    let (l, t, r, b) = win::work_area_at(cx, cy);
    let place = |size: (i32, i32)| -> (i32, i32) {
        let mut x = cx - size.0 / 2;
        let mut y = cy - size.1 - 8;
        if y < t + 8 {
            y = cy + 8;
        }
        x = x.min(r - size.0 - 8).max(l + 8);
        y = y.min(b - size.1 - 8).max(t + 8);
        (x, y)
    };
    let size = w.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((246, 268));
    let (x, y) = place(size);
    let _ = w.set_position(PhysicalPosition::new(x, y));
    if let Ok(s2) = w.outer_size() {
        let size2 = (s2.width as i32, s2.height as i32);
        if size2 != size {
            let (x2, y2) = place(size2);
            let _ = w.set_position(PhysicalPosition::new(x2, y2));
        }
    }
    let _ = w.show();
    apply_protection_to(app, &w);
    if let Some(h) = hwnd_of(&w) {
        win::focus_window(h);
    }
    let _ = w.set_focus();
    st.tray_shown_at.store(crate::db::now_ms(), Ordering::SeqCst);
    let _ = app.emit("tray-shown", ());
}

fn clamp_tray_pos(pos: (i32, i32), size: (i32, i32), work_area: (i32, i32, i32, i32)) -> (i32, i32) {
    let (l, t, r, b) = work_area;
    let nx = pos.0.min(r - size.0 - 8).max(l + 8);
    let ny = pos.1.min(b - size.1 - 8).max(t + 8);
    (nx, ny)
}

pub fn resize_tray(app: &AppHandle, height: u32) {
    let Some(w) = app.get_webview_window("tray") else { return };
    let clamped = height.clamp(170, 460) as f64;
    let _ = w.set_size(LogicalSize::new(246.0, clamped));
    if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
        let work_area = win::work_area_at(pos.x, pos.y);
        let (nx, ny) = clamp_tray_pos((pos.x, pos.y), (size.width as i32, size.height as i32), work_area);
        if nx != pos.x || ny != pos.y {
            let _ = w.set_position(PhysicalPosition::new(nx, ny));
        }
    }
    if let Some(h) = hwnd_of(&w) {
        win::round_window_corners(h);
    }
    if w.is_visible().unwrap_or(false) {
        let st = app.state::<AppState>();
        st.tray_shown_at.store(crate::db::now_ms(), Ordering::SeqCst);
        if let Some(h) = hwnd_of(&w) {
            win::focus_window(h);
        }
        let _ = w.set_focus();
    }
}

pub fn hide_tray(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("tray") {
        if let Some(h) = hwnd_of(&w) {
            win::hide_window(h);
        }
        let _ = w.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp_tray_pos() {
        // Standard primary monitor (1920x1080 with 40px taskbar at bottom -> work_area bottom is 1040)
        assert_eq!(clamp_tray_pos((1660, 764), (246, 310), (0, 0, 1920, 1040)), (1660, 722));

        // Multi-monitor with secondary monitor positioned to the left (-1920 to 0)
        assert_eq!(clamp_tray_pos((-250, 764), (246, 310), (-1920, 0, 0, 1040)), (-254, 722));
    }
}
