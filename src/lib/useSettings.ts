import { useCallback, useEffect, useRef, useState } from 'react';
import { api, on, Settings } from './api';
import { contrastOn } from './format';
import { setLang } from './i18n';
import { applyUiFont } from './uiFonts';

export const DEFAULT_SETTINGS: Settings = {
    language: 'en',
    store_rich: true,
    list_style: 'rich',
    rules: [],
    autostart: false,
    explorer_context_menu: true,
    max_items: 5000,
    retention_days: 0,
    max_image_mb: 25,
    default_mode: 'rich',
    direct_paste: true,
    move_to_top: true,
    app_rules: [
        { exe: 'windowsterminal.exe', mode: 'plain', keys: 'ctrl+v' },
        { exe: 'cmd.exe', mode: 'plain', keys: 'ctrl+v' },
        { exe: 'powershell.exe', mode: 'plain', keys: 'ctrl+v' },
        { exe: 'pwsh.exe', mode: 'plain', keys: 'ctrl+v' },
        { exe: 'conhost.exe', mode: 'plain', keys: 'ctrl+v' },
        { exe: 'mintty.exe', mode: 'plain', keys: 'shift+insert' },
    ],
    card_paste_click: 'double',
    ctrl_click_action: 'multi_select',
    ctrl_shift_click_action: 'paste_plain',
    auto_save_edit: true,
    basket_allow_cut: true,
    basket_group_by_folder: true,
    active_pinboard: null,
    independent_pinning: true,
    ignore_apps: ['keepass.exe', 'keepassxc.exe', 'bitwarden.exe', '1password.exe', 'lastpass.exe', 'dashlane.exe'],
    ignore_confidential: true,
    detect_sensitive: true,
    sensitive_action: 'mask',
    sensitive_ttl_min: 5,
    capture_protection: 'black',
    theme: 'dark',
    accent: '#4f8cff',
    density: 'compact',
    font_size: 14,
    ui_font: 'google-sans',
    font_family: '',
    card_lines: 4,
    card_max_height: 160,
    popup_width: 400,
    popup_height: 560,
    popup_position: 'caret',
    remember_popup_size: true,
    show_toolbar: false,
    show_pinboard_counts: true,
    wrap_categories: false,
    animations: true,
    delete_animation: true,
    show_thumbnails: true,
    thumbnail_size: 'medium',
    page_size: 100,
    highlight_matches: true,
    highlight_color: 'accent',
    highlight_bg: 'transparent',
    shortcut_open: 'Super+V',
    shortcut_queue: 'Ctrl+Alt+Q',
    shortcut_plain_toggle: 'Ctrl+Alt+P',
    shortcut_pause: '',
    queue_fifo: true,
    queue_intercept: true,
    auto_backup: true,
    backup_keep: 7,
    actions: [],
};

/**
 * Loads the settings, keeps them in sync with the backend and applies the theme CSS variables.
 * Writes are debounced, and the "settings-changed" echo of our own save is ignored, so typing in a
 * text field can never be overwritten by an older value coming back from the backend.
 */
export function useSettings(): [Settings | null, (s: Settings) => void] {
    const [s, setS] = useState<Settings | null>(null);
    const timer = useRef<number | undefined>(undefined);
    const latest = useRef<Settings | null>(null);
    const lastSent = useRef(0);
    const version = useRef(0);
    const inFlightSaves = useRef(0);

    const flush = useCallback(() => {
        if (timer.current === undefined) {
            return;
        }
        window.clearTimeout(timer.current);
        timer.current = undefined;
        const payload = latest.current;
        if (!payload) {
            return;
        }
        inFlightSaves.current += 1;
        lastSent.current = Date.now();
        api.setSettings(payload)
            .catch(() => {})
            .finally(() => {
                inFlightSaves.current = Math.max(0, inFlightSaves.current - 1);
                lastSent.current = Date.now();
            });
    }, []);

    const load = useCallback(() => {
        if (timer.current !== undefined || inFlightSaves.current > 0 || Date.now() - lastSent.current < 700) {
            return;
        }
        const reqVer = version.current;
        api.getSettings()
            .then((next) => {
                if (reqVer === version.current && timer.current === undefined && inFlightSaves.current === 0) {
                    setS(next);
                }
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        load();
        const p = on('settings-changed', load);
        window.addEventListener('pagehide', flush);
        return () => {
            window.removeEventListener('pagehide', flush);
            flush();
            p.then((u) => u()).catch(() => {});
        };
    }, [load, flush]);

    useEffect(() => {
        if (!s) {
            return;
        }
        const r = document.documentElement;
        const mql = window.matchMedia('(prefers-color-scheme: light)');
        const applyResolvedTheme = () => {
            const resolved = s.theme === 'system' ? (mql.matches ? 'light' : 'dark') : s.theme;
            r.dataset.theme = resolved;
            try {
                localStorage.setItem('clipnest_theme', resolved);
            } catch {
                // ignore
            }
        };
        applyResolvedTheme();

        r.dataset.density = s.density;
        r.dataset.animations = s.animations ? 'on' : 'off';
        r.dataset.deleteAnimation = s.animations && (s.delete_animation ?? true) ? 'on' : 'off';
        r.style.setProperty('--accent', s.accent);
        r.style.setProperty('--accent-fg', contrastOn(s.accent));
        r.style.setProperty('--fs', `${s.font_size}px`);
        applyUiFont(s.ui_font);

        const fam = s.font_family ? s.font_family.trim() : '';
        if (fam) {
            r.dataset.customFont = 'on';
            r.style.setProperty(
                '--card-font',
                `"${fam.replace(/"/g, '')}", "Vazirmatn", system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Tahoma, sans-serif`
            );
        } else {
            r.dataset.customFont = 'off';
            r.style.setProperty(
                '--card-font',
                '"Vazirmatn", system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Tahoma, sans-serif'
            );
        }

        const maxH = s.card_max_height > 0 ? `${Math.max(60, s.card_max_height)}px` : 'none';
        r.style.setProperty('--card-max-h', maxH);

        const thumbPx = s.thumbnail_size === 'small' ? '52px' : s.thumbnail_size === 'large' ? '170px' : '110px';
        r.style.setProperty('--thumb-max-h', thumbPx);

        const rawHl = (s.highlight_color || '').trim();
        const resolvedHlColor = !rawHl || rawHl.toLowerCase() === 'accent' ? s.accent : rawHl;
        r.style.setProperty('--hl-color', s.highlight_matches ? resolvedHlColor : 'inherit');
        r.style.setProperty('--hl-bg', s.highlight_matches ? s.highlight_bg : 'transparent');
        setLang(s.language || 'en');

        if (s.theme === 'system') {
            mql.addEventListener('change', applyResolvedTheme);
            return () => {
                mql.removeEventListener('change', applyResolvedTheme);
            };
        }
        return undefined;
    }, [s]);

    const save = useCallback(
        (next: Settings) => {
            version.current += 1;
            setS(next);
            latest.current = next;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
                flush();
            }, 250);
        },
        [flush]
    );

    return [s, save];
}
