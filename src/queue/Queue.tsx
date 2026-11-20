import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
    api,
    BasketRow,
    ClipRow,
    errText,
    on,
    onPayload,
    Settings,
    Status,
    TransferProgress,
    TransferReport,
} from '../lib/api';
import { allCut, BasketNode, groupBasketRows, progressPercent } from '../lib/basket';
import { basename } from '../lib/format';
import { Icon } from '../lib/icons';
import { num, t, useLang } from '../lib/i18n';
import { useSettings } from '../lib/useSettings';

// ───────────── native (Explorer) icons, cached per path ─────────────
const iconCache = new Map<string, Promise<string | null>>();

function loadIcon(path: string): Promise<string | null> {
    let p = iconCache.get(path);
    if (!p) {
        p = api.basketFileIcon(path).catch(() => null);
        iconCache.set(path, p);
    }
    return p;
}

/** The icon Windows Explorer shows for the path; falls back to a distinct folder or file glyph. */
function NativeIcon({ path, isDir }: { path: string | null; isDir: boolean }) {
    const [src, setSrc] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        setSrc(null);
        if (path) {
            loadIcon(path).then((u) => {
                if (alive) {
                    setSrc(u);
                }
            });
        }
        return () => {
            alive = false;
        };
    }, [path]);
    if (src) {
        return <img className="nicon" src={src} alt="" draggable={false} />;
    }
    return (
        <span className="nicon nicon-fallback">
            <Icon name={isDir ? 'folder' : 'file'} size={18} />
        </span>
    );
}

const ERROR_TEXT: Record<string, string> = {
    source_missing: 'The source no longer exists',
    invalid_path: 'Invalid path',
    dest_inside_source: 'The destination is inside the folder being copied',
    dest_create: 'Cannot create the destination folder',
    image_missing: 'Image data not found',
    copy_failed: 'Copy failed',
    reverify_failed: 'The copy could not be re-verified, so the original was left untouched',
    cut_not_removed: 'Copied successfully, but the original could not be removed',
};

/**
 * Handles keyboard interaction for expandable folder group headers in basket view.
 * Ensures Enter/Space activates group expansion, unless the event originated
 * from a nested interactive element (e.g. action buttons inside the header).
 */
export function handleFolderHeaderKeyDown(e: React.KeyboardEvent | KeyboardEvent, toggle: () => void): void {
    if ((e.target as HTMLElement | null)?.closest('button')) {
        return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
    }
}

export default function QueueView() {
    useLang();
    const [s, save] = useSettings();
    const [status, setStatus] = useState<Status | null>(null);
    const [items, setItems] = useState<ClipRow[]>([]);
    const [rows, setRows] = useState<BasketRow[]>([]);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [transfer, setTransfer] = useState<TransferProgress | null>(null);
    const [report, setReport] = useState<TransferReport | null>(null);
    const [toast, setToast] = useState('');
    const readySent = useRef(false);
    const loadSeq = useRef(0);
    const toastTimer = useRef<number | undefined>(undefined);
    const reportHandled = useRef(false);
    const transferActive = transfer !== null;

    const flash = useCallback((m: string) => {
        setToast(m);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(''), 2800);
    }, []);

    const load = useCallback(() => {
        const seq = ++loadSeq.current;
        api.status()
            .then(async (st) => {
                if (seq !== loadSeq.current) {
                    return;
                }
                setStatus(st);
                if (st.queue_mode === 'basket') {
                    const nextRows = await api.basketGet();
                    if (seq === loadSeq.current) {
                        setRows(nextRows);
                    }
                } else {
                    const nextItems = await api.queueGet();
                    if (seq === loadSeq.current) {
                        setItems(nextItems);
                    }
                }
            })
            .catch(() => {});
    }, []);

    const handleReport = useCallback(
        (r: TransferReport) => {
            if (reportHandled.current) return;
            reportHandled.current = true;
            setTransfer(null);
            if (r.failed.length > 0) {
                setReport(r);
            } else if (r.done > 0) {
                flash(t('Transferred {n} item(s) to folder', { n: num(r.done) }));
            }
            load();
        },
        [flash, load]
    );

    useEffect(() => {
        load();
        const subs = [
            on('queue-changed', load),
            on('status-changed', load),
            onPayload<TransferProgress>('basket-progress', (p) => {
                reportHandled.current = false;
                setTransfer(p);
            }),
            onPayload<TransferReport>('basket-finished', (r) => {
                // Consume any stored report on the backend so the polling fallback does not show it twice.
                api.basketTransferStatus().catch(() => {});
                handleReport(r);
            }),
        ];
        // The window is created hidden; tell the backend once the first frame exists so it can show it
        // (no black flash while the page loads).
        if (!readySent.current) {
            readySent.current = true;
            window.setTimeout(() => {
                api.queueReady().catch(() => {});
            }, 60);
        }
        return () => {
            subs.forEach((p) => p.then((u) => u()));
        };
    }, [load, flash, handleReport]);

    const mode = status?.queue_mode ?? 'queue';
    const fifo = s?.queue_fifo ?? true;
    const allowCut = s?.basket_allow_cut ?? true;
    const groupByFolder = s?.basket_group_by_folder ?? true;
    const busy = transfer !== null;

    const flip = () => {
        if (s) {
            save({ ...s, queue_fifo: !fifo } as Settings);
        }
    };

    const switchMode = (next: 'queue' | 'basket') => {
        api.queueSetMode(next)
            .then(load)
            .catch(() => {});
    };

    const onPasteHere = async () => {
        try {
            const n = await api.basketPasteHere();
            if (n > 0) {
                flash(t('Pasted {n} item(s)', { n: num(n) }));
            }
        } catch (e) {
            flash(errText(e));
        }
    };

    // Fallback polling while a transfer is active so the progress bar never gets stuck even if an
    // event arrives before the invoke resolves or is coalesced by WebView2.
    useEffect(() => {
        if (!transferActive) {
            return;
        }
        let alive = true;
        const timer = window.setInterval(() => {
            api.basketTransferStatus()
                .then((st) => {
                    if (!alive) {
                        return;
                    }
                    if (st.report) {
                        handleReport(st.report);
                    } else if (st.busy && st.progress) {
                        setTransfer(st.progress);
                    } else if (!st.busy) {
                        setTransfer(null);
                        load();
                    }
                })
                .catch(() => {});
        }, 120);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [transferActive, handleReport, load]);

    const onPasteToFolder = async () => {
        reportHandled.current = false;
        try {
            const n = await api.basketPasteToFolder();
            if (n !== null && n > 0) {
                const st = await api.basketTransferStatus();
                if (st.report) {
                    handleReport(st.report);
                } else if (st.busy) {
                    setTransfer(
                        st.progress ?? { done: 0, failed: 0, total: n, current: '', fraction: 0, phase: 'copy' }
                    );
                }
            }
        } catch (e) {
            setTransfer(null);
            flash(errText(e));
        }
    };

    const toggleGroup = (key: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });

    const reveal = (paths: (string | null)[]) => {
        api.revealPaths(paths.filter((p): p is string => !!p)).catch((e) => flash(errText(e)));
    };

    const listItems = mode === 'queue' ? (fifo ? items : [...items].reverse()) : items;
    const nodes: BasketNode[] = groupBasketRows(rows, groupByFolder);
    const count = mode === 'basket' ? rows.length : listItems.length;

    const cutBadge = (keys: string[], cut: boolean) =>
        allowCut ? (
            <button
                type="button"
                className={`cut-badge${cut ? ' cut' : ' copy'}`}
                aria-label={t('Click to toggle between Copy and Cut')}
                data-tip={t('Click to toggle between Copy and Cut')}
                onClick={() => api.basketSetCut(keys, !cut).then(load)}
            >
                {cut ? t('CUT') : t('COPY')}
            </button>
        ) : null;

    const renderRow = (r: BasketRow, inGroup: boolean) => {
        if (r.kind === 'image') {
            return (
                <div key={r.key} role="listitem" className="brow">
                    <span className="nicon nicon-fallback" aria-hidden>
                        🖼
                    </span>
                    <div className="bmain">
                        <div className="bname" dir="auto">
                            {`${t('image')} ${num(r.img_w ?? 0)}×${num(r.img_h ?? 0)}`}
                        </div>
                    </div>
                    <button
                        type="button"
                        className="iconbtn"
                        aria-label={t('Remove')}
                        data-tip={t('Remove')}
                        onClick={() => api.basketRemoveKeys([r.key]).then(load)}
                    >
                        <Icon name="close" size={11} />
                    </button>
                </div>
            );
        }
        const loc = r.is_dir ? t('Open folder location') : t('Open file location');
        const fullPath = r.path ?? r.parent ?? '';
        return (
            <div
                key={r.key}
                role="listitem"
                className={`brow${inGroup ? ' in-group' : ''}${r.exists ? '' : ' missing'}`}
            >
                <NativeIcon path={r.path} isDir={r.is_dir} />
                <div className="bmain">
                    <div className="bname" dir="auto" data-tip={r.name}>
                        {r.name}
                    </div>
                    {fullPath && (
                        <div className="bpath" dir="ltr" data-tip={fullPath}>
                            {fullPath}
                        </div>
                    )}
                    {!r.exists && <div className="bwarn">{t('The source no longer exists')}</div>}
                </div>
                {cutBadge([r.key], r.cut)}
                <button
                    type="button"
                    className="iconbtn"
                    aria-label={loc}
                    data-tip={loc}
                    onClick={() => reveal([r.path])}
                >
                    <Icon name="folderSymlink" size={13} />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    aria-label={t('Remove')}
                    data-tip={t('Remove')}
                    onClick={() => api.basketRemoveKeys([r.key]).then(load)}
                >
                    <Icon name="close" size={11} />
                </button>
            </div>
        );
    };

    const renderGroup = (g: Extract<BasketNode, { type: 'group' }>) => {
        const open = expanded.has(g.key);
        const keys = g.rows.map((r) => r.key);
        return (
            <div key={`g-${g.key}`} role="listitem" className={`bgroup${open ? ' open' : ''}`}>
                <div
                    className="brow bghead"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.key)}
                    onKeyDown={(e) => handleFolderHeaderKeyDown(e, () => toggleGroup(g.key))}
                >
                    <span className="bchev">
                        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                    </span>
                    <NativeIcon path={g.parent} isDir />
                    <div className="bmain">
                        <div className="bname" dir="auto" data-tip={g.name}>
                            {t('in {name}', { name: g.name })}
                        </div>
                        <div className="bpath" dir="ltr" data-tip={g.parent}>
                            {g.parent}
                        </div>
                    </div>
                    <span className="bcount" data-tip={t('{n} item(s)', { n: num(g.rows.length) })}>
                        {num(g.rows.length)}
                    </span>
                    <span onClick={(e) => e.stopPropagation()} className="bcut-wrap">
                        {cutBadge(keys, allCut(g.rows))}
                    </span>
                    <button
                        type="button"
                        className="iconbtn"
                        aria-label={t('Open folder location')}
                        data-tip={t('Open folder location')}
                        onClick={(e) => {
                            e.stopPropagation();
                            reveal(g.rows.map((r) => r.path));
                        }}
                    >
                        <Icon name="folderSymlink" size={13} />
                    </button>
                    <button
                        type="button"
                        className="iconbtn"
                        aria-label={t('Remove')}
                        data-tip={t('Remove')}
                        onClick={(e) => {
                            e.stopPropagation();
                            api.basketRemoveKeys(keys).then(load);
                        }}
                    >
                        <Icon name="close" size={11} />
                    </button>
                </div>
                {open && <div className="bgroup-body">{g.rows.map((r) => renderRow(r, true))}</div>}
            </div>
        );
    };

    return (
        <div className="queue" role="region" aria-label={t('Paste queue / Drop Basket')}>
            <header
                className="head"
                onMouseDown={(e) => {
                    if (e.button === 0 && !(e.target as HTMLElement).closest('button, input, a, .seg-switch')) {
                        getCurrentWindow()
                            .startDragging()
                            .catch(() => {});
                    }
                }}
            >
                <img className="logo-img" src="/icon.png" alt="ClipNest" draggable={false} />
                <div className="seg-switch" role="tablist" aria-label={t('Paste queue / Drop Basket')}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'queue'}
                        className={`seg-btn${mode === 'queue' ? ' active' : ''}`}
                        onClick={() => switchMode('queue')}
                    >
                        {t('Queue')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'basket'}
                        className={`seg-btn${mode === 'basket' ? ' active' : ''}`}
                        onClick={() => switchMode('basket')}
                    >
                        {t('Drop Basket')}
                    </button>
                </div>
                <span className="spacer" />
                {mode === 'queue' && (
                    <button
                        type="button"
                        className="mini"
                        aria-label={t('Order (click to reverse)')}
                        data-tip={t('Order (click to reverse)')}
                        onClick={flip}
                    >
                        {fifo ? 'FIFO ↓' : 'LIFO ↑'}
                    </button>
                )}
                <button
                    type="button"
                    className="iconbtn"
                    aria-label={t('Clear')}
                    data-tip={t('Clear')}
                    disabled={busy}
                    onClick={() => api.queueClear()}
                >
                    <Icon name="trash" />
                </button>
                <button
                    type="button"
                    className="iconbtn"
                    aria-label={t('Close queue')}
                    data-tip={t('Close queue')}
                    onClick={() => api.queueToggle()}
                >
                    <Icon name="close" />
                </button>
            </header>

            <div className="qlist" role="list">
                {count === 0 && mode === 'queue' && (
                    <div className="empty small">
                        {t('Copy something — it is added here.')}
                        <br />
                        {t('Then press Ctrl+V repeatedly to paste in order.')}
                    </div>
                )}
                {count === 0 && mode === 'basket' && (
                    <div className="empty small">
                        {t('Basket is empty — copy files in Explorer or images in your browser.')}
                        <br />
                        <span className="muted">
                            {t('Only files and images are collected here (plain text copies are ignored).')}
                        </span>
                    </div>
                )}
                {mode === 'queue' &&
                    listItems.map((it, i) => {
                        const firstLine = it.preview.split('\n')[0] || '';
                        return (
                            <div key={`${it.id}-${i}`} role="listitem" className={`qrow${i === 0 ? ' next' : ''}`}>
                                <span className="qn">{num(i + 1)}</span>
                                <span className="qtext" dir="auto">
                                    {it.kind === 'image'
                                        ? `🖼 ${t('image')} ${num(it.img_w ?? 0)}×${num(it.img_h ?? 0)}`
                                        : it.kind === 'file'
                                          ? `📄 ${basename(firstLine)}${
                                                (it.file_count ?? 1) > 1 ? ` (+${num((it.file_count ?? 1) - 1)})` : ''
                                            }`
                                          : it.preview.replace(/\s+/g, ' ').slice(0, 80)}
                                </span>
                                <button
                                    type="button"
                                    className="iconbtn"
                                    aria-label={t('Remove')}
                                    data-tip={t('Remove')}
                                    onClick={() => api.queueRemove(it.id)}
                                >
                                    <Icon name="close" size={11} />
                                </button>
                            </div>
                        );
                    })}
                {mode === 'basket' && nodes.map((n) => (n.type === 'group' ? renderGroup(n) : renderRow(n.row, false)))}
            </div>

            {mode === 'basket' && transfer && (
                <div className="bprog" role="status" aria-live="polite">
                    <div className="bprog-top">
                        <span>{transfer.phase === 'finalize' ? t('Finishing…') : t('Pasting…')}</span>
                        <span className="bprog-count" dir="ltr">
                            {num(transfer.done)}/{num(transfer.total)}
                        </span>
                    </div>
                    <div
                        className="bprog-bar"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progressPercent(transfer)}
                    >
                        <div className="bprog-fill" style={{ width: `${progressPercent(transfer)}%` }} />
                    </div>
                    <div className="bprog-cur" dir="auto">
                        {transfer.failed > 0 && (
                            <span className="bprog-fail">{t('{n} failed', { n: num(transfer.failed) })} · </span>
                        )}
                        {transfer.current}
                    </div>
                </div>
            )}

            {mode === 'basket' && (
                <footer className="qfoot">
                    <button type="button" className="btn" disabled={count === 0 || busy} onClick={onPasteHere}>
                        {t('Paste All Here')}
                    </button>
                    <button
                        type="button"
                        className="btn primary"
                        disabled={count === 0 || busy}
                        onClick={onPasteToFolder}
                    >
                        <Icon name="folder" size={13} /> {t('Paste All to Folder…')}
                    </button>
                </footer>
            )}

            {report && (
                <div className="qmodal-back" role="presentation">
                    <div className="qmodal" role="alertdialog" aria-modal="true" aria-label={t('Some items failed')}>
                        <div className="qmodal-head">
                            <Icon name="warning" size={16} />
                            <strong>
                                {t('{failed} of {total} item(s) could not be pasted', {
                                    failed: num(report.failed.length),
                                    total: num(report.total),
                                })}
                            </strong>
                        </div>
                        <div className="qmodal-note">
                            {report.cut_skipped && <p>{t('Because of the errors, no original file was deleted.')}</p>}
                            {report.done > 0 && (
                                <p className="muted">
                                    {t('{n} item(s) were copied successfully and stay in the destination folder.', {
                                        n: num(report.done),
                                    })}
                                </p>
                            )}
                        </div>
                        <div className="qmodal-list" role="list">
                            {report.failed.map((f) => {
                                const loc = f.is_dir ? t('Open folder location') : t('Open file location');
                                return (
                                    <div key={f.key} role="listitem" className="brow failed">
                                        <NativeIcon path={f.exists ? f.path : null} isDir={f.is_dir} />
                                        <div className="bmain">
                                            <div className="bname" dir="auto" data-tip={f.path ?? f.name}>
                                                {f.name}
                                            </div>
                                            {f.path && (
                                                <div className="bpath" dir="ltr" data-tip={f.path}>
                                                    {f.path}
                                                </div>
                                            )}
                                            <div className="bwarn" dir="auto" data-tip={f.reason || undefined}>
                                                {t(ERROR_TEXT[f.code] ?? 'Copy failed')}
                                                {f.reason ? `: ${f.reason}` : ''}
                                            </div>
                                        </div>
                                        {f.path && (
                                            <button
                                                type="button"
                                                className="iconbtn"
                                                aria-label={loc}
                                                data-tip={loc}
                                                onClick={() => reveal([f.path])}
                                            >
                                                <Icon name="folderSymlink" size={13} />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <div className="qmodal-foot">
                            <button type="button" className="btn primary" onClick={() => setReport(null)}>
                                {t('Close')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {toast && (
                <div className="toast" role="status" aria-live="polite">
                    {toast}
                </div>
            )}
        </div>
    );
}
