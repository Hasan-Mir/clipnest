import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { VList, VListHandle } from 'virtua';
import { api, ClipRow, errText, ListResult, on, PasteMode, Pinboard, Status } from '../lib/api';
import { basename } from '../lib/format';
import { SearchMode } from '../lib/highlightMatch';
import { isRtl, num, t, useLang } from '../lib/i18n';
import { Icon } from '../lib/icons';
import { TRANSFORMS, Transform } from '../lib/transforms';
import { useSettings } from '../lib/useSettings';
import { Card, DropMark } from './Card';
import { BOARD_COLORS, BoardDialog, ContextMenu, MenuEntry, Prompt, PromptState } from './Overlays';
import { Preview } from './Preview';

const PAGE = 100;

export default function Popup() {
    const lang = useLang();
    const [settings, saveSettings] = useSettings();
    const [status, setStatus] = useState<Status | null>(null);
    const [boards, setBoards] = useState<Pinboard[]>([]);
    const [tab, setTab] = useState<number | null>(null);
    const [query, setQuery] = useState('');
    const [smode, setSmode] = useState<SearchMode>('smart');
    const [limit, setLimit] = useState(PAGE);
    const [res, setRes] = useState<ListResult>({ items: [], total: 0, error: null });
    const [sel, setSel] = useState(0);
    const [multi, setMulti] = useState<number[]>([]);
    const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
    const [preview, setPreview] = useState<{ item: ClipRow; edit: boolean; formats: boolean } | null>(null);
    const [prompt, setPrompt] = useState<PromptState | null>(null);
    const [boardDlg, setBoardDlg] = useState<Pinboard | null>(null);
    const [toast, setToast] = useState('');
    const [ctrl, setCtrl] = useState(false);
    const [quickIds, setQuickIds] = useState<number[]>([]);
    const [now, setNow] = useState(Date.now());
    const [iconRev, setIconRev] = useState(0);
    const [draggingId, setDraggingId] = useState<number | null>(null);
    const [dragLabel, setDragLabel] = useState('');
    const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);
    const [dropMark, setDropMark] = useState<{ id: number; mark: DropMark } | null>(null);
    const [explorerTarget, setExplorerTarget] = useState<string | null>(null);

    const anchor = useRef(0);
    const seq = useRef(0);
    const hiddenAt = useRef(0);
    const dragId = useRef<number | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const vlistRef = useRef<VListHandle>(null);
    const dragPillRef = useRef<HTMLDivElement>(null);
    const toastTimer = useRef<number | undefined>(undefined);
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    const items = res.items;
    const cur: ClipRow | undefined = items[sel];
    const curBoard = boards.find((b) => b.id === tab) ?? null;
    // Display style: per-pinboard override, otherwise the global setting.
    const richOn =
        (curBoard && curBoard.list_style !== 'inherit'
            ? curBoard.list_style
            : (settings?.list_style ?? 'rich')) === 'rich';

    const showToast = useCallback((s: string) => {
        setToast(s);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2600);
    }, []);
    const fail = useCallback((e: unknown) => showToast(errText(e)), [showToast]);

    // ───────────── data ─────────────
    const reload = useCallback(async () => {
        const my = ++seq.current;
        try {
            const [r, b] = await Promise.all([api.listItems(tab, query, smode, limit), api.listPinboards()]);
            if (my !== seq.current) {
                return;
            }
            setRes(r);
            setBoards(b);
            setSel((s) => Math.min(s, Math.max(0, r.items.length - 1)));
        } catch (e) {
            fail(e);
        }
    }, [tab, query, smode, limit, fail]);

    const reloadRef = useRef(reload);
    reloadRef.current = reload;

    useEffect(() => {
        const timer = window.setTimeout(reload, query ? 45 : 0);
        return () => window.clearTimeout(timer);
    }, [reload, query]);

    const loadStatus = useCallback(() => {
        api.status()
            .then(setStatus)
            .catch(() => {});
    }, []);

    const askErase = useCallback(
        (explicitBoard?: Pinboard | null) => {
            setMenu(null);
            const activeId = settingsRef.current?.active_pinboard ?? null;
            const targetBoard =
                explicitBoard !== undefined
                    ? explicitBoard
                    : (curBoard ?? boards.find((b) => b.id === activeId) ?? null);
            const msg = targetBoard
                ? t('This will erase items in the active pinboard "{name}".', {
                      name: targetBoard.name,
                  })
                : t(
                      'This will erase items in the main Clipboard tab (pinboards are kept unless you check the option below).'
                  );
            setPrompt({
                title: t('Erase all history?'),
                message: msg,
                confirm: true,
                checkLabel: t('Also erase pinned items'),
                defaultChecked: false,
                checkLabel2: t('Also erase all pinboards and main clipboard'),
                defaultChecked2: false,
                okLabel: t('Erase'),
                danger: true,
                onSubmit: (_val, includePinned, allPinboards) => {
                    api.eraseHistory(includePinned, targetBoard?.id ?? null, allPinboards)
                        .then(() => {
                            reloadRef.current();
                            showToast(t('History erased'));
                        })
                        .catch(fail);
                },
            });
        },
        [curBoard, boards, showToast, fail]
    );
    const askEraseRef = useRef(askErase);
    askEraseRef.current = askErase;

    const syncExplorerTarget = useCallback(() => {
        api.getExplorerTarget()
            .then((dir) => {
                setExplorerTarget(dir);
                if (dir) {
                    setTab(null);
                    setQuery('file');
                }
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        loadStatus();
        syncExplorerTarget();
        const subs = [
            on('items-changed', () => reloadRef.current()),
            on('icon-changed', () => setIconRev((v) => v + 1)),
            on('status-changed', loadStatus),
            on('erase-request', () => askEraseRef.current()),
            on('explorer-files-mode', () => syncExplorerTarget()),
            on('popup-hidden', () => {
                hiddenAt.current = Date.now();
            }),
            on('popup-shown', () => {
                if (Date.now() - hiddenAt.current > 60_000) {
                    setQuery('');
                }
                const activeBoard = settingsRef.current?.active_pinboard ?? null;
                setTab(activeBoard);
                setLimit(PAGE);
                setSel(0);
                anchor.current = 0;
                setMulti([]);
                setPreview(null);
                setMenu(null);
                setBoardDlg(null);
                syncExplorerTarget();
                reloadRef.current();
                loadStatus();
                listRef.current?.scrollTo(0, 0);
                vlistRef.current?.scrollTo(0);
                setTimeout(() => {
                    inputRef.current?.focus();
                    inputRef.current?.select();
                }, 30);
            }),
        ];
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        const clearCtrl = () => setCtrl(false);
        const onFocusSearch = () => {
            setPreview(null);
            setMenu(null);
            inputRef.current?.focus();
            inputRef.current?.select();
        };
        window.addEventListener('blur', clearCtrl);
        window.addEventListener('clipnest-focus-search', onFocusSearch);
        return () => {
            subs.forEach((p) => p.then((u) => u()));
            window.clearInterval(timer);
            window.removeEventListener('blur', clearCtrl);
            window.removeEventListener('clipnest-focus-search', onFocusSearch);
        };
    }, [loadStatus, syncExplorerTarget]);

    useEffect(() => {
        setPreview((p) => {
            if (!p) {
                return p;
            }
            const fresh = items.find((i) => i.id === p.item.id);
            return fresh && fresh !== p.item ? { ...p, item: fresh } : p;
        });
    }, [items]);

    useEffect(() => {
        if (!menu && !preview && !prompt && !boardDlg) {
            inputRef.current?.focus();
        }
    }, [menu, preview, prompt, boardDlg]);

    useEffect(() => {
        if (settings?.virtual_scroll !== false) {
            vlistRef.current?.scrollToIndex(sel, { align: 'nearest' });
        } else if (cur) {
            document.getElementById(`card-${cur.id}`)?.scrollIntoView({ block: 'nearest' });
        }
    }, [sel, cur?.id, settings?.virtual_scroll]);

    // ───────────── helpers ─────────────
    const targets = (): ClipRow[] =>
        multi.length > 1 ? items.filter((i) => multi.includes(i.id)) : cur ? [cur] : [];

    const move = (to: number, extend = false) => {
        const n = items.length;
        if (!n) {
            return;
        }
        const tt = Math.max(0, Math.min(n - 1, to));
        if (extend) {
            const a = Math.min(anchor.current, tt);
            const b = Math.max(anchor.current, tt);
            setMulti(items.slice(a, b + 1).map((i) => i.id));
        } else {
            anchor.current = tt;
            setMulti([]);
        }
        setSel(tt);
        if (tt >= n - 8 && n < res.total) {
            setLimit((l) => l + PAGE);
        }
    };

    const resetView = () => {
        setSel(0);
        anchor.current = 0;
        setMulti([]);
        setLimit(PAGE);
    };

    const tabIds: (number | null)[] = useMemo(() => [null, ...boards.map((b) => b.id)], [boards]);
    const switchTab = (d: number) => {
        const i = tabIds.indexOf(tab);
        setTab(tabIds[(i + d + tabIds.length) % tabIds.length]);
        resetView();
    };

    const visibleIds = (): number[] => {
        const lst = listRef.current;
        if (!lst) {
            return items.slice(0, 9).map((i) => i.id);
        }
        const lr = lst.getBoundingClientRect();
        const out: number[] = [];
        for (const it of items) {
            const el = document.getElementById(`card-${it.id}`);
            if (!el) {
                continue;
            }
            const r = el.getBoundingClientRect();
            if (r.bottom > lr.top + 4 && r.top < lr.bottom - 4) {
                out.push(it.id);
            }
            if (out.length === 9) {
                break;
            }
        }
        return out;
    };

    // ───────────── actions ─────────────
    const doPaste = async (mode: PasteMode, id?: number) => {
        try {
            const ts = targets();
            if (explorerTarget && mode === 'auto') {
                const fileTargets = id !== undefined ? items.filter((x) => x.id === id) : ts;
                const fileIds = fileTargets
                    .filter((x) => x.kind === 'file' || x.kind === 'image')
                    .map((x) => x.id);
                if (fileIds.length > 0) {
                    const n = await api.pasteFilesToFolder(fileIds, explorerTarget);
                    showToast(t('Transferred {n} item(s) to folder', { n }));
                    return;
                }
            }
            if (id === undefined && ts.length > 1) {
                const nid = await api.mergeItems(
                    ts.map((x) => x.id),
                    '\n'
                );
                await api.pasteItem(nid, mode);
                return;
            }
            const target = id ?? cur?.id;
            if (target !== undefined) {
                await api.pasteItem(target, mode);
            }
        } catch (e) {
            fail(e);
        }
    };

    const doCopy = async (it?: ClipRow) => {
        const x = it ?? cur;
        if (x) {
            api.copyItem(x.id, 'auto').catch(fail);
        }
    };

    const doDelete = async (hard: boolean) => {
        const ts = targets();
        if (!ts.length) {
            return;
        }
        const ids = ts.map((x) => x.id);
        try {
            if (tab !== null && !hard) {
                await api.setPinboard(ids, null);
            } else {
                await api.deleteItems(ids);
            }
            setMulti([]);
        } catch (e) {
            fail(e);
        }
    };

    const renameItem = (it?: ClipRow) => {
        const x = it ?? cur;
        if (!x) {
            return;
        }
        setPrompt({
            title: t('Rename item'),
            initial: x.title ?? '',
            placeholder: t('Custom title (empty to clear)'),
            onSubmit: (v) => {
                api.renameItem(x.id, v).catch(fail);
            },
        });
    };

    const tagItem = (it?: ClipRow) => {
        const x = it ?? cur;
        if (!x) {
            return;
        }
        setPrompt({
            title: t('Tags (space separated)'),
            initial: x.tags,
            placeholder: 'work todo',
            onSubmit: (v) => {
                api.setTags(x.id, v).catch(fail);
            },
        });
    };

    const newBoard = (assignIds?: number[]) => {
        setPrompt({
            title: t('New pinboard'),
            placeholder: t('Name'),
            onSubmit: async (name) => {
                if (!name.trim()) {
                    return;
                }
                try {
                    const id = await api.createPinboard(
                        name,
                        BOARD_COLORS[boards.length % BOARD_COLORS.length]
                    );
                    if (assignIds?.length) {
                        await api.setPinboard(assignIds, id);
                    } else {
                        setTab(id);
                        resetView();
                    }
                } catch (e) {
                    fail(e);
                }
            },
        });
    };

    const mergePrompt = () => {
        const ts = targets();
        if (ts.length < 2) {
            showToast(t('Select several items first (Shift+↑/↓)'));
            return;
        }
        setPrompt({
            title: t('Merge {n} items — separator', { n: ts.length }),
            initial: '\\n',
            placeholder: t('\\n = new line, \\t = tab, or any text'),
            onSubmit: async (v) => {
                const sep = v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                try {
                    await api.mergeItems(
                        ts.map((x) => x.id),
                        sep
                    );
                    setMulti([]);
                    setSel(0);
                    showToast(t('Merged into a new item'));
                } catch (e) {
                    fail(e);
                }
            },
        });
    };

    const togglePin = (it?: ClipRow) => {
        const ts = it ? [it] : targets();
        if (!ts.length) {
            return;
        }
        api.setPinned(
            ts.map((x) => x.id),
            !ts[0].pinned
        ).catch(fail);
    };

    const toggleDisplayStyle = () => {
        const nextStyle = richOn ? 'plain' : 'rich';
        if (curBoard) {
            api.updatePinboard(
                curBoard.id,
                curBoard.name,
                curBoard.color,
                curBoard.max_items,
                nextStyle,
                curBoard.paste_mode
            )
                .then(() => reload())
                .catch(fail);
        } else if (settings) {
            saveSettings({ ...settings, list_style: nextStyle });
        }
    };

    const applyTransform = async (it: ClipRow, tr: Transform) => {
        try {
            const text = await api.getText(it.id);
            const out = tr.run(text);
            if (out === text) {
                showToast(t('No change'));
                return;
            }
            await api.createTextItem(out);
            setSel(0);
            showToast(t('{label}: new item created', { label: t(tr.label) }));
        } catch (e) {
            showToast(t('Cannot apply: {e}', { e: errText(e) }));
        }
    };

    const openPreview = (it?: ClipRow, edit = false, formats = false) => {
        const x = it ?? cur;
        if (x) {
            setPreview({ item: x, edit, formats });
        }
    };

    /** Keyboard / drag reordering. Only meaningful when no search is active. */
    const reorder = (id: number, target: number, after: boolean) => {
        if (query) {
            showToast(t('Clear the search to reorder items'));
            return;
        }
        api.moveItem(id, target, after, tab).catch(fail);
    };

    const openMenu = (it: ClipRow, x: number, y: number) => {
        const idx = items.findIndex((i) => i.id === it.id);
        if (idx >= 0 && !multi.includes(it.id)) {
            setSel(idx);
            anchor.current = idx;
            setMulti([]);
        }
        const plainDefault = settings?.default_mode === 'plain';
        const ids = multi.length > 1 && multi.includes(it.id) ? multi : [it.id];
        const textual = it.kind !== 'image' && it.kind !== 'file';
        const plainLabel = it.kind === 'file' ? t('Paste file path') : t('Paste as plain text');
        const e: MenuEntry[] = [];
        if (explorerTarget && (it.kind === 'file' || it.kind === 'image')) {
            e.push({
                label: `${t('Paste into folder')} (${basename(explorerTarget)})`,
                onClick: () => {
                    api.pasteFilesToFolder(ids, explorerTarget)
                        .then((n) => showToast(t('Transferred {n} item(s) to folder', { n })))
                        .catch(fail);
                },
            });
            e.push({ sep: true });
        }
        e.push(
            {
                label: ids.length > 1 ? t('Paste {n} items merged', { n: ids.length }) : t('Paste'),
                hint: '↵',
                onClick: () => doPaste('auto', ids.length > 1 ? undefined : it.id),
            },
            plainDefault && it.kind !== 'file'
                ? { label: t('Paste with formatting'), hint: 'Ctrl+↵', onClick: () => doPaste('rich', it.id) }
                : { label: plainLabel, hint: '⇧↵', onClick: () => doPaste('plain', it.id) },
            { label: t('Copy'), hint: 'Ctrl+C', onClick: () => doCopy(it) },
            { sep: true }
        );
        if (it.kind === 'link') {
            e.push({ label: t('Open link'), hint: 'Ctrl+O', onClick: () => api.openItem(it.id) });
        }
        if (it.kind === 'file') {
            e.push({ label: t('Open'), hint: 'Ctrl+O', onClick: () => api.openItem(it.id) });
            e.push({ label: t('Show in Explorer'), onClick: () => api.revealItem(it.id) });
        }
        e.push({ label: t('Preview'), hint: 'Space', onClick: () => openPreview(it) });
        if (textual) {
            e.push({ label: t('Edit…'), hint: 'Ctrl+E', onClick: () => openPreview(it, true) });
        }
        e.push({ label: t('Rename…'), hint: 'F2', onClick: () => renameItem(it) });
        e.push({ label: t('Tags…'), hint: 'Ctrl+T', onClick: () => tagItem(it) });
        e.push({
            label: t('Formats (MIME inspector)'),
            hint: 'Ctrl+I',
            onClick: () => openPreview(it, false, true),
        });
        e.push({ sep: true });
        e.push({
            label: it.pinned ? t('Unpin from top') : t('Pin on top'),
            hint: 'Ctrl+P',
            onClick: () => togglePin(it),
        });
        e.push({ header: true, label: it.pinboard_id ? t('Move to') : t('Pin to') });
        e.push({
            chips: [
                ...boards.map((b) => ({
                    label: b.name,
                    color: b.color,
                    onClick: () => {
                        api.setPinboard(ids, b.id).catch(fail);
                    },
                })),
                { label: t('+ New Pinboard'), onClick: () => newBoard(ids) },
            ],
        });
        if (it.pinboard_id) {
            e.push({
                label: t('Remove from pinboard'),
                onClick: () => {
                    api.setPinboard(ids, null).catch(fail);
                },
            });
        }
        if (textual) {
            e.push({ sep: true });
            e.push({
                label: t('Transform'),
                submenu: TRANSFORMS.map((tr) => ({
                    label: `${t(tr.group)} · ${t(tr.label)}`,
                    onClick: () => applyTransform(it, tr),
                })),
            });
            if (settings?.actions.length) {
                e.push({
                    label: t('Actions'),
                    submenu: settings.actions.map((a) => ({
                        label: a.name,
                        onClick: () => {
                            api.runAction(it.id, a.id)
                                .then((r) =>
                                    showToast(r ? t('Action finished: new item') : t('Action finished'))
                                )
                                .catch(fail);
                        },
                    })),
                });
            }
        }
        if (ids.length > 1) {
            e.push({ label: t('Merge {n} items…', { n: ids.length }), hint: 'Ctrl+M', onClick: mergePrompt });
        }
        e.push({ sep: true });
        if (tab !== null) {
            e.push({
                label: t('Delete permanently'),
                danger: true,
                onClick: () => {
                    api.deleteItems(ids).catch(fail);
                },
            });
        } else {
            e.push({
                label: ids.length > 1 ? t('Delete {n} items', { n: ids.length }) : t('Delete'),
                hint: 'Del',
                danger: true,
                onClick: () => {
                    api.deleteItems(ids).catch(fail);
                },
            });
        }
        setMenu({ x, y, entries: e });
    };

    const openTabMenu = (b: Pinboard | null, x: number, y: number) => {
        if (!b) {
            setMenu({
                x,
                y,
                entries: [{ label: t('Erase history…'), danger: true, onClick: () => askErase(null) }],
            });
            return;
        }
        const isAct = settings?.active_pinboard === b.id;
        setMenu({
            x,
            y,
            entries: [
                {
                    label: isAct ? t('Deactivate pinboard') : t('Activate pinboard (new copies go here)'),
                    onClick: () => {
                        if (settings) {
                            saveSettings({ ...settings, active_pinboard: isAct ? null : b.id });
                        }
                    },
                },
                { label: t('Pinboard settings…'), onClick: () => setBoardDlg(b) },
                { sep: true },
                {
                    label: t('Erase history…'),
                    danger: true,
                    onClick: () => askErase(b),
                },
                {
                    label: t('Delete pinboard…'),
                    danger: true,
                    onClick: () =>
                        setPrompt({
                            title: t('Delete "{name}" and its {n} item(s)?', { name: b.name, n: b.count }),
                            confirm: true,
                            okLabel: t('Delete'),
                            danger: true,
                            onSubmit: () => {
                                api.deletePinboard(b.id)
                                    .then(() => {
                                        if (tab === b.id) {
                                            setTab(null);
                                            resetView();
                                        }
                                    })
                                    .catch(fail);
                            },
                        }),
                },
            ],
        });
    };

    // ───────────── keyboard ─────────────
    const onKey = (e: React.KeyboardEvent) => {
        if (prompt || boardDlg) {
            return;
        }
        if (e.key === 'Control') {
            setCtrl(true);
            setQuickIds(visibleIds());
            return;
        }
        if (menu) {
            if (e.key === 'Escape') {
                e.preventDefault();
                setMenu(null);
            }
            return;
        }
        const k = e.key;
        const ck = e.ctrlKey || e.metaKey;
        const empty = query === '';
        // In RTL the arrows are mirrored visually, so "next tab" follows the reading direction.
        const rtl = isRtl(lang);

        if (ck && /^[1-9]$/.test(k)) {
            e.preventDefault();
            const id = visibleIds()[Number(k) - 1];
            if (id !== undefined) {
                api.pasteItem(id, e.shiftKey ? 'plain' : 'auto').catch(fail);
            }
            return;
        }
        if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && cur) {
            e.preventDefault();
            if (k === 'ArrowUp' && sel > 0) {
                reorder(cur.id, items[sel - 1].id, false);
                setSel(sel - 1);
                anchor.current = sel - 1;
            }
            if (k === 'ArrowDown' && sel < items.length - 1) {
                reorder(cur.id, items[sel + 1].id, true);
                setSel(sel + 1);
                anchor.current = sel + 1;
            }
            return;
        }
        if (ck && (k === ']' || k === '[')) {
            e.preventDefault();
            switchTab(k === ']' ? 1 : -1);
            return;
        }
        switch (k) {
            case 'ArrowDown':
                e.preventDefault();
                move(ck ? items.length - 1 : sel + 1, e.shiftKey && !ck);
                return;
            case 'ArrowUp':
                e.preventDefault();
                move(ck ? 0 : sel - 1, e.shiftKey && !ck);
                return;
            case 'PageDown':
                e.preventDefault();
                move(sel + 5);
                return;
            case 'PageUp':
                e.preventDefault();
                move(sel - 5);
                return;
            case 'Home':
                if (empty || ck) {
                    e.preventDefault();
                    move(0);
                }
                return;
            case 'End':
                if (empty || ck) {
                    e.preventDefault();
                    move(items.length - 1);
                }
                return;
            case 'ArrowLeft':
                if (empty || e.altKey) {
                    e.preventDefault();
                    switchTab(rtl ? 1 : -1);
                }
                return;
            case 'ArrowRight':
                if (empty || e.altKey) {
                    e.preventDefault();
                    switchTab(rtl ? -1 : 1);
                }
                return;
            case 'Tab':
                e.preventDefault();
                switchTab(e.shiftKey ? -1 : 1);
                return;
            case 'Enter':
                e.preventDefault();
                doPaste(e.shiftKey ? 'plain' : ck ? 'rich' : 'auto');
                return;
            case ' ':
                if (empty || ck) {
                    e.preventDefault();
                    openPreview();
                }
                return;
            case 'F3':
                e.preventDefault();
                openPreview();
                return;
            case 'F2':
                e.preventDefault();
                renameItem();
                return;
            case 'Delete':
                if (empty || ck) {
                    e.preventDefault();
                    doDelete(false);
                }
                return;
            case 'Escape':
                e.preventDefault();
                if (query) {
                    setQuery('');
                    resetView();
                } else {
                    api.hidePopup();
                }
                return;
        }
        if (ck) {
            const l = k.toLowerCase();
            if (l === 'c' && !window.getSelection()?.toString()) {
                e.preventDefault();
                doCopy();
            } else if (l === 'o' && cur) {
                e.preventDefault();
                api.openItem(cur.id);
            } else if (l === 'r') {
                e.preventDefault();
                renameItem();
            } else if (l === 'e' && cur) {
                e.preventDefault();
                openPreview(cur, true);
            } else if (l === 'n') {
                e.preventDefault();
                newBoard();
            } else if (l === 'p') {
                e.preventDefault();
                togglePin();
            } else if (l === 't') {
                e.preventDefault();
                tagItem();
            } else if (l === 'i' && cur) {
                e.preventDefault();
                openPreview(cur, false, true);
            } else if (l === 'm') {
                e.preventDefault();
                mergePrompt();
            } else if (k === ',') {
                e.preventDefault();
                api.openSettings();
            }
        }
    };

    const onCardClick = (it: ClipRow, e: React.MouseEvent) => {
        const idx = items.findIndex((i) => i.id === it.id);
        if (idx < 0) {
            return;
        }
        const ck = e.ctrlKey || e.metaKey;
        if (ck && e.shiftKey) {
            setSel(idx);
            const act = settings?.ctrl_shift_click_action ?? 'paste_plain';
            if (act === 'paste_plain') {
                doPaste('plain', it.id);
            } else if (act === 'paste') {
                doPaste('rich', it.id);
            } else if (act === 'copy_only') {
                doCopy(it);
            }
            return;
        }
        if (ck) {
            const act = settings?.ctrl_click_action ?? 'multi_select';
            if (act === 'multi_select') {
                setMulti((m) => {
                    const base = m.length ? m : cur ? [cur.id] : [];
                    return base.includes(it.id) ? base.filter((x) => x !== it.id) : [...base, it.id];
                });
                setSel(idx);
            } else if (act === 'paste') {
                setSel(idx);
                doPaste('auto', it.id);
            } else if (act === 'paste_plain') {
                setSel(idx);
                doPaste('plain', it.id);
            } else if (act === 'copy_only') {
                setSel(idx);
                doCopy(it);
            }
            return;
        }
        if (e.shiftKey) {
            move(idx, true);
            return;
        }
        setSel(idx);
        anchor.current = idx;
        setMulti([]);
        if (settings?.card_paste_click === 'single') {
            doPaste('auto', it.id);
        }
    };

    const onCardDoubleClick = (it: ClipRow, e: React.MouseEvent) => {
        if (e.ctrlKey || e.metaKey) {
            return;
        }
        doPaste(e.shiftKey ? 'plain' : 'auto', it.id);
    };

    // Card is memoised on its data props, so it receives STABLE handlers that forward to the latest closures.
    const handlers = useRef({
        click: onCardClick,
        doubleClick: onCardDoubleClick,
        menu: openMenu,
        dragStart: (_: ClipRow, __: React.DragEvent) => {},
        dragOver: (_: ClipRow, __: boolean) => {},
        drop: (_: ClipRow, __: boolean) => {},
    });
    handlers.current = {
        click: onCardClick,
        doubleClick: onCardDoubleClick,
        menu: openMenu,
        dragStart: (it, e) => {
            dragId.current = it.id;
            setDraggingId(it.id);
            const count = multi.includes(it.id) && multi.length > 1 ? multi.length : 1;
            const label = count > 1 ? t('Move {n} items', { n: count }) : t('Move item');
            setDragLabel(label);
            if (dragPillRef.current) {
                const span = dragPillRef.current.querySelector('.drag-pill-text');
                if (span) {
                    span.textContent = label;
                }
                e.dataTransfer.setDragImage(dragPillRef.current, 14, 14);
            }
        },
        dragOver: (it, after) => {
            if (dragId.current === null || dragId.current === it.id || query) {
                return;
            }
            setDragOverTabId(null);
            setDropMark((m) =>
                m && m.id === it.id && m.mark === (after ? 'after' : 'before')
                    ? m
                    : { id: it.id, mark: after ? 'after' : 'before' }
            );
        },
        drop: (it, after) => {
            const id = dragId.current;
            dragId.current = null;
            setDraggingId(null);
            setDragOverTabId(null);
            setDropMark(null);
            if (id !== null && id !== it.id) {
                reorder(id, it.id, after);
            }
        },
    };
    const stableClick = useCallback((it: ClipRow, e: React.MouseEvent) => handlers.current.click(it, e), []);
    const stableDoubleClick = useCallback(
        (it: ClipRow, e: React.MouseEvent) => handlers.current.doubleClick(it, e),
        []
    );
    const stableMenu = useCallback(
        (it: ClipRow, x: number, y: number) => handlers.current.menu(it, x, y),
        []
    );
    const stableDragStart = useCallback(
        (it: ClipRow, e: React.DragEvent) => handlers.current.dragStart(it, e),
        []
    );
    const stableDragOver = useCallback(
        (it: ClipRow, after: boolean) => handlers.current.dragOver(it, after),
        []
    );
    const stableDrop = useCallback((it: ClipRow, after: boolean) => handlers.current.drop(it, after), []);
    const stableDragEnd = useCallback(() => {
        dragId.current = null;
        setDraggingId(null);
        setDragOverTabId(null);
        setDropMark(null);
    }, []);

    // ───────────── render ─────────────
    const s = settings;
    const lines = s?.card_lines ?? 4;
    const showThumbs = s?.show_thumbnails ?? true;
    const hlEnabled = s?.highlight_matches ?? true;
    const useVirtual = s?.virtual_scroll !== false;
    const toolbar = s?.show_toolbar && cur;
    const showCounts = s?.show_pinboard_counts ?? true;

    const renderCard = (it: ClipRow, i: number) => (
        <Card
            key={it.id}
            item={it}
            selected={i === sel}
            multi={multi.includes(it.id)}
            badge={ctrl && quickIds.includes(it.id) ? quickIds.indexOf(it.id) + 1 : null}
            lines={lines}
            now={now}
            lang={lang}
            rich={richOn}
            showThumbnails={showThumbs}
            query={query}
            searchMode={smode}
            highlight={hlEnabled}
            iconRev={iconRev}
            dragging={draggingId === it.id}
            drop={dropMark && dropMark.id === it.id ? dropMark.mark : null}
            onClick={stableClick}
            onDoubleClick={stableDoubleClick}
            onContext={stableMenu}
            onDragStart={stableDragStart}
            onDragOver={stableDragOver}
            onDrop={stableDrop}
            onDragEnd={stableDragEnd}
        />
    );

    return (
        <div
            className="popup"
            tabIndex={-1}
            onKeyDown={onKey}
            onKeyUp={(e) => {
                if (e.key === 'Control') {
                    setCtrl(false);
                }
            }}
        >
            {/* Offscreen custom drag preview pill */}
            <div ref={dragPillRef} className="drag-ghost-pill" aria-hidden>
                <Icon name="copy" size={13} />
                <span className="drag-pill-text">{dragLabel || t('Move item')}</span>
            </div>

            <header
                className="head"
                onMouseDown={(e) => {
                    if (e.button === 0 && !(e.target as HTMLElement).closest('button, input, a')) {
                        getCurrentWindow()
                            .startDragging()
                            .catch(() => {});
                    }
                }}
            >
                <img className="logo-img" src="/icon.png" alt="ClipNest" draggable={false} />
                <span className="brand">ClipNest</span>
                {status && status.paused_until > 0 && (
                    <button type="button" className="chipbtn warn" onClick={() => api.resume()}>
                        {t('Paused · resume')}
                    </button>
                )}
                {status?.plain_default && (
                    <button
                        type="button"
                        className="chipbtn"
                        data-tip={t('Plain-text mode (click to turn off)')}
                        onClick={() => api.togglePlain()}
                    >
                        {t('Plain text')}
                    </button>
                )}
                {status?.queue_active && (
                    <button type="button" className="chipbtn accent" onClick={() => api.queueToggle()}>
                        {status.queue_mode === 'basket' ? t('Drop Basket') : t('Queue')}{' '}
                        {num(status.queue_len)}
                    </button>
                )}
                <span className="spacer" />
                <button
                    type="button"
                    className={`iconbtn${status?.popup_pinned ? ' on' : ''}`}
                    data-tip={status?.popup_pinned ? t('Unpin window') : t('Pin window on top')}
                    onClick={() => {
                        api.setPopupPinned(!(status?.popup_pinned ?? false)).catch(fail);
                    }}
                >
                    <Icon name="pin" />
                </button>
                <button
                    type="button"
                    className={`iconbtn${settings?.show_toolbar ? ' on' : ''}`}
                    data-tip={t('Toggle side toolbar')}
                    onClick={() => {
                        if (settings) {
                            saveSettings({ ...settings, show_toolbar: !settings.show_toolbar });
                        }
                    }}
                >
                    <Icon name="sidebar" />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    data-tip={t('Paste queue / Drop Basket')}
                    onClick={() => api.queueToggle()}
                >
                    <Icon name="list" />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    data-tip={t('Settings (Ctrl+,)')}
                    onClick={() => api.openSettings()}
                >
                    <Icon name="gear" />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    data-tip={t('Close (Esc)')}
                    onClick={() => api.hidePopup()}
                >
                    <Icon name="close" />
                </button>
            </header>

            <div className="searchrow">
                <Icon name="search" size={13} />
                <input
                    ref={inputRef}
                    className="search-bare"
                    value={query}
                    spellCheck={false}
                    dir="auto"
                    placeholder={
                        smode === 'regex' ? t('Regular expression…') : t('Type to search your clipboard')
                    }
                    onChange={(e) => {
                        setQuery(e.target.value);
                        resetView();
                    }}
                />
                {query && (
                    <button
                        type="button"
                        className="iconbtn"
                        data-tip={t('Clear')}
                        onClick={() => {
                            setQuery('');
                            resetView();
                        }}
                    >
                        <Icon name="close" size={12} />
                    </button>
                )}
                <button
                    type="button"
                    className={`mini${richOn ? ' on' : ''}`}
                    data-tip={t('Switch between original style and plain text')}
                    onClick={toggleDisplayStyle}
                >
                    Aa
                </button>
                <button
                    type="button"
                    className={`mini${smode === 'regex' ? ' on' : ''}`}
                    data-tip={t('Regular expression')}
                    onClick={() => setSmode(smode === 'regex' ? 'smart' : 'regex')}
                >
                    .*
                </button>
                <button
                    type="button"
                    className={`mini${smode === 'fuzzy' ? ' on' : ''}`}
                    data-tip={t('Strict fuzzy: letters in order')}
                    onClick={() => setSmode(smode === 'fuzzy' ? 'smart' : 'fuzzy')}
                >
                    ~
                </button>
            </div>

            <div className="tabs">
                <button
                    type="button"
                    className={`tab${tab === null ? ' active' : ''}`}
                    onClick={() => {
                        setTab(null);
                        resetView();
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        openTabMenu(null, e.clientX, e.clientY);
                    }}
                >
                    <span>{t('Clipboard')}</span>
                </button>
                {boards.map((b) => {
                    const isDropTarget = dragOverTabId === b.id;
                    const isActiveTarget = settings?.active_pinboard === b.id;
                    return (
                        <button
                            key={b.id}
                            type="button"
                            className={`tab${tab === b.id ? ' active' : ''}${isDropTarget ? ' drop-target' : ''}${
                                isActiveTarget ? ' active-board' : ''
                            }`}
                            data-tip={isActiveTarget ? t('Active pinboard (new copies go here)') : undefined}
                            onClick={() => {
                                setTab(b.id);
                                resetView();
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                openTabMenu(b, e.clientX, e.clientY);
                            }}
                            onDragEnter={(e) => {
                                e.preventDefault();
                                setDragOverTabId(b.id);
                                setDropMark(null);
                            }}
                            onDragOver={(e) => {
                                e.preventDefault();
                                if (dragOverTabId !== b.id) {
                                    setDragOverTabId(b.id);
                                }
                                if (dropMark !== null) {
                                    setDropMark(null);
                                }
                            }}
                            onDragLeave={(e) => {
                                const rel = e.relatedTarget as Node | null;
                                if (!rel || !e.currentTarget.contains(rel)) {
                                    setDragOverTabId((curId) => (curId === b.id ? null : curId));
                                }
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                setDragOverTabId(null);
                                setDraggingId(null);
                                setDropMark(null);
                                const id = Number(e.dataTransfer.getData('text/clip-id')) || dragId.current;
                                dragId.current = null;
                                if (id) {
                                    const ids = multi.includes(id) ? multi : [id];
                                    api.setPinboard(ids, b.id)
                                        .then(() => showToast(t('Pinned to {name}', { name: b.name })))
                                        .catch(fail);
                                }
                            }}
                        >
                            <span
                                className={`dot${isActiveTarget ? ' pulse' : ''}`}
                                style={{ background: b.color }}
                            />
                            <span>{isDropTarget ? t('Move to {name}', { name: b.name }) : b.name}</span>
                            {showCounts && !isDropTarget && <span className="tab-count">{num(b.count)}</span>}
                        </button>
                    );
                })}
                <button
                    type="button"
                    className="tab plus"
                    data-tip={t('New pinboard (Ctrl+N)')}
                    onClick={() => newBoard()}
                >
                    <Icon name="plus" size={12} />
                </button>
            </div>

            {explorerTarget && (
                <div className="explorer-bar">
                    <Icon name="folder" size={14} />
                    <span className="explorer-path" dir="ltr" data-tip={explorerTarget}>
                        {basename(explorerTarget)}
                    </span>
                    <span className="spacer" />
                    <button
                        type="button"
                        className="btn primary small-btn"
                        disabled={!cur || (cur.kind !== 'file' && cur.kind !== 'image')}
                        onClick={() => {
                            const ids = targets()
                                .filter((x) => x.kind === 'file' || x.kind === 'image')
                                .map((x) => x.id);
                            if (ids.length > 0) {
                                api.pasteFilesToFolder(ids, explorerTarget)
                                    .then((n) => showToast(t('Transferred {n} item(s) to folder', { n })))
                                    .catch(fail);
                            }
                        }}
                    >
                        {t('Paste into folder')}
                    </button>
                    <button
                        type="button"
                        className="iconbtn"
                        data-tip={t('Clear')}
                        onClick={() => {
                            setExplorerTarget(null);
                            api.clearExplorerTarget().catch(() => {});
                            if (query === 'file') {
                                setQuery('');
                            }
                        }}
                    >
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            <div className="mainrow">
                {res.error || items.length === 0 || !useVirtual ? (
                    <div className="list" ref={listRef}>
                        {res.error && <div className="empty err">{res.error}</div>}
                        {!res.error && items.length === 0 && (
                            <div className="empty">
                                {query
                                    ? t('Nothing found')
                                    : tab === null
                                      ? t('Nothing copied yet')
                                      : t('This pinboard is empty — drag cards onto its tab')}
                            </div>
                        )}
                        {!res.error && items.map((it, i) => renderCard(it, i))}
                    </div>
                ) : (
                    <div className="list vlist-host" ref={listRef}>
                        <VList ref={vlistRef} className="vlist">
                            {items.map((it, i) => (
                                <div key={it.id} className="vlist-item">
                                    {renderCard(it, i)}
                                </div>
                            ))}
                        </VList>
                    </div>
                )}

                {toolbar && cur && (
                    <div className="toolbar">
                        <button type="button" data-tip={t('Preview')} onClick={() => openPreview()}>
                            <Icon name="eye" size={16} />
                        </button>
                        <button type="button" data-tip={t('Pin on top')} onClick={() => togglePin()}>
                            <Icon name="pin" size={16} />
                        </button>
                        <button type="button" data-tip={t('Tags…')} onClick={() => tagItem()}>
                            <Icon name="tag" size={16} />
                        </button>
                        <button type="button" data-tip={t('Copy')} onClick={() => doCopy()}>
                            <Icon name="copy" size={16} />
                        </button>
                        <button
                            type="button"
                            data-tip={t('Formats (MIME inspector)')}
                            onClick={() => openPreview(cur, false, true)}
                        >
                            <Icon name="info" size={16} />
                        </button>
                        {cur.kind !== 'image' && cur.kind !== 'file' && (
                            <button
                                type="button"
                                data-tip={t('Edit…')}
                                onClick={() => openPreview(cur, true)}
                            >
                                <Icon name="edit" size={16} />
                            </button>
                        )}
                        <button type="button" data-tip={t('Merge selected')} onClick={mergePrompt}>
                            <Icon name="merge" size={16} />
                        </button>
                        <button
                            type="button"
                            data-tip={t('Actions')}
                            onClick={(e) => openMenu(cur, e.clientX, e.clientY)}
                        >
                            <Icon name="bolt" size={16} />
                        </button>
                        <button
                            type="button"
                            data-tip={t('Delete')}
                            className="danger"
                            onClick={() => doDelete(false)}
                        >
                            <Icon name="trash" size={16} />
                        </button>
                    </div>
                )}
            </div>

            <footer className="foot">
                <span>
                    {t(res.total === 1 ? '{n} item' : '{n} items', { n: num(res.total) })}
                    {multi.length > 1 ? ` · ${t('{n} selected', { n: num(multi.length) })}` : ''}
                </span>
                <button
                    type="button"
                    className="iconbtn erase"
                    data-tip={t('Erase history…')}
                    onClick={() => askErase()}
                >
                    <Icon name="trash" size={13} />
                </button>
                <span className="spacer" />
                <span className="hints">
                    <kbd>↵</kbd> {t('Paste')} <kbd>⇧↵</kbd>{' '}
                    {cur?.kind === 'file' ? t('File path') : t('Plain text')} <kbd>Del</kbd>{' '}
                    {tab === null ? t('Delete') : t('Unpin')}
                </span>
            </footer>

            {toast && <div className="toast">{toast}</div>}
            {menu && (
                <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
            )}
            {prompt && <Prompt p={prompt} onClose={() => setPrompt(null)} />}
            {boardDlg && (
                <BoardDialog
                    board={boardDlg}
                    isActive={settings?.active_pinboard === boardDlg.id}
                    onSave={(name, color, max, style, pasteMode, active) => {
                        api.updatePinboard(boardDlg.id, name, color, max, style, pasteMode)
                            .then(() => reload())
                            .catch(fail);
                        if (settings) {
                            const curActive = settings.active_pinboard === boardDlg.id;
                            if (active !== curActive) {
                                saveSettings({ ...settings, active_pinboard: active ? boardDlg.id : null });
                            }
                        }
                    }}
                    onClose={() => setBoardDlg(null)}
                />
            )}
            {preview && (
                <Preview
                    item={preview.item}
                    startEdit={preview.edit}
                    startFormats={preview.formats}
                    richDefault={richOn}
                    autoSaveEdit={s?.auto_save_edit ?? true}
                    query={query}
                    searchMode={smode}
                    highlight={hlEnabled}
                    onClose={() => setPreview(null)}
                    onPaste={(id, mode) => {
                        setPreview(null);
                        api.pasteItem(id, mode).catch(fail);
                    }}
                    onToast={showToast}
                />
            )}
        </div>
    );
}
