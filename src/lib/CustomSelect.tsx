import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { t } from './i18n';
import { Icon } from './icons';
import { useEntered } from './useEntered';

const EXIT_MS = 135;

function prefersInstantClose(): boolean {
    if (typeof document !== 'undefined' && document.documentElement.dataset.animations === 'off') {
        return true;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
}

export interface SelectOption<T extends string | number> {
    value: T;
    label: string;
    subLabel?: string;
    fontFamily?: string;
}

interface CustomSelectProps<T extends string | number> {
    value: T;
    options: SelectOption<T>[];
    onChange: (value: T) => void;
    className?: string;
    searchable?: boolean;
}

/**
 * DNSS/Notion-style custom dropdown component powered by @floating-ui/react for collision-aware
 * positioning, smooth enter/exit motion, two-line options, and optional search filtering.
 */
export function CustomSelect<T extends string | number>({
    value,
    options,
    onChange,
    className = '',
    searchable = false,
}: CustomSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [closing, setClosing] = useState(false);
    const [anchorWidth, setAnchorWidth] = useState(0);
    const [filter, setFilter] = useState('');
    const [focusIdx, setFocusIdx] = useState(0);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const closeTimerRef = useRef<number | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const valueRef = useRef(value);
    valueRef.current = value;

    const { refs, floatingStyles, isPositioned, placement } = useFloating({
        open: mounted,
        onOpenChange: setOpen,
        placement: 'bottom-start',
        strategy: 'fixed',
        transform: false,
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(6),
            flip({ padding: 8 }),
            shift({ padding: 8 }),
            size({
                padding: 8,
                apply({ availableHeight, elements }) {
                    const maxW =
                        typeof window !== 'undefined' ? Math.max(0, Math.round(window.innerWidth - 16)) : undefined;
                    Object.assign(elements.floating.style, {
                        ...(maxW !== undefined ? { maxWidth: `${maxW}px` } : {}),
                        maxHeight: `${Math.max(120, Math.min(300, Math.round(availableHeight)))}px`,
                    });
                },
            }),
        ],
    });

    const setWrapRef = useCallback(
        (node: HTMLDivElement | null) => {
            wrapRef.current = node;
            refs.setReference(node);
        },
        [refs]
    );

    const clearCloseTimer = useCallback(() => {
        if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    }, []);

    useEffect(() => clearCloseTimer, [clearCloseTimer]);

    useLayoutEffect(() => {
        if (open) {
            clearCloseTimer();
            const width = wrapRef.current?.offsetWidth ?? 0;
            if (width > 0) {
                setAnchorWidth(width);
            }
            setMounted(true);
            setClosing(false);
            return;
        }
        if (mounted) {
            if (prefersInstantClose()) {
                clearCloseTimer();
                setMounted(false);
                setClosing(false);
                return;
            }
            setClosing(true);
            clearCloseTimer();
            closeTimerRef.current = window.setTimeout(() => {
                closeTimerRef.current = null;
                setMounted(false);
                setClosing(false);
            }, EXIT_MS);
        }
    }, [open, mounted, clearCloseTimer]);

    const filteredOptions = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) {
            return options;
        }
        return options.filter(
            (o) =>
                o.label.toLowerCase().includes(q) ||
                (o.subLabel !== undefined && o.subLabel.toLowerCase().includes(q)) ||
                String(o.value).toLowerCase().includes(q)
        );
    }, [options, filter]);

    const menuEntered = useEntered(mounted && !closing && isPositioned);
    const isTop = placement.startsWith('top');
    const selectedOpt = options.find((o) => o.value === value);
    const selectedLabel = selectedOpt?.label ?? String(value);

    useEffect(() => {
        if (!open) {
            return;
        }
        setFilter('');
        const idx = Math.max(
            0,
            optionsRef.current.findIndex((o) => o.value === valueRef.current)
        );
        setFocusIdx(idx);
    }, [open]);

    useEffect(() => {
        if (!open || !searchable || !isPositioned) {
            return;
        }
        searchRef.current?.focus({ preventScroll: true });
    }, [open, searchable, isPositioned]);

    const focusTrigger = useCallback(() => {
        triggerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onScroll = (e: Event) => {
            const floatEl = refs.floating.current;
            if (floatEl && e.target instanceof Node && floatEl.contains(e.target)) {
                return;
            }
            setOpen(false);
        };
        const onBlur = () => setOpen(false);
        const onEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                focusTrigger();
            }
        };
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('blur', onBlur);
        window.addEventListener('keydown', onEscape, true);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('keydown', onEscape, true);
        };
    }, [open, refs.floating, focusTrigger]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!open) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
            }
            return;
        }
        if (e.key === 'Tab') {
            if (document.activeElement === searchRef.current) {
                triggerRef.current?.focus({ preventScroll: true });
            }
            setOpen(false);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            focusTrigger();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setFocusIdx((i) => (i + 1) % Math.max(1, filteredOptions.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setFocusIdx((i) => (i - 1 + Math.max(1, filteredOptions.length)) % Math.max(1, filteredOptions.length));
        } else if (e.key === 'Enter' || (!searchable && e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            const picked = filteredOptions[focusIdx];
            if (picked !== undefined) {
                onChange(picked.value);
            }
            setOpen(false);
            focusTrigger();
        }
    };

    const viewportMaxWidth = typeof window !== 'undefined' ? Math.max(0, window.innerWidth - 16) : anchorWidth;
    const resolvedMinWidth = anchorWidth > 0 ? Math.min(anchorWidth, viewportMaxWidth) : undefined;

    return (
        <div ref={setWrapRef} className={`cselect${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                className="cselect-btn"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                onKeyDown={onKeyDown}
            >
                <span
                    className="cselect-label"
                    style={
                        selectedOpt?.fontFamily ? { fontFamily: `"${selectedOpt.fontFamily}", sans-serif` } : undefined
                    }
                >
                    {selectedLabel}
                </span>
                <span className="cselect-chev">
                    <Icon name="chevronDown" size={13} />
                </span>
            </button>
            {mounted &&
                typeof document !== 'undefined' &&
                createPortal(
                    <>
                        <div
                            className={`cselect-backdrop${closing ? ' closing' : ''}`}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                setOpen(false);
                            }}
                        />
                        <div
                            ref={refs.setFloating}
                            role="listbox"
                            className={`cselect-menu${closing ? ' closing' : menuEntered ? ' entered' : ''}${
                                isTop ? ' from-top' : ''
                            }`}
                            style={{
                                ...floatingStyles,
                                minWidth: resolvedMinWidth !== undefined ? `${resolvedMinWidth}px` : undefined,
                                visibility: isPositioned ? 'visible' : 'hidden',
                            }}
                        >
                            {searchable && (
                                <div className="cselect-search">
                                    <Icon name="search" size={12} />
                                    <input
                                        ref={searchRef}
                                        className="search-bare"
                                        value={filter}
                                        placeholder={t('Filter…')}
                                        onChange={(e) => {
                                            setFilter(e.target.value);
                                            setFocusIdx(0);
                                        }}
                                        onKeyDown={onKeyDown}
                                    />
                                </div>
                            )}
                            <div className={`cselect-list${searchable ? ' searchable' : ''}`}>
                                {filteredOptions.length === 0 && (
                                    <div className="cselect-empty muted small">{t('Nothing found')}</div>
                                )}
                                {filteredOptions.map((opt, idx) => {
                                    const isSel = opt.value === value;
                                    const isFocus = idx === focusIdx;
                                    return (
                                        <div
                                            key={String(opt.value)}
                                            role="option"
                                            aria-selected={isSel}
                                            className={`cselect-opt${opt.subLabel ? ' two-line' : ''}${
                                                isSel ? ' sel' : ''
                                            }${isFocus ? ' focus' : ''}`}
                                            style={
                                                opt.fontFamily
                                                    ? { fontFamily: `"${opt.fontFamily}", sans-serif` }
                                                    : undefined
                                            }
                                            onMouseEnter={() => setFocusIdx(idx)}
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onChange(opt.value);
                                                setOpen(false);
                                            }}
                                        >
                                            <span
                                                className={`cselect-check${isSel ? ' visible' : ''}`}
                                                aria-hidden="true"
                                            >
                                                <Icon name="check" size={13} />
                                            </span>
                                            <div className="cselect-opt-texts">
                                                <span className="cselect-opt-label">{opt.label}</span>
                                                {opt.subLabel && (
                                                    <span className="cselect-opt-sub" dir="ltr">
                                                        {opt.subLabel}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </>,
                    document.body
                )}
        </div>
    );
}
