import React, { useEffect, useRef, useState } from 'react';
import {
    api,
    AppInfo,
    AppRule,
    AutoRule,
    CustomAction,
    Pinboard,
    Settings,
    ShortcutConflict,
    errText,
} from '../lib/api';
import { CustomSelect } from '../lib/CustomSelect';
import { LOCALES, t, useLang } from '../lib/i18n';
import { Icon } from '../lib/icons';
import { eventToShortcut, formatHeldModifiers } from '../lib/shortcut';
import { DEFAULT_SETTINGS, useSettings } from '../lib/useSettings';
import { ContextMenu, MenuEntry, Prompt, PromptState } from '../popup/Overlays';

type TabId =
    | 'general'
    | 'clipboard'
    | 'appearance'
    | 'privacy'
    | 'shortcuts'
    | 'rules'
    | 'actions'
    | 'backup'
    | 'help'
    | 'about';

const TABS: { id: TabId; label: string; keys: (keyof Settings)[] }[] = [
    {
        id: 'general',
        label: 'General',
        keys: [
            'language',
            'autostart',
            'explorer_context_menu',
            'max_items',
            'retention_days',
            'max_image_mb',
        ],
    },
    {
        id: 'clipboard',
        label: 'Copy & Paste',
        keys: [
            'store_rich',
            'list_style',
            'default_mode',
            'direct_paste',
            'move_to_top',
            'card_paste_click',
            'ctrl_click_action',
            'ctrl_shift_click_action',
            'auto_save_edit',
            'queue_fifo',
            'queue_intercept',
            'basket_allow_cut',
            'app_rules',
        ],
    },
    {
        id: 'appearance',
        label: 'Appearance',
        keys: [
            'theme',
            'accent',
            'animations',
            'density',
            'font_size',
            'font_family',
            'card_lines',
            'card_max_height',
            'show_thumbnails',
            'thumbnail_size',
            'virtual_scroll',
            'highlight_matches',
            'highlight_color',
            'highlight_bg',
            'popup_position',
            'popup_width',
            'popup_height',
            'remember_popup_size',
            'show_toolbar',
            'show_pinboard_counts',
        ],
    },
    {
        id: 'privacy',
        label: 'Privacy & Screen capture',
        keys: [
            'capture_protection',
            'ignore_confidential',
            'detect_sensitive',
            'sensitive_action',
            'sensitive_ttl_min',
            'ignore_apps',
        ],
    },
    {
        id: 'shortcuts',
        label: 'Shortcuts',
        keys: ['shortcut_open', 'shortcut_queue', 'shortcut_plain_toggle', 'shortcut_pause'],
    },
    {
        id: 'rules',
        label: 'Automatic rules',
        keys: ['rules'],
    },
    {
        id: 'actions',
        label: 'Custom actions',
        keys: ['actions'],
    },
    {
        id: 'backup',
        label: 'Backup & Data',
        keys: ['auto_backup', 'backup_keep'],
    },
    {
        id: 'help',
        label: 'Help & Guide',
        keys: [],
    },
    {
        id: 'about',
        label: 'About',
        keys: [],
    },
];

function isModified<K extends keyof Settings>(s: Settings, k: K): boolean {
    return JSON.stringify(s[k]) !== JSON.stringify(DEFAULT_SETTINGS[k]);
}

function matchesSearch(q: string, ...texts: (string | undefined)[]): boolean {
    const normQ = q.trim().toLowerCase();
    if (!normQ) {
        return true;
    }
    return texts.some((txt) => {
        if (!txt) {
            return false;
        }
        return txt.toLowerCase().includes(normQ) || t(txt).toLowerCase().includes(normQ);
    });
}

// ───────────── small controls ─────────────
function Row({
    k,
    s,
    searchQuery,
    label,
    hint,
    onGearMenu,
    children,
}: {
    k?: keyof Settings;
    s: Settings;
    searchQuery: string;
    label: string;
    hint?: string;
    onGearMenu: (k: keyof Settings, x: number, y: number) => void;
    children: React.ReactNode;
}) {
    if (!matchesSearch(searchQuery, label, hint, k ? String(k) : undefined)) {
        return null;
    }
    const mod = k ? isModified(s, k) : false;
    return (
        <div className={`srow${mod ? ' modified' : ''}`}>
            <div className="slabel">
                <div className="slabel-head">
                    <span>{t(label)}</span>
                    {k && (
                        <button
                            type="button"
                            className="srow-gear"
                            data-tip={t('Reset Setting')}
                            onClick={(e) => {
                                e.stopPropagation();
                                onGearMenu(k, e.clientX, e.clientY);
                            }}
                        >
                            <Icon name="gear" size={13} />
                        </button>
                    )}
                </div>
                {hint && <div className="muted small">{t(hint)}</div>}
            </div>
            <div className="sctl">{children}</div>
        </div>
    );
}

function Toggle({ v, on }: { v: boolean; on: (b: boolean) => void }) {
    return (
        <button
            type="button"
            className={`switch${v ? ' on' : ''}`}
            onClick={() => on(!v)}
            role="switch"
            aria-checked={v}
        >
            <span />
        </button>
    );
}

function Select<T extends string>({ v, on, opts }: { v: T; on: (v: T) => void; opts: [T, string][] }) {
    return (
        <CustomSelect value={v} onChange={on} options={opts.map(([k, l]) => ({ value: k, label: t(l) }))} />
    );
}

function Num({
    v,
    on,
    min = 0,
    max = 1_000_000,
    step = 1,
}: {
    v: number;
    on: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
}) {
    return (
        <input
            type="number"
            value={v}
            min={min}
            max={max}
            step={step}
            onChange={(e) => on(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        />
    );
}

/**
 * Shortcut recorder with live modifier display (e.g. "Ctrl + Alt + ") while recording
 * and real-time OS / app conflict checking via `api.checkShortcutConflict`.
 */
function ShortcutInput({
    v,
    role,
    on,
}: {
    v: string;
    role: 'open' | 'queue' | 'plain' | 'pause';
    on: (s: string) => void;
}) {
    const [rec, setRec] = useState(false);
    const [liveMods, setLiveMods] = useState('');
    const [conflict, setConflict] = useState<ShortcutConflict | null>(null);

    const hasWin = /(^|\+)(super|win|meta)(\+|$)/i.test(v);
    const withoutWin = v
        .split('+')
        .filter((p) => !/^(super|win|meta)$/i.test(p))
        .join('+');
    const isFKey = /^F([1-9]|1\d|2[0-4])$/i.test(withoutWin);

    useEffect(() => {
        const trimmed = v.trim();
        if (!trimmed) {
            setConflict(null);
            return;
        }
        let alive = true;
        api.checkShortcutConflict(trimmed, role)
            .then((res) => {
                if (alive) {
                    setConflict(res);
                }
            })
            .catch(() => {
                if (alive) {
                    setConflict(null);
                }
            });
        return () => {
            alive = false;
        };
    }, [v, role]);

    const recordingText = liveMods || (hasWin ? 'Win + ' : t('Press keys…'));

    return (
        <div className="shortcut-wrap">
            <div className="shortcut">
                <button
                    type="button"
                    className={`btn shortcut-btn${rec ? ' primary' : ''}`}
                    dir="ltr"
                    onClick={() => {
                        setRec(true);
                        setLiveMods(hasWin ? 'Win + ' : '');
                    }}
                    onBlur={() => {
                        setRec(false);
                        setLiveMods('');
                    }}
                    onKeyDown={(e) => {
                        if (!rec) {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.key === 'Escape') {
                            setRec(false);
                            setLiveMods('');
                            return;
                        }
                        if (
                            (e.key === 'Backspace' || e.key === 'Delete') &&
                            !e.ctrlKey &&
                            !e.altKey &&
                            !e.shiftKey
                        ) {
                            on('');
                            setRec(false);
                            setLiveMods('');
                            return;
                        }
                        setLiveMods(formatHeldModifiers(e.nativeEvent, hasWin));
                        const s = eventToShortcut(e, hasWin);
                        if (s) {
                            on(hasWin && !/super/i.test(s) ? `Super+${s}` : s);
                            setRec(false);
                            setLiveMods('');
                        }
                    }}
                    onKeyUp={(e) => {
                        if (!rec) {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        setLiveMods(formatHeldModifiers(e.nativeEvent, hasWin));
                    }}
                >
                    <span>{rec ? recordingText : v || t('— none —')}</span>
                </button>
                <label className="winbox" data-tip={t('Include the Windows key')}>
                    <input
                        type="checkbox"
                        checked={hasWin}
                        disabled={!v && !rec}
                        onChange={(e) => {
                            if (e.target.checked) {
                                on(withoutWin ? `Super+${withoutWin}` : 'Super+V');
                            } else {
                                if (!withoutWin.includes('+') && !isFKey) {
                                    on('');
                                } else {
                                    on(withoutWin);
                                }
                            }
                        }}
                    />
                    <span>Win</span>
                </label>
                {v && !rec && (
                    <button type="button" className="btn" onClick={() => on('')}>
                        <span>{t('Clear')}</span>
                    </button>
                )}
            </div>
            {v && conflict && conflict.status !== 'ok' && (
                <div className={`sc-status ${conflict.status === 'hook_override' ? 'info' : 'warn'}`}>
                    <Icon name={conflict.status === 'hook_override' ? 'info' : 'warning'} size={12} />
                    <span>{t(conflict.message)}</span>
                </div>
            )}
            {v && conflict && conflict.status === 'ok' && (
                <div className="sc-status ok">
                    <Icon name="check" size={12} />
                    <span>{t('No conflict detected')}</span>
                </div>
            )}
        </div>
    );
}

function TagList({
    items,
    onChange,
    suggestions,
    placeholder,
}: {
    items: string[];
    onChange: (l: string[]) => void;
    suggestions?: AppInfo[];
    placeholder: string;
}) {
    const [x, setX] = useState('');
    const add = (v0: string) => {
        const v = v0.trim().toLowerCase();
        if (v && !items.includes(v)) {
            onChange([...items, v]);
        }
        setX('');
    };
    return (
        <div className="taglist">
            <div className="pills">
                {items.map((a) => (
                    <span key={a} className="pill">
                        <span>{a}</span>
                        <button type="button" onClick={() => onChange(items.filter((y) => y !== a))}>
                            ×
                        </button>
                    </span>
                ))}
            </div>
            <div className="addrow">
                <input
                    dir="ltr"
                    value={x}
                    placeholder={placeholder}
                    onChange={(e) => setX(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            add(x);
                        }
                    }}
                />
                <button type="button" className="btn" onClick={() => add(x)}>
                    <span>{t('Add')}</span>
                </button>
            </div>
            {suggestions && suggestions.filter((s) => !items.includes(s.exe)).length > 0 && (
                <div className="suggest">
                    <span className="muted small">{t('Recently seen:')}</span>
                    {suggestions
                        .filter((s) => !items.includes(s.exe))
                        .slice(0, 10)
                        .map((s) => (
                            <button key={s.exe} type="button" className="chip" onClick={() => add(s.exe)}>
                                <span>{s.name}</span>
                            </button>
                        ))}
                </div>
            )}
        </div>
    );
}

const KINDS = ['text', 'code', 'link', 'image', 'file', 'color'];
const ACTIONS: [AutoRule['action'], string][] = [
    ['ignore', 'Do not store'],
    ['to_board', 'Move to pinboard'],
    ['tag', 'Add tag'],
    ['plain_only', 'Keep plain text only'],
    ['trim', 'Trim whitespace'],
    ['expire', 'Auto-delete after N minutes'],
    ['run_action', 'Run custom action'],
];

// ───────────── main ─────────────
export default function SettingsView() {
    useLang();
    const [s, save] = useSettings();
    const [tab, setTab] = useState<TabId>('general');
    const [searchQuery, setSearchQuery] = useState('');
    const [apps, setApps] = useState<AppInfo[]>([]);
    const [boards, setBoards] = useState<Pinboard[]>([]);
    const [systemFonts, setSystemFonts] = useState<string[]>([]);
    const [msg, setMsg] = useState('');
    const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
    const [prompt, setPrompt] = useState<PromptState | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        api.recentApps()
            .then(setApps)
            .catch(() => {});
        api.listPinboards()
            .then(setBoards)
            .catch(() => {});
    }, [tab]);

    useEffect(() => {
        api.listSystemFonts()
            .then(setSystemFonts)
            .catch(() => {});
    }, []);

    useEffect(() => {
        const onFocusSearch = () => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        };
        window.addEventListener('clipnest-focus-search', onFocusSearch);
        return () => {
            window.removeEventListener('clipnest-focus-search', onFocusSearch);
        };
    }, []);

    if (!s) {
        return (
            <div className="settings">
                <div className="muted" style={{ padding: 24 }}>
                    …
                </div>
            </div>
        );
    }

    const set = <K extends keyof Settings>(k: K, v: Settings[K]) => save({ ...s, [k]: v });
    const flash = (x: string) => {
        setMsg(x);
        window.setTimeout(() => setMsg(''), 4000);
    };
    const run = async (f: () => Promise<string | null | undefined>) => {
        try {
            const r = await f();
            if (r) {
                flash(r);
            }
        } catch (e) {
            flash(errText(e));
        }
    };

    const openGearMenu = (k: keyof Settings, x: number, y: number) => {
        const jsonSnippet = `"${String(k)}": ${JSON.stringify(s[k])}`;
        setMenu({
            x,
            y,
            entries: [
                {
                    label: t('Reset Setting'),
                    onClick: () => {
                        set(k, DEFAULT_SETTINGS[k]);
                    },
                },
                { sep: true },
                {
                    label: t('Copy Setting ID'),
                    onClick: () => {
                        api.copyText(String(k)).catch(() => {});
                        flash(t('Copied {v}', { v: String(k) }));
                    },
                },
                {
                    label: t('Copy Setting as JSON'),
                    onClick: () => {
                        api.copyText(jsonSnippet).catch(() => {});
                        flash(t('Copied {v}', { v: jsonSnippet }));
                    },
                },
            ],
        });
    };

    const resetSection = (tabId: TabId) => {
        const def = TABS.find((x) => x.id === tabId);
        if (!def) {
            return;
        }
        const next = { ...s };
        for (const key of def.keys) {
            (next as Record<keyof Settings, unknown>)[key] = DEFAULT_SETTINGS[key];
        }
        save(next);
        flash(t('Settings reset to defaults'));
    };

    const askResetAll = () => {
        setPrompt({
            title: t('Reset all settings to their default values?'),
            confirm: true,
            okLabel: t('Reset'),
            danger: true,
            onSubmit: () => {
                save({ ...DEFAULT_SETTINGS });
                flash(t('Settings reset to defaults'));
            },
        });
    };

    const askEraseHistory = () => {
        const targetBoard = boards.find((b) => b.id === s.active_pinboard) ?? null;
        const msgText = targetBoard
            ? t('This will erase items in the active pinboard "{name}".', { name: targetBoard.name })
            : t(
                  'This will erase items in the main Clipboard tab (pinboards are kept unless you check the option below).'
              );
        setPrompt({
            title: t('Erase all history?'),
            message: msgText,
            confirm: true,
            checkLabel: t('Also erase pinned items'),
            defaultChecked: false,
            checkLabel2: t('Also erase all pinboards and main clipboard'),
            defaultChecked2: false,
            okLabel: t('Erase'),
            danger: true,
            onSubmit: (_val, includePinned, allPinboards) => {
                api.eraseHistory(includePinned, targetBoard?.id ?? null, allPinboards)
                    .then(() => flash(t('History erased')))
                    .catch((e) => flash(errText(e)));
            },
        });
    };

    const sectionModified = (tabId: TabId): boolean => {
        const def = TABS.find((x) => x.id === tabId);
        if (!def) {
            return false;
        }
        return def.keys.some((k) => isModified(s, k));
    };

    const renderSectionHeader = (tabId: TabId, title: string) => (
        <div className="spane-head">
            <h2>{t(title)}</h2>
            {sectionModified(tabId) && (
                <button type="button" className="btn small-btn" onClick={() => resetSection(tabId)}>
                    <Icon name="reset" size={12} /> <span>{t('Reset section')}</span>
                </button>
            )}
        </div>
    );

    const updRule = (i: number, p: Partial<AppRule>) =>
        set(
            'app_rules',
            s.app_rules.map((r, j) => (j === i ? { ...r, ...p } : r))
        );
    const updAct = (i: number, p: Partial<CustomAction>) =>
        set(
            'actions',
            s.actions.map((a, j) => (j === i ? { ...a, ...p } : a))
        );
    const updAuto = (i: number, p: Partial<AutoRule>) =>
        set(
            'rules',
            s.rules.map((a, j) => (j === i ? { ...a, ...p } : a))
        );

    const q = searchQuery.trim();
    const isSearching = q.length > 0;
    const showTab = (id: TabId, keywords: string[]) => {
        if (!isSearching) {
            return tab === id;
        }
        return matchesSearch(q, ...keywords);
    };

    const localeOptions = LOCALES.map((l) => ({
        value: l.code,
        label: l.name,
        subLabel: l.englishName,
    }));
    const fontOptions = [
        { value: '', label: t('Default (Vazirmatn / System)') },
        ...systemFonts.map((f) => ({ value: f, label: f, fontFamily: f })),
    ];
    const resolvedHlHex =
        !s.highlight_color || s.highlight_color.toLowerCase() === 'accent'
            ? s.accent
            : /^#[0-9a-fA-F]{6}$/.test(s.highlight_color)
              ? s.highlight_color
              : s.accent;

    return (
        <div className="settings">
            <nav className="snav">
                <div className="sbrand">
                    <img className="logo-img" src="/icon.png" alt="ClipNest" draggable={false} />
                    <span>ClipNest</span>
                </div>
                <div className="snav-search">
                    <Icon name="search" size={13} />
                    <input
                        ref={searchInputRef}
                        className="search-bare"
                        value={searchQuery}
                        placeholder={t('Search settings…')}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape' && searchQuery) {
                                e.preventDefault();
                                setSearchQuery('');
                            }
                        }}
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            className="iconbtn"
                            data-tip={t('Clear')}
                            onClick={() => setSearchQuery('')}
                        >
                            <Icon name="close" size={11} />
                        </button>
                    )}
                </div>
                {TABS.map((x) => (
                    <button
                        key={x.id}
                        type="button"
                        className={!isSearching && tab === x.id ? 'active' : ''}
                        onClick={() => {
                            setSearchQuery('');
                            setTab(x.id);
                        }}
                    >
                        <span>{t(x.label)}</span>
                    </button>
                ))}
            </nav>
            <main className="spane">
                {showTab('general', [
                    'General',
                    'Language',
                    'Language / زبان',
                    'Start with Windows',
                    'Windows File Explorer context menu',
                    'Maximum history items',
                    'Keep history for (days)',
                    'Largest image to store (MB)',
                    'Erase history',
                    'Reset all settings…',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('general', 'General')}
                        <Row
                            k="language"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Language"
                            hint="Choose the UI language and text direction (LTR / RTL)."
                        >
                            <CustomSelect
                                value={s.language}
                                onChange={(v) => set('language', v)}
                                options={localeOptions}
                                searchable
                            />
                        </Row>
                        <Row
                            k="autostart"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Start with Windows"
                            hint="Launch ClipNest automatically in the system tray when you sign in to Windows."
                        >
                            <Toggle v={s.autostart} on={(b) => set('autostart', b)} />
                        </Row>
                        <Row
                            k="explorer_context_menu"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Windows File Explorer context menu"
                            hint="Adds ClipNest to the right-click context menu of folders and files in Windows Explorer to view and paste copied files or collect files into the Drop Basket."
                        >
                            <Toggle v={s.explorer_context_menu} on={(b) => set('explorer_context_menu', b)} />
                        </Row>
                        <Row
                            k="max_items"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Maximum history items"
                            hint="0 = unlimited. Pinned and pinboard items are never removed."
                        >
                            <Num v={s.max_items} on={(n) => set('max_items', n)} step={100} />
                        </Row>
                        <Row
                            k="retention_days"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Keep history for (days)"
                            hint="0 = forever."
                        >
                            <Num v={s.retention_days} on={(n) => set('retention_days', n)} />
                        </Row>
                        <Row
                            k="max_image_mb"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Largest image to store (MB)"
                            hint="Images above this size in megabytes are skipped to keep the database fast."
                        >
                            <Num v={s.max_image_mb} on={(n) => set('max_image_mb', n)} min={1} max={200} />
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Erase history"
                            hint="Removes unpinned history, with an option in the confirmation dialog to also delete pinned items and pinboards."
                        >
                            <button type="button" className="btn danger" onClick={askEraseHistory}>
                                <span>{t('Erase history…')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Reset all settings…"
                            hint="Restores all preferences, shortcuts, and appearance options to factory defaults without deleting your clips."
                        >
                            <button type="button" className="btn" onClick={askResetAll}>
                                <span>{t('Reset all settings…')}</span>
                            </button>
                        </Row>
                    </section>
                )}

                {showTab('clipboard', [
                    'Copy & Paste',
                    'Keep text styling (HTML / RTF)',
                    'List display',
                    'Default paste (Enter)',
                    'Paste directly into the app',
                    'Move used item to the top',
                    'Paste card with mouse',
                    'Ctrl + Click on card',
                    'Ctrl + Shift + Click on card',
                    'Auto-save edits in preview',
                    'Paste queue: order',
                    'Paste queue: take over Ctrl+V',
                    'Drop Basket: allow Cut (move files after verified copy)',
                    'Per-application rules',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('clipboard', 'Copy & Paste')}
                        <Row
                            k="store_rich"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Keep text styling (HTML / RTF)"
                            hint="On: colours, fonts and backgrounds are stored and can be pasted back. Off: only plain text is stored (smaller database)."
                        >
                            <Toggle v={s.store_rich} on={(b) => set('store_rich', b)} />
                        </Row>
                        <Row
                            k="list_style"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="List display"
                            hint="“Original style” draws each card exactly as it was copied (VS Code colours, backgrounds, fonts). “Plain text” shows only the text."
                        >
                            <Select
                                v={s.list_style}
                                on={(v) => set('list_style', v)}
                                opts={[
                                    ['rich', 'Original style'],
                                    ['plain', 'Plain text'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="default_mode"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Default paste (Enter)"
                            hint="“Keep formatting” restores every stored format. “Plain text” pastes only the text."
                        >
                            <Select
                                v={s.default_mode}
                                on={(v) => set('default_mode', v)}
                                opts={[
                                    ['rich', 'Keep formatting'],
                                    ['plain', 'Plain text only'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="direct_paste"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Paste directly into the app"
                            hint="Off = the item is only copied; you press Ctrl+V yourself."
                        >
                            <Toggle v={s.direct_paste} on={(b) => set('direct_paste', b)} />
                        </Row>
                        <Row
                            k="move_to_top"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Move used item to the top"
                            hint="Moves a card to the top of the history list whenever you paste or copy it."
                        >
                            <Toggle v={s.move_to_top} on={(b) => set('move_to_top', b)} />
                        </Row>
                        <Row
                            k="card_paste_click"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Paste card with mouse"
                            hint="Choose whether a single click or a double-click pastes a card (single-click always selects)."
                        >
                            <Select
                                v={s.card_paste_click}
                                on={(v) => set('card_paste_click', v)}
                                opts={[
                                    ['double', 'Double-click (single-click selects)'],
                                    ['single', 'Single-click'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="ctrl_click_action"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Ctrl + Click on card"
                            hint="What happens when you hold Ctrl and click a card."
                        >
                            <Select
                                v={s.ctrl_click_action}
                                on={(v) => set('ctrl_click_action', v)}
                                opts={[
                                    ['multi_select', 'Toggle multi-selection'],
                                    ['paste', 'Paste'],
                                    ['paste_plain', 'Paste as plain text'],
                                    ['copy_only', 'Copy only'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="ctrl_shift_click_action"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Ctrl + Shift + Click on card"
                            hint="What happens when you hold Ctrl + Shift and click a card."
                        >
                            <Select
                                v={s.ctrl_shift_click_action}
                                on={(v) => set('ctrl_shift_click_action', v)}
                                opts={[
                                    ['paste_plain', 'Paste as plain text'],
                                    ['paste', 'Paste with formatting'],
                                    ['copy_only', 'Copy only'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="auto_save_edit"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Auto-save edits in preview"
                            hint="Automatically saves text changes in the inline preview editor after a short pause without requiring Ctrl+S."
                        >
                            <Toggle v={s.auto_save_edit} on={(b) => set('auto_save_edit', b)} />
                        </Row>
                        <Row
                            k="queue_fifo"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Paste queue: order"
                            hint="Whether the Paste Queue outputs items in FIFO (first copied first) or LIFO (last copied first) order."
                        >
                            <Select
                                v={s.queue_fifo ? 'fifo' : 'lifo'}
                                on={(v) => set('queue_fifo', v === 'fifo')}
                                opts={[
                                    ['fifo', 'First copied → first pasted'],
                                    ['lifo', 'Last copied → first pasted'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="queue_intercept"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Paste queue: take over Ctrl+V"
                            hint="While the queue has items, Ctrl+V pastes the next one."
                        >
                            <Toggle v={s.queue_intercept} on={(b) => set('queue_intercept', b)} />
                        </Row>
                        <Row
                            k="basket_allow_cut"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Drop Basket: allow Cut (move files after verified copy)"
                            hint="When enabled, files cut with Ctrl+X are moved only after destination copy and exact byte size are verified on disk."
                        >
                            <Toggle v={s.basket_allow_cut} on={(b) => set('basket_allow_cut', b)} />
                        </Row>

                        {matchesSearch(q, 'Per-application rules', 'Executable', 'Paste as', 'Keystroke') && (
                            <>
                                <h3>{t('Per-application rules')}</h3>
                                <p className="muted small">
                                    {t(
                                        'Overrides the default for a specific target app (executable name). Example: Word keeps formatting, terminals get plain text.'
                                    )}
                                </p>
                                <table className="rules">
                                    <thead>
                                        <tr>
                                            <th>{t('Executable')}</th>
                                            <th>{t('Paste as')}</th>
                                            <th>{t('Keystroke')}</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {s.app_rules.map((r, i) => (
                                            <tr key={i}>
                                                <td>
                                                    <input
                                                        dir="ltr"
                                                        value={r.exe}
                                                        onChange={(e) =>
                                                            updRule(i, { exe: e.target.value.toLowerCase() })
                                                        }
                                                    />
                                                </td>
                                                <td>
                                                    <Select
                                                        v={r.mode}
                                                        on={(v) => updRule(i, { mode: v })}
                                                        opts={[
                                                            ['default', 'Default'],
                                                            ['rich', 'Keep formatting'],
                                                            ['plain', 'Plain text'],
                                                        ]}
                                                    />
                                                </td>
                                                <td>
                                                    <Select
                                                        v={r.keys}
                                                        on={(v) => updRule(i, { keys: v })}
                                                        opts={[
                                                            ['ctrl+v', 'Ctrl+V'],
                                                            ['shift+insert', 'Shift+Insert'],
                                                            ['ctrl+shift+v', 'Ctrl+Shift+V'],
                                                        ]}
                                                    />
                                                </td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        className="btn"
                                                        onClick={() =>
                                                            set(
                                                                'app_rules',
                                                                s.app_rules.filter((_, j) => j !== i)
                                                            )
                                                        }
                                                    >
                                                        <span>{t('Remove')}</span>
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() =>
                                        set('app_rules', [
                                            ...s.app_rules,
                                            { exe: 'winword.exe', mode: 'rich', keys: 'ctrl+v' },
                                        ])
                                    }
                                >
                                    <span>{t('+ Add rule')}</span>
                                </button>
                            </>
                        )}
                    </section>
                )}

                {showTab('appearance', [
                    'Appearance',
                    'Theme',
                    'System (Auto)',
                    'Accent colour',
                    'Smooth animations',
                    'Card density',
                    'Font size (px)',
                    'Clip items font family',
                    'Text lines per card',
                    'Maximum card height (px)',
                    'Show image and media thumbnails in cards',
                    'Thumbnail size',
                    'Virtual list rendering',
                    'Highlight search matches',
                    'Highlight text color (transparent = keep text color)',
                    'Highlight background color (e.g. #ffe043 for yellow marker)',
                    'Highlight presets',
                    'Popup opens at',
                    'Popup width (px)',
                    'Popup height (px)',
                    'Preserve popup size when resized with mouse',
                    'Side toolbar (CopyQ style)',
                    'Show item count on pinboard tabs',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('appearance', 'Appearance')}
                        <Row
                            k="theme"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Theme"
                            hint="Choose the colour scheme for the popup, queue, and settings windows (System follows Windows Dark/Light mode automatically)."
                        >
                            <Select
                                v={s.theme}
                                on={(v) => set('theme', v)}
                                opts={[
                                    ['system', 'System (Auto)'],
                                    ['dark', 'Dark'],
                                    ['oled', 'OLED black'],
                                    ['light', 'Light'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="accent"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Accent colour"
                            hint="Choose the primary highlight colour for borders, badges, active controls, and default search highlights."
                        >
                            <input
                                type="color"
                                value={s.accent}
                                onChange={(e) => {
                                    const nextAccent = e.target.value;
                                    const syncHl =
                                        !s.highlight_color ||
                                        s.highlight_color === 'accent' ||
                                        s.highlight_color.toLowerCase() === s.accent.toLowerCase();
                                    save({
                                        ...s,
                                        accent: nextAccent,
                                        highlight_color: syncHl ? 'accent' : s.highlight_color,
                                    });
                                }}
                            />
                        </Row>
                        <Row
                            k="animations"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Smooth animations"
                            hint="Enable subtle Notion-style transitions for menus, dialogs, and hover states."
                        >
                            <Toggle v={s.animations} on={(b) => set('animations', b)} />
                        </Row>
                        <Row
                            k="density"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Card density"
                            hint="Choose how much vertical padding each card uses in the popup list."
                        >
                            <Select
                                v={s.density}
                                on={(v) => set('density', v)}
                                opts={[
                                    ['compact', 'Compact'],
                                    ['comfortable', 'Comfortable'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="font_size"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Font size (px)"
                            hint="Base font size in pixels across the popup, queue, and settings windows."
                        >
                            <Num v={s.font_size} on={(n) => set('font_size', n)} min={10} max={20} />
                        </Row>
                        <Row
                            k="font_family"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Clip items font family"
                            hint="Choose any installed system font on your computer for rendering clipboard cards and previews."
                        >
                            <CustomSelect
                                value={s.font_family}
                                onChange={(v) => set('font_family', String(v))}
                                options={fontOptions}
                                searchable
                            />
                        </Row>
                        <Row
                            k="card_lines"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Text lines per card"
                            hint="How many lines of text are previewed on each card before truncating."
                        >
                            <Num v={s.card_lines} on={(n) => set('card_lines', n)} min={1} max={12} />
                        </Row>
                        <Row
                            k="card_max_height"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Maximum card height (px)"
                            hint="Maximum vertical height of each card body in the list (60 to 600 px)."
                        >
                            <Num
                                v={s.card_max_height}
                                on={(n) => set('card_max_height', n)}
                                min={60}
                                max={600}
                                step={10}
                            />
                        </Row>
                        <Row
                            k="show_thumbnails"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Show image and media thumbnails in cards"
                            hint="Renders inline image and video/media previews inside cards in the popup list."
                        >
                            <Toggle v={s.show_thumbnails} on={(b) => set('show_thumbnails', b)} />
                        </Row>
                        <Row
                            k="thumbnail_size"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Thumbnail size"
                            hint="Maximum height of image and media thumbnails inside cards."
                        >
                            <Select
                                v={s.thumbnail_size}
                                on={(v) => set('thumbnail_size', v)}
                                opts={[
                                    ['small', 'Small (52px)'],
                                    ['medium', 'Medium (110px)'],
                                    ['large', 'Large (170px)'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="virtual_scroll"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Virtual list rendering"
                            hint="Off renders the entire list into the DOM normally; On renders only visible items for peak performance"
                        >
                            <Toggle v={s.virtual_scroll} on={(b) => set('virtual_scroll', b)} />
                        </Row>
                        <Row
                            k="highlight_matches"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Highlight search matches"
                            hint="Highlights matched characters and words inside cards and previews while searching."
                        >
                            <Toggle v={s.highlight_matches} on={(b) => set('highlight_matches', b)} />
                        </Row>
                        <Row
                            k="highlight_color"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Highlight text color (transparent = keep text color)"
                            hint="Use “accent” to automatically follow your Accent colour, or pick any custom colour."
                        >
                            <div className="color-input-group">
                                <input
                                    dir="ltr"
                                    value={s.highlight_color}
                                    placeholder="accent"
                                    onChange={(e) => set('highlight_color', e.target.value)}
                                />
                                <input
                                    type="color"
                                    value={resolvedHlHex}
                                    onChange={(e) => set('highlight_color', e.target.value)}
                                />
                            </div>
                        </Row>
                        <Row
                            k="highlight_bg"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Highlight background color (e.g. #ffe043 for yellow marker)"
                            hint="Background colour behind matched characters (use transparent for text-only highlight)."
                        >
                            <div className="color-input-group">
                                <input
                                    dir="ltr"
                                    value={s.highlight_bg}
                                    placeholder="transparent"
                                    onChange={(e) => set('highlight_bg', e.target.value)}
                                />
                                <input
                                    type="color"
                                    value={
                                        /^#[0-9a-fA-F]{6}$/.test(s.highlight_bg) ? s.highlight_bg : '#ffe043'
                                    }
                                    onChange={(e) => set('highlight_bg', e.target.value)}
                                />
                            </div>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Highlight presets"
                            hint="Quickly switch between Accent color match, VS Code blue, yellow marker background, or high contrast."
                        >
                            <div className="presets">
                                <button
                                    type="button"
                                    className="chip"
                                    onClick={() =>
                                        save({
                                            ...s,
                                            highlight_matches: true,
                                            highlight_color: 'accent',
                                            highlight_bg: 'transparent',
                                        })
                                    }
                                >
                                    <span>{t('Match Accent')}</span>
                                </button>
                                <button
                                    type="button"
                                    className="chip"
                                    onClick={() =>
                                        save({
                                            ...s,
                                            highlight_matches: true,
                                            highlight_color: '#2ea8ff',
                                            highlight_bg: 'transparent',
                                        })
                                    }
                                >
                                    <span>{t('VS Code Blue')}</span>
                                </button>
                                <button
                                    type="button"
                                    className="chip"
                                    onClick={() =>
                                        save({
                                            ...s,
                                            highlight_matches: true,
                                            highlight_color: 'inherit',
                                            highlight_bg: '#f5d90a55',
                                        })
                                    }
                                >
                                    <span>{t('Yellow Marker')}</span>
                                </button>
                                <button
                                    type="button"
                                    className="chip"
                                    onClick={() =>
                                        save({
                                            ...s,
                                            highlight_matches: true,
                                            highlight_color: '#000000',
                                            highlight_bg: '#ffe043',
                                        })
                                    }
                                >
                                    <span>{t('High Contrast')}</span>
                                </button>
                            </div>
                        </Row>
                        <Row
                            k="popup_position"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Popup opens at"
                            hint="Choose where the popup appears on screen when opened with the global shortcut."
                        >
                            <Select
                                v={s.popup_position}
                                on={(v) => set('popup_position', v)}
                                opts={[
                                    ['caret', 'Text cursor (falls back to mouse)'],
                                    ['mouse', 'Mouse pointer'],
                                    ['center', 'Screen centre'],
                                    ['last', 'Last position'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="popup_width"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Popup width (px)"
                            hint="Default width of the popup window in logical pixels (minimum 340 px)."
                        >
                            <Num
                                v={s.popup_width}
                                on={(n) => set('popup_width', n)}
                                min={340}
                                max={1400}
                                step={10}
                            />
                        </Row>
                        <Row
                            k="popup_height"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Popup height (px)"
                            hint="Default height of the popup window in logical pixels (minimum 380 px)."
                        >
                            <Num
                                v={s.popup_height}
                                on={(n) => set('popup_height', n)}
                                min={380}
                                max={1400}
                                step={10}
                            />
                        </Row>
                        <Row
                            k="remember_popup_size"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Preserve popup size when resized with mouse"
                            hint="Automatically saves the new width and height when you drag the edges of the popup window."
                        >
                            <Toggle v={s.remember_popup_size} on={(b) => set('remember_popup_size', b)} />
                        </Row>
                        <Row
                            k="show_toolbar"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Side toolbar (CopyQ style)"
                            hint="Quick buttons next to the list: preview, pin, tags, copy, formats, edit, merge, actions, delete (can also be toggled from the popup header)."
                        >
                            <Toggle v={s.show_toolbar} on={(b) => set('show_toolbar', b)} />
                        </Row>
                        <Row
                            k="show_pinboard_counts"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Show item count on pinboard tabs"
                            hint="Displays a small badge with the number of items next to each pinboard tab in the popup."
                        >
                            <Toggle v={s.show_pinboard_counts} on={(b) => set('show_pinboard_counts', b)} />
                        </Row>
                    </section>
                )}

                {showTab('privacy', [
                    'Privacy & Screen capture',
                    'Screen-capture protection',
                    'Respect “do not record” flags',
                    'Detect sensitive data',
                    'When detected',
                    'Auto-delete after (minutes)',
                    'Ignored applications',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('privacy', 'Privacy & Screen capture')}
                        <Row
                            k="capture_protection"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Screen-capture protection"
                            hint="Applied instantly to the popup, queue and settings windows. Needs Windows 10 2004+ for “Invisible”. Does not work inside Remote Desktop sessions."
                        >
                            <Select
                                v={s.capture_protection}
                                on={(v) => set('capture_protection', v)}
                                opts={[
                                    ['black', 'Black rectangle (CopyQ style)'],
                                    ['hidden', 'Invisible in captures'],
                                    ['off', 'Off'],
                                ]}
                            />
                        </Row>
                        <Row
                            k="ignore_confidential"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Respect “do not record” flags"
                            hint="Password managers mark their clipboard data; ClipNest then never stores it."
                        >
                            <Toggle v={s.ignore_confidential} on={(b) => set('ignore_confidential', b)} />
                        </Row>
                        <Row
                            k="detect_sensitive"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Detect sensitive data"
                            hint="Card numbers (Luhn), API keys (sk-…, ghp_…, AKIA…), private keys, JWTs."
                        >
                            <Toggle v={s.detect_sensitive} on={(b) => set('detect_sensitive', b)} />
                        </Row>
                        {s.detect_sensitive && (
                            <>
                                <Row
                                    k="sensitive_action"
                                    s={s}
                                    searchQuery={q}
                                    onGearMenu={openGearMenu}
                                    label="When detected"
                                    hint="How Sensitive clips are handled when detected."
                                >
                                    <Select
                                        v={s.sensitive_action}
                                        on={(v) => set('sensitive_action', v)}
                                        opts={[
                                            ['mask', 'Store, blur in the list'],
                                            ['mask_delete', 'Store, blur, then auto-delete'],
                                            ['skip', 'Do not store'],
                                        ]}
                                    />
                                </Row>
                                {s.sensitive_action === 'mask_delete' && (
                                    <Row
                                        k="sensitive_ttl_min"
                                        s={s}
                                        searchQuery={q}
                                        onGearMenu={openGearMenu}
                                        label="Auto-delete after (minutes)"
                                        hint="How many minutes before a masked sensitive clip is permanently deleted."
                                    >
                                        <Num
                                            v={s.sensitive_ttl_min}
                                            on={(n) => set('sensitive_ttl_min', n)}
                                            min={1}
                                            max={1440}
                                        />
                                    </Row>
                                )}
                            </>
                        )}
                        {matchesSearch(
                            q,
                            'Ignored applications',
                            'Nothing copied from these executables is stored.'
                        ) && (
                            <>
                                <h3>{t('Ignored applications')}</h3>
                                <p className="muted small">
                                    {t('Nothing copied from these executables is stored.')}
                                </p>
                                <TagList
                                    items={s.ignore_apps}
                                    onChange={(l) => set('ignore_apps', l)}
                                    suggestions={apps}
                                    placeholder="keepass.exe"
                                />
                                <div className="cap-note muted small">
                                    {t(
                                        'Database encryption and per-tab locking are not part of this version.'
                                    )}
                                </div>
                            </>
                        )}
                    </section>
                )}

                {showTab('shortcuts', [
                    'Shortcuts',
                    'Global shortcuts',
                    'Open ClipNest',
                    'Paste queue on/off',
                    'Toggle plain-text mode',
                    'Pause / resume capture',
                    'Inside the popup',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('shortcuts', 'Global shortcuts')}
                        <p className="muted small">
                            {t(
                                'Shortcuts that include the Windows key (for example Win+V) are handled by a keyboard hook. Windows keeps Win+V for its own clipboard history: if it still opens, turn that off in Windows Settings → System → Clipboard.'
                            )}
                        </p>
                        <Row
                            k="shortcut_open"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Open ClipNest"
                            hint="Global hotkey to show or hide the main ClipNest popup."
                        >
                            <div className="stack">
                                <ShortcutInput
                                    role="open"
                                    v={s.shortcut_open}
                                    on={(v) => set('shortcut_open', v)}
                                />
                                <div className="presets">
                                    <button
                                        type="button"
                                        className="chip"
                                        onClick={() => set('shortcut_open', 'Super+V')}
                                    >
                                        <span>{t('Use Win+V')}</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="chip"
                                        onClick={() => set('shortcut_open', 'Alt+V')}
                                    >
                                        <span>Alt+V</span>
                                    </button>
                                </div>
                            </div>
                        </Row>
                        <Row
                            k="shortcut_queue"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Paste queue on/off"
                            hint="Global hotkey to open or close the Paste Queue / Drop Basket window."
                        >
                            <ShortcutInput
                                role="queue"
                                v={s.shortcut_queue}
                                on={(v) => set('shortcut_queue', v)}
                            />
                        </Row>
                        <Row
                            k="shortcut_plain_toggle"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Toggle plain-text mode"
                            hint="Global hotkey to toggle between rich formatting and plain-text paste mode."
                        >
                            <ShortcutInput
                                role="plain"
                                v={s.shortcut_plain_toggle}
                                on={(v) => set('shortcut_plain_toggle', v)}
                            />
                        </Row>
                        <Row
                            k="shortcut_pause"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Pause / resume capture"
                            hint="Global hotkey to pause or resume clipboard capturing."
                        >
                            <ShortcutInput
                                role="pause"
                                v={s.shortcut_pause}
                                on={(v) => set('shortcut_pause', v)}
                            />
                        </Row>
                        {!isSearching && (
                            <>
                                <h3>{t('Inside the popup')}</h3>
                                <table className="keys" dir="ltr">
                                    <tbody>
                                        {[
                                            [
                                                '↑ ↓ · Shift+↑↓ · PgUp/PgDn · Ctrl+↑↓',
                                                'Select / extend selection / jump',
                                            ],
                                            ['← → · Tab · Ctrl+[ ]', 'Switch Clipboard ↔ pinboards'],
                                            [
                                                'Enter · Shift+Enter · Ctrl+Enter',
                                                'Paste · plain text · keep formatting',
                                            ],
                                            ['Ctrl+1 … Ctrl+9', 'Quick-paste a visible card'],
                                            ['Alt+↑ / Alt+↓ (or drag a card)', 'Move the card up / down'],
                                            ['Space (or F3)', 'Preview (empty search)'],
                                            ['Ctrl+C', 'Copy only'],
                                            ['Delete / Ctrl+Delete', 'Delete (or unpin inside a pinboard)'],
                                            ['F2 · Ctrl+T · Ctrl+P', 'Rename · tags · pin on top'],
                                            [
                                                'Ctrl+E · Ctrl+I · Ctrl+M',
                                                'Edit · formats inspector · merge selected',
                                            ],
                                            [
                                                'Ctrl+O · Ctrl+N · Ctrl+,',
                                                'Open link/file · new pinboard · settings',
                                            ],
                                            ['Esc', 'Clear search, then close'],
                                        ].map(([k, d]) => (
                                            <tr key={k}>
                                                <td>
                                                    <kbd>{k}</kbd>
                                                </td>
                                                <td className="muted" dir="auto">
                                                    {t(d)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        )}
                    </section>
                )}

                {showTab('rules', [
                    'Automatic rules',
                    'When copied from app(s)',
                    'and text matches (regex)',
                    'Item type',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('rules', 'Automatic rules')}
                        <p className="muted small">
                            {t(
                                'Run on every new copy, in order. A rule applies when ALL of its filled-in conditions match. Example: app “keepass”, action “Do not store”; or pattern “^https?://”, action “Move to pinboard”.'
                            )}
                        </p>
                        {s.rules.map((r, i) => (
                            <div key={r.id} className="rulecard">
                                <div className="rulehead">
                                    <Toggle v={r.enabled} on={(b) => updAuto(i, { enabled: b })} />
                                    <input
                                        value={r.name}
                                        placeholder={t('Rule name')}
                                        onChange={(e) => updAuto(i, { name: e.target.value })}
                                    />
                                    <button
                                        type="button"
                                        className="btn"
                                        disabled={i === 0}
                                        onClick={() => {
                                            const a = [...s.rules];
                                            [a[i - 1], a[i]] = [a[i], a[i - 1]];
                                            set('rules', a);
                                        }}
                                    >
                                        <span>↑</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="btn"
                                        disabled={i === s.rules.length - 1}
                                        onClick={() => {
                                            const a = [...s.rules];
                                            [a[i + 1], a[i]] = [a[i], a[i + 1]];
                                            set('rules', a);
                                        }}
                                    >
                                        <span>↓</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="btn"
                                        onClick={() =>
                                            set(
                                                'rules',
                                                s.rules.filter((_, j) => j !== i)
                                            )
                                        }
                                    >
                                        <span>{t('Remove')}</span>
                                    </button>
                                </div>
                                <div className="rulegrid">
                                    <label>
                                        <span>{t('When copied from app(s)')}</span>
                                        <input
                                            dir="ltr"
                                            value={r.apps}
                                            placeholder="code, chrome"
                                            onChange={(e) => updAuto(i, { apps: e.target.value })}
                                        />
                                    </label>
                                    <label>
                                        <span>{t('and text matches (regex)')}</span>
                                        <input
                                            dir="ltr"
                                            value={r.pattern}
                                            placeholder="^https?://"
                                            onChange={(e) => updAuto(i, { pattern: e.target.value })}
                                        />
                                    </label>
                                </div>
                                <div className="kinds">
                                    <span className="muted small">{t('Item type')}:</span>
                                    {KINDS.map((k) => (
                                        <label key={k} className="kind">
                                            <input
                                                type="checkbox"
                                                checked={r.kinds.includes(k)}
                                                onChange={(e) =>
                                                    updAuto(i, {
                                                        kinds: e.target.checked
                                                            ? [...r.kinds, k]
                                                            : r.kinds.filter((x) => x !== k),
                                                    })
                                                }
                                            />
                                            <span>{t(k)}</span>
                                        </label>
                                    ))}
                                    <span className="muted small">
                                        {r.kinds.length === 0 ? t('(any)') : ''}
                                    </span>
                                </div>
                                <div className="rulegrid">
                                    <div>
                                        <span className="field-label">{t('Then')}</span>
                                        <Select
                                            v={r.action}
                                            on={(v) => updAuto(i, { action: v })}
                                            opts={ACTIONS}
                                        />
                                    </div>
                                    {r.action === 'to_board' && (
                                        <div>
                                            <span className="field-label">{t('Pinboard')}</span>
                                            <CustomSelect
                                                value={r.board}
                                                onChange={(v) => updAuto(i, { board: Number(v) })}
                                                options={[
                                                    { value: 0, label: '—' },
                                                    ...boards.map((b) => ({ value: b.id, label: b.name })),
                                                ]}
                                            />
                                        </div>
                                    )}
                                    {r.action === 'tag' && (
                                        <label>
                                            <span>{t('Tag')}</span>
                                            <input
                                                value={r.value}
                                                placeholder="work"
                                                onChange={(e) => updAuto(i, { value: e.target.value })}
                                            />
                                        </label>
                                    )}
                                    {r.action === 'expire' && (
                                        <label>
                                            <span>{t('Minutes')}</span>
                                            <input
                                                type="number"
                                                min={1}
                                                value={r.value}
                                                onChange={(e) => updAuto(i, { value: e.target.value })}
                                            />
                                        </label>
                                    )}
                                    {r.action === 'run_action' && (
                                        <div>
                                            <span className="field-label">{t('Custom action')}</span>
                                            <CustomSelect
                                                value={r.value}
                                                onChange={(v) => updAuto(i, { value: String(v) })}
                                                options={[
                                                    { value: '', label: '—' },
                                                    ...s.actions.map((a) => ({ value: a.id, label: a.name })),
                                                ]}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        <button
                            type="button"
                            className="btn"
                            onClick={() =>
                                set('rules', [
                                    ...s.rules,
                                    {
                                        id: `r${Date.now()}`,
                                        name: '',
                                        enabled: true,
                                        apps: '',
                                        kinds: [],
                                        pattern: '',
                                        action: 'ignore',
                                        board: 0,
                                        value: '',
                                    },
                                ])
                            }
                        >
                            <span>{t('+ Add rule')}</span>
                        </button>
                    </section>
                )}

                {showTab('actions', ['Custom actions', '+ Add action']) && (
                    <section className="ssection">
                        {renderSectionHeader('actions', 'Custom actions')}
                        <p className="muted small">
                            {t(
                                'Shell commands (run with cmd /C) that receive the item’s text on stdin. They appear under “Actions” in the item menu and can be used by automatic rules.'
                            )}{' '}
                            <code dir="ltr">
                                {'powershell -NoProfile -Command "$input | ForEach-Object { $_.ToUpper() }"'}
                            </code>
                        </p>
                        {s.actions.map((a, i) => (
                            <div key={a.id} className="action">
                                <input
                                    value={a.name}
                                    placeholder={t('Name')}
                                    onChange={(e) => updAct(i, { name: e.target.value })}
                                />
                                <input
                                    className="wide"
                                    dir="ltr"
                                    value={a.command}
                                    placeholder="command"
                                    onChange={(e) => updAct(i, { command: e.target.value })}
                                />
                                <Select
                                    v={a.output}
                                    on={(v) => updAct(i, { output: v })}
                                    opts={[
                                        ['new_item', 'Output → new item'],
                                        ['clipboard', 'Output → clipboard'],
                                        ['none', 'Ignore output'],
                                    ]}
                                />
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() =>
                                        set(
                                            'actions',
                                            s.actions.filter((_, j) => j !== i)
                                        )
                                    }
                                >
                                    <span>{t('Remove')}</span>
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            className="btn"
                            onClick={() =>
                                set('actions', [
                                    ...s.actions,
                                    {
                                        id: `a${Date.now()}`,
                                        name: t('My action'),
                                        command: '',
                                        output: 'new_item',
                                    },
                                ])
                            }
                        >
                            <span>{t('+ Add action')}</span>
                        </button>
                    </section>
                )}

                {showTab('backup', [
                    'Backup & Data',
                    'Daily automatic backup',
                    'Backups to keep',
                    'Export history',
                    'Import / restore',
                    'Export / import settings',
                    'Back up now',
                    'Data folder',
                    'Erase history',
                    'Reset all settings…',
                    'Quit ClipNest',
                ]) && (
                    <section className="ssection">
                        {renderSectionHeader('backup', 'Backup & Data')}
                        <p className="muted small">
                            {t(
                                'Every copy is written to disk immediately (SQLite WAL, full fsync), so a power cut cannot lose a completed copy.'
                            )}
                        </p>
                        <Row
                            k="auto_backup"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Daily automatic backup"
                            hint="Automatically creates a compressed daily snapshot in the backups folder."
                        >
                            <Toggle v={s.auto_backup} on={(b) => set('auto_backup', b)} />
                        </Row>
                        <Row
                            k="backup_keep"
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Backups to keep"
                            hint="How many recent daily backup files to retain before deleting older ones."
                        >
                            <Num v={s.backup_keep} on={(n) => set('backup_keep', n)} min={1} max={90} />
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Export history"
                            hint="Saves everything (items, formats, pinboards) to a file you choose."
                        >
                            <button
                                type="button"
                                className="btn"
                                onClick={() =>
                                    run(async () => {
                                        const p = await api.exportData();
                                        return p ? t('Saved: {p}', { p }) : null;
                                    })
                                }
                            >
                                <span>{t('Export…')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Import / restore"
                            hint="Merges an export or a daily backup into the current history. Nothing is overwritten or deleted."
                        >
                            <button
                                type="button"
                                className="btn"
                                onClick={() =>
                                    run(async () => {
                                        const n = await api.importData();
                                        return n === null ? null : t('Imported {n} new item(s)', { n });
                                    })
                                }
                            >
                                <span>{t('Import…')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Export / import settings"
                            hint="Settings, rules, actions and shortcuts as a JSON file."
                        >
                            <div className="shortcut">
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() =>
                                        run(async () => {
                                            const p = await api.exportSettings();
                                            return p ? t('Saved: {p}', { p }) : null;
                                        })
                                    }
                                >
                                    <span>{t('Export…')}</span>
                                </button>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() =>
                                        run(async () =>
                                            (await api.importSettings()) ? t('Settings imported') : null
                                        )
                                    }
                                >
                                    <span>{t('Import…')}</span>
                                </button>
                            </div>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Back up now"
                            hint="Create a compressed snapshot of the SQLite database right now."
                        >
                            <button
                                type="button"
                                className="btn"
                                onClick={() => run(async () => t('Saved: {p}', { p: await api.backupNow() }))}
                            >
                                <span>{t('Create backup')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Data folder"
                            hint="Database, settings.json and backups."
                        >
                            <button type="button" className="btn" onClick={() => api.openDataDir()}>
                                <span>{t('Open in Explorer')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Erase history"
                            hint="Removes unpinned history, with an option in the confirmation dialog to also delete pinned items and pinboards."
                        >
                            <button type="button" className="btn danger" onClick={askEraseHistory}>
                                <span>{t('Erase history…')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Reset all settings…"
                            hint="Restores all preferences, shortcuts, and appearance options to factory defaults without deleting your clips."
                        >
                            <button type="button" className="btn" onClick={askResetAll}>
                                <span>{t('Reset all settings…')}</span>
                            </button>
                        </Row>
                        <Row
                            s={s}
                            searchQuery={q}
                            onGearMenu={openGearMenu}
                            label="Quit ClipNest"
                            hint="Exit ClipNest completely and stop background clipboard monitoring."
                        >
                            <button type="button" className="btn danger" onClick={() => api.quit()}>
                                <span>{t('Quit')}</span>
                            </button>
                        </Row>
                    </section>
                )}

                {showTab('help', [
                    'Help & Guide',
                    'Getting started',
                    'Smart search & filters',
                    'Pinboards & active tab',
                    'Paste Queue & Drop Basket',
                    'Windows File Explorer context menu',
                    'Text transforms & Persian tools',
                ]) && (
                    <section className="ssection">
                        <div className="spane-head">
                            <h2>{t('Help & Guide')}</h2>
                        </div>
                        <div className="guide-grid">
                            <div className="guide-card">
                                <h3>{t('Getting started')}</h3>
                                <p className="muted">
                                    {t(
                                        'Press Win+V (or your configured shortcut) anywhere in Windows to open ClipNest at your text cursor. Double-click a card or press Enter to paste it with original formatting, or press Shift+Enter to paste as plain text.'
                                    )}
                                </p>
                            </div>
                            <div className="guide-card">
                                <h3>{t('Smart search & filters')}</h3>
                                <p className="muted">
                                    {t(
                                        'Type any word to search text, titles, app names, and tags with typo tolerance. Type image, code, link, file, or color to filter by item type (or wrap in quotes like "image" for literal text). Toggle .* for Regex or ~ for strict fuzzy matching.'
                                    )}
                                </p>
                            </div>
                            <div className="guide-card">
                                <h3>{t('Pinboards & active tab')}</h3>
                                <p className="muted">
                                    {t(
                                        'Create colour-coded Pinboards with + or Ctrl+N and drag cards onto any tab. Right-click a Pinboard tab and enable Active pinboard so all new copies go straight into that tab automatically.'
                                    )}
                                </p>
                            </div>
                            <div className="guide-card">
                                <h3>{t('Paste Queue & Drop Basket')}</h3>
                                <p className="muted">
                                    {t(
                                        'Press Ctrl+Alt+Q to open the floating Queue / Drop Basket window. In Queue mode, copy multiple items and press Ctrl+V repeatedly to paste them in FIFO or LIFO order. In Drop Basket mode, collect files and images from different folders and paste or move them all at once.'
                                    )}
                                </p>
                            </div>
                            <div className="guide-card">
                                <h3>{t('Windows File Explorer context menu')}</h3>
                                <p className="muted">
                                    {t(
                                        'Right-click inside any folder in Windows File Explorer and select ClipNest to view your copied files and paste them directly into that folder, or right-click any file to add it to the Drop Basket.'
                                    )}
                                </p>
                            </div>
                            <div className="guide-card">
                                <h3>{t('Text transforms & Persian tools')}</h3>
                                <p className="muted">
                                    {t(
                                        'Right-click any text card and choose Transform to convert case, format JSON, encode Base64/URL, normalize Arabic characters and digits to standard Persian/English, or convert all numbers to Persian digits.'
                                    )}
                                </p>
                            </div>
                        </div>

                        <h3>{t('Inside the popup')}</h3>
                        <table className="keys" dir="ltr">
                            <tbody>
                                {[
                                    [
                                        '↑ ↓ · Shift+↑↓ · PgUp/PgDn · Ctrl+↑↓',
                                        'Select / extend selection / jump',
                                    ],
                                    ['← → · Tab · Ctrl+[ ]', 'Switch Clipboard ↔ pinboards'],
                                    [
                                        'Enter · Shift+Enter · Ctrl+Enter',
                                        'Paste · plain text · keep formatting',
                                    ],
                                    ['Ctrl+1 … Ctrl+9', 'Quick-paste a visible card'],
                                    ['Alt+↑ / Alt+↓ (or drag a card)', 'Move the card up / down'],
                                    ['Space (or F3)', 'Preview (empty search)'],
                                    ['Ctrl+C', 'Copy only'],
                                    ['Delete / Ctrl+Delete', 'Delete (or unpin inside a pinboard)'],
                                    ['F2 · Ctrl+T · Ctrl+P', 'Rename · tags · pin on top'],
                                    ['Ctrl+E · Ctrl+I · Ctrl+M', 'Edit · formats inspector · merge selected'],
                                    ['Ctrl+O · Ctrl+N · Ctrl+,', 'Open link/file · new pinboard · settings'],
                                    ['Esc', 'Clear search, then close'],
                                ].map(([k, d]) => (
                                    <tr key={k}>
                                        <td>
                                            <kbd>{k}</kbd>
                                        </td>
                                        <td className="muted" dir="auto">
                                            {t(d)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                )}

                {showTab('about', ['About', 'ClipNest', 'Version', 'Privacy']) && (
                    <section className="ssection">
                        <div className="spane-head">
                            <h2>{t('About')}</h2>
                        </div>
                        <div className="about-hero">
                            <img className="about-logo" src="/icon.png" alt="ClipNest" draggable={false} />
                            <div className="about-meta">
                                <div className="about-title-row">
                                    <h3>ClipNest</h3>
                                    <span className="badge">v0.2.0</span>
                                </div>
                                <p className="muted">
                                    {t(
                                        'Fast, private clipboard manager & file collector for Windows 10 and 11.'
                                    )}
                                </p>
                            </div>
                        </div>

                        <div className="guide-grid">
                            <div className="guide-card">
                                <h3>{t('100% Local & Private')}</h3>
                                <p className="muted">
                                    {t(
                                        'All clipboard data, icons, and backups are stored strictly on your device with zero cloud sync or telemetry.'
                                    )}
                                </p>
                            </div>
                        </div>

                        <div className="srow">
                            <div className="slabel">
                                <span>{t('Data folder')}</span>
                                <div className="muted small" dir="ltr">
                                    %APPDATA%\com.clipnest.app
                                </div>
                            </div>
                            <div className="sctl">
                                <button type="button" className="btn" onClick={() => api.openDataDir()}>
                                    <Icon name="folder" size={13} /> <span>{t('Open in Explorer')}</span>
                                </button>
                            </div>
                        </div>
                    </section>
                )}

                {msg && <div className="toast">{msg}</div>}
                {menu && (
                    <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
                )}
                {prompt && <Prompt p={prompt} onClose={() => setPrompt(null)} />}
            </main>
        </div>
    );
}
