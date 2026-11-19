// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../popup/RichView';

describe('sanitizeHtml security & mXSS defense', () => {
    it('blocks <svg><style> and <math><style> mXSS breakout payloads', () => {
        const svgPayload = '<svg><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></svg>';
        const mathPayload = '<math><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></math>';
        for (const payload of [svgPayload, mathPayload]) {
            const out = sanitizeHtml(payload);
            const host = document.createElement('div');
            host.innerHTML = out;
            expect(host.querySelector('img')).toBeNull();
            expect(out.toLowerCase()).not.toContain('onerror');
        }
    });

    it('blocks CSS escape and image-set remote resource loads', () => {
        const cssBypass =
            '<div style="background:\\75 rl(https://evil.example/p.png);background-image:image-set(\'https://evil.example/a.png\' 1x)">hi</div>';
        const out = sanitizeHtml(cssBypass);
        expect(out).not.toContain('https://evil.example');
    });

    it('blocks non-hex backslash escaped url() loads (e.g. \\u\\r\\l)', () => {
        const nonHexUrl = '<div style="background:\\u\\r\\l(https://evil.example/t.png)">hi</div>';
        const out = sanitizeHtml(nonHexUrl);
        expect(out).not.toContain('https://evil.example');
        expect(out).not.toContain('url');
    });

    it('neutralizes nested style breakout attempts via \\3c without HTML injection', () => {
        const breakoutPayload = '<style>\\3c /sty\\3c /stylele><img src=x onerror=alert(1)></style>';
        const out = sanitizeHtml(breakoutPayload);
        const host = document.createElement('div');
        host.innerHTML = out;
        // The attempt to close </style> failed because '<' was escaped to '\3c '
        // Thus <img> is never created as a DOM element and remains inert CSS text
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelectorAll('*').length).toBe(1);
        expect(host.querySelector('style')).not.toBeNull();
        expect(host.querySelector('style')!.textContent).toContain('\\3c img');
    });

    it('handles out-of-range hex code points in CSS without throwing RangeError', () => {
        const invalidHex = '<style>div { content: "\\ffffff"; color: red; }</style>';
        expect(() => sanitizeHtml(invalidHex)).not.toThrow();
        const out = sanitizeHtml(invalidHex);
        expect(out).toContain('\uFFFD');
        expect(out).toContain('color: red');
    });

    it('blocks data:image/svg+xml with embedded scripts', () => {
        const svgData = '<img src="data:image/svg+xml;utf8,<svg onload=alert(1)>">';
        const out = sanitizeHtml(svgData);
        expect(out).not.toContain('data:image/svg+xml');
    });

    it('permits safe inline styling and standard images', () => {
        const safe =
            '<p style="color: red; font-weight: bold;">Hello <b>world</b></p><img src="data:image/png;base64,iVBORw0KGgo=">';
        const out = sanitizeHtml(safe);
        expect(out).toContain('color: red');
        expect(out).toContain('Hello');
        expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
    });
});
