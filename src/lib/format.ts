export function relTime(ts: number, now = Date.now(), lang: string = 'en'): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 45) {
        if (lang === 'fa') {
            return 'همین الان';
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
        return 'Just now';
    }
    const locale = lang === 'fa' ? 'fa-IR' : lang;
    let rtf: Intl.RelativeTimeFormat;
    try {
        rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    } catch {
        rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return rtf.format(-Math.max(1, m), 'minute');
    }
    const h = Math.floor(m / 60);
    if (h < 24) {
        return rtf.format(-h, 'hour');
    }
    const d = Math.floor(h / 24);
    if (d < 7) {
        return rtf.format(-d, 'day');
    }
    try {
        return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    } catch {
        return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
}

export function hostOf(url: string): string {
    try {
        const u = new URL(url.trim());
        return u.protocol === 'mailto:' ? u.pathname : u.host || url;
    } catch {
        return url;
    }
}

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

export function appColor(exe: string): string {
    let h = 0;
    for (const c of exe.toLowerCase()) {
        h = (h * 31 + c.charCodeAt(0)) % 360;
    }
    return `hsl(${h} 55% 48%)`;
}

// ── colour conversions (HEX / RGB / HSL) ──
export function parseCssColor(input: string): [number, number, number, number] | null {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed || /^(transparent|none|inherit|initial|unset|currentcolor)$/.test(trimmed)) {
        return null;
    }
    const c = document.createElement('canvas').getContext('2d');
    if (!c) {
        return null;
    }
    c.fillStyle = 'rgba(1, 2, 3, 0.5)';
    c.fillStyle = trimmed;
    const v = c.fillStyle as string; // normalised: #rrggbb or rgba(r, g, b, a)
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
