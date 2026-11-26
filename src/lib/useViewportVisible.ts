import { RefObject, useEffect, useState } from 'react';

/**
 * Shared viewport-proximity hook powered by a single `IntersectionObserver` (`rootMargin: '300px'`).
 *
 * Why this exists:
 * After removing `virtua` (`VList`) in favor of a paginated native DOM list, off-screen cards stay
 * mounted in the DOM for rock-solid drag-and-drop, focus stability, and declarative CSS Grid delete
 * animations. Heavy card bodies (`RichView` Shadow DOM + `api.getHtml` and `Thumb` + `api.getThumb`)
 * use this hook so off-screen cards remain lightweight placeholders until they scroll within 300px
 * of the viewport — preventing IPC bursts and cache thrashing on initial popup open.
 */

type Listener = (visible: boolean) => void;

const listeners = new WeakMap<Element, Listener>();
let sharedObserver: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver | null {
    if (typeof IntersectionObserver === 'undefined') {
        return null;
    }
    if (!sharedObserver) {
        sharedObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const cb = listeners.get(entry.target);
                        if (cb) {
                            cb(true);
                            sharedObserver?.unobserve(entry.target);
                            listeners.delete(entry.target);
                        }
                    }
                }
            },
            { rootMargin: '300px 0px' }
        );
    }
    return sharedObserver;
}

/**
 * Returns `true` once `ref.current` enters within 300px of the viewport (or immediately when
 * `eager` is true or `IntersectionObserver` is unavailable, e.g. in jsdom tests).
 */
export function useViewportVisible(ref: RefObject<Element | null>, eager = false): boolean {
    const [visible, setVisible] = useState(() => eager || typeof IntersectionObserver === 'undefined');

    useEffect(() => {
        if (eager || visible) {
            return;
        }
        const el = ref.current;
        if (!el) {
            return;
        }
        const obs = getObserver();
        if (!obs) {
            setVisible(true);
            return;
        }
        listeners.set(el, setVisible);
        obs.observe(el);
        return () => {
            obs.unobserve(el);
            listeners.delete(el);
        };
    }, [ref, eager, visible]);

    return eager || visible;
}
