import { useEffect, useState } from 'react';
import { LOCALE_MAP, LOCALES, LocaleDefinition } from './locales';

export { LOCALES, LOCALE_MAP };
export type { LocaleDefinition };
export type Lang = string;

let current: Lang = 'en';
const listeners = new Set<() => void>();

/** Switches the UI language (and the text direction of the whole window). */
export function setLang(l: Lang) {
    const def = LOCALE_MAP[l] ?? LOCALE_MAP.en;
    if (def.code === current && (typeof document === 'undefined' || document.documentElement.dir === def.dir)) {
        return;
    }
    current = def.code;
    if (typeof document !== 'undefined') {
        document.documentElement.lang = def.code;
        document.documentElement.dir = def.dir;
    }
    listeners.forEach((f) => f());
}

export function getLang(): Lang {
    return current;
}

export function isRtl(l: Lang = current): boolean {
    const def = LOCALE_MAP[l] ?? LOCALE_MAP.en;
    return def.dir === 'rtl';
}

/** English text is the key. Translations come from the active locale; `{name}` placeholders are filled from `vars`. */
export function t(s: string, vars?: Record<string, string | number>): string {
    const dict = LOCALE_MAP[current]?.translations;
    let out = dict ? (dict[s] ?? s) : s;
    if (vars) {
        out = out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
    }
    return out;
}

export function num(n: number): string {
    if (current === 'fa') {
        return n.toLocaleString('fa-IR');
    }
    if (current === 'ar') {
        return n.toLocaleString('ar-EG');
    }
    return n.toLocaleString('en-US');
}

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
    const [, force] = useState(0);
    useEffect(() => {
        const l = () => force((x) => x + 1);
        listeners.add(l);
        return () => {
            listeners.delete(l);
        };
    }, []);
    return current;
}
