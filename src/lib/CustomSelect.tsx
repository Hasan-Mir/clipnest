import React, { useEffect, useMemo, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { t } from './i18n';
import { Icon } from './icons';

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
 * Notion-style custom dropdown component powered by @floating-ui/react for collision-aware
 * positioning, dynamic max-height clamping, two-line Telegram-style options, and search filtering.
 */
export function CustomSelect<T extends string | number>({
    value,
    options,
    onChange,
    className = '',
    searchable = false,
}: CustomSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState('');
    const [focusIdx, setFocusIdx] = useState(0);
    const searchRef = useRef<HTMLInputElement>(null);

    const { refs, floatingStyles, isPositioned } = useFloating({
        open,
        onOpenChange: setOpen,
        placement: 'bottom-start',
        strategy: 'fixed',
        transform: false,
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(4),
            flip({ padding: 8 }),
            shift({ padding: 8 }),
            size({
                padding: 8,
                apply({ availableHeight, rects, elements }) {
                    Object.assign(elements.floating.style, {
                        minWidth: `${Math.max(175, rects.reference.width)}px`,
                        maxHeight: `${Math.max(120, Math.min(310, availableHeight))}px`,
                    });
                },
            }),
        ],
    });

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

    const selectedOpt = options.find((o) => o.value === value);
    const selectedLabel = selectedOpt?.label ?? String(value);

    useEffect(() => {
        if (open) {
            setFilter('');
            const idx = Math.max(
                0,
                options.findIndex((o) => o.value === value)
            );
            setFocusIdx(idx);
            if (searchable) {
                window.setTimeout(() => {
                    searchRef.current?.focus();
                }, 15);
            }
        }
    }, [open, options, value, searchable]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            const domRef = refs.domReference.current;
            const floatEl = refs.floating.current;
            if ((domRef && domRef.contains(target)) || (floatEl && floatEl.contains(target))) {
                return;
            }
            setOpen(false);
        };
        const onScroll = (e: Event) => {
            const floatEl = refs.floating.current;
            if (floatEl && e.target instanceof Node && floatEl.contains(e.target)) {
                return;
            }
            setOpen(false);
        };
        const onBlur = () => setOpen(false);
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('blur', onBlur);
        };
    }, [open, refs.domReference, refs.floating]);

    const focusTrigger = () => {
        const el = refs.domReference.current;
        if (el instanceof HTMLElement) {
            el.focus();
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!open) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
            }
            return;
        }
        if (e.key === 'Escape') {
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
            setFocusIdx(
                (i) => (i - 1 + Math.max(1, filteredOptions.length)) % Math.max(1, filteredOptions.length)
            );
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

    return (
        <div className={`cselect${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
            <button
                ref={refs.setReference}
                type="button"
                className="cselect-btn"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                onKeyDown={onKeyDown}
            >
                <span
                    className="cselect-label"
                    style={
                        selectedOpt?.fontFamily
                            ? { fontFamily: `"${selectedOpt.fontFamily}", sans-serif` }
                            : undefined
                    }
                >
                    {selectedLabel}
                </span>
                <span className="cselect-chev">
                    <Icon name="chevronDown" size={13} />
                </span>
            </button>
            {open && (
                <div
                    ref={refs.setFloating}
                    role="listbox"
                    className={`cselect-menu${isPositioned ? ' cselect-menu-ready' : ''}`}
                    style={{
                        ...floatingStyles,
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
                    <div className="cselect-list">
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
                                    <div className="cselect-opt-texts">
                                        <span className="cselect-opt-label">{opt.label}</span>
                                        {opt.subLabel && (
                                            <span className="cselect-opt-sub" dir="ltr">
                                                {opt.subLabel}
                                            </span>
                                        )}
                                    </div>
                                    {isSel && (
                                        <span className="cselect-check">
                                            <Icon name="check" size={12} />
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
