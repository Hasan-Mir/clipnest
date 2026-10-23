import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { Pinboard } from '../lib/api';
import { CustomSelect } from '../lib/CustomSelect';
import { Icon, IconName } from '../lib/icons';
import { t } from '../lib/i18n';

// ───────────── context menu (powered by @floating-ui/react) ─────────────
export interface MenuChip {
    label: string;
    color?: string;
    onClick: (ctrlKey: boolean) => void;
}

export interface MenuEntry {
    label?: string;
    hint?: string;
    icon?: IconName | string;
    onClick?: (ctrlKey: boolean) => void;
    sep?: boolean;
    header?: boolean;
    /** On the main Clipboard tab: always shows Copy icon + "Copy to" */
    staticCategoryCopy?: boolean;
    /** Inside a Category tab: shows Right-Arrow + "Move to" by default, or Copy icon + accent "Copy" + "to" while Ctrl is held */
    dynamicCategoryMoveCopy?: boolean;
    chips?: MenuChip[];
    submenu?: MenuEntry[];
    danger?: boolean;
}

function renderAccentCopyHeader() {
    const full = t('Copy to');
    const copyWord = t('Copy');
    if (full.toLowerCase().startsWith(copyWord.toLowerCase())) {
        const rest = full.slice(copyWord.length);
        return (
            <span>
                <span className="menu-copy-accent">{full.slice(0, copyWord.length)}</span>
                {rest}
            </span>
        );
    }
    return <span className="menu-copy-accent">{full}</span>;
}

export function ContextMenu({
    x,
    y,
    entries,
    initialCtrl = false,
    onClose,
}: {
    x: number;
    y: number;
    entries: MenuEntry[];
    initialCtrl?: boolean;
    onClose: () => void;
}) {
    const [openSub, setOpenSub] = useState<number | null>(null);
    const [subAnchor, setSubAnchor] = useState<DOMRect | null>(null);
    const [parentRect, setParentRect] = useState<DOMRect | null>(null);
    const [ctrlHeld, setCtrlHeld] = useState(initialCtrl);
    const [focusIdx, setFocusIdx] = useState<number>(0);
    const menuElRef = useRef<HTMLDivElement | null>(null);

    const actionableIndices = useMemo(() => {
        const out: number[] = [];
        entries.forEach((e, idx) => {
            if (!e.sep && !e.header) {
                out.push(idx);
            }
        });
        return out;
    }, [entries]);

    useEffect(() => {
        setCtrlHeld(initialCtrl);
    }, [initialCtrl]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Control' || e.ctrlKey || e.metaKey) {
                setCtrlHeld(true);
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Control' || (!e.ctrlKey && !e.metaKey)) {
                setCtrlHeld(false);
            }
        };
        const onBlur = () => setCtrlHeld(false);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    const { refs, floatingStyles, isPositioned } = useFloating({
        open: true,
        placement: 'bottom-start',
        strategy: 'fixed',
        transform: false,
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
        setOpenSub(null);
        setFocusIdx(actionableIndices[0] ?? -1);
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
    }, [x, y, refs, actionableIndices]);

    useEffect(() => {
        if (isPositioned) {
            menuElRef.current?.focus();
        }
    }, [isPositioned]);

    const handleMenuKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (openSub !== null) {
                setOpenSub(null);
            } else {
                onClose();
            }
            return;
        }
        if (!actionableIndices.length) {
            return;
        }
        const curPos = actionableIndices.indexOf(focusIdx);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            const next = actionableIndices[(curPos + 1) % actionableIndices.length];
            setFocusIdx(next);
            setOpenSub(null);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            const prev = actionableIndices[(curPos - 1 + actionableIndices.length) % actionableIndices.length];
            setFocusIdx(prev);
            setOpenSub(null);
        } else if (e.key === 'Home') {
            e.preventDefault();
            e.stopPropagation();
            setFocusIdx(actionableIndices[0]);
        } else if (e.key === 'End') {
            e.preventDefault();
            e.stopPropagation();
            setFocusIdx(actionableIndices[actionableIndices.length - 1]);
        } else if (e.key === 'ArrowRight') {
            const entry = entries[focusIdx];
            if (entry?.submenu) {
                e.preventDefault();
                e.stopPropagation();
                const itemEl = menuElRef.current?.querySelector(`[data-menu-idx="${focusIdx}"]`);
                if (itemEl) {
                    setOpenSub(focusIdx);
                    setSubAnchor(itemEl.getBoundingClientRect());
                    if (menuElRef.current) {
                        setParentRect(menuElRef.current.getBoundingClientRect());
                    }
                }
            }
        } else if (e.key === 'ArrowLeft') {
            if (openSub !== null) {
                e.preventDefault();
                e.stopPropagation();
                setOpenSub(null);
            }
        } else if (e.key === 'Enter' || e.key === ' ') {
            const entry = entries[focusIdx];
            if (!entry) {
                return;
            }
            if (entry.submenu) {
                e.preventDefault();
                e.stopPropagation();
                const itemEl = menuElRef.current?.querySelector(`[data-menu-idx="${focusIdx}"]`);
                if (itemEl) {
                    setOpenSub(focusIdx);
                    setSubAnchor(itemEl.getBoundingClientRect());
                    if (menuElRef.current) {
                        setParentRect(menuElRef.current.getBoundingClientRect());
                    }
                }
            } else if (entry.onClick) {
                e.preventDefault();
                e.stopPropagation();
                entry.onClick(e.ctrlKey || e.metaKey || ctrlHeld);
                onClose();
            } else if (entry.chips && entry.chips.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                entry.chips[0].onClick(e.ctrlKey || e.metaKey || ctrlHeld);
                onClose();
            }
        }
    };

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
                key={`${x}-${y}`}
                role="menu"
                aria-label={t('Actions')}
                tabIndex={-1}
                className={`menu${isPositioned ? ' menu-ready' : ''}`}
                ref={(node) => {
                    menuElRef.current = node;
                    refs.setFloating(node);
                }}
                style={{
                    ...floatingStyles,
                    visibility: isPositioned ? 'visible' : 'hidden',
                }}
                onKeyDown={handleMenuKeyDown}
                onScroll={() => {
                    if (openSub !== null) {
                        setOpenSub(null);
                    }
                }}
            >
                {entries.map((e, i) => {
                    if (e.sep) {
                        return <div key={i} role="separator" className="menu-sep" />;
                    }
                    if (e.header) {
                        if (e.staticCategoryCopy) {
                            return (
                                <div key={i} className="menu-head menu-head-icon">
                                    <Icon name="copy" size={12} />
                                    <span>{t('Copy to')}</span>
                                </div>
                            );
                        }
                        if (e.dynamicCategoryMoveCopy) {
                            return (
                                <div
                                    key={i}
                                    className={`menu-head menu-head-icon${ctrlHeld ? ' copy-mode' : ''}`}
                                    title={t('Hold Ctrl to copy instead of move')}
                                >
                                    <Icon name={ctrlHeld ? 'copy' : 'arrowRight'} size={12} />
                                    {ctrlHeld ? renderAccentCopyHeader() : <span>{t('Move to')}</span>}
                                    <span className="menu-head-hint">Ctrl</span>
                                </div>
                            );
                        }
                        return (
                            <div key={i} className="menu-head">
                                {e.icon && <Icon name={e.icon} size={12} />}
                                <span>{e.label}</span>
                            </div>
                        );
                    }
                    if (e.chips) {
                        return (
                            <div
                                key={i}
                                data-menu-idx={i}
                                role="group"
                                aria-label={t('Categories')}
                                className={`menu-chips${focusIdx === i ? ' focused' : ''}`}
                            >
                                {e.chips.map((c, j) => (
                                    <button
                                        key={j}
                                        type="button"
                                        role="menuitem"
                                        className="chip"
                                        onClick={(ev) => {
                                            c.onClick(ev.ctrlKey || ev.metaKey || ctrlHeld);
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
                                data-menu-idx={i}
                                role="menuitem"
                                aria-haspopup="menu"
                                aria-expanded={openSub === i}
                                className={`menu-item has-sub${focusIdx === i ? ' focused' : ''}`}
                                onMouseEnter={(ev) => {
                                    setFocusIdx(i);
                                    setOpenSub(i);
                                    setSubAnchor(ev.currentTarget.getBoundingClientRect());
                                    if (menuElRef.current) {
                                        setParentRect(menuElRef.current.getBoundingClientRect());
                                    }
                                }}
                            >
                                <span className="menu-item-label">
                                    {e.icon && <Icon name={e.icon} size={13} />}
                                    <span>{e.label}</span>
                                </span>
                                <span className="hint" aria-hidden>
                                    ▸
                                </span>
                                {openSub === i && subAnchor && (
                                    <SubMenu
                                        anchor={subAnchor}
                                        parentRect={parentRect ?? subAnchor}
                                        entries={e.submenu}
                                        ctrlHeld={ctrlHeld}
                                        onPick={onClose}
                                    />
                                )}
                            </div>
                        );
                    }
                    return (
                        <div
                            key={i}
                            data-menu-idx={i}
                            role="menuitem"
                            tabIndex={-1}
                            className={`menu-item${e.danger ? ' danger' : ''}${focusIdx === i ? ' focused' : ''}`}
                            onMouseEnter={() => {
                                setFocusIdx(i);
                                setOpenSub(null);
                            }}
                            onClick={(ev) => {
                                e.onClick?.(ev.ctrlKey || ev.metaKey || ctrlHeld);
                                onClose();
                            }}
                        >
                            <span className="menu-item-label">
                                {e.icon && <Icon name={e.icon} size={13} />}
                                <span>{e.label}</span>
                            </span>
                            {e.hint && <span className="hint">{e.hint}</span>}
                        </div>
                    );
                })}
            </div>
        </>
    );
}

/**
 * Side-anchored submenu powered by @floating-ui/react: opens to the right or left of the parent
 * menu depending on which side has more horizontal room, and never stacks vertically on top of
 * the parent menu.
 */
function SubMenu({
    anchor,
    parentRect,
    entries,
    ctrlHeld,
    onPick,
}: {
    anchor: DOMRect;
    parentRect: DOMRect;
    entries: MenuEntry[];
    ctrlHeld: boolean;
    onPick: () => void;
}) {
    const spaceRight = window.innerWidth - parentRect.right - 6;
    const spaceLeft = parentRect.left - 6;
    const preferLeft = spaceRight < 185 && spaceLeft > spaceRight;

    const { refs, floatingStyles, isPositioned } = useFloating({
        open: true,
        placement: preferLeft ? 'left-start' : 'right-start',
        strategy: 'fixed',
        transform: false,
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(2),
            flip({
                fallbackPlacements: preferLeft
                    ? ['right-start', 'left-end', 'right-end']
                    : ['left-start', 'right-end', 'left-end'],
                padding: 6,
            }),
            shift({
                padding: 6,
                crossAxis: true,
            }),
            size({
                padding: 6,
                apply({ availableHeight, elements }) {
                    const sideSpace = Math.max(spaceRight, spaceLeft);
                    const targetMaxW =
                        sideSpace >= 165 ? Math.min(250, sideSpace) : Math.min(220, window.innerWidth * 0.56);
                    Object.assign(elements.floating.style, {
                        maxHeight: `${Math.max(110, Math.min(320, availableHeight))}px`,
                        maxWidth: `${Math.max(155, Math.round(targetMaxW))}px`,
                    });
                },
            }),
        ],
    });

    useLayoutEffect(() => {
        refs.setPositionReference({
            getBoundingClientRect() {
                return {
                    width: parentRect.width,
                    height: anchor.height,
                    x: parentRect.left,
                    y: anchor.top,
                    top: anchor.top,
                    left: parentRect.left,
                    right: parentRect.right,
                    bottom: anchor.bottom,
                };
            },
        });
    }, [anchor, parentRect, refs]);

    return (
        <div
            role="menu"
            className={`menu sub${isPositioned ? ' menu-ready' : ''}`}
            ref={refs.setFloating}
            style={{
                ...floatingStyles,
                visibility: isPositioned ? 'visible' : 'hidden',
            }}
        >
            {entries.map((s, j) => (
                <div
                    key={j}
                    role="menuitem"
                    tabIndex={-1}
                    className="menu-item"
                    onClick={(ev) => {
                        ev.stopPropagation();
                        s.onClick?.(ev.ctrlKey || ev.metaKey || ctrlHeld);
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
    message?: string;
    initial?: string;
    placeholder?: string;
    confirm?: boolean; // confirm-only (no text field)
    checkLabel?: string; // primary checkbox (e.g. "Also erase pinned items")
    defaultChecked?: boolean;
    checkLabel2?: string; // secondary checkbox (e.g. "Also erase all categories and main clipboard")
    defaultChecked2?: boolean;
    okLabel?: string;
    danger?: boolean;
    onSubmit: (value: string, checked: boolean, checked2: boolean) => void;
}

export function Prompt({ p, onClose }: { p: PromptState; onClose: () => void }) {
    const [v, setV] = useState(p.initial ?? '');
    const [checked, setChecked] = useState(Boolean(p.defaultChecked));
    const [checked2, setChecked2] = useState(Boolean(p.defaultChecked2));
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
        p.onSubmit(v, checked, checked2);
        onClose();
    };
    return (
        <div className="overlay" onMouseDown={onClose}>
            <div
                className="dialog"
                role="dialog"
                aria-modal="true"
                aria-label={p.title}
                ref={dialogRef}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onClose();
                    }
                    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                        e.preventDefault();
                        submit();
                    }
                }}
            >
                <div className="dialog-title">{p.title}</div>
                {p.message && <p className="dialog-msg muted small">{p.message}</p>}
                {!p.confirm && (
                    <input
                        ref={ref}
                        aria-label={p.title}
                        value={v}
                        placeholder={p.placeholder}
                        onChange={(e) => setV(e.target.value)}
                    />
                )}
                {p.checkLabel && (
                    <label className="dialog-check">
                        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                        <span>{p.checkLabel}</span>
                    </label>
                )}
                {p.checkLabel2 && (
                    <label className="dialog-check">
                        <input type="checkbox" checked={checked2} onChange={(e) => setChecked2(e.target.checked)} />
                        <span>{p.checkLabel2}</span>
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

// ───────────── category settings dialog (per-tab settings) ─────────────
export const BOARD_COLORS = ['#4f8cff', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#ffd60a', '#8e8e93'];

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
                role="dialog"
                aria-modal="true"
                aria-label={t('Category settings')}
                ref={dialogRef}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onClose();
                    }
                    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                        e.preventDefault();
                        save();
                    }
                }}
            >
                <div className="dialog-title">{t('Category settings')}</div>
                <label className="field">
                    <span>{t('Name')}</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <div className="field">
                    <span>{t('Color')}</span>
                    <div className="swatches" role="radiogroup" aria-label={t('Color')}>
                        {BOARD_COLORS.map((c) => (
                            <button
                                key={c}
                                type="button"
                                role="radio"
                                aria-checked={c === color}
                                aria-label={c}
                                className={`sw${c === color ? ' on' : ''}`}
                                style={{ background: c }}
                                onClick={() => setColor(c)}
                            />
                        ))}
                    </div>
                </div>
                <div className="field field-row">
                    <div>
                        <div>{t('Active category (new copies go here)')}</div>
                        <div className="muted small">
                            {t('New copies are automatically placed in this category and the popup opens on this tab')}
                        </div>
                    </div>
                    <button
                        type="button"
                        className={`switch${active ? ' on' : ''}`}
                        role="switch"
                        aria-checked={active}
                        aria-label={t('Active category (new copies go here)')}
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
