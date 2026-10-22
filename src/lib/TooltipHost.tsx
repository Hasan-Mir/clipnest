import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface TipState {
    text: string;
    anchor: DOMRect;
}

/**
 * Global animated tooltip host rendering `data-tip` attributes across all windows.
 */
export function TooltipHost() {
    const [tip, setTip] = useState<TipState | null>(null);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<number | undefined>(undefined);
    const activeElRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const clear = () => {
            window.clearTimeout(timerRef.current);
            activeElRef.current = null;
            setTip(null);
            setPos(null);
        };

        const onMouseOver = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            const el = target?.closest?.('[data-tip]') as HTMLElement | null;
            if (!el) {
                if (activeElRef.current) {
                    clear();
                }
                return;
            }
            const text = el.getAttribute('data-tip')?.trim() ?? '';
            if (!text) {
                clear();
                return;
            }
            if (activeElRef.current === el) {
                return;
            }
            window.clearTimeout(timerRef.current);
            activeElRef.current = el;
            timerRef.current = window.setTimeout(() => {
                if (activeElRef.current && document.body.contains(activeElRef.current)) {
                    setTip({ text, anchor: activeElRef.current.getBoundingClientRect() });
                }
            }, 210);
        };

        const onMouseOut = (e: MouseEvent) => {
            const rel = e.relatedTarget as HTMLElement | null;
            if (activeElRef.current && rel && activeElRef.current.contains(rel)) {
                return;
            }
            clear();
        };

        window.addEventListener('mouseover', onMouseOver, true);
        window.addEventListener('mouseout', onMouseOut, true);
        window.addEventListener('mousedown', clear, true);
        window.addEventListener('keydown', clear, true);
        window.addEventListener('scroll', clear, true);
        window.addEventListener('blur', clear);
        return () => {
            window.clearTimeout(timerRef.current);
            window.removeEventListener('mouseover', onMouseOver, true);
            window.removeEventListener('mouseout', onMouseOut, true);
            window.removeEventListener('mousedown', clear, true);
            window.removeEventListener('keydown', clear, true);
            window.removeEventListener('scroll', clear, true);
            window.removeEventListener('blur', clear);
        };
    }, []);

    useLayoutEffect(() => {
        if (!tip || !tipRef.current) {
            return;
        }
        const el = tipRef.current;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = tip.anchor.left + (tip.anchor.width - w) / 2;
        left = Math.max(6, Math.min(left, vw - w - 6));
        let top = tip.anchor.bottom + 6;
        if (top + h > vh - 6) {
            top = Math.max(6, tip.anchor.top - h - 6);
        }
        setPos({ left, top });
    }, [tip]);

    if (!tip) {
        return null;
    }

    return (
        <div
            ref={tipRef}
            className="custom-tooltip"
            dir="auto"
            style={{
                left: pos ? pos.left : -9999,
                top: pos ? pos.top : -9999,
            }}
        >
            {tip.text}
        </div>
    );
}
