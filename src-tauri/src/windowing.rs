//! Popup / settings / queue / tray windows: positioning at the caret, focus handling, capture protection.

use crate::platform::{self, win};
use crate::state::AppState;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn hwnd_of(w: &WebviewWindow) -> Option<isize> {
    w.hwnd().ok().map(|h| h.0 as isize)
}

pub fn apply_protection_to(app: &AppHandle, w: &WebviewWindow) {
    let mode = app.state::<AppState>().settings.read().capture_protection.clone();
    if let Some(h) = hwnd_of(w) {
        win::set_capture_protection(h, &mode);
    }
}

/// Applies the capture-protection setting to every open window (takes effect immediately).
pub fn apply_capture_protection(app: &AppHandle) {
    for (_, w) in app.webview_windows() {
        apply_protection_to(app, &w);
    }
}

pub fn hide_popup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popup") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            let _ = app.emit("popup-hidden", ());
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

    let _ = w.set_size(LogicalSize::new(s.popup_width as f64, s.popup_height as f64));
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
    let _ = w.show();
    if let Some(h) = hwnd_of(&w) {
        win::focus_window(h);
    }
    let _ = w.set_focus();
    let _ = app.emit("popup-shown", ());
}

fn ensure_window(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Some(w);
    }
    let base = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()));
    let built = if label == "settings" {
        base.title("ClipNest Settings").inner_size(880.0, 680.0).min_inner_size(720.0, 540.0).center().build()
    } else if label == "tray" {
        base.title("ClipNest Menu")
            .inner_size(240.0, 340.0)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(true)
            .visible(false)
            .build()
    } else {
        base.title("Paste Queue")
            .inner_size(310.0, 380.0)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
    };
    match built {
        Ok(w) => {
            apply_protection_to(app, &w);
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
        let _ = w.set_focus();
    }
}

pub fn show_queue(app: &AppHandle) {
    let w = ensure_window(app, "queue");
    let Some(w) = w else { return };
    if let Some(h) = hwnd_of(&w) {
        win::make_no_activate(h);
        let (x, y) = win::cursor_pos();
        let (_, t, r, _) = win::work_area_at(x, y);
        let width = w.outer_size().map(|s| s.width as i32).unwrap_or(310);
        let _ = w.set_position(PhysicalPosition::new(r - width - 16, t + 16));
        win::show_no_activate(h);
    }
}

pub fn hide_queue(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("queue") {
        if let Some(h) = hwnd_of(&w) {
            win::hide_window(h);
        }
        let _ = w.hide();
    }
}

pub fn show_tray(app: &AppHandle) {
    let Some(w) = ensure_window(app, "tray") else { return };
    let (cx, cy) = win::cursor_pos();
    let (l, t, r, b) = win::work_area_at(cx, cy);
    let size = w.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((240, 340));
    let mut x = cx - size.0 / 2;
    let mut y = cy - size.1 - 8;
    if y < t + 8 {
        y = cy + 8;
    }
    x = x.min(r - size.0 - 8).max(l + 8);
    y = y.min(b - size.1 - 8).max(t + 8);
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.show();
    if let Some(h) = hwnd_of(&w) {
        win::focus_window(h);
    }
    let _ = w.set_focus();
    let _ = app.emit("tray-shown", ());
}

pub fn hide_tray(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("tray") {
        if let Some(h) = hwnd_of(&w) {
            win::hide_window(h);
        }
        let _ = w.hide();
    }
}
