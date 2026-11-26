import { useEffect, useState } from 'react';

/**
 * Returns `true` two animation frames after `active` becomes `true`.
 *
 * Why double `requestAnimationFrame` instead of CSS `@keyframes` on mount:
 * In WebView2/Chromium, a short `@keyframes` animation attached to a newly mounted overlay,
 * modal, or `@floating-ui` menu often elapses before the first composited frame after React
 * commit + layout + `focus()`, making the panel appear to pop in instantaneously. Mounting in
 * the hidden start state (`opacity: 0; transform: scale(...)`) and toggling `.entered` after
 * two animation frames guarantees the browser paints frame 0 first and smoothly plays the
 * entrance transition on every open.
 */
export function useEntered(active: boolean): boolean {
    const [entered, setEntered] = useState(false);

    useEffect(() => {
        if (!active) {
            setEntered(false);
            return;
        }
        let raf1 = 0;
        let raf2 = 0;
        raf1 = window.requestAnimationFrame(() => {
            raf2 = window.requestAnimationFrame(() => {
                setEntered(true);
            });
        });
        return () => {
            window.cancelAnimationFrame(raf1);
            window.cancelAnimationFrame(raf2);
        };
    }, [active]);

    return entered;
}
