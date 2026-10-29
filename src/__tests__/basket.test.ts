import { describe, expect, it } from 'vitest';
import type { BasketRow } from '../lib/api';
import { allCut, folderName, groupBasketRows, progressPercent } from '../lib/basket';
import { LOCALE_MAP, setLang, t } from '../lib/i18n';

const row = (id: number, path: string | null, over: Partial<BasketRow> = {}): BasketRow => {
    const parts = path ? path.split('\\') : [];
    return {
        key: `${id}|${path ?? ''}`,
        id,
        kind: path ? 'file' : 'image',
        path,
        name: parts[parts.length - 1] ?? '',
        parent: path ? parts.slice(0, -1).join('\\') : null,
        is_dir: false,
        exists: true,
        cut: false,
        img_w: null,
        img_h: null,
        ...over,
    };
};

describe('groupBasketRows', () => {
    const rows = [
        row(1, 'C:\\a\\x.txt'),
        row(2, 'C:\\b\\y.txt'),
        row(1, 'C:\\a\\z.txt'),
        row(3, null),
        row(4, 'c:\\A\\w.txt'),
    ];

    it('lists every row separately when grouping is off', () => {
        const out = groupBasketRows(rows, false);
        expect(out).toHaveLength(5);
        expect(out.every((n) => n.type === 'row')).toBe(true);
    });

    it('groups files sharing a folder (case-insensitive) at first appearance', () => {
        const out = groupBasketRows(rows, true);
        expect(out.map((n) => n.type)).toEqual(['group', 'row', 'row']);
        const g = out[0];
        expect(g.type === 'group' && g.rows).toHaveLength(3);
        expect(g.type === 'group' && g.name).toBe('a');
    });

    it('keeps lone files and images as plain rows', () => {
        const out = groupBasketRows([row(1, 'C:\\a\\x'), row(2, null)], true);
        expect(out.every((n) => n.type === 'row')).toBe(true);
    });
});

describe('basket helpers', () => {
    it('folderName handles trailing slashes and drive roots', () => {
        expect(folderName('C:\\Users\\me\\Docs\\')).toBe('Docs');
        expect(folderName('C:\\')).toBe('C:\\');
    });

    it('progressPercent combines finished items and current fraction', () => {
        expect(progressPercent({ done: 1, failed: 1, total: 4, fraction: 0.5 })).toBe(63);
        expect(progressPercent({ done: 0, failed: 0, total: 0, fraction: 0 })).toBe(0);
        expect(progressPercent({ done: 4, failed: 0, total: 4, fraction: 1 })).toBe(100);
    });

    it('allCut requires a non-empty all-cut list', () => {
        expect(allCut([])).toBe(false);
        expect(allCut([row(1, 'C:\\a\\x', { cut: true })])).toBe(true);
        expect(allCut([row(1, 'C:\\a\\x', { cut: true }), row(2, 'C:\\a\\y')])).toBe(false);
    });
});

describe('i18n completeness across all locales', () => {
    const requiredKeys = [
        'This category is empty — drag cards onto its tab',
        'Paste queue / Drop Basket',
        'Open file location',
        'Open folder location',
        'Drop Basket: group files by folder',
        'Because of the errors, no original file was deleted.',
    ];

    it('translates required UI and Drop Basket strings in every non-English locale', () => {
        for (const code of ['fa', 'ar', 'de', 'es', 'fr', 'ru', 'tr', 'zh']) {
            const def = LOCALE_MAP[code];
            expect(def).toBeDefined();
            for (const k of requiredKeys) {
                expect(def.translations[k], `Missing "${k}" in locale "${code}"`).toBeTruthy();
            }
        }
        setLang('ar');
        expect(t('Paste queue / Drop Basket')).toBe('طابور اللصق / سلة الملفات');
        setLang('en');
    });
});
