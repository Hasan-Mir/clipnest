pub use clipnest_core::{classify, codec, db, ipc, models, platform, rules, search, transforms};

mod capture;
pub mod cli;
mod commands;
mod paste;
mod queue;
mod state;
mod windowing;

use state::{AppState, HotAction, Settings};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

// ───────────────────────────── portable mode detection ─────────────────────────────

/// Resolves the data directory (`clipnest.db`, `settings.json`, `backups/`).
/// Uses `<exe_dir>/data` when running in portable mode (triggered by `portable.txt`, `.portable`,
/// `portable_data` folder next to the executable, `--portable` CLI flag, or `portable` in the `.exe` name).
fn resolve_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let flag_portable = args.iter().any(|a| a.eq_ignore_ascii_case("--portable"));
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_name = exe_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if let Some(exe_dir) = exe_path.parent() {
            let marker_portable = exe_dir.join("portable.txt").exists()
                || exe_dir.join(".portable").exists()
                || exe_dir.join("portable_data").exists()
                || exe_name.contains("portable");
            if flag_portable || marker_portable {
                let portable_dir = if exe_dir.join("portable_data").exists() {
                    exe_dir.join("portable_data")
                } else {
                    exe_dir.join("data")
                };
                if std::fs::create_dir_all(&portable_dir).is_ok() {
                    return Ok(portable_dir);
                }
            }
        }
    }
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// ───────────────────────────── hotkeys ─────────────────────────────

static HOOK_INIT: std::sync::Once = std::sync::Once::new();
static RESIZE_SAVE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn is_valid_fkey(s: &str) -> bool {
    s.strip_prefix('F')
        .or_else(|| s.strip_prefix('f'))
        .and_then(|n| n.parse::<u32>().ok())
        .map(|n| (1..=24).contains(&n))
        .unwrap_or(false)
}

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
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if platform::win::is_win_shortcut(trimmed) {
            // Shortcuts with the Windows key (e.g. Win+V) need the keyboard hook.
            match platform::win::parse_shortcut(trimmed) {
                Some((mods, vk)) => {
                    hook.push((mods, vk, idx as u32));
                    hook_actions.push((idx as u32, action));
                }
                None => eprintln!("clipnest: invalid shortcut {text}"),
            }
            continue;
        }
        // Reject any non-Win shortcut that has neither a '+' modifier nor is a valid F-key (F1..F24).
        if !trimmed.contains('+') && !is_valid_fkey(trimmed) {
            eprintln!("clipnest: rejecting bare single-key shortcut {text}");
            continue;
        }
        match trimmed.parse::<Shortcut>() {
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

/// Persist + apply a new settings object (hotkeys, capture protection, autostart, Explorer menu, tray, UI).
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
    if old.theme != new.theme {
        windowing::init_startup_windows(app);
    }
    if old.autostart != new.autostart {
        let al = app.autolaunch();
        let _ = if new.autostart { al.enable() } else { al.disable() };
    }
    if old.explorer_context_menu != new.explorer_context_menu || old.language != new.language {
        if let Err(e) = platform::win::sync_explorer_context_menu(new.explorer_context_menu, &new.language) {
            eprintln!("clipnest: could not update Explorer context menu: {e}");
        }
    }
    if old.max_items != new.max_items || old.retention_days != new.retention_days {
        let _ = db::apply_limits(&st.db.lock(), &new);
        let _ = app.emit("items-changed", ());
    }
    refresh_tray_tooltip(app);
    let _ = app.emit("settings-changed", ());
}

// ───────────────────────────── Explorer CLI dispatch ─────────────────────────────

fn handle_cli_args(app: &AppHandle, args: &[String], is_secondary: bool) {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--explorer-files" {
            if let Some(dir) = args.get(i + 1) {
                let clean = dir.trim_matches('"').trim().to_string();
                if !clean.is_empty() {
                    *app.state::<AppState>().explorer_target_dir.lock() = Some(clean.clone());
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        windowing::show_popup(&handle, Some("mouse"), true);
                        std::thread::sleep(std::time::Duration::from_millis(90));
                        let _ = handle.emit("explorer-files-mode", clean);
                    });
                    return;
                }
            }
        } else if arg == "--paste-basket" {
            if let Some(dir) = args.get(i + 1) {
                let clean = dir.trim_matches('"').trim().to_string();
                if !clean.is_empty() {
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let _ = queue::paste_basket_to_dir(&handle, Path::new(&clean));
                    });
                    return;
                }
            }
        } else if arg == "--collect-file" {
            if let Some(file_path) = args.get(i + 1) {
                let clean = file_path.trim_matches('"').trim().to_string();
                if !clean.is_empty() {
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let _ = queue::collect_file_from_explorer(&handle, &clean);
                    });
                    return;
                }
            }
        }
        i += 1;
    }
    if is_secondary {
        windowing::spawn_show_popup(app.clone(), None, false);
    }
}

// ───────────────────────────── tray ─────────────────────────────

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id("main").tooltip("ClipNest").show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                windowing::hide_tray(tray.app_handle());
                windowing::spawn_show_popup(tray.app_handle().clone(), Some("mouse".into()), true);
            }
            TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Up, .. } => {
                windowing::show_tray(tray.app_handle());
            }
            _ => {}
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
    let raw_args: Vec<String> = std::env::args().collect();
    if cli::is_cli_invocation(&raw_args) {
        std::process::exit(cli::run_from_env());
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_cli_args(app, &args, true);
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(on_shortcut).build())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = resolve_data_dir(app)?;
            let settings_path = data_dir.join("settings.json");
            let settings = Settings::load(&settings_path);
            let conn = db::open_with_recovery(&data_dir).map_err(|e| e.to_string())?;
            let _ = db::apply_limits(&conn, &settings);
            app.manage(AppState::new(conn, settings.clone(), data_dir, settings_path));

            windowing::init_startup_windows(&handle);
            register_hotkeys(&handle);
            build_tray(&handle)?;
            capture::spawn(handle.clone());
            spawn_maintenance(handle.clone());
            cli::spawn_ipc_server(handle.clone());

            // Keep the OS autostart entry in sync with the setting
            let al = handle.autolaunch();
            let enabled = al.is_enabled().unwrap_or(false);
            if settings.autostart && !enabled {
                let _ = al.enable();
            } else if !settings.autostart && enabled {
                let _ = al.disable();
            }

            // Keep the Windows File Explorer context menu in sync with settings
            let _ = platform::win::sync_explorer_context_menu(settings.explorer_context_menu, &settings.language);

            // Handle CLI args if ClipNest was cold-launched directly from File Explorer context menu
            let init_args: Vec<String> = std::env::args().collect();
            if init_args.iter().skip(1).any(|a| !a.eq_ignore_ascii_case("--portable")) {
                let h2 = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    handle_cli_args(&h2, &init_args, false);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                WindowEvent::Focused(false) if label == "popup" => {
                    let app = window.app_handle().clone();
                    let win_clone = window.clone();
                    std::thread::spawn(move || {
                        for _ in 0..16 {
                            std::thread::sleep(std::time::Duration::from_millis(25));
                            if !platform::win::is_down(0x01) {
                                break;
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(25));
                        let st = app.state::<AppState>();
                        let fg = platform::win::foreground();
                        if fg != 0 && !platform::win::is_own_window(fg) {
                            st.target_hwnd.store(fg, Ordering::SeqCst);
                        }
                        if st.popup_pinned.load(Ordering::SeqCst) {
                            return;
                        }
                        if st.suppress_blur.load(Ordering::SeqCst) {
                            return;
                        }
                        if win_clone.is_focused().unwrap_or(false) {
                            return;
                        }
                        if let Ok(popup_hwnd) = win_clone.hwnd() {
                            if fg == popup_hwnd.0 as isize {
                                return;
                            }
                        }
                        let since = db::now_ms() - st.popup_shown_at.load(Ordering::SeqCst);
                        if since > 200 {
                            windowing::hide_popup(&app);
                        }
                    });
                }
                WindowEvent::Focused(false) if label == "tray" => {
                    let app = window.app_handle().clone();
                    let win_clone = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(65));
                        let st = app.state::<AppState>();
                        let since = db::now_ms() - st.tray_shown_at.load(Ordering::SeqCst);
                        if since < 550 {
                            if let Ok(h) = win_clone.hwnd() {
                                platform::win::focus_window(h.0 as isize);
                            }
                            let _ = win_clone.set_focus();
                            return;
                        }
                        if !win_clone.is_focused().unwrap_or(false) {
                            windowing::hide_tray(&app);
                        }
                    });
                }
                WindowEvent::Moved(pos) if label == "popup" => {
                    let app = window.app_handle();
                    *app.state::<AppState>().last_pos.lock() = Some((pos.x, pos.y));
                }
                WindowEvent::Resized(phys) if label == "popup" => {
                    if window.is_visible().unwrap_or(false) && phys.width > 0 && phys.height > 0 {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let lw = ((phys.width as f64) / scale).round() as u32;
                        let lh = ((phys.height as f64) / scale).round() as u32;
                        if (260..=1400).contains(&lw) && (320..=1400).contains(&lh) {
                            let app = window.app_handle();
                            let st = app.state::<AppState>();
                            let remember = st.settings.read().remember_popup_size;
                            if remember {
                                let changed = {
                                    let mut s = st.settings.write();
                                    if s.popup_width != lw || s.popup_height != lh {
                                        s.popup_width = lw;
                                        s.popup_height = lh;
                                        true
                                    } else {
                                        false
                                    }
                                };
                                if changed {
                                    let gen = RESIZE_SAVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
                                    let app2 = app.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(std::time::Duration::from_millis(300));
                                        if RESIZE_SAVE_GEN.load(Ordering::SeqCst) == gen {
                                            let st2 = app2.state::<AppState>();
                                            let snap = st2.settings.read().clone();
                                            let _ = snap.save(&st2.settings_path);
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
                WindowEvent::CloseRequested { api, .. } if label == "queue" => {
                    api.prevent_close();
                    queue::close_queue(window.app_handle());
                }
                WindowEvent::CloseRequested { api, .. } if label == "settings" || label == "tray" => {
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
            commands::set_popup_pinned,
            commands::pause_capture,
            commands::resume_capture,
            commands::toggle_plain_mode,
            commands::queue_toggle,
            commands::queue_set_mode,
            commands::queue_get,
            commands::queue_remove,
            commands::queue_clear,
            commands::queue_set_fifo,
            commands::basket_toggle_cut,
            commands::basket_get,
            commands::basket_transfer_status,
            commands::basket_remove_keys,
            commands::basket_set_cut,
            commands::basket_file_icon,
            commands::reveal_paths,
            commands::queue_ready,
            commands::basket_paste_here,
            commands::basket_paste_to_folder,
            commands::show_popup_cmd,
            commands::hide_popup,
            commands::hide_tray,
            commands::resize_tray,
            commands::request_erase_from_tray,
            commands::open_settings,
            commands::erase_history,
            commands::backup_now,
            commands::open_data_dir,
            commands::recent_apps,
            commands::quit_app,
            commands::list_system_fonts,
            commands::check_shortcut_conflict,
            commands::get_explorer_target,
            commands::clear_explorer_target,
            commands::paste_files_to_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ClipNest");

    app.run(|_app, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
