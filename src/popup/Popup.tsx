import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, ClipRow, errText, ListResult, on, PasteMode, Pinboard, Status } from '../lib/api';
import { basename } from '../lib/format';
import { SearchMode } from '../lib/highlightMatch';
import { isRtl, num, t, useLang } from '../lib/i18n';
import { Icon } from '../lib/icons';
import { digitOfKey, isKey } from '../lib/shortcut';
import { TRANSFORMS, Transform } from '../lib/transforms';
import { useSettings } from '../lib/useSettings';
import { Card, DropMark } from './Card';
import { BOARD_COLORS, BoardDialog, ContextMenu, MenuEntry, Prompt, PromptState } from './Overlays';
import { Preview } from './Preview';

/** Default number of items loaded per scroll page (configurable via `settings.page_size`). */
const DEFAULT_PAGE_SIZE = 100;

function normalizePageSize(raw?: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_PAGE_SIZE;
    }
    return Math.max(20, Math.min(500, Math.round(raw)));
}

function renderCopyAccentText(full: string, accentCopy: boolean) {
    if (!accentCopy) {
        return <span className="inline-label">{full}</span>;
    }
    const copyWord = t('Copy');
    if (full.toLowerCase().startsWith(copyWord.toLowerCase())) {
        const prefix = full.slice(0, copyWord.length);
        const rest = full.slice(copyWord.length).replace(/^\s+/, '');
        return (
            <span className="inline-label">
                <span className="menu-copy-accent">{prefix}</span>
                {rest ? `\u00A0${rest}` : ''}
            </span>
        );
    }
    return <span className="inline-label menu-copy-accent">{full}</span>;
}

function renderDropTabLabel(isCopy: boolean, accentCopy: boolean, name: string) {
    if (!isCopy) {
        return <span className="inline-label">{t('Move to {name}', { name })}</span>;
    }
    return renderCopyAccentText(t('Copy to {name}', { name }), accentCopy);
}

function renderDragPillLabel(isCopy: boolean, accentCopy: boolean, count: number) {
    if (!isCopy) {
        const moveText = count > 1 ? t('Move {n} items', { n: count }) : t('Move item');
        return <span className="drag-pill-text inline-label">{moveText}</span>;
    }
    const copyText = count > 1 ? t('Copy {n} items', { n: count }) : t('Copy item');
    return <span className="drag-pill-text inline-label">{renderCopyAccentText(copyText, accentCopy)}</span>;
}

export default function Popup() {
    const lang = useLang();
    const [settings, saveSettings] = useSettings();
    const [status, setStatus] = useState<Status | null>(null);
    const [boards, setBoards] = useState<Pinboard[]>([]);
    const [tab, setTab] = useState<number | null>(null);
    const [query, setQuery] = useState('');
    const [smode, setSmode] = useState<SearchMode>('smart');
    const pageSize = normalizePageSize(settings?.page_size);
    const pageSizeRef = useRef(pageSize);
    pageSizeRef.current = pageSize;
    const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
    const [removingIds, setRemovingIds] = useState<Set<number>>(() => new Set());
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
    const [dragCount, setDragCount] = useState(1);
    const [dragPos, setDragPos] = useState<{ x: number; y: number }>({ x: -1000, y: -1000 });
    const [dragInTabs, setDragInTabs] = useState(false);
    const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);
    const [dragCtrl, setDragCtrl] = useState(false);
    const [dropMark, setDropMark] = useState<{ id: number; mark: DropMark } | null>(null);
    const [explorerTarget, setExplorerTarget] = useState<string | null>(null);
    const [tabsGrabbing, setTabsGrabbing] = useState(false);
    const [tabsHasScroll, setTabsHasScroll] = useState(false);

    const anchor = useRef(0);
    const seq = useRef(0);
    const hiddenAt = useRef(0);
    const dragId = useRef<number | null>(null);
    const dropMarkRef = useRef<{ id: number; mark: DropMark } | null>(null);
    dropMarkRef.current = dropMark;
    const dragOverTabRef = useRef<number | null>(null);
    dragOverTabRef.current = dragOverTabId;
    const dragCtrlRef = useRef(false);
    dragCtrlRef.current = dragCtrl;
    const pointerDragState = useRef<{
        pendingId: number | null;
        startX: number;
        startY: number;
        active: boolean;
        justDragged: boolean;
        count: number;
    }>({
        pendingId: null,
        startX: 0,
        startY: 0,
        active: false,
        justDragged: false,
        count: 1,
    });
    const followIdRef = useRef<number | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const tabsRef = useRef<HTMLDivElement>(null);
    const tabDragState = useRef<{ active: boolean; startX: number; startScroll: number; moved: boolean }>({
        active: false,
        startX: 0,
        startScroll: 0,
        moved: false,
    });
    const emptyDragRef = useRef<HTMLDivElement>(null);
    const toastTimer = useRef<number | undefined>(undefined);
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    const items = res.items;
    const cur: ClipRow | undefined = items[sel];
    const curBoard = boards.find((b) => b.id === tab) ?? null;
    // Display style: per-category override, otherwise the global setting.
    const richOn =
        (curBoard && curBoard.list_style !== 'inherit' ? curBoard.list_style : (settings?.list_style ?? 'rich')) ===
        'rich';

    const showToast = useCallback((s: string) => {
        setToast(s);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2600);
    }, []);
    const fail = useCallback((e: unknown) => showToast(errText(e)), [showToast]);

    const focusSearchQuietly = useCallback(() => {
        if (!menu && !preview && !prompt && !boardDlg) {
            inputRef.current?.focus({ preventScroll: true });
        }
    }, [menu, preview, prompt, boardDlg]);

    // Tracks IDs currently collapsing or awaiting backend deletion/removal so concurrent
    // `items-changed` reloads never resurrect an item mid-animation or mid-IPC.
    const pendingDeleteIdsRef = useRef<Set<number>>(new Set());

    // Keep the initial page window aligned when the user changes `page_size` in Settings.
    const prevPageSizeRef = useRef(pageSize);
    useEffect(() => {
        if (prevPageSizeRef.current !== pageSize) {
            prevPageSizeRef.current = pageSize;
            setLimit(pageSize);
        }
    }, [pageSize]);

    // ───────────── data ─────────────
    const reload = useCallback(async () => {
        const my = ++seq.current;
        try {
            const [rawRes, b] = await Promise.all([api.listItems(tab, query, smode, limit), api.listPinboards()]);
            if (my !== seq.current) {
                return;
            }
            const pending = pendingDeleteIdsRef.current;
            const r =
                pending.size > 0
                    ? (() => {
                          const filtered = rawRes.items.filter((x) => !pending.has(x.id));
                          const dropped = rawRes.items.length - filtered.length;
                          return dropped > 0
                              ? { ...rawRes, items: filtered, total: Math.max(0, rawRes.total - dropped) }
                              : rawRes;
                      })()
                    : rawRes;
            setRes(r);
            setBoards(b);
            // Prune stale IDs (deleted, expired, evicted, or moved to another category) from `multi`
            // so `targets()` never gets stuck returning `[]` and the footer count stays accurate.
            setMulti((prev) => {
                if (prev.length === 0) {
                    return prev;
                }
                const liveIds = new Set(r.items.map((x) => x.id));
                const next = prev.filter((id) => liveIds.has(id));
                return next.length === prev.length ? prev : next.length <= 1 ? [] : next;
            });
            if (followIdRef.current !== null) {
                const movedIdx = r.items.findIndex((x) => x.id === followIdRef.current);
                followIdRef.current = null;
                if (movedIdx >= 0) {
                    setSel(movedIdx);
                    anchor.current = movedIdx;
                    return;
                }
            }
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
            setCtrl(false);
            const activeId = settingsRef.current?.active_pinboard ?? null;
            const targetBoard =
                explicitBoard !== undefined
                    ? explicitBoard
                    : (curBoard ?? boards.find((b) => b.id === activeId) ?? null);
            const msg = targetBoard
                ? t('This will erase items in the active category "{name}".', {
                      name: targetBoard.name,
                  })
                : t(
                      'This will erase items in the main Clipboard tab (categories are kept unless you check the option below).'
                  );
            setPrompt({
                title: t('Erase all history?'),
                message: msg,
                confirm: true,
                checkLabel: t('Also erase pinned items'),
                defaultChecked: false,
                checkLabel2: t('Also erase all categories and main clipboard'),
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
                setCtrl(false);
                setDragCtrl(false);
                setDraggingId(null);
                setDragInTabs(false);
                setDragOverTabId(null);
                setDropMark(null);
                dragId.current = null;
                pointerDragState.current.pendingId = null;
                pointerDragState.current.active = false;
                document.body.classList.remove('dragging-card');
            }),
            on('popup-shown', () => {
                if (Date.now() - hiddenAt.current > 60_000) {
                    setQuery('');
                }
                const activeBoard = settingsRef.current?.active_pinboard ?? null;
                setTab(activeBoard);
                setLimit(pageSizeRef.current);
                setSel(0);
                anchor.current = 0;
                setMulti([]);
                setPreview(null);
                setMenu(null);
                setBoardDlg(null);
                setCtrl(false);
                setDragCtrl(false);
                setDraggingId(null);
                setDragInTabs(false);
                dragId.current = null;
                pointerDragState.current.pendingId = null;
                pointerDragState.current.active = false;
                document.body.classList.remove('dragging-card');
                syncExplorerTarget();
                reloadRef.current();
                loadStatus();
                listRef.current?.scrollTo(0, 0);
                setTimeout(() => {
                    inputRef.current?.focus();
                    inputRef.current?.select();
                }, 30);
            }),
        ];
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        const clearCtrl = () => {
            setCtrl(false);
            setDragCtrl(false);
        };
        const onWindowKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Control' || e.ctrlKey || e.metaKey) {
                setDragCtrl(true);
            }
        };
        const onWindowKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Control' || (!e.ctrlKey && !e.metaKey)) {
                setCtrl(false);
                setDragCtrl(false);
            }
        };
        const onFocusSearch = () => {
            setPreview(null);
            setMenu(null);
            inputRef.current?.focus();
            inputRef.current?.select();
        };
        window.addEventListener('blur', clearCtrl);
        window.addEventListener('keydown', onWindowKeyDown, true);
        window.addEventListener('keyup', onWindowKeyUp, true);
        window.addEventListener('clipnest-focus-search', onFocusSearch);
        return () => {
            subs.forEach((p) => p.then((u) => u()));
            window.clearInterval(timer);
            window.removeEventListener('blur', clearCtrl);
            window.removeEventListener('keydown', onWindowKeyDown, true);
            window.removeEventListener('keyup', onWindowKeyUp, true);
            window.removeEventListener('clipnest-focus-search', onFocusSearch);
        };
    }, [loadStatus, syncExplorerTarget]);

    // Dynamic detection of horizontal scrollbar on the category tabs bar
    const wrapCategories = settings?.wrap_categories ?? false;
    useEffect(() => {
        const el = tabsRef.current;
        if (!el) {
            return;
        }
        const updateOverflow = () => {
            if (wrapCategories) {
                setTabsHasScroll(false);
                return;
            }
            setTabsHasScroll(el.scrollWidth > el.clientWidth + 1);
        };
        updateOverflow();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateOverflow) : null;
        ro?.observe(el);
        Array.from(el.children).forEach((child) => ro?.observe(child));
        window.addEventListener('resize', updateOverflow);
        return () => {
            ro?.disconnect();
            window.removeEventListener('resize', updateOverflow);
        };
    }, [boards.length, wrapCategories, dragOverTabId, settings?.show_pinboard_counts]);

    // Click-and-drag scrolling on the category tabs bar
    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const st = tabDragState.current;
            if (!st.active || !tabsRef.current) {
                return;
            }
            const dx = e.clientX - st.startX;
            if (!st.moved && Math.abs(dx) > 5) {
                st.moved = true;
                setTabsGrabbing(true);
            }
            if (st.moved) {
                tabsRef.current.scrollLeft = st.startScroll - dx;
            }
        };
        const onMouseUp = () => {
            if (tabDragState.current.active) {
                tabDragState.current.active = false;
                setTabsGrabbing(false);
                window.setTimeout(() => {
                    tabDragState.current.moved = false;
                }, 40);
            }
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, []);

    // Keep the active category tab scrolled into view when switching tabs via keyboard
    useEffect(() => {
        const container = tabsRef.current;
        if (!container) {
            return;
        }
        const activeEl = container.querySelector('.tab.active') as HTMLElement | null;
        activeEl?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }, [tab]);

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
            inputRef.current?.focus({ preventScroll: true });
        } else if (preview || prompt || boardDlg) {
            setCtrl(false);
        }
    }, [menu, preview, prompt, boardDlg]);

    useEffect(() => {
        setSel((s) => {
            const clamped = Math.min(s, Math.max(0, items.length - 1));
            return clamped === s ? s : clamped;
        });
    }, [items.length]);

    useEffect(() => {
        if (cur) {
            document.getElementById(`card-${cur.id}`)?.scrollIntoView({ block: 'nearest' });
        }
    }, [sel, cur?.id]);

    // Mouse/trackpad scroll pagination: loads the next `pageSize` clips when the bottom sentinel
    // approaches the scroll viewport (previously only keyboard `move()` incremented `limit`).
    const hasMoreItems = items.length < res.total;
    useEffect(() => {
        const sentinel = loadMoreRef.current;
        const root = listRef.current;
        if (!sentinel || !root || !hasMoreItems || typeof IntersectionObserver === 'undefined') {
            return;
        }
        const obs = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setLimit((l) => (l <= items.length ? l + pageSizeRef.current : l));
                }
            },
            { root, rootMargin: '200px 0px' }
        );
        obs.observe(sentinel);
        return () => obs.disconnect();
    }, [hasMoreItems, items.length]);

    // ───────────── helpers ─────────────
    // Respect any non-empty live `multi` selection (even length 1) before falling back to `cur`,
    // preventing a deselected `cur` from being deleted if `multi` ever contains a single remaining ID.
    const targets = (): ClipRow[] => {
        if (multi.length > 0) {
            const live = items.filter((i) => multi.includes(i.id));
            if (live.length > 0) {
                return live;
            }
        }
        return cur ? [cur] : [];
    };

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
            setLimit((l) => l + pageSizeRef.current);
        }
    };

    const resetView = () => {
        setSel(0);
        anchor.current = 0;
        setMulti([]);
        setLimit(pageSizeRef.current);
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

    // ───────────── smooth declarative CSS Grid card removal animation ─────────────
    // Because `virtua` (`VList`) has been removed in favor of a paginated native DOM list, cards
    // collapse cleanly via `.card-slot.removing` (`grid-template-rows: 1fr -> 0fr`, `opacity: 1 -> 0`).
    // This eliminates imperative `translateY` DOM mutations, forced reflows, overlapping-delete style
    // races, and virtualizer height-cache poisoning while letting every sibling below glide up natively.
    const animateAndRemoveCards = useCallback(async (ids: number[], performRemove: () => Promise<void>) => {
        const freshIds = ids.filter((id) => !pendingDeleteIdsRef.current.has(id));
        if (freshIds.length === 0) {
            return;
        }
        freshIds.forEach((id) => pendingDeleteIdsRef.current.add(id));
        const idSet = new Set(freshIds);
        const canAnimate = (settingsRef.current?.animations ?? true) && (settingsRef.current?.delete_animation ?? true);

        try {
            if (canAnimate && freshIds.length <= 15) {
                setRemovingIds((prev) => {
                    const next = new Set(prev);
                    freshIds.forEach((id) => next.add(id));
                    return next;
                });
                await new Promise<void>((r) => window.setTimeout(r, 240));
            }

            // Invalidate any `reload()` started prior to optimistic removal so stale responses
            // cannot resurrect items while `performRemove()` is still executing.
            ++seq.current;
            setRes((prev) => {
                const nextItems = prev.items.filter((x) => !idSet.has(x.id));
                if (nextItems.length === prev.items.length) {
                    return prev;
                }
                const removedCount = prev.items.length - nextItems.length;
                return {
                    ...prev,
                    items: nextItems,
                    total: Math.max(0, prev.total - removedCount),
                };
            });
            // Remove only the deleted IDs from `multi` so any new selection made during the 240ms
            // collapse animation is preserved instead of wiped.
            setMulti((prev) => {
                if (prev.length === 0) {
                    return prev;
                }
                const next = prev.filter((id) => !idSet.has(id));
                return next.length === prev.length ? prev : next.length <= 1 ? [] : next;
            });
            setRemovingIds((prev) => {
                if (prev.size === 0) {
                    return prev;
                }
                const next = new Set(prev);
                freshIds.forEach((id) => next.delete(id));
                return next;
            });

            try {
                await performRemove();
            } catch (e) {
                freshIds.forEach((id) => pendingDeleteIdsRef.current.delete(id));
                reloadRef.current();
                throw e;
            }
        } finally {
            setRemovingIds((prev) => {
                let changed = false;
                for (const id of freshIds) {
                    if (prev.has(id)) {
                        changed = true;
                        break;
                    }
                }
                if (!changed) {
                    return prev;
                }
                const next = new Set(prev);
                freshIds.forEach((id) => next.delete(id));
                return next;
            });
            freshIds.forEach((id) => pendingDeleteIdsRef.current.delete(id));
        }
    }, []);

    // ───────────── actions ─────────────
    const doPaste = async (mode: PasteMode, id?: number) => {
        try {
            const ts = targets();
            if (explorerTarget && mode === 'auto') {
                const fileTargets = id !== undefined ? items.filter((x) => x.id === id) : ts;
                const fileIds = fileTargets.filter((x) => x.kind === 'file' || x.kind === 'image').map((x) => x.id);
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

    const doDelete = async (hard: boolean, explicitIds?: number[]) => {
        const ids = explicitIds ?? targets().map((x) => x.id);
        if (!ids.length) {
            return;
        }
        try {
            await animateAndRemoveCards(ids, async () => {
                if (tab !== null && !hard) {
                    await api.setPinboard(ids, null, tab, false);
                } else {
                    await api.deleteItems(ids);
                }
            });
            focusSearchQuietly();
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

    const newBoard = (assignIds?: number[], copyMode = true) => {
        setPrompt({
            title: t('New category'),
            placeholder: t('Name'),
            onSubmit: async (name) => {
                if (!name.trim()) {
                    return;
                }
                try {
                    const id = await api.createPinboard(name, BOARD_COLORS[boards.length % BOARD_COLORS.length]);
                    if (assignIds?.length) {
                        await api.setPinboard(assignIds, id, tab, copyMode);
                        showToast(
                            copyMode
                                ? t('Copied to {name}', { name: name.trim() })
                                : t('Moved to {name}', { name: name.trim() })
                        );
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
            !ts[0].pinned,
            tab
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

    /** Keyboard / drag / menu / toolbar reordering. Only meaningful when no search is active. */
    const reorder = useCallback(
        (id: number, target: number, after: boolean) => {
            if (query) {
                showToast(t('Clear the search to reorder items'));
                return;
            }
            followIdRef.current = id;
            api.moveItem(id, target, after, tab)
                .then(() => reloadRef.current())
                .catch(fail);
        },
        [query, tab, showToast, fail]
    );

    const moveCardStep = (it: ClipRow, dir: -1 | 1) => {
        if (query) {
            showToast(t('Clear the search to reorder items'));
            return;
        }
        const idx = items.findIndex((x) => x.id === it.id);
        if (idx < 0) {
            return;
        }
        const targetIdx = idx + dir;
        if (targetIdx < 0 || targetIdx >= items.length) {
            return;
        }
        reorder(it.id, items[targetIdx].id, dir > 0);
        setSel(targetIdx);
        anchor.current = targetIdx;
    };

    // Hit-test the closest visible card in the list by clientY so dragging over gaps, padding, or
    // RichView Shadow DOM still highlights and drops onto the exact target card without any dead zones.
    const updateCardDropMarkAtY = useCallback(
        (clientY: number) => {
            const activeDragId = dragId.current;
            if (activeDragId === null || query || !listRef.current) {
                return;
            }
            const cardEls = listRef.current.querySelectorAll<HTMLElement>('.card[data-card-id]');
            let bestId: number | null = null;
            let bestAfter = false;
            let bestDist = Infinity;

            cardEls.forEach((el) => {
                const cid = Number(el.dataset.cardId);
                if (!cid || cid === activeDragId) {
                    return;
                }
                const r = el.getBoundingClientRect();
                const mid = r.top + r.height / 2;
                let dist = 0;
                if (clientY < r.top) {
                    dist = r.top - clientY;
                } else if (clientY > r.bottom) {
                    dist = clientY - r.bottom;
                }
                if (dist < bestDist) {
                    bestDist = dist;
                    bestId = cid;
                    bestAfter = clientY > mid;
                }
            });

            if (bestId !== null && bestDist < 80) {
                const mark: DropMark = bestAfter ? 'after' : 'before';
                setDropMark((m) => (m && m.id === bestId && m.mark === mark ? m : { id: bestId!, mark }));
            }
        },
        [query]
    );

    // @dnd-kit-style Pointer Sensor for card dragging (eliminates browser 🚫 cursor and Shadow DOM dead zones)
    useEffect(() => {
        const onPointerMove = (e: PointerEvent) => {
            const st = pointerDragState.current;
            if (st.pendingId === null) {
                return;
            }
            const dx = e.clientX - st.startX;
            const dy = e.clientY - st.startY;
            if (!st.active) {
                if (Math.hypot(dx, dy) < 5) {
                    return;
                }
                st.active = true;
                st.justDragged = true;
                dragId.current = st.pendingId;
                setDragCount(st.count);
                setDraggingId(st.pendingId);
                document.body.classList.add('dragging-card');
            }
            e.preventDefault();
            setDragPos({ x: e.clientX, y: e.clientY });
            const ctrlNow = e.ctrlKey || e.metaKey;
            setDragCtrl((prev) => (prev === ctrlNow ? prev : ctrlNow));

            const tabsEl = tabsRef.current;
            if (tabsEl) {
                const tr = tabsEl.getBoundingClientRect();
                const insideTabs =
                    e.clientX >= tr.left - 4 &&
                    e.clientX <= tr.right + 4 &&
                    e.clientY >= tr.top - 6 &&
                    e.clientY <= tr.bottom + 8;
                setDragInTabs((prev) => (prev === insideTabs ? prev : insideTabs));

                if (insideTabs) {
                    setDropMark(null);
                    let hoveredBoard: number | null = null;
                    const tabBtns = tabsEl.querySelectorAll<HTMLElement>('.tab[data-board-id]');
                    tabBtns.forEach((btn) => {
                        const br = btn.getBoundingClientRect();
                        if (
                            e.clientX >= br.left &&
                            e.clientX <= br.right &&
                            e.clientY >= br.top &&
                            e.clientY <= br.bottom
                        ) {
                            const bid = Number(btn.dataset.boardId);
                            if (bid && bid !== tab) {
                                hoveredBoard = bid;
                            }
                        }
                    });
                    setDragOverTabId((prev) => (prev === hoveredBoard ? prev : hoveredBoard));
                    return;
                }
            }

            setDragInTabs(false);
            setDragOverTabId(null);

            // Auto-scroll list when dragging near top or bottom edge
            const lst = listRef.current;
            if (lst) {
                const lr = lst.getBoundingClientRect();
                const scrollTarget = lst;
                if (e.clientY >= lr.top && e.clientY < lr.top + 32) {
                    scrollTarget.scrollTop -= 8;
                } else if (e.clientY <= lr.bottom && e.clientY > lr.bottom - 32) {
                    scrollTarget.scrollTop += 8;
                }
                if (e.clientY >= lr.top - 10 && e.clientY <= lr.bottom + 10) {
                    updateCardDropMarkAtY(e.clientY);
                } else {
                    setDropMark(null);
                }
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            const st = pointerDragState.current;
            if (st.pendingId === null) {
                return;
            }
            const wasActive = st.active;
            const id = st.pendingId;
            st.pendingId = null;
            st.active = false;
            document.body.classList.remove('dragging-card');

            if (!wasActive) {
                return;
            }

            const targetBoardId = dragOverTabRef.current;
            const currentDropMark = dropMarkRef.current;

            dragId.current = null;
            setDraggingId(null);
            setDragInTabs(false);
            setDragOverTabId(null);
            setDropMark(null);

            window.setTimeout(() => {
                pointerDragState.current.justDragged = false;
            }, 40);

            if (targetBoardId !== null && targetBoardId !== tab) {
                const shouldCopy = tab === null || e.ctrlKey || e.metaKey || dragCtrlRef.current;
                const targetBoard = boards.find((b) => b.id === targetBoardId);
                const ids = multi.includes(id) ? multi : [id];
                api.setPinboard(ids, targetBoardId, tab, shouldCopy)
                    .then(() => {
                        if (!shouldCopy) {
                            setMulti([]);
                        }
                        if (targetBoard) {
                            showToast(
                                shouldCopy
                                    ? t('Copied to {name}', { name: targetBoard.name })
                                    : t('Moved to {name}', { name: targetBoard.name })
                            );
                        }
                    })
                    .catch(fail);
                return;
            }

            if (currentDropMark && currentDropMark.id !== id) {
                reorder(id, currentDropMark.id, currentDropMark.mark === 'after');
            }
        };

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            document.body.classList.remove('dragging-card');
        };
    }, [tab, boards, multi, reorder, updateCardDropMarkAtY, showToast, fail]);

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
            e.push({ label: t('Open link'), hint: 'Ctrl+O', onClick: () => api.openItem(it.id).catch(fail) });
        }
        if (it.kind === 'file') {
            e.push({ label: t('Open'), hint: 'Ctrl+O', onClick: () => api.openItem(it.id).catch(fail) });
            e.push({
                label: t('Show in Explorer'),
                onClick: () => {
                    api.revealItem(it.id, ids).catch(fail);
                },
            });
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
        e.push(
            {
                label: it.pinned ? t('Unpin from top') : t('Pin on top'),
                hint: 'Ctrl+P',
                onClick: () => togglePin(it),
            },
            {
                label: t('Move up'),
                icon: 'up',
                hint: 'Alt+↑',
                disabled: Boolean(query) || idx <= 0,
                onClick: () => moveCardStep(it, -1),
            },
            {
                label: t('Move down'),
                icon: 'chevronDown',
                hint: 'Alt+↓',
                disabled: Boolean(query) || idx < 0 || idx >= items.length - 1,
                onClick: () => moveCardStep(it, 1),
            }
        );
        const isMainTab = tab === null;
        const targetBoards = isMainTab ? boards : boards.filter((b) => b.id !== tab);
        e.push({
            header: true,
            staticCategoryCopy: isMainTab,
            dynamicCategoryMoveCopy: !isMainTab,
            label: isMainTab ? t('Copy to') : t('Move to'),
        });
        e.push({
            chips: [
                ...targetBoards.map((b) => ({
                    label: b.name,
                    color: b.color,
                    onClick: (ctrlPressed: boolean) => {
                        const shouldCopy = isMainTab || ctrlPressed;
                        api.setPinboard(ids, b.id, tab, shouldCopy)
                            .then(() => {
                                if (!shouldCopy) {
                                    setMulti([]);
                                }
                                showToast(
                                    shouldCopy
                                        ? t('Copied to {name}', { name: b.name })
                                        : t('Moved to {name}', { name: b.name })
                                );
                            })
                            .catch(fail);
                    },
                })),
                {
                    label: t('+ New Category'),
                    onClick: (ctrlPressed: boolean) => newBoard(ids, isMainTab || ctrlPressed),
                },
            ],
        });
        if (!isMainTab || it.pinboard_id) {
            e.push({
                label: t('Remove from category'),
                onClick: () => {
                    if (!isMainTab) {
                        doDelete(false, ids);
                    } else {
                        api.setPinboard(ids, null, tab, false).catch(fail);
                    }
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
                                .then((r) => showToast(r ? t('Action finished: new item') : t('Action finished')))
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
                    doDelete(true, ids);
                },
            });
        } else {
            e.push({
                label: ids.length > 1 ? t('Delete {n} items', { n: ids.length }) : t('Delete'),
                hint: 'Del',
                danger: true,
                onClick: () => {
                    doDelete(true, ids);
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
                    label: isAct ? t('Deactivate category') : t('Activate category (new copies go here)'),
                    onClick: () => {
                        if (settings) {
                            saveSettings({ ...settings, active_pinboard: isAct ? null : b.id });
                        }
                    },
                },
                { label: t('Category settings…'), onClick: () => setBoardDlg(b) },
                { sep: true },
                {
                    label: t('Erase history…'),
                    danger: true,
                    onClick: () => askErase(b),
                },
                {
                    label: t('Delete category…'),
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
    const onKey = (e: React.KeyboardEvent | KeyboardEvent) => {
        if (prompt || boardDlg || preview) {
            return;
        }
        if (e.key === 'Control') {
            setCtrl(true);
            setDragCtrl(true);
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

        // Keyboard context menu activation (Shift+F10 or ContextMenu / Applications key)
        if ((k === 'ContextMenu' || (e.shiftKey && k === 'F10')) && cur) {
            e.preventDefault();
            const cardEl = document.getElementById(`card-${cur.id}`);
            const rect = cardEl?.getBoundingClientRect();
            openMenu(cur, rect ? rect.left + 28 : 80, rect ? rect.top + 24 : 120);
            return;
        }

        const digit = ck ? digitOfKey(e) : null;
        if (digit !== null) {
            e.preventDefault();
            const id = visibleIds()[digit - 1];
            if (id !== undefined) {
                api.pasteItem(id, e.shiftKey ? 'plain' : 'auto').catch(fail);
            }
            return;
        }
        if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && cur) {
            e.preventDefault();
            moveCardStep(cur, k === 'ArrowUp' ? -1 : 1);
            return;
        }
        if (ck && (isKey(e, ']') || isKey(e, '['))) {
            e.preventDefault();
            switchTab(isKey(e, ']') ? 1 : -1);
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
            if (isKey(e, 'c') && !window.getSelection()?.toString()) {
                e.preventDefault();
                doCopy();
            } else if (isKey(e, 'o') && cur) {
                e.preventDefault();
                api.openItem(cur.id).catch(fail);
            } else if (isKey(e, 'r')) {
                e.preventDefault();
                renameItem();
            } else if (isKey(e, 'e') && cur) {
                e.preventDefault();
                openPreview(cur, true);
            } else if (isKey(e, 'n')) {
                e.preventDefault();
                newBoard();
            } else if (isKey(e, 'p')) {
                e.preventDefault();
                togglePin();
            } else if (isKey(e, 't')) {
                e.preventDefault();
                tagItem();
            } else if (isKey(e, 'i') && cur) {
                e.preventDefault();
                openPreview(cur, false, true);
            } else if (isKey(e, 'm')) {
                e.preventDefault();
                mergePrompt();
            } else if (isKey(e, ',')) {
                e.preventDefault();
                api.openSettings();
            }
        }
    };

    const onKeyRef = useRef(onKey);
    onKeyRef.current = onKey;

    // Fallback window keydown listener so if DOM focus ever lands on document.body (e.g. after deleting
    // an item or closing an overlay), ArrowUp / ArrowDown / Delete still navigate cleanly.
    useEffect(() => {
        const onGlobalKeyDown = (e: KeyboardEvent) => {
            const popupEl = document.querySelector('.popup');
            const active = document.activeElement;
            if (!popupEl || !active || !popupEl.contains(active)) {
                onKeyRef.current(e);
            }
        };
        window.addEventListener('keydown', onGlobalKeyDown);
        return () => {
            window.removeEventListener('keydown', onGlobalKeyDown);
        };
    }, []);

    const onCardClick = (it: ClipRow, e: React.MouseEvent) => {
        if (pointerDragState.current.justDragged) {
            return;
        }
        const idx = items.findIndex((i) => i.id === it.id);
        if (idx < 0) {
            return;
        }
        focusSearchQuietly();
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
                // Keep `sel` and `anchor` synchronized when toggling items: if deselecting shrinks
                // `multi` down to a single remaining item, collapse cleanly back to single-selection
                // on that remaining item so Delete can never target the deselected card.
                const base = multi.length ? multi : cur ? [cur.id] : [];
                const removing = base.includes(it.id);
                const next = removing ? base.filter((x) => x !== it.id) : [...base, it.id];
                if (next.length === 1) {
                    const onlyIdx = items.findIndex((i) => i.id === next[0]);
                    setMulti([]);
                    if (onlyIdx >= 0) {
                        setSel(onlyIdx);
                        anchor.current = onlyIdx;
                    }
                } else {
                    setMulti(next);
                    if (!removing || next.length === 0) {
                        setSel(idx);
                        anchor.current = idx;
                    }
                }
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
        pointerDragStart: (_: ClipRow, __: React.PointerEvent) => {},
        dragStart: (_: ClipRow, __: React.DragEvent) => {},
        dragOver: (_: ClipRow, __: boolean) => {},
        drop: (_: ClipRow, __: boolean, ___?: number) => {},
    });
    handlers.current = {
        click: onCardClick,
        doubleClick: onCardDoubleClick,
        menu: openMenu,
        pointerDragStart: (it, e) => {
            const count = multi.includes(it.id) && multi.length > 1 ? multi.length : 1;
            pointerDragState.current = {
                pendingId: it.id,
                startX: e.clientX,
                startY: e.clientY,
                active: false,
                justDragged: false,
                count,
            };
            setDragCtrl(e.ctrlKey || e.metaKey);
        },
        dragStart: (it, e) => {
            dragId.current = it.id;
            const count = multi.includes(it.id) && multi.length > 1 ? multi.length : 1;
            setDragCount(count);
            setDragPos({ x: e.clientX, y: e.clientY });
            setDragInTabs(false);
            setDragCtrl(e.ctrlKey || e.metaKey);
            setDraggingId(it.id);
            if (emptyDragRef.current) {
                e.dataTransfer.setDragImage(emptyDragRef.current, 0, 0);
            }
        },
        dragOver: (it, after) => {
            if (dragId.current === null || dragId.current === it.id || query) {
                return;
            }
            setDragInTabs(false);
            setDragOverTabId(null);
            setDropMark((m) =>
                m && m.id === it.id && m.mark === (after ? 'after' : 'before')
                    ? m
                    : { id: it.id, mark: after ? 'after' : 'before' }
            );
        },
        drop: (it, after, droppedId) => {
            const id = droppedId ?? dragId.current;
            dragId.current = null;
            setDraggingId(null);
            setDragInTabs(false);
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
    const stableMenu = useCallback((it: ClipRow, x: number, y: number) => handlers.current.menu(it, x, y), []);
    const stablePointerDragStart = useCallback(
        (it: ClipRow, e: React.PointerEvent) => handlers.current.pointerDragStart(it, e),
        []
    );
    const stableDragStart = useCallback((it: ClipRow, e: React.DragEvent) => handlers.current.dragStart(it, e), []);
    const stableDragOver = useCallback((it: ClipRow, after: boolean) => handlers.current.dragOver(it, after), []);
    const stableDrop = useCallback(
        (it: ClipRow, after: boolean, droppedId?: number) => handlers.current.drop(it, after, droppedId),
        []
    );
    const stableDragEnd = useCallback(() => {
        dragId.current = null;
        setDraggingId(null);
        setDragInTabs(false);
        setDragOverTabId(null);
        setDropMark(null);
    }, []);

    // ───────────── render ─────────────
    const s = settings;
    const lines = s?.card_lines ?? 4;
    const showThumbs = s?.show_thumbnails ?? true;
    const hlEnabled = s?.highlight_matches ?? true;
    // Show the side toolbar whenever toggled on, even on an empty list (item actions disable gracefully).
    const toolbar = Boolean(s?.show_toolbar);
    const showCounts = s?.show_pinboard_counts ?? true;
    const isCopyDrag = tab === null || dragCtrl;
    const accentCopyDrag = tab !== null && dragCtrl;
    const showDragPill = draggingId !== null && (dragInTabs || dragOverTabId !== null) && dragPos.x > -500;

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
            onPointerDragStart={stablePointerDragStart}
            onDragStart={stableDragStart}
            onDragOver={stableDragOver}
            onDrop={stableDrop}
            onDragEnd={stableDragEnd}
        />
    );

    const handleListDragOver = (e: React.DragEvent) => {
        if (dragId.current !== null) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragInTabs(false);
            setDragOverTabId(null);
            updateCardDropMarkAtY(e.clientY);
        }
    };

    const handleListDrop = (e: React.DragEvent) => {
        if (dragId.current !== null) {
            e.preventDefault();
            const id = Number(e.dataTransfer.getData('text/clip-id')) || dragId.current;
            const currentDropMark = dropMarkRef.current;
            dragId.current = null;
            setDraggingId(null);
            setDragInTabs(false);
            setDragOverTabId(null);
            setDropMark(null);
            if (id && currentDropMark && currentDropMark.id !== id) {
                reorder(id, currentDropMark.id, currentDropMark.mark === 'after');
            }
        }
    };

    return (
        <div
            className="popup"
            role="application"
            aria-label="ClipNest"
            tabIndex={-1}
            onKeyDown={onKey}
            onKeyUp={(e) => {
                if (e.key === 'Control') {
                    setCtrl(false);
                    setDragCtrl(false);
                }
            }}
        >
            {/* Screen-reader live region */}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {toast ||
                    t(res.total === 1 ? '{n} item' : '{n} items', {
                        n: num(res.total),
                    })}
            </div>

            {/* 1x1 transparent element used to suppress native static drag snapshot */}
            <div ref={emptyDragRef} className="drag-empty-img" aria-hidden />

            {/* Live floating drag pill — shown ONLY when dragging over the Category tabs area */}
            {showDragPill && (
                <div
                    className={`drag-ghost-pill live${isCopyDrag ? ' copy-mode' : ''}`}
                    style={{ left: `${dragPos.x + 14}px`, top: `${dragPos.y + 14}px` }}
                    aria-hidden
                >
                    <Icon name={isCopyDrag ? 'copy' : 'arrowRight'} size={13} />
                    {renderDragPillLabel(isCopyDrag, accentCopyDrag, dragCount)}
                </div>
            )}

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
                        aria-label={t('Plain-text mode (click to turn off)')}
                        data-tip={t('Plain-text mode (click to turn off)')}
                        onClick={() => api.togglePlain()}
                    >
                        {t('Plain text')}
                    </button>
                )}
                {status?.queue_active && (
                    <button type="button" className="chipbtn accent" onClick={() => api.queueToggle()}>
                        {status.queue_mode === 'basket' ? t('Drop Basket') : t('Queue')} {num(status.queue_len)}
                    </button>
                )}
                <span className="spacer" />
                <button
                    type="button"
                    className={`iconbtn pin-toggle${status?.popup_pinned ? ' pinned' : ''}`}
                    aria-pressed={Boolean(status?.popup_pinned)}
                    aria-label={status?.popup_pinned ? t('Unpin window') : t('Pin window on top')}
                    data-tip={status?.popup_pinned ? t('Unpin window') : t('Pin window on top')}
                    onClick={() => {
                        api.setPopupPinned(!(status?.popup_pinned ?? false)).catch(fail);
                    }}
                >
                    <Icon name="pin" />
                </button>
                <button
                    type="button"
                    className={`iconbtn toolbar-toggle${settings?.show_toolbar ? ' active' : ''}`}
                    aria-pressed={Boolean(settings?.show_toolbar)}
                    aria-label={t('Toggle side toolbar')}
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
                    aria-label={t('Paste queue / Drop Basket')}
                    data-tip={t('Paste queue / Drop Basket')}
                    onClick={() => api.queueToggle()}
                >
                    <Icon name="list" />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    aria-label={t('Settings (Ctrl+,)')}
                    data-tip={t('Settings (Ctrl+,)')}
                    onClick={() => api.openSettings()}
                >
                    <Icon name="gear" />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    aria-label={t('Close (Esc)')}
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
                    role="searchbox"
                    aria-label={t('Type to search your clipboard')}
                    aria-controls="clip-list"
                    aria-activedescendant={cur ? `card-${cur.id}` : undefined}
                    className="search-bare"
                    value={query}
                    spellCheck={false}
                    // An empty box follows the UI direction so the placeholder is aligned properly in RTL.
                    dir={query ? 'auto' : isRtl() ? 'rtl' : 'ltr'}
                    placeholder={smode === 'regex' ? t('Regular expression…') : t('Type to search your clipboard')}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        resetView();
                    }}
                />
                {query && (
                    <button
                        type="button"
                        className="iconbtn"
                        aria-label={t('Clear')}
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
                    aria-pressed={richOn}
                    aria-label={t('Switch between original style and plain text')}
                    data-tip={t('Switch between original style and plain text')}
                    onClick={toggleDisplayStyle}
                >
                    Aa
                </button>
                <button
                    type="button"
                    className={`mini${smode === 'regex' ? ' on' : ''}`}
                    aria-pressed={smode === 'regex'}
                    aria-label={t('Regular expression')}
                    data-tip={t('Regular expression')}
                    onClick={() => setSmode(smode === 'regex' ? 'smart' : 'regex')}
                >
                    .*
                </button>
                <button
                    type="button"
                    className={`mini${smode === 'fuzzy' ? ' on' : ''}`}
                    aria-pressed={smode === 'fuzzy'}
                    aria-label={t('Strict fuzzy: letters in order')}
                    data-tip={t('Strict fuzzy: letters in order')}
                    onClick={() => setSmode(smode === 'fuzzy' ? 'smart' : 'fuzzy')}
                >
                    ~
                </button>
            </div>

            <div
                ref={tabsRef}
                role="tablist"
                aria-label={t('Categories')}
                className={`tabs${wrapCategories ? ' wrap' : ''}${tabsGrabbing ? ' grabbing' : ''}${
                    tabsHasScroll ? ' has-scroll' : ''
                }`}
                onWheel={(e) => {
                    if (!wrapCategories && tabsRef.current && e.deltaY !== 0 && e.deltaX === 0) {
                        tabsRef.current.scrollLeft += isRtl(lang) ? -e.deltaY : e.deltaY;
                    }
                }}
                onMouseDown={(e) => {
                    if (!wrapCategories && e.button === 0 && tabsRef.current) {
                        tabDragState.current = {
                            active: true,
                            startX: e.clientX,
                            startScroll: tabsRef.current.scrollLeft,
                            moved: false,
                        };
                    }
                }}
                onClickCapture={(e) => {
                    if (tabDragState.current.moved) {
                        e.preventDefault();
                        e.stopPropagation();
                        tabDragState.current.moved = false;
                    }
                }}
                onDragEnter={() => {
                    if (draggingId !== null) {
                        setDragInTabs(true);
                    }
                }}
                onDragOver={(e) => {
                    if (draggingId !== null) {
                        e.preventDefault();
                        setDragInTabs(true);
                    }
                }}
                onDragLeave={(e) => {
                    const rel = e.relatedTarget as Node | null;
                    if (!rel || !e.currentTarget.contains(rel)) {
                        setDragInTabs(false);
                        setDragOverTabId(null);
                    }
                }}
            >
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === null}
                    aria-controls="clip-list"
                    className={`tab${tab === null ? ' active' : ''}`}
                    onClick={() => {
                        setTab(null);
                        resetView();
                        focusSearchQuietly();
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        openTabMenu(null, e.clientX, e.clientY);
                    }}
                >
                    <span>{t('Clipboard')}</span>
                </button>
                {boards.map((b) => {
                    const isDropTarget = dragOverTabId === b.id && tab !== b.id;
                    const isActiveTarget = settings?.active_pinboard === b.id;
                    const isCopyDrop = tab === null || dragCtrl;
                    const accentCopyDrop = tab !== null && dragCtrl;
                    return (
                        <button
                            key={b.id}
                            type="button"
                            role="tab"
                            data-board-id={b.id}
                            aria-selected={tab === b.id}
                            aria-controls="clip-list"
                            className={`tab${tab === b.id ? ' active' : ''}${isDropTarget ? ' drop-target' : ''}${
                                isActiveTarget ? ' active-board' : ''
                            }`}
                            data-tip={isActiveTarget ? t('Active category (new copies go here)') : undefined}
                            onClick={() => {
                                setTab(b.id);
                                resetView();
                                focusSearchQuietly();
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                openTabMenu(b, e.clientX, e.clientY);
                            }}
                            onDragEnter={(e) => {
                                e.preventDefault();
                                setDragInTabs(true);
                                if (tab !== b.id) {
                                    setDragOverTabId(b.id);
                                    setDragCtrl(e.ctrlKey || e.metaKey);
                                    setDropMark(null);
                                }
                            }}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDragInTabs(true);
                                const wantCopy = tab === null || e.ctrlKey || e.metaKey;
                                e.dataTransfer.dropEffect = wantCopy ? 'copy' : 'move';
                                if (dragCtrl !== (e.ctrlKey || e.metaKey)) {
                                    setDragCtrl(e.ctrlKey || e.metaKey);
                                }
                                if (tab !== b.id && dragOverTabId !== b.id) {
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
                                const shouldCopy = tab === null || e.ctrlKey || e.metaKey || dragCtrl;
                                setDragInTabs(false);
                                setDragOverTabId(null);
                                setDraggingId(null);
                                setDropMark(null);
                                const id = Number(e.dataTransfer.getData('text/clip-id')) || dragId.current;
                                dragId.current = null;
                                if (id && tab !== b.id) {
                                    const ids = multi.includes(id) ? multi : [id];
                                    api.setPinboard(ids, b.id, tab, shouldCopy)
                                        .then(() => {
                                            if (!shouldCopy) {
                                                setMulti([]);
                                            }
                                            showToast(
                                                shouldCopy
                                                    ? t('Copied to {name}', { name: b.name })
                                                    : t('Moved to {name}', { name: b.name })
                                            );
                                        })
                                        .catch(fail);
                                }
                            }}
                        >
                            {isDropTarget ? (
                                <Icon name={isCopyDrop ? 'copy' : 'arrowRight'} size={12} />
                            ) : (
                                <span
                                    className={`dot${isActiveTarget ? ' pulse' : ''}`}
                                    style={{ background: b.color }}
                                />
                            )}
                            {isDropTarget ? (
                                renderDropTabLabel(isCopyDrop, accentCopyDrop, b.name)
                            ) : (
                                <span>{b.name}</span>
                            )}
                            {showCounts && b.count > 0 && !isDropTarget && (
                                <span className="tab-count">{num(b.count)}</span>
                            )}
                        </button>
                    );
                })}
                <button
                    type="button"
                    className="tab plus"
                    aria-label={t('New category (Ctrl+N)')}
                    data-tip={t('New category (Ctrl+N)')}
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
                        aria-label={t('Clear')}
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
                <div
                    id="clip-list"
                    role="listbox"
                    aria-label={t('Clipboard')}
                    aria-multiselectable="true"
                    className={`list${draggingId !== null ? ' is-dragging-card' : ''}`}
                    ref={listRef}
                    onDragOver={handleListDragOver}
                    onDrop={handleListDrop}
                >
                    {res.error && <div className="empty err">{res.error}</div>}
                    {!res.error && items.length === 0 && (
                        <div className="empty">
                            {query
                                ? t('Nothing found')
                                : tab === null
                                  ? t('Nothing copied yet')
                                  : t('This category is empty — drag cards onto its tab')}
                        </div>
                    )}
                    {!res.error &&
                        items.map((it, i) => (
                            <div key={it.id} className={`card-slot${removingIds.has(it.id) ? ' removing' : ''}`}>
                                <div className="card-slot-inner">{renderCard(it, i)}</div>
                            </div>
                        ))}
                    {!res.error && hasMoreItems && (
                        <div ref={loadMoreRef} className="list-sentinel" aria-hidden="true" />
                    )}
                </div>

                {toolbar && (
                    <div className="toolbar" role="toolbar" aria-label={t('Actions')}>
                        <button
                            type="button"
                            aria-label={t('Preview')}
                            data-tip={t('Preview')}
                            disabled={!cur}
                            onClick={() => openPreview()}
                        >
                            <Icon name="eye" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Pin on top')}
                            data-tip={t('Pin on top')}
                            disabled={!cur}
                            onClick={() => togglePin()}
                        >
                            <Icon name="pin" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Move up (Alt+↑)')}
                            data-tip={t('Move up (Alt+↑)')}
                            disabled={!cur || Boolean(query) || sel <= 0}
                            onClick={() => cur && moveCardStep(cur, -1)}
                        >
                            <Icon name="up" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Move down (Alt+↓)')}
                            data-tip={t('Move down (Alt+↓)')}
                            disabled={!cur || Boolean(query) || sel >= items.length - 1}
                            onClick={() => cur && moveCardStep(cur, 1)}
                        >
                            <Icon name="chevronDown" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Tags…')}
                            data-tip={t('Tags…')}
                            disabled={!cur}
                            onClick={() => tagItem()}
                        >
                            <Icon name="tag" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Copy')}
                            data-tip={t('Copy')}
                            disabled={!cur}
                            onClick={() => doCopy()}
                        >
                            <Icon name="copy" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Formats (MIME inspector)')}
                            data-tip={t('Formats (MIME inspector)')}
                            disabled={!cur}
                            onClick={() => cur && openPreview(cur, false, true)}
                        >
                            <Icon name="info" size={16} />
                        </button>
                        {(!cur || (cur.kind !== 'image' && cur.kind !== 'file')) && (
                            <button
                                type="button"
                                aria-label={t('Edit…')}
                                data-tip={t('Edit…')}
                                disabled={!cur}
                                onClick={() => cur && openPreview(cur, true)}
                            >
                                <Icon name="edit" size={16} />
                            </button>
                        )}
                        <button
                            type="button"
                            aria-label={t('Merge selected')}
                            data-tip={t('Merge selected')}
                            disabled={!cur}
                            onClick={mergePrompt}
                        >
                            <Icon name="merge" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Actions')}
                            data-tip={t('Actions')}
                            disabled={!cur}
                            onClick={(e) => cur && openMenu(cur, e.clientX, e.clientY)}
                        >
                            <Icon name="bolt" size={16} />
                        </button>
                        <button
                            type="button"
                            aria-label={t('Delete')}
                            data-tip={t('Delete')}
                            className="danger"
                            disabled={!cur}
                            onClick={() => doDelete(false)}
                        >
                            <Icon name="trash" size={16} />
                        </button>
                    </div>
                )}
            </div>

            <footer className="foot">
                <span className="foot-count">
                    {t(res.total === 1 ? '{n} item' : '{n} items', { n: num(res.total) })}
                    {multi.length > 1 ? ` · ${t('{n} selected', { n: num(multi.length) })}` : ''}
                </span>
                <button
                    type="button"
                    className="iconbtn erase"
                    aria-label={t('Erase history…')}
                    data-tip={t('Erase history…')}
                    onClick={() => askErase()}
                >
                    <Icon name="trash" size={13} />
                </button>
                <span className="spacer" />
                <span className="hints">
                    <span className="hint-item">
                        <kbd>↵</kbd>
                        <span>{t('Paste')}</span>
                    </span>
                    <span className="hint-item">
                        <kbd>⇧↵</kbd>
                        <span>{cur?.kind === 'file' ? t('File path') : t('Plain text')}</span>
                    </span>
                    <span className="hint-item">
                        <kbd>Del</kbd>
                        <span>{tab === null ? t('Delete') : t('Remove')}</span>
                    </span>
                </span>
            </footer>

            {toast && <div className="toast">{toast}</div>}
            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    entries={menu.entries}
                    initialCtrl={ctrl}
                    onClose={() => setMenu(null)}
                />
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
