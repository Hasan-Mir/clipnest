import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export type Kind = 'text' | 'code' | 'link' | 'image' | 'file' | 'color';

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
    has_thumb: boolean;
    cut: boolean;
}

export interface ListResult {
    items: ClipRow[];
    total: number;
    error: string | null;
}

export interface Pinboard {
    id: number;
    name: string;
    color: string;
    position: number;
    count: number;
    max_items: number;
    list_style: 'inherit' | 'rich' | 'plain';
    paste_mode: 'inherit' | 'rich' | 'plain';
}

export interface AutoRule {
    id: string;
    name: string;
    enabled: boolean;
    apps: string;
    kinds: string[];
    pattern: string;
    action: 'ignore' | 'to_board' | 'tag' | 'plain_only' | 'trim' | 'expire' | 'run_action';
    board: number;
    value: string;
}

export interface FormatMeta {
    name: string;
    mime: string;
    size: number;
}

export interface AppInfo {
    exe: string;
    name: string;
}

export interface AppRule {
    exe: string;
    mode: 'default' | 'rich' | 'plain';
    keys: string;
}

export interface CustomAction {
    id: string;
    name: string;
    command: string;
    output: 'new_item' | 'clipboard' | 'none';
}

export interface Status {
    paused_until: number;
    plain_default: boolean;
    queue_active: boolean;
    queue_mode: 'queue' | 'basket';
    queue_len: number;
    popup_pinned: boolean;
}

/** One file / folder / image of the Drop Basket. */
export interface BasketRow {
    key: string;
    id: number;
    kind: 'file' | 'image' | string;
    path: string | null;
    name: string;
    parent: string | null;
    is_dir: boolean;
    exists: boolean;
    cut: boolean;
    img_w: number | null;
    img_h: number | null;
}

export interface TransferProgress {
    done: number;
    failed: number;
    total: number;
    current: string;
    fraction: number;
    phase: 'copy' | 'finalize' | string;
}

export type TransferErrorCode =
    | 'source_missing'
    | 'invalid_path'
    | 'dest_inside_source'
    | 'dest_create'
    | 'image_missing'
    | 'copy_failed'
    | 'reverify_failed'
    | 'cut_not_removed';

export interface TransferFailure {
    key: string;
    id: number;
    path: string | null;
    name: string;
    is_dir: boolean;
    exists: boolean;
    code: TransferErrorCode | string;
    reason: string;
}

export interface TransferReport {
    total: number;
    done: number;
    failed: TransferFailure[];
    cut_skipped: boolean;
    dest: string;
}

export interface TransferStatus {
    busy: boolean;
    progress: TransferProgress | null;
    report: TransferReport | null;
}

export interface ShortcutConflict {
    status: 'ok' | 'conflict_app' | 'conflict_os' | 'hook_override' | 'invalid';
    message: string;
}

export interface Settings {
    language: string;
    store_rich: boolean;
    list_style: 'rich' | 'plain';
    rules: AutoRule[];
    autostart: boolean;
    explorer_context_menu: boolean;
    max_items: number;
    retention_days: number;
    max_image_mb: number;
    default_mode: 'rich' | 'plain';
    direct_paste: boolean;
    move_to_top: boolean;
    app_rules: AppRule[];
    card_paste_click: 'double' | 'single';
    ctrl_click_action: 'multi_select' | 'paste' | 'paste_plain' | 'copy_only';
    ctrl_shift_click_action: 'paste_plain' | 'paste' | 'copy_only';
    auto_save_edit: boolean;
    basket_allow_cut: boolean;
    basket_group_by_folder: boolean;
    active_pinboard: number | null;
    independent_pinning: boolean;
    ignore_apps: string[];
    ignore_confidential: boolean;
    detect_sensitive: boolean;
    sensitive_action: 'mask' | 'mask_delete' | 'skip';
    sensitive_ttl_min: number;
    capture_protection: 'off' | 'black' | 'hidden';
    theme: 'system' | 'dark' | 'light' | 'oled';
    accent: string;
    density: 'compact' | 'comfortable';
    font_size: number;
    ui_font: 'google-sans' | 'inter' | 'plus-jakarta-sans' | 'dm-sans' | 'roboto';
    font_family: string;
    card_lines: number;
    card_max_height: number;
    popup_width: number;
    popup_height: number;
    popup_position: 'caret' | 'mouse' | 'center' | 'last';
    remember_popup_size: boolean;
    show_toolbar: boolean;
    show_pinboard_counts: boolean;
    wrap_categories: boolean;
    animations: boolean;
    delete_animation: boolean;
    show_thumbnails: boolean;
    thumbnail_size: 'small' | 'medium' | 'large';
    page_size: number;
    highlight_matches: boolean;
    highlight_color: string;
    highlight_bg: string;
    shortcut_open: string;
    shortcut_queue: string;
    shortcut_plain_toggle: string;
    shortcut_pause: string;
    queue_fifo: boolean;
    queue_intercept: boolean;
    auto_backup: boolean;
    backup_keep: number;
    actions: CustomAction[];
}

export type PasteMode = 'auto' | 'plain' | 'rich';

export const api = {
    listItems: (pinboard: number | null, query: string, mode: string, limit: number) =>
        invoke<ListResult>('list_items', { args: { pinboard, query, mode, limit } }),
    listPinboards: () => invoke<Pinboard[]>('list_pinboards'),
    getText: (id: number) => invoke<string>('get_text', { id }),
    getThumb: (id: number) => invoke<string | null>('get_thumb', { id }),
    getImage: (id: number) => invoke<string | null>('get_image', { id }),
    getFormats: (id: number) => invoke<FormatMeta[]>('get_formats', { id }),
    pasteItem: (id: number, mode: PasteMode) => invoke<void>('paste_item', { id, mode }),
    copyText: (text: string) => invoke<void>('copy_text', { text }),
    copyItem: (id: number, mode: PasteMode) => invoke<void>('copy_item', { id, mode }),
    deleteItems: (ids: number[]) => invoke<void>('delete_items', { ids }),
    renameItem: (id: number, title: string) => invoke<void>('rename_item', { id, title }),
    setTags: (id: number, tags: string) => invoke<void>('set_tags', { id, tags }),
    setPinboard: (ids: number[], board: number | null, sourceBoard: number | null = null, copy = false) =>
        invoke<void>('set_pinboard', { ids, board, sourceBoard, copy }),
    setPinned: (ids: number[], pinned: boolean, board: number | null = null) =>
        invoke<void>('set_pinned', { ids, pinned, board }),
    createTextItem: (text: string) => invoke<number>('create_text_item', { text }),
    mergeItems: (ids: number[], sep: string) => invoke<number>('merge_items', { ids, sep }),
    updateItemText: (id: number, text: string) => invoke<void>('update_item_text', { id, text }),
    createPinboard: (name: string, color: string) => invoke<number>('create_pinboard', { name, color }),
    updatePinboard: (
        id: number,
        name: string,
        color: string,
        maxItems: number,
        listStyle: string,
        pasteMode: string = 'inherit'
    ) => invoke<void>('update_pinboard', { id, name, color, maxItems, listStyle, pasteMode }),
    getHtml: (id: number) => invoke<string | null>('get_html', { id }),
    getAppIcon: (exe: string) => invoke<string | null>('get_app_icon', { exe }),
    moveItem: (id: number, target: number, after: boolean, scope: number | null) =>
        invoke<void>('move_item', { id, target, after, scope }),
    exportData: () => invoke<string | null>('export_data'),
    importData: () => invoke<number | null>('import_data'),
    exportSettings: () => invoke<string | null>('export_settings'),
    importSettings: () => invoke<boolean>('import_settings'),
    reorderPinboards: (ids: number[]) => invoke<void>('reorder_pinboards', { ids }),
    deletePinboard: (id: number) => invoke<void>('delete_pinboard', { id }),
    runAction: (id: number, action: string) => invoke<number | null>('run_action', { id, action }),
    openItem: (id: number) => invoke<void>('open_item', { id }),
    revealItem: (id: number, ids?: number[]) => invoke<void>('reveal_item', { id, ids }),
    getSettings: () => invoke<Settings>('get_settings'),
    setSettings: (settings: Settings) => invoke<void>('set_settings', { settings }),
    status: () => invoke<Status>('app_status'),
    setPopupPinned: (pinned: boolean) => invoke<boolean>('set_popup_pinned', { pinned }),
    pause: (minutes: number | null) => invoke<void>('pause_capture', { minutes }),
    resume: () => invoke<void>('resume_capture'),
    togglePlain: () => invoke<void>('toggle_plain_mode'),
    queueToggle: () => invoke<void>('queue_toggle'),
    queueSetMode: (mode: 'queue' | 'basket') => invoke<void>('queue_set_mode', { mode }),
    queueGet: () => invoke<ClipRow[]>('queue_get'),
    queueRemove: (id: number) => invoke<void>('queue_remove', { id }),
    queueClear: () => invoke<void>('queue_clear'),
    queueSetFifo: (fifo: boolean) => invoke<void>('queue_set_fifo', { fifo }),
    basketToggleCut: (id: number) => invoke<void>('basket_toggle_cut', { id }),
    basketGet: () => invoke<BasketRow[]>('basket_get'),
    basketTransferStatus: () => invoke<TransferStatus>('basket_transfer_status'),
    basketRemoveKeys: (keys: string[]) => invoke<void>('basket_remove_keys', { keys }),
    basketSetCut: (keys: string[], cut: boolean) => invoke<void>('basket_set_cut', { keys, cut }),
    basketFileIcon: (path: string) => invoke<string | null>('basket_file_icon', { path }),
    revealPaths: (paths: string[]) => invoke<void>('reveal_paths', { paths }),
    queueReady: () => invoke<void>('queue_ready'),
    basketPasteHere: () => invoke<number>('basket_paste_here'),
    basketPasteToFolder: () => invoke<number | null>('basket_paste_to_folder'),
    showPopup: () => invoke<void>('show_popup_cmd'),
    hidePopup: () => invoke<void>('hide_popup'),
    hideTray: () => invoke<void>('hide_tray'),
    resizeTray: (height: number) => invoke<void>('resize_tray', { height }),
    requestEraseFromTray: () => invoke<void>('request_erase_from_tray'),
    openSettings: () => invoke<void>('open_settings'),
    settingsMinimize: () => invoke<void>('settings_minimize'),
    settingsToggleMaximize: () => invoke<boolean>('settings_toggle_maximize'),
    settingsIsMaximized: () => invoke<boolean>('settings_is_maximized'),
    settingsClose: () => invoke<void>('settings_close'),
    eraseHistory: (includePinned = false, pinboard: number | null = null, allPinboards = false) =>
        invoke<number>('erase_history', { includePinned, pinboard, allPinboards }),
    backupNow: () => invoke<string>('backup_now'),
    openDataDir: () => invoke<void>('open_data_dir'),
    recentApps: () => invoke<AppInfo[]>('recent_apps'),
    quit: () => invoke<void>('quit_app'),
    listSystemFonts: () => invoke<string[]>('list_system_fonts'),
    checkShortcutConflict: (shortcut: string, role: string) =>
        invoke<ShortcutConflict>('check_shortcut_conflict', { shortcut, role }),
    getExplorerTarget: () => invoke<string | null>('get_explorer_target'),
    clearExplorerTarget: () => invoke<void>('clear_explorer_target'),
    pasteFilesToFolder: (ids: number[], folder: string) => invoke<number>('paste_files_to_folder', { ids, folder }),
};

export function on(event: string, cb: () => void): Promise<UnlistenFn> {
    return listen(event, () => cb());
}

/** Subscribes to an event that carries a payload. */
export function onPayload<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
    return listen<T>(event, (e) => cb(e.payload));
}

export function errText(e: unknown): string {
    return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
