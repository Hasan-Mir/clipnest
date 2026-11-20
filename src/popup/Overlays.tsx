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
    disabled?: boolean;
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
        const rest = full.slice(copyWord.length).replace(/^\s+/, '');
        return (
            <span className="inline-label">
                <span className="menu-copy-accent">{full.slice(0, copyWord.length)}</span>
                {rest ? `\u00A0${rest}` : ''}
            </span>
        );
    }
    return <span className="inline-label menu-copy-accent">{full}</span>;
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
            if (!e.sep && !e.header && !e.disabled) {
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
            if ((e.target as HTMLElement | null)?.closest('.menu-chips button')) {
                return;
            }
            const entry = entries[focusIdx];
            if (!entry || entry.disabled) {
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
                            aria-disabled={e.disabled ? 'true' : undefined}
                            tabIndex={-1}
                            className={`menu-item${e.danger ? ' danger' : ''}${e.disabled ? ' disabled' : ''}${
                                focusIdx === i ? ' focused' : ''
                            }`}
                            onMouseEnter={() => {
                                if (!e.disabled) {
                                    setFocusIdx(i);
                                    setOpenSub(null);
                                }
                            }}
                            onClick={(ev) => {
                                if (e.disabled) {
                                    return;
                                }
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
    }, [parentRect, anchor, refs]);

    return (
        <div
            role="menu"
            ref={refs.setFloating}
            className={`menu sub${isPositioned ? ' menu-ready' : ''}`}
            style={{
                ...floatingStyles,
                visibility: isPositioned ? 'visible' : 'hidden',
            }}
        >
            {entries.map((s, k) => (
                <div
                    key={k}
                    role="menuitem"
                    className={`menu-item${s.disabled ? ' disabled' : ''}`}
                    onClick={(ev) => {
                        if (s.disabled) {
                            return;
                        }
                        s.onClick?.(ev.ctrlKey || ev.metaKey || ctrlHeld);
                        onPick();
                    }}
                >
                    <span className="menu-item-label">
                        {s.icon && <Icon name={s.icon} size={13} />}
                        <span>{s.label}</span>
                    </span>
                </div>
            ))}
        </div>
    );
}

// ───────────── prompt / confirmation modal ─────────────
export interface PromptState {
    title: string;
    message?: string;
    initial?: string;
    placeholder?: string;
    confirm?: boolean;
    checkLabel?: string;
    defaultChecked?: boolean;
    checkLabel2?: string;
    defaultChecked2?: boolean;
    okLabel?: string;
    danger?: boolean;
    onSubmit: (v: string, checked: boolean, checked2: boolean) => void;
}

export function Prompt({ p, onClose }: { p: PromptState; onClose: () => void }) {
    const [v, setV] = useState(p.initial ?? '');
    const [checked, setChecked] = useState(p.defaultChecked ?? false);
    const [checked2, setChecked2] = useState(p.defaultChecked2 ?? false);
    const okBtnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (p.confirm) {
            okBtnRef.current?.focus();
        }
    }, [p.confirm]);

    const submit = () => {
        p.onSubmit(v, checked, checked2);
        onClose();
    };

    return (
        <div
            className="overlay"
            onMouseDown={onClose}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                } else if (e.key === 'Enter' && p.confirm && !(e.target as HTMLElement | null)?.closest('button')) {
                    e.preventDefault();
                    e.stopPropagation();
                    submit();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={p.title}
                className="dialog"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="dialog-title">{p.title}</div>
                {p.message && <p className="dialog-msg muted small">{p.message}</p>}
                {!p.confirm && (
                    <input
                        autoFocus
                        value={v}
                        placeholder={p.placeholder}
                        dir="auto"
                        onChange={(e) => setV(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                submit();
                            }
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                onClose();
                            }
                        }}
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
                        <span>{t('Cancel')}</span>
                    </button>
                    <button
                        ref={okBtnRef}
                        type="button"
                        className={`btn ${p.danger ? 'danger-solid' : 'primary'}`}
                        onClick={submit}
                    >
                        <span>{p.okLabel ?? t('OK')}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

// ───────────── category (pinboard) settings modal ─────────────
export const BOARD_COLORS = ['#4f8cff', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#ff375f', '#ffd60a'];

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
    const [color, setColor] = useState(board.color || BOARD_COLORS[0]);
    const [max, setMax] = useState(board.max_items);
    const [style, setStyle] = useState<string>(board.list_style || 'inherit');
    const [pasteMode, setPasteMode] = useState<string>(board.paste_mode || 'inherit');
    const [active, setActive] = useState(isActive);

    const submit = () => {
        if (!name.trim()) {
            return;
        }
        onSave(name.trim(), color, max, style, pasteMode, active);
        onClose();
    };

    const styleOpts = [
        { value: 'inherit', label: t('Same as global setting') },
        { value: 'rich', label: t('Original style') },
        { value: 'plain', label: t('Plain text') },
    ];

    const pasteOpts = [
        { value: 'inherit', label: t('Same as global setting') },
        { value: 'rich', label: t('Keep formatting') },
        { value: 'plain', label: t('Plain text only') },
    ];

    return (
        <div
            className="overlay"
            onMouseDown={onClose}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('Category settings')}
                className="dialog board-dlg"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="dialog-title">{t('Category settings')}</div>

                <label className="field">
                    <span>{t('Name')}</span>
                    <input
                        autoFocus
                        value={name}
                        dir="auto"
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                submit();
                            }
                            if (e.key === 'Escape') {
                                onClose();
                            }
                        }}
                    />
                </label>

                <div className="field">
                    <span>{t('Color')}</span>
                    <div className="swatches">
                        {BOARD_COLORS.map((c) => (
                            <button
                                key={c}
                                type="button"
                                aria-label={c}
                                className={`swatch-pick${color === c ? ' on' : ''}`}
                                style={{ background: c }}
                                onClick={() => setColor(c)}
                            />
                        ))}
                    </div>
                </div>

                <label className="field">
                    <span>{t('Maximum items (0 = unlimited, oldest are deleted)')}</span>
                    <input
                        type="number"
                        min={0}
                        max={100000}
                        step={10}
                        value={max}
                        onChange={(e) => setMax(Math.max(0, Number(e.target.value) || 0))}
                    />
                </label>

                <div className="field">
                    <span>{t('Show items as')}</span>
                    <CustomSelect value={style} onChange={setStyle} options={styleOpts} />
                </div>

                <div className="field">
                    <span>{t('Default paste mode')}</span>
                    <CustomSelect value={pasteMode} onChange={setPasteMode} options={pasteOpts} />
                </div>

                <label className="dialog-check">
                    <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                    <span>
                        {t('New copies are automatically placed in this category and the popup opens on this tab')}
                    </span>
                </label>

                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={onClose}>
                        <span>{t('Cancel')}</span>
                    </button>
                    <button type="button" className="btn primary" onClick={submit}>
                        <span>{t('Save')}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
