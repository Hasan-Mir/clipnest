import { describe, expect, it } from 'vitest';
import { highlightMatch } from '../lib/highlightMatch';

describe('highlightMatch search highlighting & FTS5 query cleaning', () => {
    it('returns original text unchanged when query is empty or whitespace', () => {
        expect(highlightMatch('Hello ClipNest', '')).toBe('Hello ClipNest');
        expect(highlightMatch('Hello ClipNest', '   ')).toBe('Hello ClipNest');
    });

    it('strips FTS5 column prefixes (content:, ocr:, notes:, app:) before matching', () => {
        const res = highlightMatch('ClipNest clipboard manager', 'content:clipboard');
        expect(Array.isArray(res)).toBe(true);
    });

    it('strips boolean operators (AND, OR, NOT) and special FTS syntax characters (*, ^, quotes, parens)', () => {
        const res = highlightMatch(
            'Error 404 in production server',
            'content:"Error" AND NOT (staging*) OR production^'
        );
        expect(Array.isArray(res)).toBe(true);
        const serialized = JSON.stringify(res);
        expect(serialized).toContain('Error');
        expect(serialized).toContain('production');
        expect(serialized).not.toContain('"AND"');
        expect(serialized).not.toContain('"NOT"');
    });

    it('returns original text when query consists solely of FTS5 operators', () => {
        expect(highlightMatch('AND OR NOT', 'AND OR NOT')).toBe('AND OR NOT');
        expect(highlightMatch('Hello World', '"" () * ^')).toBe('Hello World');
    });

    it('escapes regex metacharacters safely in user search terms', () => {
        const text = 'Price is $100.00 (USD) [final]';
        const res = highlightMatch(text, '$100.00 [final]');
        expect(Array.isArray(res)).toBe(true);
        const serialized = JSON.stringify(res);
        expect(serialized).toContain('$100.00');
        expect(serialized).toContain('[final]');
    });

    it('handles Persian and RTL search terms accurately', () => {
        const text = 'برنامه مدیریت کلیپ‌بورد ویندوز';
        const res = highlightMatch(text, 'مدیریت کلیپ‌بورد');
        expect(Array.isArray(res)).toBe(true);
        const serialized = JSON.stringify(res);
        expect(serialized).toContain('مدیریت');
        expect(serialized).toContain('کلیپ‌بورد');
    });
});
