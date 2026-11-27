import type { Pinboard } from './api';

export interface TabRect {
    id: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/**
 * Resolves the live list of categories to render in the tab bar.
 * When `reorderIds` is active, maps each draft ID to its live `Pinboard` record (so live item counts
 * and renames stay fresh, deleted boards drop out, and newly created boards append cleanly).
 */
export function resolveDisplayedBoards(boards: Pinboard[], reorderIds: number[] | null): Pinboard[] {
    if (!reorderIds) {
        return boards;
    }
    const byId = new Map(boards.map((b) => [b.id, b]));
    const ordered: Pinboard[] = [];
    const seen = new Set<number>();
    for (const id of reorderIds) {
        if (seen.has(id)) {
            continue;
        }
        const b = byId.get(id);
        if (b) {
            ordered.push(b);
            seen.add(id);
        }
    }
    for (const b of boards) {
        if (!seen.has(b.id)) {
            ordered.push(b);
        }
    }
    return ordered;
}

/**
 * Moves `draggedId` to `targetId`'s index in `ids`, returning the original array if unchanged.
 */
export function moveBoardId(ids: number[], draggedId: number, targetId: number): number[] {
    if (draggedId === targetId) {
        return ids;
    }
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
        return ids;
    }
    const next = ids.slice();
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggedId);
    return next;
}

/**
 * Oscillation-free spatial hit-test for category tab reordering.
 * Supports LTR, RTL, single-row horizontal scrolling, and multi-row wrapped category bars.
 * On the same row, only swaps once the pointer crosses the target tab's horizontal midpoint in the
 * direction of movement, preventing flicker when swapping tabs of unequal widths.
 */
export function computeReorderTargetId(
    draggedId: number,
    pointerX: number,
    pointerY: number,
    rects: TabRect[],
    rtl: boolean,
    wrapped: boolean
): number | null {
    if (rects.length < 2) {
        return null;
    }
    const fromIdx = rects.findIndex((r) => r.id === draggedId);
    if (fromIdx === -1) {
        return null;
    }
    const draggedRect = rects[fromIdx];

    for (let i = 0; i < rects.length; i++) {
        if (i === fromIdx) {
            continue;
        }
        const r = rects[i];
        const inX = pointerX >= r.left && pointerX <= r.right;
        const inY = !wrapped || (pointerY >= r.top && pointerY <= r.bottom);
        if (!inX || !inY) {
            continue;
        }

        const sameRow = !wrapped || Math.abs(r.top - draggedRect.top) <= 10;
        if (!sameRow) {
            return r.id;
        }

        const midX = (r.left + r.right) / 2;
        const movingForward = i > fromIdx;
        if (movingForward) {
            const crossed = rtl ? pointerX <= midX : pointerX >= midX;
            return crossed ? r.id : null;
        }
        const crossed = rtl ? pointerX >= midX : pointerX <= midX;
        return crossed ? r.id : null;
    }

    if (!wrapped) {
        const first = rects[0];
        const last = rects[rects.length - 1];
        if (rtl) {
            if (pointerX > first.right && fromIdx !== 0) {
                return first.id;
            }
            if (pointerX < last.left && fromIdx !== rects.length - 1) {
                return last.id;
            }
        } else {
            if (pointerX < first.left && fromIdx !== 0) {
                return first.id;
            }
            if (pointerX > last.right && fromIdx !== rects.length - 1) {
                return last.id;
            }
        }
    }

    return null;
}
