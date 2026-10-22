export function relTime(ts: number, now = Date.now(), lang: string = 'en'): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 5) {
        if (lang === 'fa') {
            return 'الان';
        }
        if (lang === 'ar') {
            return 'الآن';
        }
        if (lang === 'es') {
            return 'Ahora mismo';
        }
        if (lang === 'zh') {
            return '刚刚';
        }
        if (lang === 'ru') {
            return 'Только что';
        }
        if (lang === 'de') {
            return 'Gerade eben';
        }
        if (lang === 'fr') {
            return "À l'instant";
        }
        if (lang === 'tr') {
            return 'Az önce';
        }
        return 'now';
    }
    if (s < 60) {
        if (lang === 'fa') {
            return `${s} ثانیه`;
        }
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        if (lang === 'fa') {
            return `${m} دقیقه`;
        }
        return `${m}m`;
    }
    const h = Math.floor(m / 60);
    if (h < 24) {
        if (lang === 'fa') {
            return `${h} ساعت`;
        }
        return `${h}h`;
    }
    const d = Math.floor(h / 24);
    if (d < 30) {
        if (lang === 'fa') {
            return `${d} روز`;
        }
        return `${d}d`;
    }
    const mo = Math.max(1, Math.floor(d / 30));
    if (lang === 'fa') {
        return `${mo} ماه`;
    }
    return `${mo}mo`;
}

export function hostOf(url: string): string {
    try {
        const u = new URL(url.trim());
        const host = u.protocol === 'mailto:' ? u.pathname : u.host || url;
        return host.replace(/^www\./i, '');
    } catch {
        return url;
    }
}

export const urlHost = hostOf;

export function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

export function extOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i > 0 && i < name.length - 1 ? name.slice(i + 1, i + 5).toUpperCase() : 'FILE';
}

export function humanSize(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const fmtBytes = humanSize;

export function detectDir(text: string): 'rtl' | 'ltr' {
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (
            (code >= 0x0590 && code <= 0x08ff) ||
            (code >= 0xfb1d && code <= 0xfdff) ||
            (code >= 0xfe70 && code <= 0xfeff)
        ) {
            return 'rtl';
        }
        if (
            (code >= 0x0041 && code <= 0x005a) ||
            (code >= 0x0061 && code <= 0x007a) ||
            (code >= 0x00c0 && code <= 0x02af)
        ) {
            return 'ltr';
        }
    }
    return 'ltr';
}

export function appColor(exe: string): string {
    let h = 0;
    for (const c of exe.toLowerCase()) {
        h = (h * 31 + c.charCodeAt(0)) % 360;
    }
    return `hsl(${h} 55% 48%)`;
}

// ── colour conversions (HEX / RGB / HSL) & dynamic WCAG contrast ──
export function parseCssColor(input: string): [number, number, number, number] | null {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed || /^(transparent|none|inherit|initial|unset|currentcolor)$/.test(trimmed)) {
        return null;
    }
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed);
    if (hexMatch) {
        const h = hexMatch[1];
        if (h.length === 3) {
            return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
        }
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return [r, g, b, a];
    }
    const rgbMatch =
        /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(
            trimmed
        );
    if (rgbMatch) {
        return [
            Number(rgbMatch[1]),
            Number(rgbMatch[2]),
            Number(rgbMatch[3]),
            rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1,
        ];
    }
    if (typeof document === 'undefined') {
        return null;
    }
    const c = document.createElement('canvas').getContext('2d');
    if (!c) {
        return null;
    }
    c.fillStyle = 'rgba(1, 2, 3, 0.5)';
    c.fillStyle = trimmed;
    const v = c.fillStyle as string;
    if (v === 'rgba(1, 2, 3, 0.5)' && !trimmed.includes('1, 2, 3')) {
        return null;
    }
    if (v.startsWith('#')) {
        return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
    }
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) {
        return null;
    }
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p[3] ?? 1];
}

/**
 * Computes WCAG 2.1 relative luminance of a background colour and returns `#000` (dark text)
 * for bright backgrounds (such as neon green, yellow, cyan, or white) and `#fff` (light text)
 * for darker backgrounds.
 */
export function contrastOn(bgColor: string): '#000' | '#fff' {
    const rgba = parseCssColor(bgColor);
    if (!rgba) {
        return '#fff';
    }
    const [r, g, b] = rgba;
    const toLinear = (c: number) => {
        const s = c / 255;
        if (s <= 0.03928) {
            return s / 12.92;
        }
        return Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    if (lum > 0.36) {
        return '#000';
    }
    return '#fff';
}

export function colorFormats(input: string): { label: string; value: string }[] {
    const rgba = parseCssColor(input);
    if (!rgba) {
        return [];
    }
    const [r, g, b, a] = rgba;
    const hex = '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    const r1 = r / 255;
    const g1 = g / 255;
    const b1 = b / 255;
    const max = Math.max(r1, g1, b1);
    const min = Math.min(r1, g1, b1);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (max === r1) {
            h = ((g1 - b1) / d) % 6;
        } else if (max === g1) {
            h = (b1 - r1) / d + 2;
        } else {
            h = (r1 - g1) / d + 4;
        }
        h = Math.round(h * 60);
        if (h < 0) {
            h += 360;
        }
    }
    const out = [
        { label: 'HEX', value: hex.toUpperCase() },
        { label: 'RGB', value: `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})` },
        { label: 'HSL', value: `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)` },
    ];
    if (a < 1) {
        out.push({
            label: 'RGBA',
            value: `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(2)})`,
        });
    }
    return out;
}
