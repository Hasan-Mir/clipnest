import type React from 'react';

/**
 * Formats currently held modifier keys into a live preview string while recording a shortcut,
 * e.g. "Ctrl + ", "Ctrl + Alt + ", or "Win + Ctrl + ".
 */
export function formatHeldModifiers(
    e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
    includeWin = false
): string {
    const mods: string[] = [];
    if (includeWin || e.metaKey) {
        mods.push('Win');
    }
    if (e.ctrlKey) {
        mods.push('Ctrl');
    }
    if (e.altKey) {
        mods.push('Alt');
    }
    if (e.shiftKey) {
        mods.push('Shift');
    }
    if (mods.length === 0) {
        return '';
    }
    return `${mods.join(' + ')} + `;
}

const PUNCTUATION_CODES: Record<string, string> = {
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    '-': 'Minus',
    '=': 'Equal',
    '`': 'Backquote',
};

/**
 * Checks whether a keyboard event matches the given ASCII letter or punctuation key
 * regardless of the active OS input language (e.g. Persian, Arabic, Russian).
 * Matches physical key position (`e.code`, e.g. `KeyI` for `'i'`, `Comma` for `','`)
 * first, and falls back to `e.key` for remapped layouts or synthetic events without `code`.
 */
export function isKey(e: Pick<KeyboardEvent | React.KeyboardEvent, 'key' | 'code'>, target: string): boolean {
    const t = target.toLowerCase();
    const code = e.code || '';
    if (t.length === 1 && t >= 'a' && t <= 'z') {
        if (code === `Key${t.toUpperCase()}`) {
            return true;
        }
    } else if (PUNCTUATION_CODES[t] && code === PUNCTUATION_CODES[t]) {
        return true;
    } else if (code && code.toLowerCase() === t) {
        return true;
    }
    return (e.key || '').toLowerCase() === t;
}

/**
 * Returns the digit 1..9 if the pressed key is a top-row or numpad digit 1..9
 * (layout-independent via `e.code` with `e.key` fallback), or `null` otherwise.
 */
export function digitOfKey(e: Pick<KeyboardEvent | React.KeyboardEvent, 'key' | 'code'>): number | null {
    const code = e.code || '';
    if (/^Digit[1-9]$/.test(code)) {
        return Number(code.slice(5));
    }
    if (/^Numpad[1-9]$/.test(code)) {
        return Number(code.slice(6));
    }
    const k = e.key || '';
    if (/^[1-9]$/.test(k)) {
        return Number(k);
    }
    return null;
}

/** Converts a KeyboardEvent into the string format understood by the Rust global-shortcut parser. */
export function eventToShortcut(e: KeyboardEvent | React.KeyboardEvent, allowBare = false): string | null {
    const code = e.code;
    const keyName = e.key;
    if (/^(Control|Shift|Alt|Meta)(Left|Right)?$/i.test(code) || /^(Control|Shift|Alt|Meta)$/i.test(keyName)) {
        return null;
    }
    const mods: string[] = [];
    if (e.ctrlKey) {
        mods.push('Ctrl');
    }
    if (e.altKey) {
        mods.push('Alt');
    }
    if (e.shiftKey) {
        mods.push('Shift');
    }
    if (e.metaKey) {
        mods.push('Super');
    }
    let key = code;
    if (code.startsWith('Key')) {
        key = code.slice(3).toUpperCase();
    } else if (code.startsWith('Digit')) {
        key = code.slice(5);
    } else if (!key && keyName.length === 1) {
        key = keyName.toUpperCase();
    }
    if (!key) {
        return null;
    }
    const isF = /^F([1-9]|1\d|2[0-4])$/i.test(key);
    if (!mods.length && !isF && !allowBare) {
        return null;
    }
    return [...mods, key].join('+');
}
