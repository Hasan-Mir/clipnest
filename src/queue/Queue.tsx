import React, { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, ClipRow, errText, on, Settings, Status } from '../lib/api';
import { basename } from '../lib/format';
import { Icon } from '../lib/icons';
import { t, useLang } from '../lib/i18n';
import { useSettings } from '../lib/useSettings';

export default function QueueView() {
    useLang();
    const [s, save] = useSettings();
    const [status, setStatus] = useState<Status | null>(null);
    const [items, setItems] = useState<ClipRow[]>([]);
    const [toast, setToast] = useState('');

    const flash = (m: string) => {
        setToast(m);
        window.setTimeout(() => setToast(''), 2800);
    };

    const load = useCallback(() => {
        api.queueGet()
            .then(setItems)
            .catch(() => {});
        api.status()
            .then(setStatus)
            .catch(() => {});
    }, []);

    useEffect(() => {
        load();
        const p1 = on('queue-changed', load);
        const p2 = on('status-changed', load);
        return () => {
            p1.then((u) => u());
            p2.then((u) => u());
        };
    }, [load]);

    const mode = status?.queue_mode ?? 'queue';
    const fifo = s?.queue_fifo ?? true;
    const allowCut = s?.basket_allow_cut ?? true;

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
                flash(t('Pasted {n} item(s)', { n }));
            }
        } catch (e) {
            flash(errText(e));
        }
    };

    const onPasteToFolder = async () => {
        try {
            const n = await api.basketPasteToFolder();
            if (n !== null && n > 0) {
                flash(t('Transferred {n} item(s) to folder', { n }));
            }
        } catch (e) {
            flash(errText(e));
        }
    };

    const listItems = mode === 'queue' ? (fifo ? items : [...items].reverse()) : items;

    return (
        <div className="queue">
            <header
                className="head"
                onMouseDown={(e) => {
                    if (
                        e.button === 0 &&
                        !(e.target as HTMLElement).closest('button, input, a, .seg-switch')
                    ) {
                        getCurrentWindow()
                            .startDragging()
                            .catch(() => {});
                    }
                }}
            >
                <img className="logo-img" src="/icon.png" alt="ClipNest" draggable={false} />
                <div className="seg-switch">
                    <button
                        type="button"
                        className={`seg-btn${mode === 'queue' ? ' active' : ''}`}
                        onClick={() => switchMode('queue')}
                    >
                        {t('Queue')}
                    </button>
                    <button
                        type="button"
                        className={`seg-btn${mode === 'basket' ? ' active' : ''}`}
                        onClick={() => switchMode('basket')}
                    >
                        {t('Drop Basket')}
                    </button>
                </div>
                <span className="spacer" />
                {mode === 'queue' && (
                    <button className="mini" data-tip={t('Order (click to reverse)')} onClick={flip}>
                        {fifo ? 'FIFO ↓' : 'LIFO ↑'}
                    </button>
                )}
                <button className="iconbtn" data-tip={t('Clear')} onClick={() => api.queueClear()}>
                    <Icon name="trash" />
                </button>
                <button className="iconbtn" data-tip={t('Close queue')} onClick={() => api.queueToggle()}>
                    <Icon name="close" />
                </button>
            </header>

            <div className="qlist">
                {listItems.length === 0 && mode === 'queue' && (
                    <div className="empty small">
                        {t('Copy something — it is added here.')}
                        <br />
                        {t('Then press Ctrl+V repeatedly to paste in order.')}
                    </div>
                )}
                {listItems.length === 0 && mode === 'basket' && (
                    <div className="empty small">
                        {t('Basket is empty — copy files in Explorer or images in your browser.')}
                        <br />
                        <span className="muted">
                            {t('Only files and images are collected here (plain text copies are ignored).')}
                        </span>
                    </div>
                )}
                {listItems.map((it, i) => {
                    const firstLine = it.preview.split('\n')[0] || '';
                    return (
                        <div
                            key={`${it.id}-${i}`}
                            className={`qrow${mode === 'queue' && i === 0 ? ' next' : ''}`}
                        >
                            <span className="qn">{i + 1}</span>
                            <span className="qtext" dir="auto">
                                {it.kind === 'image'
                                    ? `🖼 ${t('image')} ${it.img_w ?? 0}×${it.img_h ?? 0}`
                                    : it.kind === 'file'
                                      ? `📄 ${basename(firstLine)}${
                                            (it.file_count ?? 1) > 1 ? ` (+${(it.file_count ?? 1) - 1})` : ''
                                        }`
                                      : it.preview.replace(/\s+/g, ' ').slice(0, 80)}
                            </span>
                            {mode === 'basket' && it.kind === 'file' && allowCut && (
                                <button
                                    type="button"
                                    className={`cut-badge${it.cut ? ' cut' : ' copy'}`}
                                    data-tip={t('Click to toggle between Copy and Cut')}
                                    onClick={() => api.basketToggleCut(it.id)}
                                >
                                    {it.cut ? 'CUT' : 'COPY'}
                                </button>
                            )}
                            <button
                                className="iconbtn"
                                data-tip={t('Remove')}
                                onClick={() => api.queueRemove(it.id)}
                            >
                                <Icon name="close" size={11} />
                            </button>
                        </div>
                    );
                })}
            </div>

            {mode === 'basket' && (
                <footer className="qfoot">
                    <button
                        type="button"
                        className="btn"
                        disabled={listItems.length === 0}
                        onClick={onPasteHere}
                    >
                        {t('Paste All Here')}
                    </button>
                    <button
                        type="button"
                        className="btn primary"
                        disabled={listItems.length === 0}
                        onClick={onPasteToFolder}
                    >
                        <Icon name="folder" size={13} /> {t('Paste All to Folder…')}
                    </button>
                </footer>
            )}

            {toast && <div className="toast">{toast}</div>}
        </div>
    );
}
