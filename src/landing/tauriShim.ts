import type {
    BasketRow,
    ClipRow,
    FormatMeta,
    ListResult,
    Pinboard,
    Settings,
    Status,
    TransferProgress,
    TransferReport,
    TransferStatus,
} from '../lib/api';
import { normWithMap } from '../lib/highlightMatch';
import { DEFAULT_SETTINGS } from '../lib/useSettings';

export type UnlistenFn = () => void;

type Listener = (event: { event: string; payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();

export function emitDemoEvent(event: string, payload?: unknown): void {
    const set = listeners.get(event);
    if (!set) return;
    set.forEach((fn) => {
        try {
            fn({ event, payload });
        } catch {
            // ignore listener error in demo
        }
    });
}

export function listen<T = unknown>(
    event: string,
    handler: (event: { event: string; payload: T }) => void
): Promise<UnlistenFn> {
    let set = listeners.get(event);
    if (!set) {
        set = new Set();
        listeners.set(event, set);
    }
    const wrapped = handler as Listener;
    set.add(wrapped);
    return Promise.resolve(() => {
        set?.delete(wrapped);
    });
}

export function getCurrentWindow() {
    return {
        label: 'main',
        startDragging: () => Promise.resolve(),
    };
}

// ───────────── Realistic SVG Data URIs for App Icons & Demo Image Thumbnails ─────────────
function svgUri(svg: string): string {
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const APP_ICONS: Record<string, string> = {
    'code.exe': svgUri(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#1b2638"/><path d="M16.8 4.5l3.2 1.5v12l-3.2 1.5L9.5 13l-3.8 2.9-1.7-1.1 3.3-2.8L4 9.2l1.7-1.1 3.8 2.9 7.3-6.5zm-.3 4.3L12.2 12l4.3 3.2V8.8z" fill="#3b9eff"/></svg>`
    ),
    'telegram.exe': svgUri(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#27a7e7"/><path d="M16.9 7.4L6.3 11.5c-.7.3-.7.7-.1.9l2.7.8 6.3-4c.3-.2.6-.1.3.1l-5.1 4.6-.2 2.9c.3 0 .4-.1.6-.3l1.4-1.3 2.8 2.1c.5.3.9.1 1-.5l1.9-8.8c.2-.8-.3-1.1-.9-.6z" fill="#fff"/></svg>`
    ),
    'chrome.exe': svgUri(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fbbc05"/><path d="M12 1.5A10.5 10.5 0 0121.1 6.75H12z" fill="#ea4335"/><path d="M1.5 12a10.5 10.5 0 0010.5 10.5l4.5-7.8-4.5-2.7z" fill="#34a853"/><circle cx="12" cy="12" r="4.6" fill="#fff"/><circle cx="12" cy="12" r="3.6" fill="#4285f4"/></svg>`
    ),
    'figma.exe': svgUri(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#1e1e24"/><circle cx="14.5" cy="12" r="2.5" fill="#1abcfe"/><path d="M9.5 4.5H12v5H9.5a2.5 2.5 0 010-5z" fill="#f24e1e"/><path d="M12 4.5h2.5a2.5 2.5 0 010 5H12v-5z" fill="#ff7262"/><path d="M9.5 9.5H12v5H9.5a2.5 2.5 0 010-5z" fill="#a259ff"/><path d="M9.5 14.5H12V17a2.5 2.5 0 11-2.5-2.5z" fill="#0acf83"/></svg>`
    ),
    'explorer.exe': svgUri(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2.5 6.5A2 2 0 014.5 4.5h5l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2h-15a2 2 0 01-2-2v-11z" fill="#e5b13a"/><path d="M2.5 9.5h19v8a2 2 0 01-2 2h-15a2 2 0 01-2-2v-8z" fill="#f5c654"/></svg>`
    ),
};

const DEMO_SCREENSHOT_SVG =
    svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="499" height="320" viewBox="0 0 499 320">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#17191e"/>
      <stop offset="100%" stop-color="#101216"/>
    </linearGradient>
  </defs>
  <rect width="499" height="320" rx="12" fill="url(#g)" stroke="#333640"/>
  <rect x="18" y="18" width="463" height="38" rx="8" fill="#23262d" stroke="#343844"/>
  <circle cx="38" cy="37" r="7" fill="#4f8cff"/>
  <rect x="54" y="32" width="120" height="10" rx="4" fill="#e8e8ea" opacity="0.85"/>
  <rect x="380" y="27" width="38" height="20" rx="6" fill="#4f8cff"/>
  <rect x="426" y="27" width="42" height="20" rx="6" fill="#2f323b"/>
  <rect x="18" y="70" width="463" height="72" rx="9" fill="#262830" stroke="#4f8cff" stroke-width="1.5"/>
  <rect x="32" y="84" width="90" height="10" rx="4" fill="#8c8e97" opacity="0.7"/>
  <rect x="32" y="104" width="360" height="10" rx="4" fill="#e8e8ea" opacity="0.9"/>
  <rect x="32" y="121" width="240" height="8" rx="4" fill="#4f8cff" opacity="0.75"/>
  <rect x="18" y="154" width="463" height="68" rx="9" fill="#22242a" stroke="#343844"/>
  <rect x="32" y="168" width="110" height="10" rx="4" fill="#8c8e97" opacity="0.65"/>
  <rect x="32" y="188" width="310" height="10" rx="4" fill="#d0d3dc" opacity="0.75"/>
  <rect x="32" y="204" width="180" height="8" rx="4" fill="#3ecf8e" opacity="0.75"/>
  <rect x="18" y="234" width="463" height="68" rx="9" fill="#22242a" stroke="#343844"/>
  <rect x="32" y="248" width="84" height="10" rx="4" fill="#8c8e97" opacity="0.65"/>
  <rect x="32" y="268" width="275" height="10" rx="4" fill="#d0d3dc" opacity="0.7"/>
  <rect x="32" y="284" width="140" height="8" rx="4" fill="#ffb02e" opacity="0.75"/>
</svg>`);

const FOLDER_ICON_SVG = svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" fill="#e8b84b"/></svg>`
);

const PNG_ICON_SVG = svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="#263142" stroke="#4f8cff" stroke-width="1.5"/><circle cx="9" cy="9.5" r="2" fill="#ffb02e"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5 4 4H5z" fill="#4f8cff"/></svg>`
);

const DOC_ICON_SVG = svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6V3z" fill="#252831" stroke="#8c8e97" stroke-width="1.4"/><path d="M9 11h6M9 14.5h6M9 18h4" stroke="#9aa0ae" stroke-width="1.4" stroke-linecap="round"/></svg>`
);

// ───────────── Stateful In-Memory Demo Database ─────────────
interface DemoItemRecord {
    row: ClipRow;
    fullText: string;
    html: string | null;
    image: string | null;
    formats: FormatMeta[];
    /** Per-board membership: null key = main clipboard history, number = board id. */
    boardPins: Map<number | null, boolean>;
    boardOrder: Map<number | null, number>;
}

interface DemoState {
    settings: Settings;
    status: Status;
    boards: Pinboard[];
    items: DemoItemRecord[];
    queueIds: number[];
    basket: BasketRow[];
    nextId: number;
    transferTimer: number | null;
    transferProgress: TransferProgress | null;
    transferReport: TransferReport | null;
}

const DEMO_ACTION_CALLBACKS = new Set<(kind: string, detail?: string) => void>();

export function onDemoAction(cb: (kind: string, detail?: string) => void): () => void {
    DEMO_ACTION_CALLBACKS.add(cb);
    return () => {
        DEMO_ACTION_CALLBACKS.delete(cb);
    };
}

function notifyDemoAction(kind: string, detail?: string) {
    DEMO_ACTION_CALLBACKS.forEach((cb) => cb(kind, detail));
}

function buildInitialState(): DemoState {
    const now = Date.now();
    const initialSettings: Settings = {
        ...DEFAULT_SETTINGS,
        language: 'en',
        theme: 'dark',
        accent: '#4f8cff',
        show_toolbar: true,
        show_pinboard_counts: true,
        density: 'compact',
        move_to_top: false,
    };

    const boards: Pinboard[] = [
        {
            id: 1,
            name: 'Dev',
            color: '#4f8cff',
            position: 1,
            count: 2,
            max_items: 200,
            list_style: 'inherit',
            paste_mode: 'inherit',
        },
        {
            id: 2,
            name: 'Design',
            color: '#3ecf8e',
            position: 2,
            count: 2,
            max_items: 200,
            list_style: 'inherit',
            paste_mode: 'inherit',
        },
        {
            id: 3,
            name: 'Links',
            color: '#ffb02e',
            position: 3,
            count: 1,
            max_items: 200,
            list_style: 'inherit',
            paste_mode: 'inherit',
        },
        {
            id: 4,
            name: 'Scratch',
            color: '#ef4444',
            position: 4,
            count: 0,
            max_items: 200,
            list_style: 'inherit',
            paste_mode: 'inherit',
        },
    ];

    const rawItems: Array<{
        id: number;
        kind: ClipRow['kind'];
        title: string | null;
        preview: string;
        fullText?: string;
        html?: string | null;
        image?: string | null;
        app_name: string;
        app_exe: string;
        tags: string;
        img_w?: number | null;
        img_h?: number | null;
        color?: string | null;
        file_count?: number | null;
        pinnedMain?: boolean;
        boards?: number[];
        sensitive?: boolean;
        ageMs: number;
    }> = [
        {
            id: 101,
            kind: 'image',
            title: null,
            preview: '[image 499×320]',
            image: DEMO_SCREENSHOT_SVG,
            app_name: 'Svchost',
            app_exe: 'svchost.exe',
            tags: 'screenshot ui',
            img_w: 499,
            img_h: 320,
            boards: [2],
            ageMs: 25_000,
        },
        {
            id: 102,
            kind: 'text',
            title: null,
            preview: 'آزمایشگاه تعاملی Git — Interactive Branching Playground',
            fullText:
                'آزمایشگاه تعاملی Git — Interactive Branching Playground\nhttps://learngitbranching.js.org/?locale=fa',
            html: `<div style="background:#1c2330;color:#e8eefc;padding:4px 6px;border-radius:4px;font-size:13px;"><span style="color:#60a5fa;font-weight:600;">Git</span> آزمایشگاه تعاملی — <span style="color:#93c5fd;">Interactive Branching</span></div>`,
            app_name: 'Telegram',
            app_exe: 'telegram.exe',
            tags: 'git rtl',
            boards: [3],
            ageMs: 4 * 60_000,
        },
        {
            id: 103,
            kind: 'code',
            title: null,
            preview:
                '"node_modules/tauri-apps": {\n  "version": "2.12.4",\n  "resolved": "https://registry.npmjs.org/@tauri-apps/api"\n}',
            fullText:
                '"node_modules/@tauri-apps/api": {\n  "version": "2.12.4",\n  "resolved": "https://registry.npmjs.org/@tauri-apps/api/-/api-2.12.4.tgz",\n  "integrity": "sha512-9xClipNestDemoIntegrityHash=="\n}',
            html: `<pre style="background:#1e1e1e;color:#d4d4d4;padding:4px 6px;border-radius:4px;font-family:'Cascadia Mono',Consolas,monospace;font-size:12px;margin:0;"><span style="color:#9cdcfe;">"node_modules/@tauri-apps/api"</span>: {\n  <span style="color:#9cdcfe;">"version"</span>: <span style="color:#ce9178;">"2.12.4"</span>,\n  <span style="color:#9cdcfe;">"resolved"</span>: <span style="color:#ce9178;">"https://registry.npmjs.org/..."</span>\n}</pre>`,
            app_name: 'VS Code',
            app_exe: 'code.exe',
            tags: 'tauri json',
            pinnedMain: true,
            boards: [1],
            ageMs: 9 * 60_000,
        },
        {
            id: 104,
            kind: 'link',
            title: 'ClipNest Repository',
            preview: 'https://github.com/Hasan-Mir/clipnest',
            app_name: 'Chrome',
            app_exe: 'chrome.exe',
            tags: 'github release',
            boards: [3],
            ageMs: 18 * 60_000,
        },
        {
            id: 105,
            kind: 'file',
            title: null,
            preview:
                'C:\\Users\\Alex\\Releases\\clipnest-setup.exe\nC:\\Users\\Alex\\Releases\\clipnest-portable.zip\nC:\\Users\\Alex\\Releases\\SHA256SUMS.txt',
            app_name: 'Explorer',
            app_exe: 'explorer.exe',
            tags: 'release windows',
            file_count: 3,
            ageMs: 32 * 60_000,
        },
        {
            id: 106,
            kind: 'color',
            title: 'Accent Cobalt',
            preview: '#4f8cff',
            color: '#4f8cff',
            app_name: 'Figma',
            app_exe: 'figma.exe',
            tags: 'palette',
            boards: [2],
            ageMs: 47 * 60_000,
        },
        {
            id: 107,
            kind: 'code',
            title: 'Atomic SQLite Backup',
            preview:
                'pub fn save_atomic(path: &Path, bytes: &[u8]) -> Result<()> {\n    let tmp = path.with_extension("tmp");\n    fs::write(&tmp, bytes)?;\n    fs::rename(tmp, path)\n}',
            app_name: 'VS Code',
            app_exe: 'code.exe',
            tags: 'rust sqlite',
            boards: [1],
            ageMs: 75 * 60_000,
        },
        {
            id: 108,
            kind: 'text',
            title: 'Production API Key',
            preview: 'cn_live_8f42a9d0e1c74b319a77f204e8b9c311',
            app_name: 'Chrome',
            app_exe: 'chrome.exe',
            tags: 'secret',
            sensitive: true,
            ageMs: 2 * 3600_000,
        },
    ];

    const items: DemoItemRecord[] = rawItems.map((raw, idx) => {
        const fullText = raw.fullText ?? raw.preview;
        const ts = now - raw.ageMs;
        const boardPins = new Map<number | null, boolean>();
        const boardOrder = new Map<number | null, number>();
        boardPins.set(null, Boolean(raw.pinnedMain));
        boardOrder.set(null, idx + 1);
        for (const bid of raw.boards ?? []) {
            boardPins.set(bid, false);
            boardOrder.set(bid, idx + 1);
        }

        const formats: FormatMeta[] =
            raw.kind === 'image'
                ? [
                      { name: 'PNG', mime: 'image/png', size: 84_320 },
                      { name: 'CF_DIBV5', mime: 'image/bmp', size: 638_720 },
                  ]
                : raw.kind === 'file'
                  ? [
                        { name: 'CF_HDROP', mime: 'text/uri-list', size: 214 },
                        { name: 'Preferred DropEffect', mime: 'application/octet-stream', size: 4 },
                    ]
                  : raw.html
                    ? [
                          { name: 'HTML Format', mime: 'text/html', size: new Blob([raw.html]).size },
                          { name: 'CF_UNICODETEXT', mime: 'text/plain;charset=utf-8', size: (fullText.length + 1) * 2 },
                      ]
                    : [{ name: 'CF_UNICODETEXT', mime: 'text/plain;charset=utf-8', size: (fullText.length + 1) * 2 }];

        return {
            row: {
                id: raw.id,
                kind: raw.kind,
                title: raw.title,
                preview: raw.preview,
                app_name: raw.app_name,
                app_exe: raw.app_exe,
                tags: raw.tags,
                lang: null,
                img_w: raw.img_w ?? null,
                img_h: raw.img_h ?? null,
                color: raw.color ?? null,
                chars: fullText.length,
                file_count: raw.file_count ?? null,
                pinboard_id: raw.boards?.[0] ?? null,
                pinned: Boolean(raw.pinnedMain),
                sensitive: Boolean(raw.sensitive),
                has_rich: Boolean(raw.html),
                ts,
                created_at: ts,
                has_thumb: raw.kind === 'image',
                cut: false,
            },
            fullText,
            html: raw.html ?? null,
            image: raw.image ?? null,
            formats,
            boardPins,
            boardOrder,
        };
    });

    const basket: BasketRow[] = [
        {
            key: 'f-1',
            id: 901,
            kind: 'file',
            path: 'C:\\Users\\Alex\\Downloads\\Shots\\hero-dark.png',
            name: 'hero-dark.png',
            parent: 'C:\\Users\\Alex\\Downloads\\Shots',
            is_dir: false,
            exists: true,
            cut: false,
            img_w: null,
            img_h: null,
        },
        {
            key: 'f-2',
            id: 902,
            kind: 'file',
            path: 'C:\\Users\\Alex\\Downloads\\Shots\\tray-menu.png',
            name: 'tray-menu.png',
            parent: 'C:\\Users\\Alex\\Downloads\\Shots',
            is_dir: false,
            exists: true,
            cut: true,
            img_w: null,
            img_h: null,
        },
        {
            key: 'f-3',
            id: 903,
            kind: 'file',
            path: 'C:\\Users\\Alex\\Projects\\Notes\\CHANGELOG.md',
            name: 'CHANGELOG.md',
            parent: 'C:\\Users\\Alex\\Projects\\Notes',
            is_dir: false,
            exists: true,
            cut: false,
            img_w: null,
            img_h: null,
        },
        {
            key: 'img-1',
            id: 904,
            kind: 'image',
            path: null,
            name: 'Browser image',
            parent: null,
            is_dir: false,
            exists: true,
            cut: false,
            img_w: 1280,
            img_h: 720,
        },
    ];

    return {
        settings: initialSettings,
        status: {
            paused_until: 0,
            plain_default: false,
            queue_active: false,
            queue_mode: 'queue',
            queue_len: 3,
            popup_pinned: true,
        },
        boards,
        items,
        queueIds: [103, 104, 107],
        basket,
        nextId: 200,
        transferTimer: null,
        transferProgress: null,
        transferReport: null,
    };
}

let state: DemoState = buildInitialState();

function syncQueueLen() {
    state.status = {
        ...state.status,
        queue_len: state.status.queue_mode === 'basket' ? state.basket.length : state.queueIds.length,
    };
}

function syncBoardCounts() {
    state.boards = state.boards.map((b) => ({
        ...b,
        count: state.items.filter((it) => it.boardOrder.has(b.id)).length,
    }));
}

function matchesQuery(rec: DemoItemRecord, query: string, mode: string): boolean {
    const q = query.trim();
    if (!q) return true;
    const hay = [rec.row.title ?? '', rec.fullText, rec.row.tags, rec.row.app_name, rec.row.kind].join(' ');
    if (mode === 'regex') {
        try {
            return new RegExp(q, 'i').test(hay);
        } catch {
            return false;
        }
    }
    const { norm: hayNorm } = normWithMap(hay);
    if (mode === 'fuzzy') {
        const { norm: qNorm } = normWithMap(q);
        let idx = 0;
        for (let i = 0; i < qNorm.length; i++) {
            const found = hayNorm.indexOf(qNorm[i], idx);
            if (found < 0) return false;
            idx = found + 1;
        }
        return true;
    }
    const tokens = q
        .split(/\s+/)
        .map((t) => normWithMap(t).norm)
        .filter(Boolean);
    return tokens.every((tok) => hayNorm.includes(tok));
}

function getScopedItems(pinboard: number | null): DemoItemRecord[] {
    return state.items
        .filter((r) => r.boardOrder.has(pinboard))
        .sort((a, b) => {
            const ap = a.boardPins.get(pinboard) ? 1 : 0;
            const bp = b.boardPins.get(pinboard) ? 1 : 0;
            if (ap !== bp) return bp - ap;
            return (a.boardOrder.get(pinboard) ?? 9999) - (b.boardOrder.get(pinboard) ?? 9999);
        });
}

function reorderInScope(scope: number | null, id: number, target: number, after: boolean) {
    const ordered = getScopedItems(scope);
    const fromIdx = ordered.findIndex((r) => r.row.id === id);
    const targetIdx = ordered.findIndex((r) => r.row.id === target);
    if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return;
    const [moved] = ordered.splice(fromIdx, 1);
    const newTargetIdx = ordered.findIndex((r) => r.row.id === target);
    ordered.splice(after ? newTargetIdx + 1 : newTargetIdx, 0, moved);
    ordered.forEach((r, i) => r.boardOrder.set(scope, i + 1));
}

function bestEffortWriteClipboard(text: string) {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    } catch {
        // ignore clipboard permission errors
    }
}

const SIMULATED_COPIES = [
    {
        kind: 'code' as const,
        app_name: 'Windows Terminal',
        app_exe: 'cmd.exe',
        preview: 'git log -5 --oneline | clipn add - --category Dev --copy',
        tags: 'cli git',
    },
    {
        kind: 'text' as const,
        app_name: 'Telegram',
        app_exe: 'telegram.exe',
        preview: 'ساختار Paste Queue و Drop Basket در کلیپ‌نست کاملاً آفلاین و سریع کار می‌کند.',
        tags: 'notes rtl',
    },
    {
        kind: 'color' as const,
        app_name: 'Figma',
        app_exe: 'figma.exe',
        preview: '#3ecf8e',
        color: '#3ecf8e',
        tags: 'mint accent',
    },
    {
        kind: 'link' as const,
        app_name: 'Chrome',
        app_exe: 'chrome.exe',
        preview: 'https://github.com/Hasan-Mir/clipnest/releases/latest',
        tags: 'download',
    },
];

let simCursor = 0;

// ───────────── Public Demo Controls (for DemoStage workbench bar) ─────────────
export function demoReset() {
    if (state.transferTimer !== null) {
        window.clearInterval(state.transferTimer);
    }
    const prevLang = state.settings.language;
    const prevTheme = state.settings.theme;
    const prevAccent = state.settings.accent;
    state = buildInitialState();
    state.settings.language = prevLang;
    state.settings.theme = prevTheme;
    state.settings.accent = prevAccent;
    syncBoardCounts();
    syncQueueLen();
    emitDemoEvent('settings-changed');
    emitDemoEvent('status-changed');
    emitDemoEvent('items-changed');
    emitDemoEvent('queue-changed');
}

export function demoPatchSettings(patch: Partial<Settings>) {
    state.settings = { ...state.settings, ...patch };
    emitDemoEvent('settings-changed');
}

function insertCapturedClip(params: {
    kind: ClipRow['kind'];
    preview: string;
    fullText?: string;
    app_name: string;
    app_exe: string;
    tags: string;
    color?: string | null;
    actionKind: string;
}) {
    const id = state.nextId++;
    const now = Date.now();
    const fullText = params.fullText ?? params.preview;
    const minMainOrder = Math.min(0, ...state.items.map((x) => x.boardOrder.get(null) ?? 0));
    const activeBoard = state.settings.active_pinboard;

    const boardPins = new Map<number | null, boolean>([[null, false]]);
    const boardOrder = new Map<number | null, number>([[null, minMainOrder - 1]]);

    if (activeBoard !== null && state.boards.some((b) => b.id === activeBoard)) {
        const minBoardOrder = Math.min(0, ...state.items.map((x) => x.boardOrder.get(activeBoard) ?? 0));
        boardPins.set(activeBoard, false);
        boardOrder.set(activeBoard, minBoardOrder - 1);
    }

    const rec: DemoItemRecord = {
        row: {
            id,
            kind: params.kind,
            title: null,
            preview: params.preview.slice(0, 300),
            app_name: params.app_name,
            app_exe: params.app_exe,
            tags: params.tags,
            lang: null,
            img_w: null,
            img_h: null,
            color: params.color ?? null,
            chars: fullText.length,
            file_count: null,
            pinboard_id: activeBoard,
            pinned: false,
            sensitive: false,
            has_rich: false,
            ts: now,
            created_at: now,
            has_thumb: false,
            cut: false,
        },
        fullText,
        html: null,
        image: null,
        formats: [{ name: 'CF_UNICODETEXT', mime: 'text/plain;charset=utf-8', size: (fullText.length + 1) * 2 }],
        boardPins,
        boardOrder,
    };

    state.items.unshift(rec);
    syncBoardCounts();
    if (state.status.queue_active && state.status.queue_mode === 'queue') {
        state.queueIds.push(id);
        syncQueueLen();
        emitDemoEvent('queue-changed');
        emitDemoEvent('status-changed');
    }
    emitDemoEvent('items-changed');
    notifyDemoAction(params.actionKind, fullText);
}

export function demoSimulateCopy() {
    const sample = SIMULATED_COPIES[simCursor % SIMULATED_COPIES.length];
    simCursor += 1;
    insertCapturedClip({
        kind: sample.kind,
        preview: sample.preview,
        app_name: sample.app_name,
        app_exe: sample.app_exe,
        tags: sample.tags,
        color: 'color' in sample ? (sample.color ?? null) : null,
        actionKind: 'copied',
    });
}

export function demoCaptureUserCopy(rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    let kind: ClipRow['kind'] = 'text';
    let color: string | null = null;
    if (/^https?:\/\/\S+$/i.test(text)) {
        kind = 'link';
    } else if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
        kind = 'color';
        color = text;
    } else if (text.includes('\n') && /[{}();=>]/.test(text)) {
        kind = 'code';
    }
    insertCapturedClip({
        kind,
        preview: text,
        fullText: text,
        app_name: 'Chrome',
        app_exe: 'chrome.exe',
        tags: 'page-copy',
        color,
        actionKind: 'user-copied',
    });
}

export function demoSimulateQueuePaste(): string | null {
    if (state.queueIds.length === 0) return null;
    const fifo = state.settings.queue_fifo;
    const id = fifo ? state.queueIds.shift()! : state.queueIds.pop()!;
    syncQueueLen();
    emitDemoEvent('queue-changed');
    emitDemoEvent('status-changed');
    const item = state.items.find((x) => x.row.id === id);
    return item ? item.fullText : null;
}

export function demoAddFileToBasket() {
    const idx = state.basket.length + 1;
    const id = state.nextId++;
    state.basket.push({
        key: `f-${id}`,
        id,
        kind: 'file',
        path: `C:\\Users\\Alex\\Desktop\\clip-export-${idx}.png`,
        name: `clip-export-${idx}.png`,
        parent: 'C:\\Users\\Alex\\Desktop',
        is_dir: false,
        exists: true,
        cut: false,
        img_w: null,
        img_h: null,
    });
    state.status.queue_active = true;
    state.status.queue_mode = 'basket';
    syncQueueLen();
    emitDemoEvent('status-changed');
    emitDemoEvent('queue-changed');
}

export function getDemoStatusSnapshot(): Status {
    return { ...state.status };
}

// ───────────── Tauri invoke() implementation ─────────────
export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (cmd) {
        case 'get_settings':
            return { ...state.settings } as T;

        case 'set_settings': {
            const next = args.settings as Settings | undefined;
            if (next) {
                state.settings = { ...next };
                emitDemoEvent('settings-changed');
            }
            return undefined as T;
        }

        case 'app_status':
            return { ...state.status } as T;

        case 'set_popup_pinned': {
            state.status = { ...state.status, popup_pinned: Boolean(args.pinned) };
            emitDemoEvent('status-changed');
            return state.status.popup_pinned as T;
        }

        case 'list_items': {
            const inner = (args.args ?? args) as {
                pinboard: number | null;
                query: string;
                mode: string;
                limit: number;
            };
            const scope = inner.pinboard ?? null;
            const scoped = getScopedItems(scope);
            const filtered = scoped.filter((r) => matchesQuery(r, inner.query ?? '', inner.mode ?? 'smart'));
            const limited = filtered.slice(0, inner.limit ?? 100).map((r) => ({
                ...r.row,
                pinned: Boolean(r.boardPins.get(scope)),
            }));
            const res: ListResult = { items: limited, total: filtered.length, error: null };
            return res as T;
        }

        case 'list_pinboards':
            syncBoardCounts();
            return state.boards.map((b) => ({ ...b })) as T;

        case 'get_text': {
            const rec = state.items.find((r) => r.row.id === args.id);
            return (rec ? rec.fullText : '') as T;
        }

        case 'get_html': {
            const rec = state.items.find((r) => r.row.id === args.id);
            return (rec ? rec.html : null) as T;
        }

        case 'get_thumb':
        case 'get_image': {
            const rec = state.items.find((r) => r.row.id === args.id);
            return (rec ? rec.image : null) as T;
        }

        case 'get_app_icon': {
            const exe = String(args.exe ?? '').toLowerCase();
            return (APP_ICONS[exe] ?? null) as T;
        }

        case 'get_formats': {
            const rec = state.items.find((r) => r.row.id === args.id);
            return (rec ? rec.formats : []) as T;
        }

        case 'paste_item': {
            const id = Number(args.id);
            const rec = state.items.find((r) => r.row.id === id);
            if (rec) {
                bestEffortWriteClipboard(rec.fullText);
                if (state.settings.move_to_top && !rec.boardPins.get(null)) {
                    const minOrder = Math.min(0, ...state.items.map((x) => x.boardOrder.get(null) ?? 0));
                    rec.boardOrder.set(null, minOrder - 1);
                    emitDemoEvent('items-changed');
                }
                notifyDemoAction('pasted', rec.row.preview);
            }
            return undefined as T;
        }

        case 'copy_item': {
            const rec = state.items.find((r) => r.row.id === Number(args.id));
            if (rec) {
                bestEffortWriteClipboard(rec.fullText);
                notifyDemoAction('copied', rec.row.preview);
            }
            return undefined as T;
        }

        case 'copy_text': {
            bestEffortWriteClipboard(String(args.text ?? ''));
            return undefined as T;
        }

        case 'delete_items': {
            const ids = new Set((args.ids as number[]) ?? []);
            state.items = state.items.filter((r) => !ids.has(r.row.id));
            state.queueIds = state.queueIds.filter((qid) => !ids.has(qid));
            syncBoardCounts();
            syncQueueLen();
            emitDemoEvent('items-changed');
            emitDemoEvent('queue-changed');
            emitDemoEvent('status-changed');
            return undefined as T;
        }

        case 'rename_item': {
            const rec = state.items.find((r) => r.row.id === Number(args.id));
            if (rec) {
                const title = String(args.title ?? '').trim();
                rec.row.title = title ? title : null;
                emitDemoEvent('items-changed');
            }
            return undefined as T;
        }

        case 'set_tags': {
            const rec = state.items.find((r) => r.row.id === Number(args.id));
            if (rec) {
                rec.row.tags = String(args.tags ?? '').trim();
                emitDemoEvent('items-changed');
            }
            return undefined as T;
        }

        case 'set_pinboard': {
            const ids = (args.ids as number[]) ?? [];
            const board = (args.board as number | null) ?? null;
            const sourceBoard = (args.sourceBoard as number | null) ?? null;
            const copy = Boolean(args.copy);
            for (const id of ids) {
                const rec = state.items.find((r) => r.row.id === id);
                if (!rec) continue;
                if (board === null) {
                    if (sourceBoard !== null) {
                        rec.boardOrder.delete(sourceBoard);
                        rec.boardPins.delete(sourceBoard);
                    }
                } else {
                    const maxOrder = Math.max(0, ...state.items.map((x) => x.boardOrder.get(board) ?? 0));
                    if (!rec.boardOrder.has(board)) {
                        rec.boardOrder.set(board, maxOrder + 1);
                        rec.boardPins.set(board, false);
                    }
                    if (!copy && sourceBoard !== null && sourceBoard !== board) {
                        rec.boardOrder.delete(sourceBoard);
                        rec.boardPins.delete(sourceBoard);
                    }
                }
            }
            syncBoardCounts();
            emitDemoEvent('items-changed');
            return undefined as T;
        }

        case 'set_pinned': {
            const ids = (args.ids as number[]) ?? [];
            const pinned = Boolean(args.pinned);
            const board = (args.board as number | null) ?? null;
            for (const id of ids) {
                const rec = state.items.find((r) => r.row.id === id);
                if (!rec) continue;
                rec.boardPins.set(board, pinned);
                if (board === null) {
                    rec.row.pinned = pinned;
                }
            }
            emitDemoEvent('items-changed');
            return undefined as T;
        }

        case 'create_text_item': {
            const text = String(args.text ?? '');
            const id = state.nextId++;
            const now = Date.now();
            const minOrder = Math.min(0, ...state.items.map((x) => x.boardOrder.get(null) ?? 0));
            state.items.unshift({
                row: {
                    id,
                    kind: 'text',
                    title: null,
                    preview: text.slice(0, 300),
                    app_name: 'ClipNest',
                    app_exe: 'clipnest.exe',
                    tags: '',
                    lang: null,
                    img_w: null,
                    img_h: null,
                    color: null,
                    chars: text.length,
                    file_count: null,
                    pinboard_id: null,
                    pinned: false,
                    sensitive: false,
                    has_rich: false,
                    ts: now,
                    created_at: now,
                    has_thumb: false,
                    cut: false,
                },
                fullText: text,
                html: null,
                image: null,
                formats: [{ name: 'CF_UNICODETEXT', mime: 'text/plain;charset=utf-8', size: (text.length + 1) * 2 }],
                boardPins: new Map([[null, false]]),
                boardOrder: new Map([[null, minOrder - 1]]),
            });
            emitDemoEvent('items-changed');
            return id as T;
        }

        case 'merge_items': {
            const ids = (args.ids as number[]) ?? [];
            const sep = String(args.sep ?? '\n');
            const parts = ids
                .map((id) => state.items.find((r) => r.row.id === id)?.fullText)
                .filter((x): x is string => typeof x === 'string');
            const merged = parts.join(sep);
            return invoke<T>('create_text_item', { text: merged });
        }

        case 'update_item_text': {
            const id = Number(args.id);
            const text = String(args.text ?? '');
            const rec = state.items.find((r) => r.row.id === id);
            if (rec) {
                rec.fullText = text;
                rec.row.preview = text.slice(0, 300);
                rec.row.chars = text.length;
                rec.row.has_rich = false;
                rec.html = null;
                rec.row.ts = Date.now();
                rec.formats = [
                    { name: 'CF_UNICODETEXT', mime: 'text/plain;charset=utf-8', size: (text.length + 1) * 2 },
                ];
                emitDemoEvent('items-changed');
            }
            return undefined as T;
        }

        case 'create_pinboard': {
            const id = state.nextId++;
            state.boards.push({
                id,
                name: String(args.name ?? 'Category').trim(),
                color: String(args.color ?? '#4f8cff'),
                position: state.boards.length + 1,
                count: 0,
                max_items: 200,
                list_style: 'inherit',
                paste_mode: 'inherit',
            });
            emitDemoEvent('items-changed');
            return id as T;
        }

        case 'update_pinboard': {
            const id = Number(args.id);
            const b = state.boards.find((x) => x.id === id);
            if (b) {
                b.name = String(args.name ?? b.name);
                b.color = String(args.color ?? b.color);
                b.max_items = Number(args.maxItems ?? b.max_items);
                b.list_style = (args.listStyle as Pinboard['list_style']) ?? b.list_style;
                b.paste_mode = (args.pasteMode as Pinboard['paste_mode']) ?? b.paste_mode;
                emitDemoEvent('items-changed');
            }
            return undefined as T;
        }

        case 'delete_pinboard': {
            const id = Number(args.id);
            state.boards = state.boards.filter((x) => x.id !== id);
            for (const rec of state.items) {
                rec.boardOrder.delete(id);
                rec.boardPins.delete(id);
            }
            emitDemoEvent('items-changed');
            return undefined as T;
        }

        case 'move_item': {
            reorderInScope(
                (args.scope as number | null) ?? null,
                Number(args.id),
                Number(args.target),
                Boolean(args.after)
            );
            emitDemoEvent('items-changed');
            return undefined as T;
        }

        case 'erase_history': {
            const includePinned = Boolean(args.includePinned);
            const pinboard = (args.pinboard as number | null) ?? null;
            const allPinboards = Boolean(args.allPinboards);
            let removed = 0;
            if (allPinboards) {
                const keep = includePinned ? [] : state.items.filter((r) => r.boardPins.get(null));
                removed = state.items.length - keep.length;
                state.items = keep;
            } else if (pinboard !== null) {
                for (const rec of state.items) {
                    if (rec.boardOrder.has(pinboard) && (includePinned || !rec.boardPins.get(pinboard))) {
                        rec.boardOrder.delete(pinboard);
                        rec.boardPins.delete(pinboard);
                        removed += 1;
                    }
                }
            } else {
                state.items = state.items.filter((rec) => {
                    if (!rec.boardOrder.has(null)) return true;
                    if (!includePinned && rec.boardPins.get(null)) return true;
                    rec.boardOrder.delete(null);
                    rec.boardPins.delete(null);
                    removed += 1;
                    return rec.boardOrder.size > 0;
                });
            }
            syncBoardCounts();
            emitDemoEvent('items-changed');
            return removed as T;
        }

        case 'resume_capture':
            state.status = { ...state.status, paused_until: 0 };
            emitDemoEvent('status-changed');
            return undefined as T;

        case 'toggle_plain_mode':
            state.status = { ...state.status, plain_default: !state.status.plain_default };
            emitDemoEvent('status-changed');
            return undefined as T;

        case 'queue_toggle':
            state.status = { ...state.status, queue_active: !state.status.queue_active };
            syncQueueLen();
            emitDemoEvent('status-changed');
            emitDemoEvent('queue-changed');
            return undefined as T;

        case 'queue_set_mode':
            state.status = {
                ...state.status,
                queue_mode: args.mode === 'basket' ? 'basket' : 'queue',
            };
            syncQueueLen();
            emitDemoEvent('status-changed');
            emitDemoEvent('queue-changed');
            return undefined as T;

        case 'queue_get': {
            const list = state.queueIds
                .map((id) => state.items.find((r) => r.row.id === id)?.row)
                .filter((x): x is ClipRow => Boolean(x));
            return list as T;
        }

        case 'queue_remove':
            state.queueIds = state.queueIds.filter((id) => id !== Number(args.id));
            syncQueueLen();
            emitDemoEvent('queue-changed');
            emitDemoEvent('status-changed');
            return undefined as T;

        case 'queue_clear':
            if (state.status.queue_mode === 'basket') {
                state.basket = [];
            } else {
                state.queueIds = [];
            }
            syncQueueLen();
            emitDemoEvent('queue-changed');
            emitDemoEvent('status-changed');
            return undefined as T;

        case 'basket_get':
            return state.basket.map((r) => ({ ...r })) as T;

        case 'basket_remove_keys': {
            const keys = new Set((args.keys as string[]) ?? []);
            state.basket = state.basket.filter((r) => !keys.has(r.key));
            syncQueueLen();
            emitDemoEvent('queue-changed');
            emitDemoEvent('status-changed');
            return undefined as T;
        }

        case 'basket_set_cut': {
            const keys = new Set((args.keys as string[]) ?? []);
            const cut = Boolean(args.cut);
            state.basket = state.basket.map((r) => (keys.has(r.key) ? { ...r, cut } : r));
            emitDemoEvent('queue-changed');
            return undefined as T;
        }

        case 'basket_file_icon': {
            const p = String(args.path ?? '').toLowerCase();
            if (!p || !p.includes('.')) return FOLDER_ICON_SVG as T;
            if (p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.svg')) return PNG_ICON_SVG as T;
            return DOC_ICON_SVG as T;
        }

        case 'basket_paste_here':
        case 'basket_paste_to_folder': {
            const total = state.basket.length;
            if (total === 0) return 0 as T;
            if (cmd === 'basket_paste_here') {
                state.basket = state.basket.filter((r) => !r.cut);
                syncQueueLen();
                emitDemoEvent('queue-changed');
                emitDemoEvent('status-changed');
                return total as T;
            }
            const snapshot = [...state.basket];
            let step = 0;
            state.transferReport = null;
            state.transferProgress = {
                done: 0,
                failed: 0,
                total,
                current: snapshot[0]?.name ?? '',
                fraction: 0.08,
                phase: 'copy',
            };
            emitDemoEvent('basket-progress', state.transferProgress);
            if (state.transferTimer !== null) {
                window.clearInterval(state.transferTimer);
            }
            state.transferTimer = window.setInterval(() => {
                step += 1;
                if (step < total) {
                    state.transferProgress = {
                        done: step,
                        failed: 0,
                        total,
                        current: snapshot[step]?.name ?? '',
                        fraction: step / total,
                        phase: 'copy',
                    };
                    emitDemoEvent('basket-progress', state.transferProgress);
                } else if (step === total) {
                    state.transferProgress = {
                        done: total,
                        failed: 0,
                        total,
                        current: 'Verifying byte sizes & finalizing…',
                        fraction: 1,
                        phase: 'finalize',
                    };
                    emitDemoEvent('basket-progress', state.transferProgress);
                } else {
                    if (state.transferTimer !== null) {
                        window.clearInterval(state.transferTimer);
                        state.transferTimer = null;
                    }
                    state.transferProgress = null;
                    const report: TransferReport = {
                        total,
                        done: total,
                        failed: [],
                        cut_skipped: false,
                        dest: 'C:\\Users\\Alex\\Desktop\\Release',
                    };
                    state.transferReport = report;
                    state.basket = state.basket.filter((r) => !r.cut);
                    syncQueueLen();
                    emitDemoEvent('basket-finished', report);
                    emitDemoEvent('queue-changed');
                    emitDemoEvent('status-changed');
                }
            }, 340);
            return total as T;
        }

        case 'basket_transfer_status': {
            const rep = state.transferReport;
            state.transferReport = null;
            const res: TransferStatus = {
                busy: state.transferProgress !== null,
                progress: state.transferProgress,
                report: rep,
            };
            return res as T;
        }

        // Disabled desktop-only commands (silent no-op per user specification)
        case 'open_settings':
        case 'hide_popup':
        case 'quit_app':
        case 'open_item':
        case 'reveal_item':
        case 'reveal_paths':
        case 'open_data_dir':
        case 'clear_explorer_target':
        case 'queue_ready':
            return undefined as T;

        case 'get_explorer_target':
        case 'export_data':
        case 'import_data':
        case 'export_settings':
        case 'import_settings':
        case 'run_action':
            return null as T;

        case 'recent_apps':
        case 'list_system_fonts':
            return [] as T;

        default:
            return undefined as T;
    }
}
