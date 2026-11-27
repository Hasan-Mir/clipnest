import React, { useEffect, useMemo, useState } from 'react';
import { CopyDict } from './copy';
import { Icon } from '../lib/icons';

type ShowcaseTab = 'queue' | 'basket';

const QUEUE_ITEMS = [
    { id: 1, label: 'https://api.clipnest.dev/v2/sync', field: 'endpoint', tag: 'URL' },
    { id: 2, label: 'cn_client_win32_x64', field: 'client', tag: 'TEXT' },
    { id: 3, label: 'Bearer tok_live_8f42a9d0e1c7', field: 'token', tag: 'KEY' },
];

interface BasketAnimRow {
    id: string;
    name: string;
    folder: string;
    folderShort: string;
    size: string;
    cut: boolean;
    isImage?: boolean;
}

const INITIAL_BASKET: BasketAnimRow[] = [
    {
        id: 'b1',
        name: 'hero-dark.png',
        folder: 'C:\\Users\\Alex\\Downloads\\Shots',
        folderShort: 'Downloads\\Shots',
        size: '412 KB',
        cut: false,
    },
    {
        id: 'b2',
        name: 'tray-menu.png',
        folder: 'C:\\Users\\Alex\\Downloads\\Shots',
        folderShort: 'Downloads\\Shots',
        size: '198 KB',
        cut: true,
    },
    {
        id: 'b3',
        name: 'CHANGELOG.md',
        folder: 'C:\\Users\\Alex\\Projects\\Notes',
        folderShort: 'Projects\\Notes',
        size: '14 KB',
        cut: false,
    },
    {
        id: 'b4',
        name: 'Browser image (1280×720)',
        folder: 'Chrome Clipboard',
        folderShort: 'Browser',
        size: '640 KB',
        cut: false,
        isImage: true,
    },
];

export function QueueBasketShowcase({ copy }: { copy: CopyDict['showcase'] }) {
    const [tab, setTab] = useState<ShowcaseTab>('queue');
    const [playing, setPlaying] = useState(true);

    // Queue animation state (steps 0..4)
    const [qStep, setQStep] = useState(0);
    const [fifo, setFifo] = useState(true);

    // Basket animation state (steps 0..4)
    const [bStep, setBStep] = useState(0);
    const [basketRows, setBasketRows] = useState<BasketAnimRow[]>(INITIAL_BASKET);

    // Advance active animation smoothly
    useEffect(() => {
        if (!playing) return;
        const timer = window.setInterval(() => {
            if (tab === 'queue') {
                setQStep((s) => (s >= 4 ? 0 : s + 1));
            } else {
                setBStep((s) => (s >= 4 ? 0 : s + 1));
            }
        }, 2100);
        return () => window.clearInterval(timer);
    }, [playing, tab]);

    const orderedQueue = useMemo(() => (fifo ? QUEUE_ITEMS : [...QUEUE_ITEMS].reverse()), [fifo]);

    // Derive visible items in Queue & pasted target fields from qStep
    // qStep 0: Copying #1 -> Queue has [0]
    // qStep 1: Copying #1,#2,#3 -> Queue has 3 items
    // qStep 2: Ctrl+V #1 -> 1st item popped into field
    // qStep 3: Ctrl+V #2 -> 2nd item popped into field
    // qStep 4: Ctrl+V #3 -> all 3 pasted!
    const qCopiedCount = qStep === 0 ? 1 : 3;
    const qPastedCount = qStep <= 1 ? 0 : qStep - 1; // 0, 0, 1, 2, 3
    const remainingQueue = qStep === 0 ? orderedQueue.slice(0, 1) : orderedQueue.slice(qPastedCount);

    const pastedMap = useMemo(() => {
        const m: Record<string, string> = {};
        const pasted = orderedQueue.slice(0, qPastedCount);
        copy.queue.fields.forEach((f, idx) => {
            if (pasted[idx]) {
                m[f.key] = pasted[idx].label;
            }
        });
        return m;
    }, [orderedQueue, qPastedCount, copy.queue.fields]);

    const activeQueueStageIndex = Math.min(3, qStep);

    // Derive Drop Basket animation state from bStep:
    // bStep 0: Collecting items (first 2 visible)
    // bStep 1: All 4 grouped by folder + COPY/CUT badges visible
    // bStep 2: Transferring (`Paste All to Folder...`, progress 55%)
    // bStep 3: Finalizing + byte-size verification (100%)
    // bStep 4: Complete! Destination populated, CUT original crossed/cleared from source
    const bVisibleRows = bStep === 0 ? basketRows.slice(0, 2) : basketRows;
    const bTransferPct = bStep === 2 ? 58 : bStep >= 3 ? 100 : 0;
    const bDone = bStep >= 4;
    const activeBasketStageIndex = bStep <= 1 ? bStep : bStep <= 3 ? 2 : 3;

    const toggleRowCut = (id: string) => {
        setBasketRows((prev) => prev.map((r) => (r.id === id ? { ...r, cut: !r.cut } : r)));
    };

    const handleReplay = () => {
        if (tab === 'queue') {
            setQStep(0);
        } else {
            setBStep(0);
        }
        setPlaying(true);
    };

    const handleNextStep = () => {
        setPlaying(false);
        if (tab === 'queue') {
            setQStep((s) => (s >= 4 ? 0 : s + 1));
        } else {
            setBStep((s) => (s >= 4 ? 0 : s + 1));
        }
    };

    const renderFlowArrow = (flowing: boolean) => (
        <div className={`lp-flow-bridge${flowing ? ' flowing' : ''}`} aria-hidden>
            <svg className="lp-flow-svg" width="42" height="12" viewBox="0 0 42 12" fill="none">
                <line
                    className="lp-flow-svg-base"
                    x1="1"
                    y1="6"
                    x2="39"
                    y2="6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                {flowing && (
                    <line
                        className="lp-flow-svg-pulse"
                        x1="1"
                        y1="6"
                        x2="39"
                        y2="6"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                )}
                <path
                    d="M34 1.5L39.5 6L34 10.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </div>
    );

    return (
        <section className="lp-section lp-showcase-section" id="queue-basket">
            <div className="lp-container">
                <div className="lp-section-head">
                    <h2>{copy.title}</h2>
                    <p>{copy.subtitle}</p>
                </div>

                <div className="lp-showcase-shell">
                    <div className="lp-showcase-top">
                        <div className="lp-showcase-tabs" role="tablist">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={tab === 'queue'}
                                className={`lp-sc-tab${tab === 'queue' ? ' active' : ''}`}
                                onClick={() => {
                                    setTab('queue');
                                    setQStep(1);
                                }}
                            >
                                <Icon name="list" size={15} />
                                <span>{copy.tabQueue}</span>
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={tab === 'basket'}
                                className={`lp-sc-tab${tab === 'basket' ? ' active' : ''}`}
                                onClick={() => {
                                    setTab('basket');
                                    setBStep(1);
                                }}
                            >
                                <Icon name="basket" size={15} />
                                <span>{copy.tabBasket}</span>
                            </button>
                        </div>

                        <div className="lp-sc-playback">
                            <button type="button" className="lp-sc-ctrl" onClick={() => setPlaying((p) => !p)}>
                                <Icon name={playing ? 'pause' : 'play'} size={13} />
                                <span>{playing ? copy.pause : copy.play}</span>
                            </button>
                            <button type="button" className="lp-sc-ctrl" onClick={handleNextStep}>
                                <Icon name="arrowRight" size={13} />
                                <span>{copy.nextStep}</span>
                            </button>
                            <button type="button" className="lp-sc-ctrl" onClick={handleReplay}>
                                <Icon name="reset" size={13} />
                                <span>{copy.replay}</span>
                            </button>
                        </div>
                    </div>

                    {tab === 'queue' ? (
                        <div className="lp-sc-body" key="panel-queue">
                            <div className="lp-sc-lead-row">
                                <p className="lp-sc-lead">{copy.queue.lead}</p>
                                <div className="lp-sc-steps">
                                    {copy.queue.stepLabels.map((lbl, idx) => (
                                        <button
                                            key={lbl}
                                            type="button"
                                            className={`lp-sc-step-pill${activeQueueStageIndex === idx ? ' active' : ''}`}
                                            onClick={() => {
                                                setPlaying(false);
                                                setQStep(idx === 3 ? 4 : idx);
                                            }}
                                        >
                                            {lbl}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="lp-anim-stage lp-queue-stage" dir="ltr">
                                {/* Left: Source window */}
                                <div className={`lp-mini-win${qStep <= 1 ? ' active-pulse' : ''}`}>
                                    <div className="lp-mini-head">
                                        <span className="lp-mini-dot" />
                                        <span>{copy.queue.sourceApp}</span>
                                        {qStep <= 1 && <kbd className="lp-key-pulse">Ctrl+C ×{qCopiedCount}</kbd>}
                                    </div>
                                    <div className="lp-mini-lines">
                                        {QUEUE_ITEMS.map((item, idx) => {
                                            const copied = qStep === 0 ? idx === 0 : true;
                                            return (
                                                <div key={item.id} className={`lp-src-line${copied ? ' copied' : ''}`}>
                                                    <span className="lp-src-tag">{item.tag}</span>
                                                    <span className="lp-src-val">{item.label}</span>
                                                    {copied && <span className="lp-src-check">✓</span>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Flow connector 1 */}
                                {renderFlowArrow(qStep <= 1)}

                                {/* Center: Authentic ClipNest Queue window */}
                                <div className="lp-mini-win cn-app-win">
                                    <div className="lp-mini-head">
                                        <img src="./icon.png" alt="" className="lp-mini-logo" />
                                        <span>{copy.queue.windowTitle}</span>
                                        <span className="spacer" />
                                        <button
                                            type="button"
                                            className="lp-fifo-btn"
                                            onClick={() => {
                                                setFifo((f) => !f);
                                                setPlaying(false);
                                            }}
                                            title={copy.queue.orderToggle}
                                        >
                                            {fifo ? 'FIFO ↓' : 'LIFO ↑'}
                                        </button>
                                    </div>
                                    <div className="lp-q-list">
                                        {remainingQueue.length === 0 ? (
                                            <div className="lp-q-empty">{copy.queue.emptyQueue}</div>
                                        ) : (
                                            remainingQueue.map((item, idx) => (
                                                <div
                                                    key={`${item.id}-${fifo ? 'f' : 'l'}`}
                                                    className={`lp-q-row${idx === 0 ? ' next' : ''}`}
                                                >
                                                    <span className="lp-q-num">{idx + 1}</span>
                                                    <span className="lp-q-txt">{item.label}</span>
                                                    {idx === 0 && <span className="lp-q-next-badge">NEXT</span>}
                                                </div>
                                            ))
                                        )}
                                    </div>
                                    <div className="lp-q-foot-note">{copy.queue.doneHint}</div>
                                </div>

                                {/* Flow connector 2 */}
                                {renderFlowArrow(qStep >= 2)}

                                {/* Right: Target form receiving sequential Ctrl+V */}
                                <div className={`lp-mini-win${qStep >= 2 ? ' active-pulse' : ''}`}>
                                    <div className="lp-mini-head">
                                        <span className="lp-mini-dot green" />
                                        <span>{copy.queue.targetForm}</span>
                                        {qStep >= 2 && (
                                            <kbd className="lp-key-pulse accent">Ctrl+V ×{qPastedCount}</kbd>
                                        )}
                                    </div>
                                    <div className="lp-form-fields">
                                        {copy.queue.fields.map((f, idx) => {
                                            const val = pastedMap[f.key];
                                            const isJustPasted = qStep >= 2 && qPastedCount - 1 === idx;
                                            return (
                                                <div key={f.key} className="lp-form-field">
                                                    <label>{f.label}</label>
                                                    <div
                                                        className={`lp-form-input${val ? ' filled' : ''}${
                                                            isJustPasted ? ' flash' : ''
                                                        }`}
                                                    >
                                                        {val || <span className="lp-form-ph">Waiting for Ctrl+V…</span>}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="lp-sc-body" key="panel-basket">
                            <div className="lp-sc-lead-row">
                                <p className="lp-sc-lead">{copy.basket.lead}</p>
                                <div className="lp-sc-steps">
                                    {copy.basket.stepLabels.map((lbl, idx) => (
                                        <button
                                            key={lbl}
                                            type="button"
                                            className={`lp-sc-step-pill${activeBasketStageIndex === idx ? ' active' : ''}`}
                                            onClick={() => {
                                                setPlaying(false);
                                                setBStep(idx === 3 ? 4 : idx);
                                            }}
                                        >
                                            {lbl}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="lp-anim-stage lp-basket-stage" dir="ltr">
                                {/* Left: Scattered source folders */}
                                <div className="lp-mini-win">
                                    <div className="lp-mini-head">
                                        <Icon name="folder" size={14} />
                                        <span>{copy.basket.sourcesTitle}</span>
                                    </div>
                                    <div className="lp-src-folders">
                                        {basketRows.map((row, idx) => {
                                            const collected = bStep > 0 || idx < 2;
                                            const removedByCut = bDone && row.cut;
                                            return (
                                                <div
                                                    key={row.id}
                                                    className={`lp-src-file${collected ? ' collected' : ''}${
                                                        removedByCut ? ' cut-removed' : ''
                                                    }`}
                                                >
                                                    <span className="lp-src-folder-pill">{row.folderShort}</span>
                                                    <span className="lp-src-fname">{row.name}</span>
                                                    {removedByCut ? (
                                                        <span className="lp-cut-done-tag">MOVED</span>
                                                    ) : (
                                                        <span className="lp-src-fsize">{row.size}</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Flow bridge 1 */}
                                {renderFlowArrow(bStep <= 1)}

                                {/* Center: Drop Basket window */}
                                <div className="lp-mini-win cn-app-win">
                                    <div className="lp-mini-head">
                                        <img src="./icon.png" alt="" className="lp-mini-logo" />
                                        <span>{copy.basket.windowTitle}</span>
                                        <span className="spacer" />
                                        <span className="lp-b-count">{bVisibleRows.length}</span>
                                    </div>

                                    <div className="lp-b-list">
                                        {bVisibleRows.map((row) => (
                                            <div key={row.id} className="lp-b-row">
                                                <Icon name={row.isImage ? 'eye' : 'file'} size={13} />
                                                <div className="lp-b-main">
                                                    <div className="lp-b-name">{row.name}</div>
                                                    <div className="lp-b-path">{row.folder}</div>
                                                </div>
                                                {!row.isImage && (
                                                    <button
                                                        type="button"
                                                        className={`lp-b-badge${row.cut ? ' cut' : ''}`}
                                                        onClick={() => toggleRowCut(row.id)}
                                                        title={copy.basket.toggleCutTip}
                                                    >
                                                        {row.cut ? 'CUT' : 'COPY'}
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>

                                    {bStep >= 2 && (
                                        <div className="lp-b-prog">
                                            <div className="lp-b-prog-top">
                                                <span>
                                                    {bStep === 2
                                                        ? 'Transferring…'
                                                        : bStep === 3
                                                          ? 'Verifying exact byte sizes…'
                                                          : copy.basket.verifiedBadge}
                                                </span>
                                                <span>{bTransferPct}%</span>
                                            </div>
                                            <div className="lp-b-prog-track">
                                                <div
                                                    className={`lp-b-prog-fill${bDone ? ' done' : ''}`}
                                                    style={{ width: `${bTransferPct}%` }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="lp-b-foot">
                                        <button
                                            type="button"
                                            className={`lp-b-paste-btn${bStep === 2 ? ' pressing' : ''}`}
                                            onClick={() => {
                                                setPlaying(false);
                                                setBStep(2);
                                                window.setTimeout(() => setBStep(3), 750);
                                                window.setTimeout(() => setBStep(4), 1500);
                                            }}
                                        >
                                            <Icon name="folder" size={12} />
                                            <span>{copy.basket.pasteBtn}</span>
                                        </button>
                                    </div>
                                </div>

                                {/* Flow bridge 2 */}
                                {renderFlowArrow(bStep >= 2)}

                                {/* Right: Destination folder */}
                                <div className={`lp-mini-win${bDone ? ' active-pulse' : ''}`}>
                                    <div className="lp-mini-head">
                                        <span className="lp-mini-dot green" />
                                        <span>{copy.basket.destTitle}</span>
                                    </div>
                                    <div className="lp-dest-list">
                                        {basketRows.map((row, idx) => {
                                            const arrived = bStep === 2 ? idx < 2 : bStep >= 3;
                                            return (
                                                <div key={row.id} className={`lp-dest-row${arrived ? ' arrived' : ''}`}>
                                                    <Icon name={arrived ? 'check' : 'file'} size={13} />
                                                    <span className="lp-dest-name">
                                                        {row.isImage ? 'clipboard-image-1280x720.png' : row.name}
                                                    </span>
                                                    {arrived && (
                                                        <span className={`lp-dest-pill${row.cut ? ' cut' : ''}`}>
                                                            {row.cut ? 'MOVED' : 'COPIED'}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {bDone && <div className="lp-b-verified-note">{copy.basket.cutClearedNote}</div>}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}
