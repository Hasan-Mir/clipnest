import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { contrastOn } from './format';
import { t } from './i18n';
import { Icon } from './icons';
import { useEntered } from './useEntered';

const EXIT_MS = 135;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface ColorPreset {
    id: string;
    label: string;
    hex: string;
}

export const COLOR_PRESETS: ColorPreset[] = [
    { id: 'blue', label: 'Ocean', hex: '#4f8cff' },
    { id: 'emerald', label: 'Emerald', hex: '#10b981' },
    { id: 'teal', label: 'Teal', hex: '#06b6d4' },
    { id: 'indigo', label: 'Indigo', hex: '#6366f1' },
    { id: 'violet', label: 'Violet', hex: '#8b5cf6' },
    { id: 'rose', label: 'Rose', hex: '#f43f5e' },
    { id: 'amber', label: 'Amber', hex: '#f59e0b' },
    { id: 'pink', label: 'Pink', hex: '#ec4899' },
];

export function isValidHex(value: string): boolean {
    return HEX_RE.test(value.trim());
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const n = Number.parseInt(clean, 16);
    return {
        r: (n >> 16) & 255,
        g: (n >> 8) & 255,
        b: n & 255,
    };
}

export function rgbToHex(r: number, g: number, b: number): string {
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return '#' + [clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case rn:
                h = (gn - bn) / d + (gn < bn ? 6 : 0);
                break;
            case gn:
                h = (bn - rn) / d + 2;
                break;
            default:
                h = (rn - gn) / d + 4;
                break;
        }
        h *= 60;
    }

    return {
        h: Math.round(h) % 360,
        s: Math.round(s * 100),
        l: Math.round(l * 100),
    };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const hn = ((h % 360) + 360) % 360;
    const sn = Math.max(0, Math.min(100, s)) / 100;
    const ln = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = ln - c / 2;
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;

    if (hn < 60) {
        r1 = c;
        g1 = x;
    } else if (hn < 120) {
        r1 = x;
        g1 = c;
    } else if (hn < 180) {
        g1 = c;
        b1 = x;
    } else if (hn < 240) {
        g1 = x;
        b1 = c;
    } else if (hn < 300) {
        r1 = x;
        b1 = c;
    } else {
        r1 = c;
        b1 = x;
    }

    return {
        r: Math.round((r1 + m) * 255),
        g: Math.round((g1 + m) * 255),
        b: Math.round((b1 + m) * 255),
    };
}

export function hexToHsl(hex: string, fallback = '#4f8cff'): { h: number; s: number; l: number } {
    const safe = isValidHex(hex) ? hex : fallback;
    const { r, g, b } = hexToRgb(safe);
    return rgbToHsl(r, g, b);
}

export function hslToHex(h: number, s: number, l: number): string {
    const { r, g, b } = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
}

function prefersInstantClose(): boolean {
    if (typeof document !== 'undefined' && document.documentElement.dataset.animations === 'off') {
        return true;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
}

export interface ColorPickerProps {
    value: string;
    onChange: (hex: string) => void;
    defaultValue?: string;
    presets?: ColorPreset[];
    compact?: boolean;
    isTransparent?: boolean;
    ariaLabel?: string;
    className?: string;
}

/**
 * DNSS-inspired custom color picker replacing native browser <input type="color"> controls.
 * Renders a tactile swatch trigger when closed and a smooth portaled popover with preset swatches,
 * Hue / Saturation / Lightness spectrum sliders, and a live monospace Hex editor when open.
 */
export function ColorPicker({
    value,
    onChange,
    defaultValue,
    presets = COLOR_PRESETS,
    compact = false,
    isTransparent = false,
    ariaLabel,
    className = '',
}: ColorPickerProps) {
    const normalizedDefault = defaultValue && isValidHex(defaultValue) ? defaultValue.trim().toLowerCase() : undefined;
    const safeHex = isValidHex(value) ? value.trim().toLowerCase() : (normalizedDefault ?? '#4f8cff');
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [closing, setClosing] = useState(false);
    const [hexDraft, setHexDraft] = useState<string | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const closeTimerRef = useRef<number | null>(null);

    const hsl = useMemo(() => hexToHsl(safeHex), [safeHex]);
    const savedHueRef = useRef<number>(hsl.h);
    if (hsl.s > 0 && hsl.l > 0 && hsl.l < 100) {
        savedHueRef.current = hsl.h;
    }
    const effectiveHue = hsl.s === 0 ? savedHueRef.current : hsl.h;

    const { refs, floatingStyles, isPositioned, placement } = useFloating({
        open: mounted,
        onOpenChange: setOpen,
        placement: 'bottom-end',
        strategy: 'fixed',
        transform: false,
        whileElementsMounted: autoUpdate,
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    });

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
            setMounted(true);
            setClosing(false);
            return;
        }
        if (mounted) {
            setHexDraft(null);
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

    const menuEntered = useEntered(mounted && !closing && isPositioned);
    const isTop = placement.startsWith('top');

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

    const handleHueChange = (nextHue: number) => {
        savedHueRef.current = nextHue;
        const sat = hsl.s < 10 ? 75 : hsl.s;
        const light = hsl.l < 15 || hsl.l > 85 ? 55 : hsl.l;
        setHexDraft(null);
        onChange(hslToHex(nextHue, sat, light));
    };

    const handleSatChange = (nextSat: number) => {
        const light = hsl.l < 15 || hsl.l > 85 ? 55 : hsl.l;
        setHexDraft(null);
        onChange(hslToHex(effectiveHue, nextSat, light));
    };

    const handleLightChange = (nextLight: number) => {
        setHexDraft(null);
        onChange(hslToHex(effectiveHue, hsl.s, nextLight));
    };

    const handleHexInput = (raw: string) => {
        setHexDraft(raw);
        const trimmed = raw.trim();
        const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        if (isValidHex(normalized)) {
            onChange(normalized.toLowerCase());
        }
    };

    const showReset = normalizedDefault !== undefined && safeHex !== normalizedDefault;

    return (
        <div ref={refs.setReference} className={`cpicker${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
            <button
                ref={triggerRef}
                type="button"
                className={`cpicker-trigger${compact ? ' compact' : ''}`}
                aria-label={ariaLabel ?? t('Color')}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
            >
                <span
                    className={`cpicker-dot${isTransparent ? ' transparent' : ''}`}
                    style={isTransparent ? undefined : { backgroundColor: safeHex }}
                    aria-hidden="true"
                />
                {!compact && (
                    <>
                        <span className="cpicker-hex mono" dir="ltr">
                            {safeHex.toUpperCase()}
                        </span>
                        <span className="cselect-chev" aria-hidden="true">
                            <Icon name="chevronDown" size={13} />
                        </span>
                    </>
                )}
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
                            role="dialog"
                            aria-label={ariaLabel ?? t('Color')}
                            className={`cpicker-popover${closing ? ' closing' : menuEntered ? ' entered' : ''}${
                                isTop ? ' from-top' : ''
                            }`}
                            style={{
                                ...floatingStyles,
                                visibility: isPositioned ? 'visible' : 'hidden',
                            }}
                        >
                            {/* Curated preset swatches */}
                            <div className="cpicker-swatches">
                                {presets.map((preset) => {
                                    const selected =
                                        !isTransparent && safeHex.toLowerCase() === preset.hex.toLowerCase();
                                    return (
                                        <button
                                            key={preset.id}
                                            type="button"
                                            title={preset.label}
                                            aria-label={preset.label}
                                            aria-pressed={selected}
                                            className={`cpicker-swatch${selected ? ' selected' : ''}`}
                                            style={{ backgroundColor: preset.hex, color: contrastOn(preset.hex) }}
                                            onClick={() => {
                                                setHexDraft(null);
                                                onChange(preset.hex);
                                            }}
                                        >
                                            {selected && <Icon name="check" size={12} />}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Hue, Saturation & Lightness spectrum sliders */}
                            <div className="cpicker-sliders">
                                <label className="cpicker-slider-row">
                                    <div className="cpicker-slider-head">
                                        <span>{t('Hue')}</span>
                                        <span className="mono cpicker-slider-val" dir="ltr">
                                            {effectiveHue}°
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        dir="ltr"
                                        min={0}
                                        max={359}
                                        value={effectiveHue}
                                        aria-label={t('Hue')}
                                        onChange={(e) => handleHueChange(Number(e.target.value))}
                                        className="cpicker-range cpicker-hue"
                                    />
                                </label>

                                <label className="cpicker-slider-row">
                                    <div className="cpicker-slider-head">
                                        <span>{t('Saturation')}</span>
                                        <span className="mono cpicker-slider-val" dir="ltr">
                                            {hsl.s}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        dir="ltr"
                                        min={0}
                                        max={100}
                                        value={hsl.s}
                                        aria-label={t('Saturation')}
                                        onChange={(e) => handleSatChange(Number(e.target.value))}
                                        style={{
                                            background: `linear-gradient(to right, ${hslToHex(effectiveHue, 0, Math.max(20, Math.min(80, hsl.l)))}, ${hslToHex(effectiveHue, 100, Math.max(20, Math.min(80, hsl.l)))})`,
                                        }}
                                        className="cpicker-range cpicker-sat"
                                    />
                                </label>

                                <label className="cpicker-slider-row">
                                    <div className="cpicker-slider-head">
                                        <span>{t('Lightness')}</span>
                                        <span className="mono cpicker-slider-val" dir="ltr">
                                            {hsl.l}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        dir="ltr"
                                        min={15}
                                        max={85}
                                        value={Math.max(15, Math.min(85, hsl.l))}
                                        aria-label={t('Lightness')}
                                        onChange={(e) => handleLightChange(Number(e.target.value))}
                                        style={{
                                            background: `linear-gradient(to right, ${hslToHex(effectiveHue, hsl.s, 15)}, ${hslToHex(effectiveHue, hsl.s, 50)}, ${hslToHex(effectiveHue, hsl.s, 85)})`,
                                        }}
                                        className="cpicker-range cpicker-light"
                                    />
                                </label>
                            </div>

                            {/* Live hex input + reset button */}
                            <div className="cpicker-footer">
                                <div className="cpicker-hex-box" dir="ltr">
                                    <span
                                        className="cpicker-dot sm"
                                        style={{ backgroundColor: safeHex }}
                                        aria-hidden="true"
                                    />
                                    <input
                                        type="text"
                                        className="cpicker-hex-input mono"
                                        aria-label="Hex color"
                                        value={hexDraft ?? safeHex.toUpperCase()}
                                        maxLength={7}
                                        onChange={(e) => handleHexInput(e.target.value)}
                                        onBlur={() => setHexDraft(null)}
                                    />
                                </div>
                                {showReset && normalizedDefault && (
                                    <button
                                        type="button"
                                        className="cpicker-reset"
                                        onClick={() => {
                                            setHexDraft(null);
                                            onChange(normalizedDefault);
                                        }}
                                    >
                                        <Icon name="reset" size={12} />
                                        <span>{t('Reset')}</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    </>,
                    document.body
                )}
        </div>
    );
}
