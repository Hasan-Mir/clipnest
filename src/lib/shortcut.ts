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

/** Converts a KeyboardEvent into the string format understood by the Rust global-shortcut parser. */
export function eventToShortcut(e: KeyboardEvent | React.KeyboardEvent, allowBare = false): string | null {
    const code = e.code;
    const keyName = e.key;
    if (
        /^(Control|Shift|Alt|Meta)(Left|Right)?$/i.test(code) ||
        /^(Control|Shift|Alt|Meta)$/i.test(keyName)
    ) {
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
