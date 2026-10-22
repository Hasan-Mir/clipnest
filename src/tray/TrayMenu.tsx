import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, on, Status } from '../lib/api';
import { num, t, useLang } from '../lib/i18n';
import { Icon } from '../lib/icons';
import { useSettings } from '../lib/useSettings';

export default function TrayMenu() {
    const lang = useLang();
    useSettings();
    const [status, setStatus] = useState<Status | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const load = useCallback(() => {
        api.status()
            .then(setStatus)
            .catch(() => {});
    }, []);

    useEffect(() => {
        load();
        const s1 = on('status-changed', load);
        const s2 = on('tray-shown', load);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                api.hideTray();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            s1.then((u) => u());
            s2.then((u) => u());
            window.removeEventListener('keydown', onKey);
        };
    }, [load]);

    const paused = (status?.paused_until ?? 0) > 0;
    const plain = status?.plain_default ?? false;
    const qActive = status?.queue_active ?? false;
    const qLen = status?.queue_len ?? 0;

    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!el) {
            return;
        }
        const measureAndSync = () => {
            const h = Math.ceil(el.scrollHeight) + 2;
            if (h >= 180) {
                api.resizeTray(h).catch(() => {});
            }
        };
        measureAndSync();
        const ro = new ResizeObserver(measureAndSync);
        ro.observe(el);
        return () => {
            ro.disconnect();
        };
    }, [paused, qActive, lang]);

    return (
        <div ref={menuRef} className="tray-menu">
            <div className="tray-head">
                <img className="logo-img" src="/icon.png" alt="ClipNest" draggable={false} />
                <span className="brand">ClipNest</span>
                <span className="spacer" />
                <button
                    type="button"
                    className={`tray-pill${paused ? ' warn' : ' ok'}`}
                    onClick={() => {
                        if (paused) {
                            api.resume();
                        } else {
                            api.pause(15);
                        }
                    }}
                >
                    {paused ? t('Paused · resume') : t('Active')}
                </button>
            </div>

            <div className="menu-sep" />

            <button
                type="button"
                className="tray-row"
                onClick={() => {
                    api.showPopup();
                }}
            >
                <Icon name="copy" size={14} />
                <span>{t('Open ClipNest')}</span>
            </button>

            <button
                type="button"
                className="tray-row"
                onClick={() => {
                    api.queueToggle();
                    api.hideTray();
                }}
            >
                <Icon name="basket" size={14} />
                <span>{t('Paste queue / Drop Basket')}</span>
                <span className="spacer" />
                {qActive && <span className="tray-count">{num(qLen)}</span>}
            </button>

            <button
                type="button"
                className="tray-row"
                onClick={() => {
                    api.togglePlain();
                }}
            >
                <Icon name="richText" size={14} />
                <span>{t('Plain-text mode')}</span>
                <span className="spacer" />
                <span className={`tray-dot${plain ? ' on' : ''}`} />
            </button>

            <div className="menu-sep" />

            {paused ? (
                <button
                    type="button"
                    className="tray-row accent"
                    onClick={() => {
                        api.resume();
                    }}
                >
                    <Icon name="play" size={14} />
                    <span>{t('Resume capture')}</span>
                </button>
            ) : (
                <div className="tray-pause-block">
                    <div className="tray-pause-label">
                        <Icon name="pause" size={13} />
                        <span>{t('Pause capture')}</span>
                    </div>
                    <div className="tray-chips" dir="ltr">
                        <button type="button" className="chip" onClick={() => api.pause(15)}>
                            15m
                        </button>
                        <button type="button" className="chip" onClick={() => api.pause(60)}>
                            1h
                        </button>
                        <button type="button" className="chip" onClick={() => api.pause(480)}>
                            8h
                        </button>
                        <button type="button" className="chip" onClick={() => api.pause(null)}>
                            ∞
                        </button>
                    </div>
                </div>
            )}

            <div className="menu-sep" />

            <button
                type="button"
                className="tray-row"
                onClick={() => {
                    api.requestEraseFromTray();
                }}
            >
                <Icon name="trash" size={14} />
                <span>{t('Erase history…')}</span>
            </button>

            <button
                type="button"
                className="tray-row"
                onClick={() => {
                    api.openSettings();
                }}
            >
                <Icon name="gear" size={14} />
                <span>{t('Settings…')}</span>
            </button>

            <div className="menu-sep" />

            <button
                type="button"
                className="tray-row danger"
                onClick={() => {
                    api.quit();
                }}
            >
                <Icon name="close" size={14} />
                <span>{t('Quit ClipNest')}</span>
            </button>
        </div>
    );
}
