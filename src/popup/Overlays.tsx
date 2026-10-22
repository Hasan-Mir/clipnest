import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { Pinboard } from '../lib/api';
import { CustomSelect } from '../lib/CustomSelect';
import { t } from '../lib/i18n';

// ───────────── context menu (powered by @floating-ui/react) ─────────────
export interface MenuEntry {
    label?: string;
    hint?: string;
    onClick?: () => void;
    sep?: boolean;
    header?: boolean;
    chips?: { label: string; color?: string; onClick: () => void }[];
    submenu?: MenuEntry[];
    danger?: boolean;
}

export function ContextMenu({
    x,
    y,
    entries,
    onClose,
}: {
    x: number;
    y: number;
    entries: MenuEntry[];
    onClose: () => void;
}) {
    const [openSub, setOpenSub] = useState<number | null>(null);
    const [subAnchor, setSubAnchor] = useState<DOMRect | null>(null);

    const { refs, floatingStyles } = useFloating({
        open: true,
        placement: 'bottom-start',
        strategy: 'fixed',
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(2),
            flip({
                fallbackPlacements: ['bottom-end', 'top-start', 'top-end'],
                padding: 8,
            }),
            shift({ padding: 8 }),
            size({
                padding: 8,
                apply({ availableHeight, availableWidth, elements }) {
                    Object.assign(elements.floating.style, {
                        maxHeight: `${Math.max(100, availableHeight)}px`,
                        maxWidth: `${Math.max(180, availableWidth)}px`,
                    });
                },
            }),
        ],
    });

    useLayoutEffect(() => {
        refs.setPositionReference({
            getBoundingClientRect() {
                return {
                    width: 0,
                    height: 0,
                    x,
                    y,
                    top: y,
                    left: x,
                    right: x,
                    bottom: y,
                };
            },
        });
    }, [x, y, refs]);

    return (
        <>
            <div
                className="menu-backdrop"
                onMouseDown={onClose}
                onContextMenu={(e) => {
                    e.preventDefault();
                    onClose();
                }}
            />
            <div
                className="menu"
                ref={refs.setFloating}
                style={floatingStyles}
                onScroll={() => {
                    if (openSub !== null) {
                        setOpenSub(null);
                    }
                }}
            >
                {entries.map((e, i) => {
                    if (e.sep) {
                        return <div key={i} className="menu-sep" />;
                    }
                    if (e.header) {
                        return (
                            <div key={i} className="menu-head">
                                {e.label}
                            </div>
                        );
                    }
                    if (e.chips) {
                        return (
                            <div key={i} className="menu-chips">
                                {e.chips.map((c, j) => (
                                    <button
                                        key={j}
                                        type="button"
                                        className="chip"
                                        onClick={() => {
                                            c.onClick();
                                            onClose();
                                        }}
                                    >
                                        {c.color && <span className="dot" style={{ background: c.color }} />}
                                        <span>{c.label}</span>
                                    </button>
                                ))}
                            </div>
                        );
                    }
                    if (e.submenu) {
                        return (
                            <div
                                key={i}
                                className="menu-item has-sub"
                                onMouseEnter={(ev) => {
                                    setOpenSub(i);
                                    setSubAnchor(ev.currentTarget.getBoundingClientRect());
                                }}
                            >
                                <span className="menu-item-label">{e.label}</span>
                                <span className="hint">▸</span>
                                {openSub === i && subAnchor && (
                                    <SubMenu anchor={subAnchor} entries={e.submenu} onPick={onClose} />
                                )}
                            </div>
                        );
                    }
                    return (
                        <div
                            key={i}
                            className={`menu-item${e.danger ? ' danger' : ''}`}
                            onMouseEnter={() => setOpenSub(null)}
                            onClick={() => {
                                e.onClick?.();
                                onClose();
                            }}
                        >
                            <span className="menu-item-label">{e.label}</span>
                            {e.hint && <span className="hint">{e.hint}</span>}
                        </div>
                    );
                })}
            </div>
        </>
    );
}

/**
 * Collision-aware submenu powered by @floating-ui/react: opens to the right if there is room,
 * otherwise flips to the left or top/bottom, and scrolls cleanly inside small popup windows.
 */
function SubMenu({ anchor, entries, onPick }: { anchor: DOMRect; entries: MenuEntry[]; onPick: () => void }) {
    const { refs, floatingStyles } = useFloating({
        open: true,
        placement: 'right-start',
        strategy: 'fixed',
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(-4),
            flip({
                fallbackPlacements: ['left-start', 'right-end', 'left-end', 'bottom-start', 'top-start'],
                padding: 8,
            }),
            shift({ padding: 8 }),
            size({
                padding: 8,
                apply({ availableHeight, availableWidth, elements }) {
                    Object.assign(elements.floating.style, {
                        maxHeight: `${Math.max(100, availableHeight)}px`,
                        maxWidth: `${Math.max(180, availableWidth)}px`,
                    });
                },
            }),
        ],
    });

    useLayoutEffect(() => {
        refs.setPositionReference({
            getBoundingClientRect() {
                return anchor;
            },
        });
    }, [anchor, refs]);

    return (
        <div className="menu sub" ref={refs.setFloating} style={floatingStyles}>
            {entries.map((s, j) => (
                <div
                    key={j}
                    className="menu-item"
                    onClick={(ev) => {
                        ev.stopPropagation();
                        s.onClick?.();
                        onPick();
                    }}
                >
                    <span className="menu-item-label">{s.label}</span>
                </div>
            ))}
        </div>
    );
}

// ───────────── prompt dialog ─────────────
export interface PromptState {
    title: string;
    initial?: string;
    placeholder?: string;
    confirm?: boolean; // confirm-only (no text field)
    checkLabel?: string; // optional checkbox (e.g. "Also erase pinned items and pinboards")
    defaultChecked?: boolean;
    okLabel?: string;
    danger?: boolean;
    onSubmit: (value: string, checked: boolean) => void;
}

export function Prompt({ p, onClose }: { p: PromptState; onClose: () => void }) {
    const [v, setV] = useState(p.initial ?? '');
    const [checked, setChecked] = useState(Boolean(p.defaultChecked));
    const ref = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (p.confirm) {
            dialogRef.current?.focus();
        } else {
            ref.current?.focus();
            ref.current?.select();
        }
    }, [p.confirm]);
    const submit = () => {
        p.onSubmit(v, checked);
        onClose();
    };
    return (
        <div className="overlay" onMouseDown={onClose}>
            <div
                className="dialog"
                ref={dialogRef}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onClose();
                    }
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        submit();
                    }
                }}
            >
                <div className="dialog-title">{p.title}</div>
                {!p.confirm && (
                    <input
                        ref={ref}
                        value={v}
                        placeholder={p.placeholder}
                        onChange={(e) => setV(e.target.value)}
                    />
                )}
                {p.checkLabel && (
                    <label className="dialog-check">
                        <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setChecked(e.target.checked)}
                        />
                        <span>{p.checkLabel}</span>
                    </label>
                )}
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={onClose}>
                        {t('Cancel')}
                    </button>
                    <button
                        type="button"
                        className={`btn ${p.danger ? 'danger-solid' : 'primary'}`}
                        autoFocus={p.confirm}
                        onClick={submit}
                    >
                        {p.okLabel ?? t('OK')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ───────────── pinboard settings dialog (per-tab settings) ─────────────
export const BOARD_COLORS = [
    '#4f8cff',
    '#34c759',
    '#ff9f0a',
    '#ff453a',
    '#bf5af2',
    '#64d2ff',
    '#ffd60a',
    '#8e8e93',
];

export function BoardDialog({
    board,
    isActive,
    onSave,
    onClose,
}: {
    board: Pinboard;
    isActive: boolean;
    onSave: (
        name: string,
        color: string,
        maxItems: number,
        listStyle: string,
        pasteMode: string,
        active: boolean
    ) => void;
    onClose: () => void;
}) {
    const [name, setName] = useState(board.name);
    const [color, setColor] = useState(board.color);
    const [max, setMax] = useState(board.max_items);
    const [style, setStyle] = useState<string>(board.list_style || 'inherit');
    const [pasteMode, setPasteMode] = useState<string>(board.paste_mode || 'inherit');
    const [active, setActive] = useState<boolean>(isActive);
    const dialogRef = useRef<HTMLDivElement>(null);

    const save = () => {
        if (name.trim()) {
            onSave(name, color, max, style, pasteMode, active);
            onClose();
        }
    };
    return (
        <div className="overlay" onMouseDown={onClose}>
            <div
                className="dialog"
                ref={dialogRef}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onClose();
                    }
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        save();
                    }
                }}
            >
                <div className="dialog-title">{t('Pinboard settings')}</div>
                <label className="field">
                    <span>{t('Name')}</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <div className="field">
                    <span>{t('Color')}</span>
                    <div className="swatches">
                        {BOARD_COLORS.map((c) => (
                            <button
                                key={c}
                                type="button"
                                className={`sw${c === color ? ' on' : ''}`}
                                style={{ background: c }}
                                onClick={() => setColor(c)}
                            />
                        ))}
                    </div>
                </div>
                <div className="field field-row">
                    <div>
                        <div>{t('Active pinboard (new copies go here)')}</div>
                        <div className="muted small">
                            {t(
                                'New copies are automatically placed in this pinboard and the popup opens on this tab'
                            )}
                        </div>
                    </div>
                    <button
                        type="button"
                        className={`switch${active ? ' on' : ''}`}
                        role="switch"
                        aria-checked={active}
                        onClick={() => setActive((v) => !v)}
                    >
                        <span />
                    </button>
                </div>
                <div className="field">
                    <span>{t('Show items as')}</span>
                    <CustomSelect
                        value={style}
                        onChange={(v) => setStyle(v)}
                        options={[
                            { value: 'inherit', label: t('Same as global setting') },
                            { value: 'rich', label: t('Original style') },
                            { value: 'plain', label: t('Plain text') },
                        ]}
                    />
                </div>
                <div className="field">
                    <span>{t('Default paste mode')}</span>
                    <CustomSelect
                        value={pasteMode}
                        onChange={(v) => setPasteMode(v)}
                        options={[
                            { value: 'inherit', label: t('Same as global setting') },
                            { value: 'rich', label: t('Keep formatting') },
                            { value: 'plain', label: t('Plain text only') },
                        ]}
                    />
                </div>
                <label className="field">
                    <span>{t('Maximum items (0 = unlimited, oldest are deleted)')}</span>
                    <input
                        type="number"
                        min={0}
                        value={max}
                        onChange={(e) => setMax(Math.max(0, Number(e.target.value) || 0))}
                    />
                </label>
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={onClose}>
                        {t('Cancel')}
                    </button>
                    <button type="button" className="btn primary" onClick={save}>
                        {t('Save')}
                    </button>
                </div>
            </div>
        </div>
    );
}
