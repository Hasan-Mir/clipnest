mod capture;
mod classify;
mod commands;
mod db;
mod paste;
mod platform;
mod queue;
mod rules;
mod search;
mod state;
mod windowing;

use state::{AppState, HotAction, Settings};
use std::sync::atomic::Ordering;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

// ───────────────────────────── hotkeys ─────────────────────────────

static HOOK_INIT: std::sync::Once = std::sync::Once::new();

fn register_hotkeys(app: &AppHandle) {
    let st = app.state::<AppState>();
    let s = st.settings.read().clone();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    *st.queue_sc.lock() = None;
    let mut list: Vec<(Shortcut, HotAction)> = Vec::new();
    let mut hook: Vec<(u8, u32, u32)> = Vec::new();
    let mut hook_actions: Vec<(u32, HotAction)> = Vec::new();
    let wanted = [
        (s.shortcut_open.clone(), HotAction::Open),
        (s.shortcut_queue.clone(), HotAction::Queue),
        (s.shortcut_plain_toggle.clone(), HotAction::TogglePlain),
        (s.shortcut_pause.clone(), HotAction::TogglePause),
    ];
    for (idx, (text, action)) in wanted.into_iter().enumerate() {
        if text.trim().is_empty() {
            continue;
        }
        if platform::win::is_win_shortcut(&text) {
            // Shortcuts with the Windows key (e.g. Win+V) need the keyboard hook.
            match platform::win::parse_shortcut(&text) {
                Some((mods, vk)) => {
                    hook.push((mods, vk, idx as u32));
                    hook_actions.push((idx as u32, action));
                }
                None => eprintln!("clipnest: invalid shortcut {text}"),
            }
            continue;
        }
        match text.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc.clone()) {
                Ok(_) => list.push((sc, action)),
                Err(e) => eprintln!("clipnest: cannot register {text}: {e}"),
            },
            Err(e) => eprintln!("clipnest: invalid shortcut {text}: {e}"),
        }
    }
    *st.hotkeys.lock() = list;
    *st.hook_actions.lock() = hook_actions;
    if !hook.is_empty() {
        let handle = app.clone();
        HOOK_INIT.call_once(move || {
            let (tx, rx) = std::sync::mpsc::channel::<u32>();
            platform::win::start_hotkey_hook(tx);
            std::thread::spawn(move || {
                while let Ok(id) = rx.recv() {
                    let st = handle.state::<AppState>();
                    let act = st.hook_actions.lock().iter().find(|(i, _)| *i == id).map(|(_, a)| *a);
                    if let Some(a) = act {
                        dispatch(&handle, a);
                    }
                }
            });
        });
    }
    platform::win::set_hook_bindings(hook);
    queue::sync_intercept(app);
}

fn dispatch(app: &AppHandle, action: HotAction) {
    let st = app.state::<AppState>();
    match action {
        HotAction::Open => windowing::toggle_popup(app),
        HotAction::Queue => queue::toggle(app),
        HotAction::TogglePlain => toggle_plain(app),
        HotAction::TogglePause => {
            if st.is_paused() {
                resume(app)
            } else {
                set_pause(app, None)
            }
        }
    }
}

fn on_shortcut(app: &AppHandle, sc: &Shortcut, ev: ShortcutEvent) {
    if ev.state() != ShortcutState::Pressed {
        return;
    }
    let st = app.state::<AppState>();
    let is_queue_paste = st.queue_sc.lock().as_ref().map(|q| q == sc).unwrap_or(false);
    if is_queue_paste {
        queue::on_paste_hotkey(app);
        return;
    }
    let action = st.hotkeys.lock().iter().find(|(s, _)| s == sc).map(|(_, a)| *a);
    if let Some(a) = action {
        dispatch(app, a);
    }
}

// ───────────────────────────── status helpers ─────────────────────────────

fn refresh_tray_tooltip(app: &AppHandle) {
    let st = app.state::<AppState>();
    let mut tip = String::from("ClipNest");
    if st.is_paused() {
        tip.push_str(" — capture paused");
    }
    if st.settings.read().default_mode == "plain" {
        tip.push_str(" — plain-text mode");
    }
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(tip));
    }
    let _ = app.emit("status-changed", ());
}

pub fn set_pause(app: &AppHandle, minutes: Option<u32>) {
    let st = app.state::<AppState>();
    let until = match minutes {
        Some(m) => db::now_ms() + (m as i64) * 60_000,
        None => i64::MAX,
    };
    st.paused_until.store(until, Ordering::SeqCst);
    refresh_tray_tooltip(app);
}

pub fn resume(app: &AppHandle) {
    app.state::<AppState>().paused_until.store(0, Ordering::SeqCst);
    refresh_tray_tooltip(app);
}

pub fn toggle_plain(app: &AppHandle) {
    let mut s = app.state::<AppState>().settings.read().clone();
    s.default_mode = if s.default_mode == "plain" { "rich".into() } else { "plain".into() };
    apply_settings(app, s);
}

/// Persist + apply a new settings object (hotkeys, capture protection, autostart, tray, UI).
pub fn apply_settings(app: &AppHandle, new: Settings) {
    let st = app.state::<AppState>();
    let old = st.settings.read().clone();
    if let Err(e) = new.save(&st.settings_path) {
        eprintln!("clipnest: cannot save settings: {e}");
    }
    *st.settings.write() = new.clone();

    if old.shortcut_open != new.shortcut_open
        || old.shortcut_queue != new.shortcut_queue
        || old.shortcut_plain_toggle != new.shortcut_plain_toggle
        || old.shortcut_pause != new.shortcut_pause
        || old.queue_intercept != new.queue_intercept
    {
        register_hotkeys(app);
    }
    if old.capture_protection != new.capture_protection {
        windowing::apply_capture_protection(app);
    }
    if old.autostart != new.autostart {
        let al = app.autolaunch();
        let _ = if new.autostart { al.enable() } else { al.disable() };
    }
    if old.max_items != new.max_items || old.retention_days != new.retention_days {
        let _ = db::apply_limits(&st.db.lock(), &new);
        let _ = app.emit("items-changed", ());
    }
    if old.language != new.language {
        if let (Some(t), Ok(m)) = (app.tray_by_id("main"), build_menu(app, &new.language)) {
            let _ = t.set_menu(Some(m));
        }
    }
    refresh_tray_tooltip(app);
    let _ = app.emit("settings-changed", ());
}

// ───────────────────────────── tray ─────────────────────────────

fn tr(lang: &str, key: &str) -> &'static str {
    let fa = lang == "fa";
    match (key, fa) {
        ("open", false) => "Open ClipNest",
        ("open", true) => "باز کردن ClipNest",
        ("queue", false) => "Paste Queue (on/off)",
        ("queue", true) => "صف Paste (روشن/خاموش)",
        ("plain", false) => "Toggle plain-text mode",
        ("plain", true) => "حالت متن ساده (روشن/خاموش)",
        ("p15", false) => "Pause 15 minutes",
        ("p15", true) => "توقف ۱۵ دقیقه‌ای",
        ("p60", false) => "Pause 1 hour",
        ("p60", true) => "توقف ۱ ساعته",
        ("p480", false) => "Pause 8 hours",
        ("p480", true) => "توقف ۸ ساعته",
        ("pinf", false) => "Pause until resumed",
        ("pinf", true) => "توقف تا ازسرگیری",
        ("resume", false) => "Resume capture",
        ("resume", true) => "ازسرگیری ثبت",
        ("erase", false) => "Erase history…",
        ("erase", true) => "پاک کردن تاریخچه…",
        ("settings", false) => "Settings…",
        ("settings", true) => "تنظیمات…",
        ("quit", false) => "Quit ClipNest",
        _ => "خروج از ClipNest",
    }
}

fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let mk = |id: &str| MenuItem::with_id(app, id, tr(lang, id), true, None::<&str>);
    let (open, queue_i, plain) = (mk("open")?, mk("queue")?, mk("plain")?);
    let (p15, p60, p480, pinf, res) = (mk("p15")?, mk("p60")?, mk("p480")?, mk("pinf")?, mk("resume")?);
    let (erase, set, quit) = (mk("erase")?, mk("settings")?, mk("quit")?);
    let s1 = PredefinedMenuItem::separator(app)?;
    let s2 = PredefinedMenuItem::separator(app)?;
    let s3 = PredefinedMenuItem::separator(app)?;
    let items: Vec<&dyn IsMenuItem<tauri::Wry>> =
        vec![&open, &queue_i, &plain, &s1, &p15, &p60, &p480, &pinf, &res, &s2, &erase, &set, &s3, &quit];
    Menu::with_items(app, &items)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let lang = app.state::<AppState>().settings.read().language.clone();
    let menu = build_menu(app, &lang)?;
    let mut builder = TrayIconBuilder::with_id("main").tooltip("ClipNest").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => windowing::spawn_show_popup(app.clone(), Some("center".into()), true),
            "queue" => queue::toggle(app),
            "plain" => toggle_plain(app),
            "p15" => set_pause(app, Some(15)),
            "p60" => set_pause(app, Some(60)),
            "p480" => set_pause(app, Some(480)),
            "pinf" => set_pause(app, None),
            "resume" => resume(app),
            "erase" => {
                // The popup asks for confirmation (never erase from a tray click alone).
                let app2 = app.clone();
                std::thread::spawn(move || {
                    windowing::show_popup(&app2, Some("center"), true);
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    let _ = app2.emit("erase-request", ());
                });
            }
            "settings" => windowing::open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                windowing::spawn_show_popup(tray.app_handle().clone(), Some("mouse".into()), true);
            }
        })
        .build(app)?;
    Ok(())
}

// ───────────────────────────── maintenance ─────────────────────────────

fn spawn_maintenance(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let st = app.state::<AppState>();
        let s = st.settings.read().clone();
        let mut changed = false;
        if db::delete_expired(&st.db.lock()) > 0 {
            changed = true;
        }
        let due = s.auto_backup && db::backup_due(&st.db.lock());
        if due {
            if let Err(e) = db::backup(&st.db, &st.data_dir, s.backup_keep) {
                eprintln!("clipnest: backup failed: {e}");
            }
        }
        if changed {
            let _ = app.emit("items-changed", ());
        }
    });
}

// ───────────────────────────── run ─────────────────────────────

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windowing::spawn_show_popup(app.clone(), None, false);
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(on_shortcut).build())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let settings_path = data_dir.join("settings.json");
            let settings = Settings::load(&settings_path);
            let conn = db::open_with_recovery(&data_dir).map_err(|e| e.to_string())?;
            let _ = db::apply_limits(&conn, &settings);
            app.manage(AppState::new(conn, settings.clone(), data_dir, settings_path));

            if let Some(w) = handle.get_webview_window("popup") {
                windowing::apply_protection_to(&handle, &w);
            }
            register_hotkeys(&handle);
            build_tray(&handle)?;
            capture::spawn(handle.clone());
            spawn_maintenance(handle.clone());

            // keep the OS autostart entry in sync with the setting
            let al = handle.autolaunch();
            let enabled = al.is_enabled().unwrap_or(false);
            if settings.autostart && !enabled {
                let _ = al.enable();
            } else if !settings.autostart && enabled {
                let _ = al.disable();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                WindowEvent::Focused(false) if label == "popup" => {
                    let app = window.app_handle();
                    let st = app.state::<AppState>();
                    let since = db::now_ms() - st.popup_shown_at.load(Ordering::SeqCst);
                    if !st.suppress_blur.load(Ordering::SeqCst) && since > 300 {
                        windowing::hide_popup(app);
                    }
                }
                WindowEvent::Moved(pos) if label == "popup" => {
                    let app = window.app_handle();
                    *app.state::<AppState>().last_pos.lock() = Some((pos.x, pos.y));
                }
                WindowEvent::CloseRequested { api, .. } if label == "settings" || label == "queue" => {
                    // keep the window alive (hidden) so re-opening is instant
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_items,
            commands::list_pinboards,
            commands::get_text,
            commands::get_thumb,
            commands::get_image,
            commands::get_formats,
            commands::copy_text,
            commands::get_html,
            commands::get_app_icon,
            commands::move_item,
            commands::export_data,
            commands::import_data,
            commands::export_settings,
            commands::import_settings,
            commands::paste_item,
            commands::copy_item,
            commands::delete_items,
            commands::rename_item,
            commands::set_tags,
            commands::set_pinboard,
            commands::set_pinned,
            commands::create_text_item,
            commands::merge_items,
            commands::update_item_text,
            commands::create_pinboard,
            commands::update_pinboard,
            commands::delete_pinboard,
            commands::run_action,
            commands::open_item,
            commands::reveal_item,
            commands::get_settings,
            commands::set_settings,
            commands::app_status,
            commands::pause_capture,
            commands::resume_capture,
            commands::toggle_plain_mode,
            commands::queue_toggle,
            commands::queue_get,
            commands::queue_remove,
            commands::queue_clear,
            commands::queue_set_fifo,
            commands::hide_popup,
            commands::open_settings,
            commands::erase_history,
            commands::backup_now,
            commands::open_data_dir,
            commands::recent_apps,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ClipNest");

    app.run(|_app, event| {
        // Keep running in the tray when every window is hidden/closed.
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
