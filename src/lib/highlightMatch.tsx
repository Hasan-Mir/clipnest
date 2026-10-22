import React from 'react';

export type SearchMode = 'smart' | 'regex' | 'fuzzy';

const TYPE_WORDS = new Set([
    'text',
    'texts',
    'code',
    'codes',
    'link',
    'links',
    'url',
    'urls',
    'image',
    'images',
    'img',
    'picture',
    'pictures',
    'file',
    'files',
    'color',
    'colors',
    'colour',
    'colours',
]);

function isSkippedCodeUnit(code: number): boolean {
    return (
        code === 0x200b ||
        code === 0x200c ||
        code === 0x200d ||
        code === 0x0640 ||
        code === 0x0670 ||
        (code >= 0x064b && code <= 0x065f)
    );
}

/**
 * Mirrors Rust's `classify::normalize` while recording the original UTF-16 code-unit index
 * in `map` for each character in `norm`.
 */
export function normWithMap(text: string): { norm: string; map: number[] } {
    let norm = '';
    const map: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (isSkippedCodeUnit(code)) {
            continue;
        }
        const ch = text[i];
        if (ch === 'ي' || ch === 'ى' || ch === 'ئ') {
            norm += 'ی';
            map.push(i);
        } else if (ch === 'ك') {
            norm += 'ک';
            map.push(i);
        } else if (ch === 'ة') {
            norm += 'ه';
            map.push(i);
        } else if (ch === 'أ' || ch === 'إ' || ch === 'ٱ') {
            norm += 'ا';
            map.push(i);
        } else if (code >= 0x06f0 && code <= 0x06f9) {
            norm += String.fromCharCode(48 + (code - 0x06f0));
            map.push(i);
        } else if (code >= 0x0660 && code <= 0x0669) {
            norm += String.fromCharCode(48 + (code - 0x0660));
            map.push(i);
        } else {
            const low = ch.toLowerCase();
            for (let k = 0; k < low.length; k++) {
                norm += low[k];
                map.push(i);
            }
        }
    }
    return { norm, map };
}

function tokenizeSmart(q: string): { token: string; quoted: boolean }[] {
    const out: { token: string; quoted: boolean }[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < q.length; i++) {
        const ch = q[i];
        if (ch === '"') {
            if (cur.length > 0) {
                out.push({ token: cur, quoted: inQ });
                cur = '';
            }
            inQ = !inQ;
        } else if (/\s/.test(ch) && !inQ) {
            if (cur.length > 0) {
                out.push({ token: cur, quoted: false });
                cur = '';
            }
        } else {
            cur += ch;
        }
    }
    if (cur.length > 0) {
        out.push({ token: cur, quoted: inQ });
    }
    return out;
}

/**
 * Finds subsequence character positions in `norm` for `needle`, preferring contiguous
 * runs when available (matching VS Code's quick-open highlight style).
 */
function findSubsequencePositions(norm: string, needle: string): number[] | null {
    if (!needle.length || needle.length > norm.length) {
        return null;
    }
    const direct = norm.indexOf(needle);
    if (direct >= 0) {
        const pos: number[] = [];
        for (let i = 0; i < needle.length; i++) {
            pos.push(direct + i);
        }
        return pos;
    }
    const pos: number[] = [];
    let idx = 0;
    for (let i = 0; i < needle.length; i++) {
        const found = norm.indexOf(needle[i], idx);
        if (found < 0) {
            return null;
        }
        pos.push(found);
        idx = found + 1;
    }
    return pos;
}

function mapSpanToOriginal(map: number[], nStart: number, nEnd: number): [number, number] | null {
    if (nStart < 0 || nEnd <= nStart || nEnd > map.length) {
        return null;
    }
    const start = map[nStart];
    const end = map[nEnd - 1] + 1;
    return [start, end];
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
    if (intervals.length <= 1) {
        return intervals;
    }
    const sorted = [...intervals].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
    const merged: [number, number][] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const prev = merged[merged.length - 1];
        const cur = sorted[i];
        if (cur[0] <= prev[1]) {
            if (cur[1] > prev[1]) {
                prev[1] = cur[1];
            }
        } else {
            merged.push([cur[0], cur[1]]);
        }
    }
    return merged;
}

export function findMatchSpans(text: string, query: string, mode: SearchMode): [number, number][] {
    const q = query.trim();
    if (!text || !q) {
        return [];
    }
    const rawSpans: [number, number][] = [];

    if (mode === 'regex') {
        try {
            const re = new RegExp(q, 'gi');
            let m: RegExpExecArray | null;
            let guard = 0;
            while ((m = re.exec(text)) !== null && guard < 500) {
                guard++;
                if (m[0].length === 0) {
                    re.lastIndex++;
                    continue;
                }
                rawSpans.push([m.index, m.index + m[0].length]);
            }
        } catch {
            return [];
        }
        return mergeIntervals(rawSpans);
    }

    const { norm, map } = normWithMap(text);
    if (!norm.length) {
        return [];
    }

    if (mode === 'fuzzy') {
        const fz = normWithMap(q).norm.replace(/\s+/g, '');
        const pos = findSubsequencePositions(norm, fz);
        if (pos) {
            let runStart = pos[0];
            let runPrev = pos[0];
            for (let i = 1; i < pos.length; i++) {
                if (pos[i] === runPrev + 1) {
                    runPrev = pos[i];
                } else {
                    const sp = mapSpanToOriginal(map, runStart, runPrev + 1);
                    if (sp) {
                        rawSpans.push(sp);
                    }
                    runStart = pos[i];
                    runPrev = pos[i];
                }
            }
            const lastSp = mapSpanToOriginal(map, runStart, runPrev + 1);
            if (lastSp) {
                rawSpans.push(lastSp);
            }
        }
        return mergeIntervals(rawSpans);
    }

    // "smart" mode
    const tokens = tokenizeSmart(q);
    for (const { token, quoted } of tokens) {
        const nTok = normWithMap(token).norm;
        if (!nTok) {
            continue;
        }
        if (!quoted && TYPE_WORDS.has(nTok)) {
            continue;
        }
        let idx = 0;
        let foundSubstring = false;
        while (idx <= norm.length - nTok.length) {
            const hit = norm.indexOf(nTok, idx);
            if (hit < 0) {
                break;
            }
            foundSubstring = true;
            const sp = mapSpanToOriginal(map, hit, hit + nTok.length);
            if (sp) {
                rawSpans.push(sp);
            }
            idx = hit + nTok.length;
        }
        if (!foundSubstring) {
            const pos = findSubsequencePositions(norm, nTok);
            if (pos) {
                for (const p of pos) {
                    const sp = mapSpanToOriginal(map, p, p + 1);
                    if (sp) {
                        rawSpans.push(sp);
                    }
                }
            }
        }
    }

    return mergeIntervals(rawSpans);
}

/**
 * Slices `text` into plain strings and `<mark className="shl">` nodes without breaking
 * Persian or Arabic cursive letter joining.
 */
export function highlightText(
    text: string,
    query: string,
    mode: SearchMode,
    enabled = true
): React.ReactNode {
    if (!enabled || !text || !query.trim()) {
        return text;
    }
    const spans = findMatchSpans(text, query, mode);
    if (spans.length === 0) {
        return text;
    }
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (let i = 0; i < spans.length; i++) {
        const [start, end] = spans[i];
        if (start > cursor) {
            nodes.push(text.slice(cursor, start));
        }
        nodes.push(
            <mark key={i} className="shl">
                {text.slice(start, end)}
            </mark>
        );
        cursor = end;
    }
    if (cursor < text.length) {
        nodes.push(text.slice(cursor));
    }
    return nodes;
}

/**
 * Highlights matched spans inside a DOM / Shadow DOM subtree in-place by wrapping matched
 * text-node slices in `<mark class="shl">`.
 */
export function highlightDomElement(root: Node, query: string, mode: SearchMode, enabled = true): void {
    if (!enabled || !query.trim()) {
        return;
    }
    const doc = root.ownerDocument ?? document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode()) !== null) {
        const parent = current.parentElement;
        if (
            parent &&
            (parent.tagName === 'STYLE' || parent.tagName === 'SCRIPT' || parent.tagName === 'MARK')
        ) {
            continue;
        }
        if (current.nodeValue && current.nodeValue.trim().length > 0) {
            textNodes.push(current as Text);
        }
    }

    for (const tNode of textNodes) {
        const val = tNode.nodeValue ?? '';
        const spans = findMatchSpans(val, query, mode);
        if (spans.length === 0) {
            continue;
        }
        const frag = doc.createDocumentFragment();
        let cursor = 0;
        for (const [start, end] of spans) {
            if (start > cursor) {
                frag.appendChild(doc.createTextNode(val.slice(cursor, start)));
            }
            const mark = doc.createElement('mark');
            mark.className = 'shl';
            mark.textContent = val.slice(start, end);
            frag.appendChild(mark);
            cursor = end;
        }
        if (cursor < val.length) {
            frag.appendChild(doc.createTextNode(val.slice(cursor)));
        }
        tNode.parentNode?.replaceChild(frag, tNode);
    }
}
