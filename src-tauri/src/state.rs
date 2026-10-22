use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, Ordering};
use tauri_plugin_global_shortcut::Shortcut;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppRule {
    /// Executable name, lower-case (e.g. "winword.exe")
    pub exe: String,
    /// "default" | "rich" | "plain"
    pub mode: String,
    /// "ctrl+v" | "shift+insert" | "ctrl+shift+v"
    pub keys: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CustomAction {
    pub id: String,
    pub name: String,
    /// Shell command. The clip's text is written to its stdin.
    pub command: String,
    /// "new_item" | "clipboard" | "none"
    pub output: String,
}

/// "When X is copied, do Y" (CopyQ-style automatic commands).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AutoRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Comma separated executable-name fragments ("code, chrome"); empty = any app.
    pub apps: String,
    /// Item kinds the rule applies to; empty = any.
    pub kinds: Vec<String>,
    /// Case-insensitive regular expression tested against the text; empty = any.
    pub pattern: String,
    /// "ignore" | "to_board" | "tag" | "plain_only" | "trim" | "expire" | "run_action"
    pub action: String,
    /// Target pinboard id for "to_board" (0 = none).
    pub board: i64,
    /// Tag text, minutes for "expire", or custom-action id for "run_action".
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    // Language / display of the list
    pub language: String,
    pub store_rich: bool,
    pub list_style: String,
    pub rules: Vec<AutoRule>,
    // General
    pub autostart: bool,
    pub max_items: u32,
    pub retention_days: u32,
    pub max_image_mb: u32,
    // Clipboard behaviour
    pub default_mode: String,
    pub direct_paste: bool,
    pub move_to_top: bool,
    pub app_rules: Vec<AppRule>,
    // Privacy
    pub ignore_apps: Vec<String>,
    pub ignore_confidential: bool,
    pub detect_sensitive: bool,
    pub sensitive_action: String,
    pub sensitive_ttl_min: u32,
    pub capture_protection: String,
    // Appearance
    pub theme: String,
    pub accent: String,
    pub density: String,
    pub font_size: u32,
    pub card_lines: u32,
    pub popup_width: u32,
    pub popup_height: u32,
    pub popup_position: String,
    pub show_toolbar: bool,
    // Shortcuts
    pub shortcut_open: String,
    pub shortcut_queue: String,
    pub shortcut_plain_toggle: String,
    pub shortcut_pause: String,
    // Paste queue
    pub queue_fifo: bool,
    pub queue_intercept: bool,
    // Backup
    pub auto_backup: bool,
    pub backup_keep: u32,
    // Actions
    pub actions: Vec<CustomAction>,
}

impl Default for Settings {
    fn default() -> Self {
        let rule = |exe: &str, mode: &str, keys: &str| AppRule {
            exe: exe.into(),
            mode: mode.into(),
            keys: keys.into(),
        };
        Settings {
            language: "en".into(),
            store_rich: true,
            list_style: "rich".into(),
            rules: vec![],
            autostart: false,
            max_items: 5000,
            retention_days: 0,
            max_image_mb: 25,
            default_mode: "rich".into(),
            direct_paste: true,
            move_to_top: true,
            app_rules: vec![
                rule("windowsterminal.exe", "plain", "ctrl+v"),
                rule("cmd.exe", "plain", "ctrl+v"),
                rule("powershell.exe", "plain", "ctrl+v"),
                rule("pwsh.exe", "plain", "ctrl+v"),
                rule("conhost.exe", "plain", "ctrl+v"),
                rule("mintty.exe", "plain", "shift+insert"),
            ],
            ignore_apps: vec![
                "keepass.exe".into(),
                "keepassxc.exe".into(),
                "bitwarden.exe".into(),
                "1password.exe".into(),
                "lastpass.exe".into(),
                "dashlane.exe".into(),
            ],
            ignore_confidential: true,
            detect_sensitive: true,
            sensitive_action: "mask".into(),
            sensitive_ttl_min: 5,
            capture_protection: "black".into(),
            theme: "dark".into(),
            accent: "#4f8cff".into(),
            density: "compact".into(),
            font_size: 13,
            card_lines: 4,
            popup_width: 400,
            popup_height: 560,
            popup_position: "caret".into(),
            show_toolbar: false,
            shortcut_open: "Ctrl+Alt+V".into(),
            shortcut_queue: "Ctrl+Alt+Q".into(),
            shortcut_plain_toggle: "Ctrl+Alt+P".into(),
            shortcut_pause: String::new(),
            queue_fifo: true,
            queue_intercept: true,
            auto_backup: true,
            backup_keep: 7,
            actions: vec![],
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Atomic write: temp file + fsync + rename, so a crash can never leave a half-written file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        crate::db::write_atomic(path, json.as_bytes())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HotAction {
    Open,
    Queue,
    TogglePlain,
    TogglePause,
}

#[derive(Default)]
pub struct Queue {
    pub active: bool,
    /// Clip ids waiting to be pasted.
    pub items: Vec<i64>,
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
    pub suppress_blur: AtomicBool,
    pub last_pos: Mutex<Option<(i32, i32)>>,
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
            suppress_blur: AtomicBool::new(false),
            last_pos: Mutex::new(None),
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
