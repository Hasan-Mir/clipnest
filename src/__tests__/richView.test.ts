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

    it('strips backslash-synthesized escapes and line-continued SVG data URLs in CSS', () => {
        const payload1 = '<div style="background:\\5c 75 rl(https://evil.example/p.png)">hi</div>';
        const out1 = sanitizeHtml(payload1);
        expect(out1).not.toContain('\\5c 75 rl');
        expect(out1).not.toContain('\\75 rl');
        expect(out1).toContain('\uFFFD75 rl');

        const payload2 = '<div style="background:\\\\u\\\\r\\\\l(https://evil.example/p.png)">hi</div>';
        const out2 = sanitizeHtml(payload2);
        expect(out2).not.toContain('\\u\\r\\l');
        expect(out2).toContain('\uFFFDu\uFFFDr\uFFFDl');

        const payload3 = '<style>@\\5c 69 mport "https://evil.example/a.css";</style>';
        const out3 = sanitizeHtml(payload3);
        expect(out3).not.toContain('@\\5c 69 mport');
        expect(out3).not.toContain('@\\69 mport');

        const payload4 = '<div style="background:\\5c 69 mage-set(\'https://evil.example/a.png\' 1x)">hi</div>';
        const out4 = sanitizeHtml(payload4);
        expect(out4).not.toContain('\\5c 69 mage-set');
        expect(out4).not.toContain('\\69 mage-set');

        const payload5 = '<div style="background:url(\'data:image/svg+\\\nxml;base64,PHN2Zy8+\')">hi</div>';
        const out5 = sanitizeHtml(payload5);
        expect(out5).not.toContain('PHN2Zy8+');
        expect(out5).toContain('none');
    });

    it('strips nested @import, EOF-unclosed url(, and EOF-unclosed -webkit-image-set while preserving valid raster data URLs', () => {
        // Nested @import in <style> block and inline style
        const nestedImportStyle = '<style>@im@import;port "https://evil.example/a.css"; body { color: red; }</style>';
        const outStyle = sanitizeHtml(nestedImportStyle);
        expect(outStyle).not.toContain('evil.example');
        expect(outStyle).not.toContain('@import');

        // EOF-unclosed url( and -webkit-image-set( in style attribute
        const unclosedInline = '<div style="background: url(https://evil.example/p.png">hi</div>';
        const outInline = sanitizeHtml(unclosedInline);
        expect(outInline).not.toContain('evil.example');
        expect(outInline).toContain('none');

        const unclosedImageSet =
            '<div style="background-image: -webkit-image-set(\'https://evil.example/p.png\' 1x">hi</div>';
        const outImageSet = sanitizeHtml(unclosedImageSet);
        expect(outImageSet).not.toContain('evil.example');
        expect(outImageSet).toContain('none');

        // Valid raster data URL is preserved
        const validRaster = '<div style="background: url(data:image/png;base64,iVBORw0KGgo=)">hi</div>';
        const outRaster = sanitizeHtml(validRaster);
        expect(outRaster).toContain('data:image/png;base64,iVBORw0KGgo=');
    });
});
