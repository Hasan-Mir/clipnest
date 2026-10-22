import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type Kind = "text" | "code" | "link" | "image" | "file" | "color";

export interface ClipRow {
  id: number;
  kind: Kind;
  title: string | null;
  preview: string;
  app_name: string;
  app_exe: string;
  tags: string;
  lang: string | null;
  img_w: number | null;
  img_h: number | null;
  color: string | null;
  chars: number;
  file_count: number | null;
  pinboard_id: number | null;
  pinned: boolean;
  sensitive: boolean;
  has_rich: boolean;
  ts: number;
  created_at: number;
}
export interface ListResult { items: ClipRow[]; total: number; error: string | null }
export interface Pinboard { id: number; name: string; color: string; position: number; count: number; max_items: number; list_style: "inherit" | "rich" | "plain" }
export interface AutoRule {
  id: string; name: string; enabled: boolean; apps: string; kinds: string[]; pattern: string;
  action: "ignore" | "to_board" | "tag" | "plain_only" | "trim" | "expire" | "run_action";
  board: number; value: string;
}
export interface FormatMeta { name: string; mime: string; size: number }
export interface AppInfo { exe: string; name: string }
export interface AppRule { exe: string; mode: "default" | "rich" | "plain"; keys: string }
export interface CustomAction { id: string; name: string; command: string; output: "new_item" | "clipboard" | "none" }
export interface Status { paused_until: number; plain_default: boolean; queue_active: boolean; queue_len: number }

export interface Settings {
  language: "en" | "fa"; store_rich: boolean; list_style: "rich" | "plain"; rules: AutoRule[];
  autostart: boolean; max_items: number; retention_days: number; max_image_mb: number;
  default_mode: "rich" | "plain"; direct_paste: boolean; move_to_top: boolean; app_rules: AppRule[];
  ignore_apps: string[]; ignore_confidential: boolean; detect_sensitive: boolean;
  sensitive_action: "mask" | "mask_delete" | "skip"; sensitive_ttl_min: number;
  capture_protection: "off" | "black" | "hidden";
  theme: "dark" | "light" | "oled"; accent: string; density: "compact" | "comfortable";
  font_size: number; card_lines: number; popup_width: number; popup_height: number;
  popup_position: "caret" | "mouse" | "center" | "last"; show_toolbar: boolean;
  shortcut_open: string; shortcut_queue: string; shortcut_plain_toggle: string; shortcut_pause: string;
  queue_fifo: boolean; queue_intercept: boolean; auto_backup: boolean; backup_keep: number;
  actions: CustomAction[];
}

export type PasteMode = "auto" | "plain" | "rich";

export const api = {
  listItems: (pinboard: number | null, query: string, mode: string, limit: number) =>
    invoke<ListResult>("list_items", { args: { pinboard, query, mode, limit } }),
  listPinboards: () => invoke<Pinboard[]>("list_pinboards"),
  getText: (id: number) => invoke<string>("get_text", { id }),
  getThumb: (id: number) => invoke<string | null>("get_thumb", { id }),
  getImage: (id: number) => invoke<string | null>("get_image", { id }),
  getFormats: (id: number) => invoke<FormatMeta[]>("get_formats", { id }),
  pasteItem: (id: number, mode: PasteMode) => invoke<void>("paste_item", { id, mode }),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  copyItem: (id: number, mode: PasteMode) => invoke<void>("copy_item", { id, mode }),
  deleteItems: (ids: number[]) => invoke<void>("delete_items", { ids }),
  renameItem: (id: number, title: string) => invoke<void>("rename_item", { id, title }),
  setTags: (id: number, tags: string) => invoke<void>("set_tags", { id, tags }),
  setPinboard: (ids: number[], board: number | null) => invoke<void>("set_pinboard", { ids, board }),
  setPinned: (ids: number[], pinned: boolean) => invoke<void>("set_pinned", { ids, pinned }),
  createTextItem: (text: string) => invoke<number>("create_text_item", { text }),
  mergeItems: (ids: number[], sep: string) => invoke<number>("merge_items", { ids, sep }),
  updateItemText: (id: number, text: string) => invoke<void>("update_item_text", { id, text }),
  createPinboard: (name: string, color: string) => invoke<number>("create_pinboard", { name, color }),
  updatePinboard: (id: number, name: string, color: string, maxItems: number, listStyle: string) =>
    invoke<void>("update_pinboard", { id, name, color, maxItems, listStyle }),
  getHtml: (id: number) => invoke<string | null>("get_html", { id }),
  getAppIcon: (exe: string) => invoke<string | null>("get_app_icon", { exe }),
  moveItem: (id: number, target: number, after: boolean, scope: number | null) =>
    invoke<void>("move_item", { id, target, after, scope }),
  exportData: () => invoke<string | null>("export_data"),
  importData: () => invoke<number | null>("import_data"),
  exportSettings: () => invoke<string | null>("export_settings"),
  importSettings: () => invoke<boolean>("import_settings"),
  deletePinboard: (id: number) => invoke<void>("delete_pinboard", { id }),
  runAction: (id: number, action: string) => invoke<number | null>("run_action", { id, action }),
  openItem: (id: number) => invoke<void>("open_item", { id }),
  revealItem: (id: number) => invoke<void>("reveal_item", { id }),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  status: () => invoke<Status>("app_status"),
  pause: (minutes: number | null) => invoke<void>("pause_capture", { minutes }),
  resume: () => invoke<void>("resume_capture"),
  togglePlain: () => invoke<void>("toggle_plain_mode"),
  queueToggle: () => invoke<void>("queue_toggle"),
  queueGet: () => invoke<ClipRow[]>("queue_get"),
  queueRemove: (id: number) => invoke<void>("queue_remove", { id }),
  queueClear: () => invoke<void>("queue_clear"),
  queueSetFifo: (fifo: boolean) => invoke<void>("queue_set_fifo", { fifo }),
  hidePopup: () => invoke<void>("hide_popup"),
  openSettings: () => invoke<void>("open_settings"),
  eraseHistory: () => invoke<void>("erase_history"),
  backupNow: () => invoke<string>("backup_now"),
  openDataDir: () => invoke<void>("open_data_dir"),
  recentApps: () => invoke<AppInfo[]>("recent_apps"),
  quit: () => invoke<void>("quit_app"),
};

export function on(event: string, cb: () => void): Promise<UnlistenFn> {
  return listen(event, () => cb());
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
