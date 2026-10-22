//! Paste Queue: copy several things, then paste them one by one in order (FIFO) or reversed (LIFO).
//! While the queue holds items, Ctrl+V is intercepted globally and pastes the next item.

use crate::platform::win;
use crate::state::AppState;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn changed(app: &AppHandle) {
    let _ = app.emit("queue-changed", ());
    let _ = app.emit("status-changed", ());
}

/// Registers/unregisters the global Ctrl+V interception depending on the queue state.
pub fn sync_intercept(app: &AppHandle) {
    let st = app.state::<AppState>();
    let want = {
        let q = st.queue.lock();
        q.active && !q.items.is_empty()
    } && st.settings.read().queue_intercept;
    let gs = app.global_shortcut();
    let mut slot = st.queue_sc.lock();
    if want {
        if slot.is_none() {
            if let Ok(sc) = "Ctrl+V".parse::<Shortcut>() {
                if gs.register(sc.clone()).is_ok() {
                    *slot = Some(sc);
                }
            }
        }
    } else if let Some(sc) = slot.take() {
        let _ = gs.unregister(sc);
    }
}

pub fn push(app: &AppHandle, id: i64) {
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        if !q.active {
            return;
        }
        q.items.push(id);
    }
    changed(app);
    sync_intercept(app);
}

pub fn toggle(app: &AppHandle) {
    let active = app.state::<AppState>().queue.lock().active;
    if active {
        {
            let st = app.state::<AppState>();
            let mut q = st.queue.lock();
            q.active = false;
            q.items.clear();
        }
        crate::windowing::hide_queue(app);
    } else {
        app.state::<AppState>().queue.lock().active = true;
        crate::windowing::show_queue(app);
    }
    changed(app);
    sync_intercept(app);
}

pub fn remove(app: &AppHandle, id: i64) {
    {
        let st = app.state::<AppState>();
        let mut q = st.queue.lock();
        if let Some(pos) = q.items.iter().position(|x| *x == id) {
            q.items.remove(pos);
        }
    }
    changed(app);
    sync_intercept(app);
}

pub fn clear(app: &AppHandle) {
    app.state::<AppState>().queue.lock().items.clear();
    changed(app);
    sync_intercept(app);
}

/// Called when the intercepted Ctrl+V is pressed.
pub fn on_paste_hotkey(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        let fifo = st.settings.read().queue_fifo;
        let id = {
            let mut q = st.queue.lock();
            if q.items.is_empty() {
                None
            } else if fifo {
                Some(q.items.remove(0))
            } else {
                q.items.pop()
            }
        };
        let Some(id) = id else {
            sync_intercept(&app);
            return;
        };
        // Release the hotkey so the synthesized Ctrl+V reaches the target app instead of us.
        if let Some(sc) = st.queue_sc.lock().take() {
            let _ = app.global_shortcut().unregister(sc);
        }
        let exe = win::exe_of_hwnd(win::foreground());
        let (plain, keys) = crate::paste::resolve(&app, "auto", &exe);
        if crate::paste::write_item(&app, id, plain).is_ok() {
            std::thread::sleep(Duration::from_millis(20));
            win::send_paste_keys(&keys);
        }
        std::thread::sleep(Duration::from_millis(150));
        changed(&app);
        sync_intercept(&app);
    });
}
