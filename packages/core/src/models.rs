//! Pure configuration, rule, action, and queue models shared across GUI and CLI.

use serde::{Deserialize, Serialize};
use std::path::Path;

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
    /// Target category/pinboard id for "to_board" (0 = none).
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
    pub explorer_context_menu: bool,
    pub max_items: u32,
    pub retention_days: u32,
    pub max_image_mb: u32,
    // Clipboard behaviour
    pub default_mode: String,
    pub direct_paste: bool,
    pub move_to_top: bool,
    pub app_rules: Vec<AppRule>,
    pub card_paste_click: String,
    pub ctrl_click_action: String,
    pub ctrl_shift_click_action: String,
    pub auto_save_edit: bool,
    pub basket_allow_cut: bool,
    pub active_pinboard: Option<i64>,
    pub independent_pinning: bool,
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
    pub font_family: String,
    pub card_lines: u32,
    pub card_max_height: u32,
    pub popup_width: u32,
    pub popup_height: u32,
    pub popup_position: String,
    pub remember_popup_size: bool,
    pub show_toolbar: bool,
    pub show_pinboard_counts: bool,
    pub wrap_categories: bool,
    pub animations: bool,
    pub show_thumbnails: bool,
    pub thumbnail_size: String,
    pub virtual_scroll: bool,
    pub highlight_matches: bool,
    pub highlight_color: String,
    pub highlight_bg: String,
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
        let rule =
            |exe: &str, mode: &str, keys: &str| AppRule { exe: exe.into(), mode: mode.into(), keys: keys.into() };
        Settings {
            language: "en".into(),
            store_rich: true,
            list_style: "rich".into(),
            rules: vec![],
            autostart: false,
            explorer_context_menu: true,
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
            card_paste_click: "double".into(),
            ctrl_click_action: "multi_select".into(),
            ctrl_shift_click_action: "paste_plain".into(),
            auto_save_edit: true,
            basket_allow_cut: true,
            active_pinboard: None,
            independent_pinning: true,
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
            font_family: String::new(),
            card_lines: 4,
            card_max_height: 160,
            popup_width: 400,
            popup_height: 560,
            popup_position: "caret".into(),
            remember_popup_size: true,
            show_toolbar: false,
            show_pinboard_counts: true,
            wrap_categories: false,
            animations: true,
            show_thumbnails: true,
            thumbnail_size: "medium".into(),
            virtual_scroll: true,
            highlight_matches: true,
            highlight_color: "accent".into(),
            highlight_bg: "transparent".into(),
            shortcut_open: "Super+V".into(),
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
        std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    /// Atomic write: temp file + fsync + rename, so a crash can never leave a half-written file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        crate::db::write_atomic(path, json.as_bytes())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BasketEntry {
    pub id: i64,
    pub cut: bool,
}

pub struct Queue {
    pub active: bool,
    /// "queue" | "basket"
    pub mode: String,
    /// Clip ids waiting to be pasted in sequential Queue mode.
    pub items: Vec<i64>,
    /// File and image items collected in Drop Basket mode.
    pub basket: Vec<BasketEntry>,
}

impl Default for Queue {
    fn default() -> Self {
        Queue { active: false, mode: "queue".into(), items: Vec::new(), basket: Vec::new() }
    }
}
