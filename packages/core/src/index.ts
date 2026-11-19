/**
 * @seymi/clipnest-core
 *
 * Loads the compiled Rust N-API native addon (`clipnest-core.win32-x64-msvc.node`) when present,
 * and provides the shared IPC client, offline dispatcher, and text transformation engine
 * used by `@seymi/clipnest-cli` and external automation scripts.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const CLI_VERSION = '0.2.0';
export const PROTOCOL_VERSION = 1;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_OFFLINE = 4;
export const EXIT_PARTIAL = 5;

export interface IpcEndpoint {
    protocol: number;
    version: string;
    pid: number;
    port: number;
    token: string;
}

export interface IpcRequest {
    protocol: number;
    version: string;
    token: string;
    op: string;
    params: Record<string, unknown>;
}

export interface IpcResponse {
    ok: boolean;
    exit_code: number;
    data: unknown;
    error?: string;
    hint?: string;
}

export interface TransformDef {
    id: string;
    group: string;
    label: string;
    run: (s: string) => string;
}

export interface NativeCoreBinding {
    dispatchOfflineJson: (dataDir: string, op: string, paramsJson: string) => string;
    applyTransformNative: (id: string, input: string) => string;
    listTransformsJson: () => string;
    normalizeTextNative: (input: string) => string;
    isSensitiveNative: (input: string) => boolean;
    runCliNative: (argsJson: string) => number;
}

let cachedBinding: NativeCoreBinding | null | undefined;

export function loadNativeCore(): NativeCoreBinding | null {
    if (cachedBinding !== undefined) {
        return cachedBinding;
    }
    try {
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const candidates = [
            path.join(thisDir, 'clipnest-core.win32-x64-msvc.node'),
            path.resolve(thisDir, '..', 'dist', 'clipnest-core.win32-x64-msvc.node'),
        ];
        const req = createRequire(import.meta.url);
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                cachedBinding = req(p) as NativeCoreBinding;
                return cachedBinding;
            }
        }
    } catch {
        // Fallback to IPC / CLI binary / JS engine when .node is not built for the current host OS
    }
    cachedBinding = null;
    return null;
}

const arabicChars = ['ك', '\u0640', '\u200d', 'دِ', 'بِ', 'زِ', 'ذِ', 'ِشِ', 'ِسِ', 'ى', 'ي', 'ة'] as const;
const persianChars = ['ک', '', '\u200c', 'د', 'ب', 'ز', 'ذ', 'ش', 'س', 'ی', 'ی', 'ه'] as const;
const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;
const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
const englishDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function toEnglishDigits(value: string): string {
    let out = value;
    for (let i = 0; i < arabicDigits.length; i++) {
        out = out.replace(new RegExp(arabicDigits[i], 'gu'), englishDigits[i]);
    }
    for (let i = 0; i < persianDigits.length; i++) {
        out = out.replace(new RegExp(persianDigits[i], 'gu'), englishDigits[i]);
    }
    return out;
}

export function arabicReplacer(value: string): string {
    let out = value;
    for (let i = 0; i < arabicChars.length; i++) {
        out = out.replace(new RegExp(arabicChars[i], 'gu'), persianChars[i]);
    }
    return toEnglishDigits(out);
}

export function toPersianDigits(value: string): string {
    let out = value;
    for (let i = 0; i < arabicDigits.length; i++) {
        out = out.replace(new RegExp(arabicDigits[i], 'gu'), persianDigits[i]);
    }
    for (let i = 0; i < englishDigits.length; i++) {
        out = out.replace(new RegExp(englishDigits[i], 'gu'), persianDigits[i]);
    }
    return out;
}

const splitWords = (s: string) =>
    s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

const b64enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const b64dec = (s: string) => {
    const raw = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '=');
    return Buffer.from(padded, 'base64').toString('utf8');
};

export const CLI_TRANSFORMS: TransformDef[] = [
    {
        id: 'json-pretty',
        group: 'JSON',
        label: 'Prettify JSON',
        run: (s: string) => JSON.stringify(JSON.parse(s), null, 2),
    },
    {
        id: 'json-min',
        group: 'JSON',
        label: 'Minify JSON',
        run: (s: string) => JSON.stringify(JSON.parse(s)),
    },
    { id: 'upper', group: 'Case', label: 'UPPERCASE', run: (s: string) => s.toUpperCase() },
    { id: 'lower', group: 'Case', label: 'lowercase', run: (s: string) => s.toLowerCase() },
    {
        id: 'title',
        group: 'Case',
        label: 'Title Case',
        run: (s: string) => s.replace(/\w\S*/g, (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
    },
    {
        id: 'sentence',
        group: 'Case',
        label: 'Sentence case',
        run: (s: string) => s.toLowerCase().replace(/(^\s*[a-z]|[.!?]\s+[a-z])/g, (m: string) => m.toUpperCase()),
    },
    {
        id: 'camel',
        group: 'Case',
        label: 'camelCase',
        run: (s: string) =>
            splitWords(s)
                .map((w: string, i: number) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
                .join(''),
    },
    {
        id: 'pascal',
        group: 'Case',
        label: 'PascalCase',
        run: (s: string) =>
            splitWords(s)
                .map((w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase())
                .join(''),
    },
    {
        id: 'snake',
        group: 'Case',
        label: 'snake_case',
        run: (s: string) =>
            splitWords(s)
                .map((w: string) => w.toLowerCase())
                .join('_'),
    },
    {
        id: 'kebab',
        group: 'Case',
        label: 'kebab-case',
        run: (s: string) =>
            splitWords(s)
                .map((w: string) => w.toLowerCase())
                .join('-'),
    },
    {
        id: 'const',
        group: 'Case',
        label: 'CONSTANT_CASE',
        run: (s: string) =>
            splitWords(s)
                .map((w: string) => w.toUpperCase())
                .join('_'),
    },
    { id: 'b64-enc', group: 'Encode', label: 'Base64 encode', run: b64enc },
    { id: 'b64-dec', group: 'Encode', label: 'Base64 decode', run: b64dec },
    { id: 'url-enc', group: 'Encode', label: 'URL encode', run: encodeURIComponent },
    { id: 'url-dec', group: 'Encode', label: 'URL decode', run: decodeURIComponent },
    {
        id: 'html-esc',
        group: 'Encode',
        label: 'HTML escape',
        run: (s: string) =>
            s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;'),
    },
    {
        id: 'html-unesc',
        group: 'Encode',
        label: 'HTML unescape',
        run: (s: string) =>
            s
                .replace(/&#39;|&apos;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/&gt;/g, '>')
                .replace(/&lt;/g, '<')
                .replace(/&amp;/g, '&'),
    },
    {
        id: 'jwt',
        group: 'Encode',
        label: 'Decode JWT',
        run: (s: string) => {
            const p = s.trim().split('.');
            if (p.length < 2) {
                throw new Error('Not a valid JWT');
            }
            const pretty = (x: string) => JSON.stringify(JSON.parse(b64dec(x)), null, 2);
            return `// header\n${pretty(p[0])}\n\n// payload\n${pretty(p[1])}`;
        },
    },
    {
        id: 'trim',
        group: 'Whitespace',
        label: 'Trim',
        run: (s: string) =>
            s
                .split(/\r?\n/)
                .map((l: string) => l.trim())
                .filter(Boolean)
                .join('\n'),
    },
    {
        id: 'collapse',
        group: 'Whitespace',
        label: 'Collapse whitespace',
        run: (s: string) =>
            s
                .replace(/[ \t]+/g, ' ')
                .replace(/\s*\n\s*/g, '\n')
                .trim(),
    },
    {
        id: 'singleline',
        group: 'Lines',
        label: 'Join lines',
        run: (s: string) => s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim(),
    },
    {
        id: 'join-lines-dense',
        group: 'Lines',
        label: 'Join lines (dense)',
        run: (s: string) => s.replace(/\r?\n/g, ''),
    },
    {
        id: 'noblank',
        group: 'Lines',
        label: 'Remove blank lines',
        run: (s: string) =>
            s
                .split(/\r?\n/)
                .filter((l: string) => l.trim())
                .join('\n'),
    },
    {
        id: 'dedupe',
        group: 'Lines',
        label: 'Remove duplicate lines',
        run: (s: string) => [...new Set(s.split(/\r?\n/))].join('\n'),
    },
    {
        id: 'sort',
        group: 'Lines',
        label: 'Sort lines A->Z',
        run: (s: string) =>
            s
                .split(/\r?\n/)
                .sort((a: string, b: string) => a.localeCompare(b))
                .join('\n'),
    },
    {
        id: 'sortr',
        group: 'Lines',
        label: 'Sort lines Z->A',
        run: (s: string) =>
            s
                .split(/\r?\n/)
                .sort((a: string, b: string) => b.localeCompare(a))
                .join('\n'),
    },
    {
        id: 'reverse',
        group: 'Lines',
        label: 'Reverse lines',
        run: (s: string) => s.split(/\r?\n/).reverse().join('\n'),
    },
    {
        id: 'number',
        group: 'Lines',
        label: 'Number lines',
        run: (s: string) =>
            s
                .split(/\r?\n/)
                .map((l: string, i: number) => `${i + 1}. ${l}`)
                .join('\n'),
    },
    {
        id: 'fa-normalize',
        group: 'Persian',
        label: 'Normalize chars & English digits (ی ک 123)',
        run: arabicReplacer,
    },
    {
        id: 'fa-digits',
        group: 'Persian',
        label: 'Farsi digits (۰۱۲۳۴۵۶۷۸۹)',
        run: toPersianDigits,
    },
    {
        id: 'fa-ye-ke',
        group: 'Persian',
        label: 'Arabic Yeh/Kaf -> Persian (ی ک)',
        run: (s: string) => s.replace(/[يى]/gu, 'ی').replace(/ك/gu, 'ک').replace(/ة/gu, 'ه'),
    },
    {
        id: 'count',
        group: 'Info',
        label: 'Count chars / words / lines',
        run: (s: string) =>
            `characters: ${[...s].length}\nwords: ${(s.match(/\S+/g) || []).length}\nlines: ${s.split(/\r?\n/).length}`,
    },
];

export function applyCoreTransform(id: string, input: string): string {
    const addon = loadNativeCore();
    if (addon) {
        return addon.applyTransformNative(id, input);
    }
    const found = CLI_TRANSFORMS.find((t) => t.id === id);
    if (!found) {
        throw new Error(`unknown transform '${id}'. Run 'clipnest transform list' to see available transforms.`);
    }
    return found.run(input);
}

export function resolveDataDir(explicit?: string): string {
    if (explicit) {
        return explicit;
    }
    if (process.env.CLIPNEST_DATA_DIR?.trim()) {
        return process.env.CLIPNEST_DATA_DIR.trim();
    }
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'com.clipnest.app');
}

export function findNativeBinary(): string | null {
    if (process.env.CLIPNEST_BIN && fs.existsSync(process.env.CLIPNEST_BIN)) {
        return process.env.CLIPNEST_BIN;
    }
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'clipnest-cli.exe' : 'clipnest-cli';
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(thisDir, '..');

    const candidates = [
        path.join(pkgRoot, 'bin', exeName),
        path.join(pkgRoot, 'target', 'release', exeName),
        path.resolve(pkgRoot, '..', 'cli', 'bin', exeName),
        path.resolve(pkgRoot, '..', '..', 'src-tauri', 'target', 'release', exeName),
        path.resolve(pkgRoot, '..', '..', 'src-tauri', 'target', 'release', isWin ? 'clipnest.exe' : 'clipnest'),
    ];
    if (isWin) {
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        candidates.push(
            path.join(localAppData, 'Programs', 'ClipNest', 'clipnest-cli.exe'),
            path.join(localAppData, 'Programs', 'ClipNest', 'ClipNest.exe'),
            path.join(localAppData, 'ClipNest', 'clipnest-cli.exe'),
            path.join(localAppData, 'ClipNest', 'ClipNest.exe'),
            path.join(programFiles, 'ClipNest', 'clipnest-cli.exe'),
            path.join(programFiles, 'ClipNest', 'ClipNest.exe')
        );
    }
    for (const c of candidates) {
        if (c && fs.existsSync(c)) {
            return c;
        }
    }
    return null;
}

export function checkVersionCompatibility(cliVersion: string, appVersion: string, appProtocol: number): string | null {
    if (appProtocol !== PROTOCOL_VERSION) {
        return `Protocol mismatch: CLI v${cliVersion} uses protocol v${PROTOCOL_VERSION}, but running ClipNest desktop (v${appVersion}) uses protocol v${appProtocol}. Please update both ClipNest desktop and @seymi/clipnest-cli.`;
    }
    const [cliMaj, cliMin] = cliVersion.split('.').map(Number);
    const [appMaj, appMin] = appVersion.split('.').map(Number);
    if (!Number.isNaN(cliMaj) && !Number.isNaN(appMaj) && (cliMaj !== appMaj || cliMin !== appMin)) {
        return `Version mismatch: CLI is v${cliVersion}, but ClipNest desktop app is v${appVersion}. Please install matching versions.`;
    }
    return null;
}

export async function callIpc(
    dataDir: string,
    op: string,
    params: Record<string, unknown>,
    timeoutMs: number
): Promise<IpcResponse | null> {
    const epFile = path.join(dataDir, 'cli-rpc.json');
    if (!fs.existsSync(epFile)) {
        return null;
    }
    let ep: IpcEndpoint;
    try {
        ep = JSON.parse(fs.readFileSync(epFile, 'utf8')) as IpcEndpoint;
    } catch {
        return null;
    }

    const compatErr = checkVersionCompatibility(CLI_VERSION, ep.version, ep.protocol);
    if (compatErr) {
        return {
            ok: false,
            exit_code: EXIT_OFFLINE,
            data: null,
            error: compatErr,
            hint: 'Run "npm install -g @seymi/clipnest-cli" or update the ClipNest desktop app.',
        };
    }

    return new Promise<IpcResponse | null>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const chunks: Buffer[] = [];

        const finish = (val: IpcResponse | null) => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(val);
            }
        };

        socket.setTimeout(Math.max(250, timeoutMs));
        socket.on('timeout', () =>
            finish({
                ok: false,
                exit_code: EXIT_OFFLINE,
                data: null,
                error: `IPC request timed out after ${timeoutMs}ms`,
                hint: 'Check if ClipNest is frozen or increase --timeout <ms>.',
            })
        );
        socket.on('error', (err: NodeJS.ErrnoException) => {
            if (err?.code === 'ECONNREFUSED') {
                try {
                    fs.unlinkSync(epFile);
                } catch {
                    // ignore
                }
            }
            finish(null);
        });
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            const nlInChunk = chunk.indexOf(0x0a);
            if (nlInChunk >= 0) {
                const full = Buffer.concat(chunks);
                const nl = full.indexOf(0x0a);
                const line = full.subarray(0, nl).toString('utf8').trim();
                try {
                    finish(JSON.parse(line) as IpcResponse);
                } catch {
                    finish(null);
                }
            }
        });
        socket.connect(ep.port, '127.0.0.1', () => {
            const req: IpcRequest = {
                protocol: PROTOCOL_VERSION,
                version: CLI_VERSION,
                token: ep.token,
                op,
                params,
            };
            socket.write(JSON.stringify(req) + '\n');
        });
    });
}

export function dispatchCoreOffline(dataDir: string, op: string, params: Record<string, unknown>): IpcResponse | null {
    const addon = loadNativeCore();
    if (addon) {
        try {
            const raw = addon.dispatchOfflineJson(dataDir, op, JSON.stringify(params));
            return JSON.parse(raw) as IpcResponse;
        } catch (e) {
            return {
                ok: false,
                exit_code: EXIT_ERROR,
                data: null,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    const nativeBin = findNativeBinary();
    if (nativeBin) {
        return invokeNativeBinaryOffline(nativeBin, dataDir, op, params);
    }

    return null;
}

function invokeNativeBinaryOffline(
    nativeBin: string,
    dataDir: string,
    op: string,
    params: Record<string, unknown>
): IpcResponse {
    const cliArgs = ['--data-dir', dataDir, '--offline-rpc', op];
    const r = spawnSync(nativeBin, cliArgs, {
        input: JSON.stringify(params ?? {}),
        encoding: 'utf8',
        timeout: 10000,
    });
    if (r.stdout) {
        try {
            return JSON.parse(r.stdout.trim()) as IpcResponse;
        } catch {
            if (r.status === 0) {
                return { ok: true, exit_code: EXIT_OK, data: { text: r.stdout } };
            }
        }
    }
    if (r.stderr) {
        try {
            const parsedErr = JSON.parse(r.stderr) as { exit_code?: number; error?: string; hint?: string };
            return {
                ok: false,
                exit_code: parsedErr.exit_code ?? r.status ?? EXIT_ERROR,
                data: null,
                error: parsedErr.error ?? r.stderr.trim(),
                hint: parsedErr.hint,
            };
        } catch {
            return {
                ok: false,
                exit_code: r.status || EXIT_ERROR,
                data: null,
                error: r.stderr.trim(),
            };
        }
    }
    return {
        ok: false,
        exit_code: r.status || EXIT_ERROR,
        data: null,
        error: 'Native CLI execution failed',
    };
}
