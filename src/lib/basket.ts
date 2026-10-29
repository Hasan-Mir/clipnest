import type { BasketRow, TransferProgress } from './api';
import { basename } from './format';

/** A top-level entry of the Drop Basket list: a single row, or several files that share one folder. */
export type BasketNode =
    { type: 'row'; row: BasketRow } | { type: 'group'; key: string; parent: string; name: string; rows: BasketRow[] };

const normPath = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

/**
 * Groups basket rows by the folder they live in.
 * - Only files/folders that share a parent with at least one other row form a group; a lone file stays a plain row.
 * - Images (no path) are never grouped.
 * - Order follows the first appearance of every folder, rows keep their collection order.
 */
export function groupBasketRows(rows: BasketRow[], groupByFolder: boolean): BasketNode[] {
    if (!groupByFolder) {
        return rows.map((row) => ({ type: 'row', row }));
    }
    const buckets = new Map<string, BasketRow[]>();
    for (const r of rows) {
        if (r.kind === 'file' && r.parent) {
            const k = normPath(r.parent);
            const b = buckets.get(k);
            if (b) {
                b.push(r);
            } else {
                buckets.set(k, [r]);
            }
        }
    }
    const out: BasketNode[] = [];
    const emitted = new Set<string>();
    for (const r of rows) {
        const k = r.kind === 'file' && r.parent ? normPath(r.parent) : null;
        const bucket = k ? buckets.get(k) : undefined;
        if (!k || !bucket || bucket.length < 2) {
            out.push({ type: 'row', row: r });
            continue;
        }
        if (emitted.has(k)) {
            continue;
        }
        emitted.add(k);
        out.push({
            type: 'group',
            key: k,
            parent: r.parent as string,
            name: folderName(r.parent as string),
            rows: bucket,
        });
    }
    return out;
}

/** Last path segment of a folder path ("C:\\Users\\me\\Docs" → "Docs", "C:\\" → "C:\\"). */
export function folderName(p: string): string {
    const trimmed = p.replace(/[\\/]+$/, '');
    if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) {
        return p;
    }
    return basename(trimmed);
}

/** Overall progress 0..100 of a running transfer (finished items + fraction of the current one). */
export function progressPercent(p: Pick<TransferProgress, 'done' | 'failed' | 'total' | 'fraction'>): number {
    if (p.total <= 0) {
        return 0;
    }
    const v = ((p.done + p.failed + Math.min(Math.max(p.fraction, 0), 1)) / p.total) * 100;
    return Math.round(Math.min(100, Math.max(0, v)));
}

/** True when every row of the list is marked Cut. */
export function allCut(rows: BasketRow[]): boolean {
    return rows.length > 0 && rows.every((r) => r.cut);
}
