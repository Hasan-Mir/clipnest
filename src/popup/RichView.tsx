import React, { memo, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { parseCssColor } from '../lib/format';
import { highlightDomElement, SearchMode } from '../lib/highlightMatch';

// ───────────── HTML cache ─────────────
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(id: number, ts?: number): string {
    return `${id}:${ts ?? 0}`;
}

async function loadHtml(id: number, ts?: number): Promise<string | null> {
    const key = cacheKey(id, ts);
    if (cache.has(key)) {
        return cache.get(key) ?? null;
    }
    const existing = inflight.get(key);
    if (existing) {
        return existing;
    }
    const p: Promise<string | null> = api
        .getHtml(id)
        .then((raw) => {
            const clean = raw ? sanitizeHtml(raw) : null;
            if (cache.size > 80) {
                const firstKey = cache.keys().next().value;
                if (firstKey !== undefined) {
                    cache.delete(firstKey);
                }
            }
            cache.set(key, clean);
            inflight.delete(key);
            return clean;
        })
        .catch(() => {
            inflight.delete(key);
            return null;
        });
    inflight.set(key, p);
    return p;
}

export function forgetHtml(id: number) {
    const prefix = `${id}:`;
    for (const k of Array.from(cache.keys())) {
        if (k === String(id) || k.startsWith(prefix)) {
            cache.delete(k);
        }
    }
}

// ───────────── sanitiser ─────────────
// The HTML comes from other applications, so it is parsed inertly (DOMParser never runs scripts) and
// stripped of anything active or networked. What remains is only structure + inline/embedded styling.

const REMOVE =
    'script,iframe,frame,frameset,object,embed,applet,link,meta,base,form,input,button,textarea,select,noscript,audio,video,source,track,portal,template';

function cleanCss(css: string): string {
    return css
        .replace(/@import[^;]*;?/gi, '')
        .replace(/expression\s*\([^)]*\)/gi, 'none')
        .replace(/url\(\s*(?!['"]?\s*data:image\/)[^)]*\)/gi, 'none'); // no remote loads (privacy/tracking)
}

export function sanitizeHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(REMOVE).forEach((e) => e.remove());
    doc.querySelectorAll('style').forEach((st) => {
        st.textContent = cleanCss(st.textContent || '');
    });
    doc.querySelectorAll('*').forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
            const n = attr.name.toLowerCase();
            if (
                n.startsWith('on') ||
                n === 'href' ||
                n === 'xlink:href' ||
                n === 'srcset' ||
                n === 'action' ||
                n === 'formaction' ||
                n === 'poster' ||
                n === 'background'
            ) {
                el.removeAttribute(attr.name);
            } else if (n === 'src' && !/^\s*data:image\//i.test(attr.value)) {
                el.removeAttribute(attr.name);
            } else if (n === 'style') {
                el.setAttribute('style', cleanCss(attr.value));
            }
        }
    });
    const styles = Array.from(doc.head.querySelectorAll('style'))
        .map((s) => s.outerHTML)
        .join('');
    return styles + doc.body.innerHTML;
}

// ───────────── background ("paper") choice ─────────────
// Pages copied from the web often carry dark text and no background (or transparent background).
// On a dark list that would be unreadable, so such content gets a light paper (and light text gets a dark one).
// Content that defines its own opaque background (VS Code, Word…) is shown untouched.
function hasOpaqueBgColor(html: string): boolean {
    for (const m of html.matchAll(/\sbgcolor\s*=\s*['"]?([^'"\s>]+)/gi)) {
        const c = parseCssColor(m[1].trim());
        if (c && c[3] > 0.05) {
            return true;
        }
    }
    for (const m of html.matchAll(/(?:^|[;\s"'])background(?:-color)?\s*:\s*([^;"'>]+)/gi)) {
        const raw = m[1].trim();
        if (/^(transparent|none|inherit|initial|unset)$/i.test(raw)) {
            continue;
        }
        const direct = parseCssColor(raw);
        if (direct && direct[3] > 0.05) {
            return true;
        }
        const tokens = raw.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-zA-Z]+/g) ?? [];
        for (const tok of tokens) {
            if (
                /^(transparent|none|inherit|initial|unset|scroll|fixed|local|repeat|no-repeat|center|top|bottom|left|right|cover|contain|border-box|padding-box|content-box)$/i.test(
                    tok
                )
            ) {
                continue;
            }
            const parsed = parseCssColor(tok);
            if (parsed && parsed[3] > 0.05) {
                return true;
            }
        }
    }
    return false;
}

function pickPaper(html: string): string | null {
    if (hasOpaqueBgColor(html)) {
        return null;
    }
    const cols = Array.from(html.matchAll(/(?:^|[;\s"'])color\s*:\s*([^;"'>]+)/gi))
        .slice(0, 40)
        .map((m) => parseCssColor(m[1].trim()));
    const ok = cols.filter((c): c is [number, number, number, number] => !!c && c[3] > 0.05);
    if (!ok.length) {
        return null;
    }
    const lum = ok.reduce((a, c) => a + (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255, 0) / ok.length;
    return lum > 0.6 ? '#1e1e1e' : '#ffffff';
}

const BASE_CSS = `
  :host {
    display: block;
    overflow: hidden;
    line-height: 1.4;
    word-break: break-word;
    contain: content;
    position: relative;
    padding: 4px 6px;
    box-sizing: border-box;
  }
  body, pre, p, div { margin: 0; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { pointer-events: none; }
  * { cursor: inherit; }
  mark.shl {
    background-color: var(--hl-bg, transparent);
    color: var(--hl-color, inherit);
    font-weight: 700;
    padding: 0;
    margin: 0;
    border: 0;
    display: inline;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
  }
`;

interface Props {
    id: number;
    ts?: number;
    lines: number;
    full?: boolean;
    query?: string;
    searchMode?: SearchMode;
    highlight?: boolean;
    /** called when there is no HTML after all (so the caller can fall back to plain text) */
    onMissing?: () => void;
}

type RichHostStyle = React.CSSProperties & {
    '--rl'?: number;
};

export const RichView = memo(function RichView({
    id,
    ts,
    lines,
    full,
    query = '',
    searchMode = 'smart',
    highlight = true,
    onMissing,
}: Props) {
    const host = useRef<HTMLDivElement>(null);
    const key = cacheKey(id, ts);
    const [state, setState] = useState<'loading' | 'ok' | 'none'>(
        cache.has(key) ? (cache.get(key) ? 'ok' : 'none') : 'loading'
    );
    const [paper, setPaper] = useState<string | null>(null);
    const [overflowing, setOverflowing] = useState(false);

    useEffect(() => {
        let alive = true;
        loadHtml(id, ts).then((html) => {
            if (!alive) {
                return;
            }
            if (!html || !host.current) {
                setState('none');
                onMissing?.();
                return;
            }
            const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${BASE_CSS}</style>${html}`;
            if (highlight && query.trim()) {
                highlightDomElement(root, query, searchMode, highlight);
            }
            setPaper(pickPaper(html));
            setState('ok');
            if (!full && host.current) {
                const el = host.current;
                setOverflowing(el.scrollHeight > el.clientHeight + 4);
            } else {
                setOverflowing(false);
            }
        });
        return () => {
            alive = false;
        };
    }, [id, ts, full, query, searchMode, highlight, onMissing]);

    if (state === 'none') {
        return null;
    }
    const style: RichHostStyle = {
        '--rl': lines,
        maxHeight: full ? undefined : `calc(var(--rl) * 1.55em + 12px)`,
        overflow: full ? 'auto' : 'hidden',
        background: paper ?? undefined,
        color: paper === '#ffffff' ? '#1a1a1a' : paper ? '#f0f0f0' : undefined,
        padding: paper ? '6px 8px' : undefined,
        borderRadius: paper ? 6 : undefined,
        visibility: state === 'loading' ? 'hidden' : 'visible',
        minHeight: state === 'loading' ? 18 : undefined,
        WebkitMaskImage:
            !full && overflowing ? 'linear-gradient(to bottom, #000 78%, transparent 100%)' : undefined,
        maskImage:
            !full && overflowing ? 'linear-gradient(to bottom, #000 78%, transparent 100%)' : undefined,
    };
    return <div ref={host} className="rich-host" style={style} dir="auto" />;
});
