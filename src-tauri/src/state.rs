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
    /// Timestamp (epoch ms) of our own most recent clipboard write (prevents self-capture race on paste).
    pub self_write_at: AtomicI64,
    /// True while a Drop Basket transfer is running in the background.
    pub transfer_busy: AtomicBool,
    /// Latest live progress of a running Drop Basket transfer (None when idle).
    pub transfer_progress: Mutex<Option<crate::queue::TransferProgress>>,
    /// Most recent finished Drop Basket transfer report waiting to be consumed by the UI.
    pub transfer_report: Mutex<Option<crate::queue::TransferReport>>,
    /// True once the queue window's webview has rendered (the window is shown only after that).
    pub queue_ready: AtomicBool,
    pub queue_show_pending: AtomicBool,
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
            self_write_at: AtomicI64::new(0),
            transfer_busy: AtomicBool::new(false),
            transfer_progress: Mutex::new(None),
            transfer_report: Mutex::new(None),
            queue_ready: AtomicBool::new(false),
            queue_show_pending: AtomicBool::new(false),
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
