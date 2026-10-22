import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ClipRow, FormatMeta, errText } from '../lib/api';
import { basename, colorFormats, hostOf, humanSize, relTime } from '../lib/format';
import { highlightText, SearchMode } from '../lib/highlightMatch';
import { num, t, useLang } from '../lib/i18n';
import { Icon } from '../lib/icons';
import { RichView, forgetHtml } from './RichView';

interface Props {
    item: ClipRow;
    startEdit: boolean;
    startFormats: boolean;
    /** true = show the original styling when the clip has any */
    richDefault: boolean;
    autoSaveEdit: boolean;
    query: string;
    searchMode: SearchMode;
    highlight: boolean;
    onClose: () => void;
    onPaste: (id: number, mode: 'auto' | 'plain' | 'rich') => void;
    onToast: (s: string) => void;
}

const MAX_LINES = 3000;

export function Preview({
    item,
    startEdit,
    startFormats,
    richDefault,
    autoSaveEdit,
    query,
    searchMode,
    highlight,
    onClose,
    onPaste,
    onToast,
}: Props) {
    const lang = useLang();
    const [text, setText] = useState<string | null>(null);
    const [img, setImg] = useState<string | null>(null);
    const [formats, setFormats] = useState<FormatMeta[] | null>(null);
    const [showFormats, setShowFormats] = useState(startFormats);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [autoSaved, setAutoSaved] = useState(false);
    const [styled, setStyled] = useState(richDefault);
    const root = useRef<HTMLDivElement>(null);
    const autoSaveTimer = useRef<number | undefined>(undefined);
    const editable = item.kind !== 'image' && item.kind !== 'file';
    const canStyle = item.has_rich && (item.kind === 'text' || item.kind === 'code');

    useEffect(() => {
        root.current?.focus();
        setAutoSaved(false);
        if (item.kind === 'image') {
            api.getImage(item.id)
                .then(setImg)
                .catch(() => {});
        } else {
            api.getText(item.id)
                .then((x) => {
                    setText(x);
                    if (startEdit && editable) {
                        setDraft(x);
                        setEditing(true);
                    }
                })
                .catch(() => {});
        }
    }, [item.id, startEdit, editable]);

    useEffect(() => {
        if (showFormats && !formats) {
            api.getFormats(item.id)
                .then(setFormats)
                .catch(() => {});
        }
    }, [showFormats, formats, item.id]);

    const persistDraft = useCallback(
        async (value: string, closeEditor: boolean) => {
            if (!value.trim() || value === text) {
                if (closeEditor) {
                    setEditing(false);
                }
                return;
            }
            try {
                await api.updateItemText(item.id, value);
                forgetHtml(item.id);
                setText(value);
                setFormats(null);
                if (showFormats) {
                    api.getFormats(item.id)
                        .then(setFormats)
                        .catch(() => {});
                }
                if (closeEditor) {
                    setEditing(false);
                    onToast(t('Saved (rich formatting dropped)'));
                } else {
                    setAutoSaved(true);
                }
            } catch (e) {
                if (closeEditor) {
                    onToast(errText(e));
                }
            }
        },
        [item.id, text, showFormats, onToast]
    );

    useEffect(() => {
        if (!editing || !autoSaveEdit) {
            return;
        }
        if (draft === text || !draft.trim()) {
            return;
        }
        window.clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = window.setTimeout(() => {
            persistDraft(draft, false);
        }, 450);
        return () => {
            window.clearTimeout(autoSaveTimer.current);
        };
    }, [editing, autoSaveEdit, draft, text, persistDraft]);

    const save = async () => {
        window.clearTimeout(autoSaveTimer.current);
        await persistDraft(draft, true);
    };

    const handleClose = () => {
        window.clearTimeout(autoSaveTimer.current);
        if (editing && autoSaveEdit && draft.trim() && draft !== text) {
            persistDraft(draft, false);
        }
        onClose();
    };

    const lines = useMemo(() => (text ?? '').split('\n'), [text]);
    const truncated = lines.length > MAX_LINES;
    const shown = truncated ? lines.slice(0, MAX_LINES) : lines;

    const onKey = (e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (editing) {
            if (e.key === 'Escape') {
                window.clearTimeout(autoSaveTimer.current);
                if (autoSaveEdit && draft.trim() && draft !== text) {
                    persistDraft(draft, true);
                } else {
                    setEditing(false);
                }
                e.preventDefault();
            }
            if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
            }
            return;
        }
        if (e.key === 'Escape' || e.key === ' ') {
            e.preventDefault();
            handleClose();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            onPaste(item.id, e.shiftKey ? 'plain' : 'auto');
        } else if (e.key.toLowerCase() === 'e' && e.ctrlKey && editable) {
            e.preventDefault();
            setDraft(text ?? '');
            setEditing(true);
        } else if (e.key.toLowerCase() === 'i' && e.ctrlKey) {
            e.preventDefault();
            setShowFormats((v) => !v);
        }
    };

    const showRich = canStyle && styled && !editing;

    return (
        <div className="preview" ref={root} tabIndex={0} onKeyDown={onKey}>
            <div className="preview-head">
                <div className="preview-title">
                    <b>{item.title || t(item.kind)}</b>
                    <span className="muted">
                        {' '}
                        · {item.app_name} · {relTime(item.ts, Date.now(), lang)}
                    </span>
                </div>
                <div className="preview-actions">
                    {canStyle && !editing && (
                        <button className="btn small-btn" onClick={() => setStyled((v) => !v)}>
                            {styled ? t('Plain text') : t('Original style')}
                        </button>
                    )}
                    {editable && !editing && (
                        <button
                            className="iconbtn"
                            data-tip={t('Edit (Ctrl+E)')}
                            onClick={() => {
                                setDraft(text ?? '');
                                setEditing(true);
                            }}
                        >
                            <Icon name="edit" />
                        </button>
                    )}
                    <button
                        className={`iconbtn${showFormats ? ' on' : ''}`}
                        data-tip={t('Formats (Ctrl+I)')}
                        onClick={() => setShowFormats((v) => !v)}
                    >
                        <Icon name="info" />
                    </button>
                    <button className="iconbtn" data-tip={t('Close (Esc)')} onClick={handleClose}>
                        <Icon name="close" />
                    </button>
                </div>
            </div>

            <div className="preview-body">
                {item.kind === 'image' && (
                    <div className="pv-image">
                        {img ? <img src={img} alt="" /> : <div className="muted">{t('Loading…')}</div>}
                        <div className="muted small">
                            {item.img_w}×{item.img_h} px
                        </div>
                    </div>
                )}
                {item.kind === 'color' && item.color && (
                    <div className="pv-color">
                        <div className="pv-swatch" style={{ background: item.color }} />
                        {colorFormats(item.color).map((f) => (
                            <div
                                key={f.label}
                                className="pv-colorrow"
                                onClick={() => {
                                    api.copyText(f.value).catch(() => {});
                                    onToast(t('Copied {v}', { v: f.value }));
                                }}
                            >
                                <span className="muted">{f.label}</span>
                                <span className="mono">{f.value}</span>
                            </div>
                        ))}
                    </div>
                )}
                {item.kind === 'link' && text && (
                    <div className="pv-link">
                        <div className="link-host big">
                            {highlightText(hostOf(text), query, searchMode, highlight)}
                        </div>
                        <div className="link-url wrap" dir="ltr">
                            {highlightText(text, query, searchMode, highlight)}
                        </div>
                        <button className="btn" onClick={() => api.openItem(item.id)}>
                            {t('Open in browser')}
                        </button>
                    </div>
                )}
                {item.kind === 'file' && text && (
                    <div className="files big">
                        {text
                            .split('\n')
                            .filter(Boolean)
                            .map((p, i) => (
                                <div key={i} className="file-row">
                                    <span className="fname" dir="auto">
                                        {highlightText(basename(p), query, searchMode, highlight)}
                                    </span>
                                    <span className="muted small wrap" dir="ltr">
                                        {highlightText(p, query, searchMode, highlight)}
                                    </span>
                                </div>
                            ))}
                        <button className="btn" onClick={() => api.revealItem(item.id)}>
                            {t('Show in Explorer')}
                        </button>
                    </div>
                )}
                {editable && editing && (
                    <textarea
                        className="editor"
                        dir="auto"
                        autoFocus
                        value={draft}
                        onChange={(e) => {
                            setAutoSaved(false);
                            setDraft(e.target.value);
                        }}
                    />
                )}
                {showRich && (
                    <RichView
                        id={item.id}
                        ts={item.ts}
                        lines={9999}
                        full
                        query={query}
                        searchMode={searchMode}
                        highlight={highlight}
                    />
                )}
                {editable &&
                    !editing &&
                    !showRich &&
                    text !== null &&
                    (item.kind === 'text' || item.kind === 'code') && (
                        <div className="codeview" dir="ltr">
                            <div className="gutter">
                                {shown.map((_, i) => (
                                    <div key={i}>{i + 1}</div>
                                ))}
                            </div>
                            <pre className="codepre" dir="auto">
                                {highlightText(shown.join('\n'), query, searchMode, highlight)}
                            </pre>
                        </div>
                    )}
                {truncated && !showRich && (
                    <div className="muted small">
                        {t('Showing the first {n} lines of {total}. The full text is pasted.', {
                            n: MAX_LINES,
                            total: lines.length,
                        })}
                    </div>
                )}

                {showFormats && (
                    <div className="formats" dir="ltr">
                        <div className="muted small">{t('Stored clipboard formats')}</div>
                        {(formats ?? []).map((f, i) => (
                            <div key={i} className="fmt-row">
                                <span className="mono">{f.name}</span>
                                <span className="muted">{f.mime}</span>
                                <span>{humanSize(f.size)}</span>
                            </div>
                        ))}
                        {formats && formats.length === 0 && (
                            <div className="muted small">{t('No raw formats stored.')}</div>
                        )}
                    </div>
                )}
            </div>

            <div className="preview-foot">
                {editing ? (
                    <>
                        <span className="muted small">{t('Ctrl+S save · Esc cancel')}</span>
                        {autoSaved && <span className="autosave-badge">✓ {t('Auto-saved')}</span>}
                        <span className="spacer" />
                        <button className="btn" onClick={() => setEditing(false)}>
                            {t('Cancel')}
                        </button>
                        <button className="btn primary" onClick={save}>
                            {t('Save')}
                        </button>
                    </>
                ) : (
                    <>
                        <span className="muted small">
                            {item.chars ? t('{n} chars', { n: num(item.chars) }) : ''}
                        </span>
                        {autoSaved && <span className="autosave-badge">✓ {t('Auto-saved')}</span>}
                        <span className="spacer" />
                        <button className="btn" onClick={() => onPaste(item.id, 'plain')}>
                            {item.kind === 'file' ? t('Paste file path') : t('Paste plain')}
                        </button>
                        <button className="btn primary" onClick={() => onPaste(item.id, 'auto')}>
                            {t('Paste')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
