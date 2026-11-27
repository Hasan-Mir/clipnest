import React, { useEffect, useState } from 'react';
import Popup from '../popup/Popup';
import QueueView from '../queue/Queue';
import { TooltipHost } from '../lib/TooltipHost';
import { CopyDict } from './copy';
import {
    demoCaptureUserCopy,
    demoPatchSettings,
    demoReset,
    demoSimulateCopy,
    emitDemoEvent,
    getDemoStatusSnapshot,
    invoke,
    listen,
    onDemoAction,
} from './tauriShim';
import { Icon } from '../lib/icons';

const ACCENTS = [
    { name: 'Cobalt', hex: '#4f8cff' },
    { name: 'Emerald', hex: '#3ecf8e' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Amber', hex: '#ffb02e' },
    { name: 'Rose', hex: '#f43f5e' },
];

export function DemoStage({ copy }: { copy: CopyDict['demo'] }) {
    const [theme, setTheme] = useState<'dark' | 'oled' | 'light'>('dark');
    const [accent, setAccent] = useState('#4f8cff');
    const [demoLang, setDemoLang] = useState<'en' | 'fa'>('en');
    const [queueOpen, setQueueOpen] = useState(false);
    const [demoKey, setDemoKey] = useState(0);
    const [activity, setActivity] = useState<string>('');

    useEffect(() => {
        document.documentElement.dataset.embeddedDemo = 'true';
        const unsubStatus = listen('status-changed', () => {
            setQueueOpen(getDemoStatusSnapshot().queue_active);
        });
        const unsubAction = onDemoAction((kind, detail) => {
            const snippet = (detail ?? '').replace(/\s+/g, ' ').slice(0, 38);
            if (kind === 'pasted') {
                setActivity(`${copy.pastedEvent}${snippet ? `: "${snippet}"` : ''}`);
            } else if (kind === 'user-copied') {
                setActivity(`${copy.userCopiedEvent}${snippet ? `: "${snippet}"` : ''}`);
            } else if (kind === 'copied') {
                setActivity(`${copy.copiedEvent}${snippet ? `: "${snippet}"` : ''}`);
            }
        });
        const onPageCopy = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('.cn-demo-shell')) {
                return;
            }
            const selected = window.getSelection()?.toString().trim() ?? '';
            if (selected) {
                demoCaptureUserCopy(selected);
            }
        };
        document.addEventListener('copy', onPageCopy);
        return () => {
            delete document.documentElement.dataset.embeddedDemo;
            document.removeEventListener('copy', onPageCopy);
            unsubStatus.then((fn) => fn());
            unsubAction();
        };
    }, [copy.copiedEvent, copy.pastedEvent, copy.userCopiedEvent]);

    useEffect(() => {
        if (!activity) return;
        const id = window.setTimeout(() => setActivity(''), 3200);
        return () => window.clearTimeout(id);
    }, [activity]);

    const applyTheme = (next: 'dark' | 'oled' | 'light') => {
        setTheme(next);
        demoPatchSettings({ theme: next });
    };

    const applyAccent = (hex: string) => {
        setAccent(hex);
        demoPatchSettings({ accent: hex });
    };

    const toggleDemoLang = () => {
        const next = demoLang === 'en' ? 'fa' : 'en';
        setDemoLang(next);
        demoPatchSettings({ language: next });
    };

    const toggleQueueWindow = () => {
        invoke('queue_toggle').catch(() => {});
    };

    const handleReset = () => {
        demoReset();
        setQueueOpen(false);
        setDemoKey((k) => k + 1);
        emitDemoEvent('status-changed');
    };

    return (
        <div className="lp-demo-stage" id="demo">
            <div className="lp-workbench-bar">
                <div className="lp-wb-group">
                    <span className="lp-wb-dot" aria-hidden />
                    <span className="lp-wb-title">{copy.workbenchLabel}</span>
                </div>

                <div className="lp-wb-controls">
                    <div className="lp-wb-seg" role="group" aria-label={copy.themeLabel}>
                        {(['dark', 'oled', 'light'] as const).map((t) => (
                            <button
                                key={t}
                                type="button"
                                className={`lp-wb-pill${theme === t ? ' active' : ''}`}
                                onClick={() => applyTheme(t)}
                            >
                                {copy.themes[t]}
                            </button>
                        ))}
                    </div>

                    <div className="lp-wb-swatches" role="group" aria-label={copy.accentLabel}>
                        {ACCENTS.map((a) => (
                            <button
                                key={a.hex}
                                type="button"
                                title={a.name}
                                aria-label={`${copy.accentLabel}: ${a.name}`}
                                className={`lp-wb-swatch${accent === a.hex ? ' active' : ''}`}
                                style={{ background: a.hex }}
                                onClick={() => applyAccent(a.hex)}
                            />
                        ))}
                    </div>

                    <button type="button" className="lp-wb-btn" onClick={toggleDemoLang} title={copy.demoLangLabel}>
                        <span>{demoLang === 'en' ? 'UI: EN' : 'UI: فا'}</span>
                    </button>

                    <button
                        type="button"
                        className={`lp-wb-btn${queueOpen ? ' active' : ''}`}
                        onClick={toggleQueueWindow}
                    >
                        <Icon name="list" size={13} />
                        <span>{copy.queueBtn}</span>
                    </button>

                    <button type="button" className="lp-wb-btn" onClick={demoSimulateCopy}>
                        <Icon name="plus" size={13} />
                        <span>{copy.simCopy}</span>
                    </button>

                    <button type="button" className="lp-wb-btn subtle" onClick={handleReset} title={copy.reset}>
                        <Icon name="reset" size={13} />
                    </button>
                </div>
            </div>

            <div className={`cn-demo-windows${queueOpen ? ' has-queue' : ''}`} dir={demoLang === 'fa' ? 'rtl' : 'ltr'}>
                <div className="cn-demo-shell cn-demo-frame">
                    <Popup key={`popup-${demoKey}`} />
                </div>

                {queueOpen && (
                    <div className="cn-demo-shell cn-queue-frame">
                        <QueueView key={`queue-${demoKey}`} />
                    </div>
                )}
            </div>

            <div className="lp-demo-footer">
                <span className="lp-demo-hint">{activity || copy.hint}</span>
            </div>

            <TooltipHost />
        </div>
    );
}
