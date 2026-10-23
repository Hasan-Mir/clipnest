#[allow(unused_imports)]
pub use clipnest_core::models::{AppRule, AutoRule, BasketEntry, CustomAction, Queue, Settings};

use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, Ordering};
use tauri_plugin_global_shortcut::Shortcut;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HotAction {
    Open,
    Queue,
    TogglePlain,
    TogglePause,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub settings: RwLock<Settings>,
    pub data_dir: PathBuf,
    pub settings_path: PathBuf,
    /// Window that had the focus before the popup opened (paste target).
    pub target_hwnd: AtomicIsize,
    /// Clipboard sequence number after our own write (so we don't re-capture it).
    pub self_seq: AtomicU32,
    /// 0 = capturing, i64::MAX = paused until resumed, otherwise epoch-ms to resume at.
    pub paused_until: AtomicI64,
    pub queue: Mutex<Queue>,
    pub hotkeys: Mutex<Vec<(Shortcut, HotAction)>>,
    /// Shortcuts that include the Windows key are handled by a keyboard hook: (binding id, action).
    pub hook_actions: Mutex<Vec<(u32, HotAction)>>,
    pub queue_sc: Mutex<Option<Shortcut>>,
    pub popup_shown_at: AtomicI64,
    pub tray_shown_at: AtomicI64,
    pub suppress_blur: AtomicBool,
    pub popup_pinned: AtomicBool,
    pub last_pos: Mutex<Option<(i32, i32)>>,
    /// Folder path when opened from Windows File Explorer context menu.
    pub explorer_target_dir: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(db: Connection, settings: Settings, data_dir: PathBuf, settings_path: PathBuf) -> Self {
        AppState {
            db: Mutex::new(db),
            settings: RwLock::new(settings),
            data_dir,
            settings_path,
            target_hwnd: AtomicIsize::new(0),
            self_seq: AtomicU32::new(0),
            paused_until: AtomicI64::new(0),
            queue: Mutex::new(Queue::default()),
            hotkeys: Mutex::new(vec![]),
            hook_actions: Mutex::new(vec![]),
            queue_sc: Mutex::new(None),
            popup_shown_at: AtomicI64::new(0),
            tray_shown_at: AtomicI64::new(0),
            suppress_blur: AtomicBool::new(false),
            popup_pinned: AtomicBool::new(false),
            last_pos: Mutex::new(None),
            explorer_target_dir: Mutex::new(None),
        }
    }

    pub fn is_paused(&self) -> bool {
        let p = self.paused_until.load(Ordering::SeqCst);
        if p == 0 {
            return false;
        }
        if p != i64::MAX && crate::db::now_ms() >= p {
            self.paused_until.store(0, Ordering::SeqCst);
            return false;
        }
        true
    }
}
