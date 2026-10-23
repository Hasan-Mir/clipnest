#!/usr/bin/env node
/**
 * ClipNest CLI (@seymi/clipnest-cli) — invoked via `clipnest` or short alias `clipn`.
 *
 * Command-first, pipeline-friendly CLI for ClipNest.
 * Communicates with the running ClipNest desktop app over its authenticated local IPC endpoint
 * (`<data_dir>/cli-rpc.json`), delegates offline SQLite operations to the native `clipnest-cli`
 * binary when available, and provides built-in offline support for text transformations,
 * configuration management, and system clipboard operations.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_VERSION = '0.2.0';
export const PROTOCOL_VERSION = 1;
const MAX_STDIN_BYTES = 64 * 1024 * 1024; // 64 MB

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

export interface CliIo {
    stdin?: string | (() => Promise<string>);
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    readClipboard?: () => Promise<string>;
    writeClipboard?: (text: string) => Promise<void>;
    dataDir?: string;
}

export interface TransformDef {
    id: string;
    group: string;
    label: string;
    run: (s: string) => string;
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

async function defaultReadClipboard(): Promise<string> {
    if (process.platform === 'win32') {
        const r = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
            encoding: 'utf8',
            timeout: 4000,
        });
        if (r.status === 0) {
            return (r.stdout || '').replace(/\r?\n$/, '');
        }
        throw new Error(r.stderr?.trim() || 'Failed to read system clipboard');
    }
    if (process.platform === 'darwin') {
        const r = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 4000 });
        if (r.status === 0) {
            return r.stdout || '';
        }
    }
    const r = spawnSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) {
        return r.stdout || '';
    }
    throw new Error('System clipboard is unavailable in this environment');
}

async function defaultWriteClipboard(text: string): Promise<void> {
    if (process.platform === 'win32') {
        const r = spawnSync('clip', [], { input: text, encoding: 'utf8', timeout: 4000 });
        if (r.status === 0) {
            return;
        }
        throw new Error(r.stderr?.trim() || 'Failed to write to system clipboard');
    }
    if (process.platform === 'darwin') {
        const r = spawnSync('pbcopy', [], { input: text, encoding: 'utf8', timeout: 4000 });
        if (r.status === 0) {
            return;
        }
    }
    const r = spawnSync('xclip', ['-selection', 'clipboard', '-i'], {
        input: text,
        encoding: 'utf8',
        timeout: 4000,
    });
    if (r.status === 0) {
        return;
    }
    throw new Error('System clipboard is unavailable in this environment');
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
        let buffer = '';

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
        socket.on('error', () => {
            try {
                fs.unlinkSync(epFile);
            } catch {
                // ignore
            }
            finish(null);
        });
        socket.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const nl = buffer.indexOf('\n');
            if (nl >= 0) {
                const line = buffer.slice(0, nl).trim();
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

const KNOWN_COMMANDS = [
    'add',
    'list',
    'ls',
    'search',
    'find',
    'get',
    'copy',
    'cp',
    'paste',
    'edit',
    'rename',
    'delete',
    'rm',
    'pin',
    'unpin',
    'tag',
    'move',
    'mv',
    'merge',
    'formats',
    'transform',
    'tr',
    'category',
    'cat',
    'categories',
    'pinboard',
    'board',
    'pinboards',
    'queue',
    'basket',
    'rule',
    'rules',
    'action',
    'actions',
    'config',
    'settings',
    'status',
    'pause',
    'resume',
    'plain',
    'open',
    'show',
    'hide',
    'quit',
    'backup',
    'export',
    'import',
    'erase',
    'clear-history',
    'path',
    'help',
    'version',
] as const;

function editDistance(a: string, b: string): number {
    const dp = Array.from({ length: b.length + 1 }, (_, j: number) => j);
    for (let i = 0; i < a.length; i++) {
        let prev = dp[0];
        dp[0] = i + 1;
        for (let j = 0; j < b.length; j++) {
            const temp = dp[j + 1];
            const cost = a[i] === b[j] ? 0 : 1;
            dp[j + 1] = Math.min(dp[j] + 1, dp[j + 1] + 1, prev + cost);
            prev = temp;
        }
    }
    return dp[b.length];
}

export function suggestCommand(unknown: string): string | null {
    const low = unknown.toLowerCase();
    let best: { cmd: string; d: number } | null = null;
    for (const cmd of KNOWN_COMMANDS) {
        const d = editDistance(low, cmd);
        if (d <= 2 && (!best || d < best.d)) {
            best = { cmd, d };
        }
    }
    return best ? best.cmd : null;
}

async function readStdinFromProcess(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        process.stdin.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_STDIN_BYTES) {
                reject(
                    new Error(`Input from stdin exceeds maximum size limit (${MAX_STDIN_BYTES / (1024 * 1024)} MB)`)
                );
                return;
            }
            chunks.push(chunk);
        });
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', (err: Error) => reject(err));
    });
}

async function readStdin(io: CliIo): Promise<string> {
    if (typeof io.stdin === 'string') {
        if (Buffer.byteLength(io.stdin, 'utf8') > MAX_STDIN_BYTES) {
            throw new Error(`Input from stdin exceeds maximum size limit (${MAX_STDIN_BYTES / (1024 * 1024)} MB)`);
        }
        return io.stdin;
    }
    if (typeof io.stdin === 'function') {
        return io.stdin();
    }
    return readStdinFromProcess();
}

async function resolveInputText(
    io: CliIo,
    argText: string | undefined,
    filePath: string | undefined,
    allowEmpty: boolean
): Promise<string> {
    let raw: string;
    if (filePath !== undefined) {
        if (filePath === '-') {
            raw = await readStdin(io);
        } else {
            if (!fs.existsSync(filePath)) {
                throw new Error(`Cannot read file '${filePath}': file does not exist`);
            }
            raw = fs.readFileSync(filePath, 'utf8');
        }
    } else if (argText !== undefined) {
        if (argText === '-') {
            raw = await readStdin(io);
        } else {
            raw = argText;
        }
    } else {
        throw new Error("Missing input text (provide text argument, '-' for stdin, or --file <path>)");
    }
    if (!allowEmpty && raw.length === 0) {
        throw new Error('Cannot add empty input');
    }
    return raw;
}

const COMMAND_HELP: Record<string, string[]> = {
    add: [
        'Usage: clipnest add <text|-> [options]   (or: clipn add ...)',
        '',
        'Add a new item to ClipNest history (and optionally copy to the system clipboard).',
        '',
        'Options:',
        '  -c, --copy                Also copy the text to the system clipboard (reads stdin once)',
        '  -p, --pin                 Pin the item to the top of history',
        '  -b, --category, --board   Target category (pinboard) ID or name',
        '  -t, --tags <tags>         Space or comma-separated tags',
        '  --title <title>           Custom title for the item',
        '  -f, --file <path>         Read content from a file',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  clipnest add "Deployment token"',
        '  git log -5 --oneline | clipn add -',
        '  git diff | clipn add - --copy --category Work --tags "git,diff"',
    ],
    list: [
        'Usage: clipnest list [options]   (alias: ls)',
        '',
        'List recent clipboard history items.',
        '',
        'Options:',
        '  -n, --limit <count>       Maximum items to return (default: 30)',
        '  -b, --category, --board   Filter by category ID or name',
        '  -k, --kind <kind>         Filter by item kind (text, code, link, image, file, color)',
        '  --pinned                  Only show pinned items',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  clipnest list -n 20',
        '  clipn list --category Work --pinned',
        '  clipn ls --kind code --json',
    ],
    search: [
        'Usage: clipnest search <query> [options]   (alias: find)',
        '',
        'Search clipboard history by keyword, fuzzy subsequence, or regular expression.',
        '',
        'Options:',
        '  -m, --mode <mode>         Search mode: smart (default), fuzzy, or regex',
        '  -r, --regex               Shorthand for --mode regex',
        '  -z, --fuzzy               Shorthand for --mode fuzzy',
        '  -b, --category, --board   Restrict search to a category ID or name',
        '  -n, --limit <count>       Maximum items to return (default: 50)',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  clipnest search "invoice"',
        '  clipn search "^https://" --regex',
        '  clipn find "api" --category Work --json',
    ],
    get: [
        'Usage: clipnest get [id] [options]',
        '',
        'Retrieve raw content from a history item (when [id] is given, e.g. 12 or @0 / latest)',
        'or from the current system clipboard (when [id] is omitted).',
        '',
        'Options:',
        '  -f, --format <fmt>        plain (default), html, formats, or meta',
        '  --html / --meta / --formats  Shorthand format flags',
        '  -o, --out <file>          Write output directly to a file',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  clipnest get 12 > snippet.txt',
        '  clipn get @0 | pb_consumer',
        '  clipn get',
    ],
    copy: [
        'Usage: clipnest copy <text|-> [options]   (alias: cp)',
        '       clipnest copy --id <id> [--plain]',
        '',
        'Write text, piped stdin (-), a file, or an existing history item to the OS clipboard.',
        '',
        'Options:',
        '  -i, --id <id>             Copy an existing history item by ID (or @0 / latest)',
        '  -p, --plain               Copy as plain text only (strip rich HTML/RTF)',
        '  -f, --file <path>         Read text from a file into the clipboard',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  git diff | clipn copy -',
        '  clipnest copy "Quick note"',
        '  clipn copy --id 12 --plain',
    ],
    paste: [
        'Usage: clipnest paste [id] [--plain|--rich|--auto]',
        '',
        'Copy a history item (default: @0 / latest) to the clipboard and simulate paste into the active window.',
        '',
        'Options:',
        '  -p, --plain               Paste as plain text',
        '  -r, --rich                Paste with original rich formatting',
        '  --auto                    Respect default paste mode (default)',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  clipnest paste 12',
        '  clipn paste @0 --plain',
    ],
    edit: [
        'Usage: clipnest edit <id> [new_text|-] [options]',
        '',
        'Update the text content, title, or tags of an existing history item.',
        '',
        'Options:',
        '  --title <title>           Set custom title',
        '  -t, --tags <tags>         Set space or comma-separated tags',
        '  -f, --file <path>         Read replacement text from a file',
        '  --json                    Output structured JSON',
        '',
        'Examples:',
        '  clipnest edit 12 "Updated text" --title "Fixed"',
        '  cat fixed.txt | clipn edit 12 -',
    ],
    rename: [
        'Usage: clipnest rename <id> <title>',
        '',
        'Set or clear the custom title of a history item (pass "" to clear).',
        '',
        'Examples:',
        '  clipnest rename 12 "Production SSH Key"',
        '  clipn rename 12 ""',
    ],
    delete: [
        'Usage: clipnest delete <id...> [--yes]   (alias: rm)',
        '',
        'Delete one or more items from history. Deleting more than 3 items at once requires --yes (-y).',
        '',
        'Examples:',
        '  clipnest delete 12',
        '  clipn rm 12 13 14 15 --yes',
    ],
    pin: [
        'Usage: clipnest pin <id...> [--category <cat>]',
        '',
        'Pin one or more items to the top of the list (globally in main Clipboard or scoped to a category).',
        '',
        'Options:',
        '  -b, --category, --board   Pin inside a specific category only (when independent pinning is enabled)',
        '',
        'Examples:',
        '  clipnest pin 12',
        '  clipn pin 12 --category Work',
    ],
    unpin: [
        'Usage: clipnest unpin <id...> [--category <cat>]',
        '',
        'Unpin one or more items from the top of the list (globally or inside a specific category).',
        '',
        'Options:',
        '  -b, --category, --board   Unpin inside a specific category only',
        '',
        'Examples:',
        '  clipnest unpin 12',
        '  clipn unpin 12 --category Work',
    ],
    tag: [
        'Usage: clipnest tag <id> [tags...] [--add | --remove | --clear]',
        '',
        'Set, add, remove, or clear tags on a history item.',
        '',
        'Examples:',
        '  clipnest tag 12 work urgent',
        '  clipn tag 12 --add backend',
        '  clipn tag 12 --remove urgent',
        '  clipn tag 12 --clear',
    ],
    move: [
        'Usage: clipnest move <id...> --to <category|main> [--from <category>] [--copy]   (alias: mv)',
        '       clipnest move <id> --before <target_id> | --after <target_id> [--scope <category>]',
        '',
        'Move or copy items to a category (or remove from category with --to main), or reorder items.',
        '',
        'Options:',
        '  --to, -b, --category      Target category ID/name (or "main" / "none")',
        '  --from <category>         Source category ID/name when moving between categories',
        '  -c, --copy                Copy to target category while keeping in source category',
        '  --before <id>             Reorder item before target item ID',
        '  --after <id>              Reorder item after target item ID',
        '  --scope <category>        Category scope for reordering',
        '',
        'Examples:',
        '  clipnest move 12 --to Work',
        '  clipn move 12 --from Work --to Personal --copy',
        '  clipn move 15 --before 12',
    ],
    merge: [
        'Usage: clipnest merge <id1> <id2> [idN...] [--sep <separator>] [--copy]',
        '',
        'Merge multiple text items into a single new history item.',
        '',
        'Options:',
        '  -s, --sep <str>           Separator between items (default: "\\n")',
        '  -c, --copy                Also copy the merged item to the system clipboard',
        '',
        'Examples:',
        '  clipnest merge 12 15 --sep "\\n---\\n" --copy',
    ],
    formats: [
        'Usage: clipnest formats [id]',
        '',
        'Inspect all stored clipboard/MIME formats and byte sizes for an item (default: @0 / latest).',
        '',
        'Examples:',
        '  clipnest formats 12',
        '  clipn formats @0 --json',
    ],
    transform: [
        'Usage: clipnest transform <transform_id|list> [id|-] [--save] [--copy]   (alias: tr)',
        '',
        'Run a built-in text transformation on a history item, stdin (-), or --text.',
        '',
        'Options:',
        '  -s, --save                Save the transformed text as a new item in history',
        '  -c, --copy                Copy the transformed text to the system clipboard',
        '  -t, --text <str>          Transform literal text string',
        '',
        'Examples:',
        '  clipnest transform list',
        '  clipn transform json-pretty 12',
        '  echo "كتاب شماره ٢" | clipn tr fa-normalize - --copy',
    ],
    category: [
        'Usage: clipnest category <subcommand> [options]   (aliases: cat, categories, pinboard, board, pinboards)',
        '',
        'Manage categories (pinboards) and the active capture target.',
        '',
        'Subcommands:',
        '  list                                          List all categories and item counts',
        '  create <name> [--color #hex] [--max N] [--active]  Create a new category',
        '  update <id|name> [--name N] [--color C] [--max N] [--paste-mode auto|plain|rich]',
        '  delete <id|name> --yes                        Delete a category and its items',
        '  activate <id|name|none>                       Route new clipboard copies into this category',
        '',
        'Examples:',
        '  clipnest category list',
        '  clipn category create "Work" --color "#34c759" --active',
        '  clipn category activate none',
        '  clipn category delete "Work" --yes',
    ],
    queue: [
        'Usage: clipnest queue <subcommand>',
        '',
        'Control the sequential Paste Queue (FIFO/LIFO). Requires running desktop app.',
        '',
        'Subcommands:',
        '  status | list             Show queue state and queued items',
        '  add <id...>               Add history items to the paste queue',
        '  remove <id>               Remove an item from the queue',
        '  clear                     Clear all queued items',
        '  toggle | close            Show/toggle or close the floating Queue window',
        '  fifo <on|off>             Set FIFO (on) or LIFO (off) paste order',
        '',
        'Examples:',
        '  clipnest queue add 12 15 18',
        '  clipn queue fifo on',
    ],
    basket: [
        'Usage: clipnest basket <subcommand>',
        '',
        'Control the file & image Drop Basket. Requires running desktop app.',
        '',
        'Subcommands:',
        '  list                      List collected files and images in the basket',
        '  add <file_or_id...>       Collect file paths or file/image item IDs into the basket',
        '  remove <id>               Remove an item from the basket',
        '  cut <id>                  Toggle Copy vs Cut (move) mode for a basket item',
        '  paste-to <folder>         Copy/move all basket files into the target folder safely',
        '  clear                     Empty the basket',
        '',
        'Examples:',
        '  clipnest basket add "C:\\Users\\Me\\report.pdf"',
        '  clipn basket paste-to "D:\\Backup"',
    ],
    rule: [
        'Usage: clipnest rule <subcommand>   (alias: rules)',
        '',
        'Manage automatic capture rules (ignore apps, auto-tag, auto-assign category, mask sensitive).',
        '',
        'Subcommands:',
        '  list                                          List all automatic rules',
        '  add <name> --action <ignore|pin|tag|board|sensitive> [--apps a,b] [--pattern regex] [--board id] [--value tag]',
        '  enable <id|name>                              Enable a rule',
        '  disable <id|name>                             Disable a rule',
        '  delete <id|name>                              Delete a rule',
    ],
    action: [
        'Usage: clipnest action <subcommand>   (alias: actions)',
        '',
        'Manage and run custom shell actions on clipboard items (%s = item text).',
        '',
        'Subcommands:',
        '  list                                          List custom actions',
        '  run <id|name> [item_id]                       Run a custom action on an item (default: @0)',
        '  add <name> --cmd <command> [--output new_item|copy|replace|ignore]',
        '  delete <id|name>                              Delete a custom action',
    ],
    config: [
        'Usage: clipnest config <subcommand>',
        '',
        'Read, update, or reset ClipNest settings.',
        '',
        'Subcommands:',
        '  list                      Print all settings as JSON',
        '  get <key>                 Get a single setting value (e.g. max_items, independent_pinning, wrap_categories)',
        '  set <key> <value>         Update a setting (booleans, numbers, strings, or JSON)',
        '  reset [key] [--yes]       Reset one setting key, or all settings (with --yes)',
        '',
        'Examples:',
        '  clipnest config get independent_pinning',
        '  clipn config set wrap_categories true',
        '  clipn config reset max_items',
    ],
    status: [
        'Usage: clipnest status [--check-running] [--json]',
        '',
        'Show daemon status, capture state, paste mode, item/category counts, and data directory.',
        'Pass --check-running to exit with code 4 (EXIT_OFFLINE) when the desktop app is not running.',
    ],
    pause: [
        'Usage: clipnest pause [minutes]',
        '',
        'Pause clipboard monitoring for [minutes] (or indefinitely if omitted).',
    ],
    resume: ['Usage: clipnest resume', '', 'Resume clipboard monitoring immediately.'],
    plain: ['Usage: clipnest plain [on|off|toggle]', '', 'Set or toggle global plain-text default paste mode.'],
    export: [
        'Usage: clipnest export <file> [--format json|db] [--settings]',
        '',
        'Export history, categories, and settings to a JSON bundle (.json), compressed SQLite backup (.db.gz),',
        'or settings-only JSON (--settings). Writes atomically so target files are never corrupted.',
    ],
    import: [
        'Usage: clipnest import <file> [--settings]',
        '',
        'Import and merge items/categories from a ClipNest JSON bundle (.json) or SQLite backup (.db.gz / .db),',
        'or import settings JSON (--settings).',
    ],
    backup: [
        'Usage: clipnest backup [destination_file]',
        '',
        'Create an immediate compressed SQLite snapshot (.db.gz) in the backups folder or at [destination_file].',
    ],
    erase: [
        'Usage: clipnest erase --yes [--category <name|main>] [--include-pinned] [--all-boards]',
        '',
        'Permanently erase clipboard history. Requires --yes (-y) confirmation.',
        '',
        'Options:',
        '  -b, --category, --board   Only erase items in the specified category',
        '  --include-pinned          Also erase pinned items',
        '  --all-boards, --all       Also erase all categories and main clipboard',
    ],
    open: ['Usage: clipnest open   (alias: show)', '', 'Show and focus the ClipNest popup window.'],
    hide: ['Usage: clipnest hide', '', 'Hide the ClipNest popup and tray menu windows.'],
    settings: ['Usage: clipnest settings', '', 'Open the ClipNest Settings window in the running desktop app.'],
    quit: ['Usage: clipnest quit', '', 'Gracefully stop the running ClipNest desktop application.'],
    path: [
        'Usage: clipnest path [status|install|uninstall]',
        '',
        "Inspect, add, or remove ClipNest CLI ('clipnest' and 'clipn') in the current Windows user's PATH.",
    ],
};

const HELP_ALIASES: Record<string, string> = {
    ls: 'list',
    find: 'search',
    cp: 'copy',
    rm: 'delete',
    mv: 'move',
    tr: 'transform',
    cat: 'category',
    categories: 'category',
    pinboard: 'category',
    board: 'category',
    pinboards: 'category',
    rules: 'rule',
    actions: 'action',
    'clear-history': 'erase',
    show: 'open',
};

export function getHelpText(topic?: string): string {
    if (topic) {
        const key = HELP_ALIASES[topic.toLowerCase()] ?? topic.toLowerCase();
        if (COMMAND_HELP[key]) {
            return COMMAND_HELP[key].join('\n');
        }
    }
    return [
        `ClipNest CLI v${CLI_VERSION} — Fast, pipeline-friendly command-line interface for ClipNest`,
        '',
        'USAGE:',
        '  clipnest <command> [arguments] [options]',
        '  clipn <command> [arguments] [options]      (short alias)',
        '',
        'CORE HISTORY & CLIPBOARD COMMANDS:',
        '  add <text|-> [--copy]     Add text or stdin (-) to history (with --copy: also set OS clipboard)',
        '  list [-n <limit>]         List recent clipboard items (--category, --kind, --pinned)',
        '  search <query>            Search history (--mode smart|fuzzy|regex, --category, -n)',
        "  get [id]                  Print item content (e.g. 'get 12', 'get @0') or OS clipboard ('get')",
        "  copy <text|->             Set OS clipboard from text/stdin, or copy history item ('copy --id 12')",
        '  paste [id]                Copy item to clipboard and paste into active window (--plain|--rich)',
        '  edit <id> <text|->        Replace item text and/or metadata (--title, --tags)',
        '  rename <id> <title>       Set or clear custom title for an item',
        '  delete <id...> [--yes]    Delete one or more items from history',
        '  pin <id...> / unpin <id>  Pin or unpin items (supports --category <name>)',
        '  tag <id> [tags...]        Set, --add, --remove, or --clear tags on an item',
        "  move <id...> --to <cat>   Move or --copy items to a category (or 'main'), or reorder (--before/--after)",
        '  merge <id...> [--sep <s>] Merge multiple text items into a new item (--copy)',
        '  formats [id]              Inspect stored MIME/clipboard formats and byte sizes for an item',
        '  transform <tr|list> [id|-] Run a built-in text transform (e.g. upper, json-pretty, fa-normalize)',
        '',
        'CATEGORIES (PINBOARDS), QUEUE & DROP BASKET:',
        '  category <subcommand>     list | create <name> | update <id> | delete <id> | activate <id|none> (alias: pinboard)',
        '  queue <subcommand>        status | list | add <id...> | remove <id> | clear | toggle | fifo <on|off>',
        '  basket <subcommand>       list | add <file|id...> | remove <id> | clear | cut <id> | paste-to <dir>',
        '',
        'AUTOMATION, SETTINGS & MAINTENANCE:',
        '  rule <subcommand>         list | add | enable <id|name> | disable <id|name> | delete <id|name>',
        '  action <subcommand>       list | run <action> <item_id> | add <name> --cmd <cmd> | delete <id>',
        '  config <subcommand>       list | get <key> | set <key> <json_val> | reset [key] [--yes]',
        '  status                    Show daemon, capture, queue, and database status',
        '  pause [minutes] / resume  Pause or resume clipboard capture',
        '  plain [on|off|toggle]     Toggle or set global plain-text paste mode',
        '  export <file>             Export history/categories/settings (.db.gz or .json, or --settings)',
        '  import <file>             Import/merge backup or export (.db.gz, .db, or .json)',
        '  backup [file]             Create a compressed SQLite snapshot immediately',
        '  erase --yes               Erase history (--category <c|main>, --include-pinned, --all-boards)',
        '  open / hide / settings / quit  Show or hide popup, open settings, or quit ClipNest',
        "  path [status|install|uninstall] Manage 'clipnest' & 'clipn' in the current Windows user's PATH",
        '',
        "Run 'clipnest <command> --help' (or 'clipn help <command>') for detailed help on any command.",
    ].join('\n');
}

export async function runCli(rawArgs: string[], customIo?: Partial<CliIo>): Promise<number> {
    const io: CliIo = {
        stdout: customIo?.stdout ?? ((s: string) => process.stdout.write(s)),
        stderr: customIo?.stderr ?? ((s: string) => process.stderr.write(s)),
        stdin: customIo?.stdin,
        readClipboard: customIo?.readClipboard ?? defaultReadClipboard,
        writeClipboard: customIo?.writeClipboard ?? defaultWriteClipboard,
        dataDir: customIo?.dataDir,
    };

    let jsonOut = false;
    let assumeYes = false;
    let onlineOnly = false;
    let timeoutMs = 5000;
    let explicitDataDir = io.dataDir;
    const args: string[] = [];

    for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i];
        if (a === '--json') {
            jsonOut = true;
        } else if (a === '-y' || a === '--yes') {
            assumeYes = true;
        } else if (a === '--online-only' || a === '--require-running') {
            onlineOnly = true;
        } else if (a === '--timeout' && rawArgs[i + 1]) {
            timeoutMs = Number(rawArgs[++i]) || 5000;
        } else if (a === '--data-dir' && rawArgs[i + 1]) {
            explicitDataDir = rawArgs[++i];
        } else if (a === '--portable') {
            // handled in data dir resolution
        } else {
            args.push(a);
        }
    }

    const emitErr = (code: number, msg: string, hint?: string) => {
        if (jsonOut) {
            io.stderr(
                JSON.stringify({
                    ok: false,
                    exit_code: code,
                    error: msg,
                    hint: hint ?? null,
                }) + '\n'
            );
        } else {
            io.stderr(`Error: ${msg}\n`);
            if (hint) {
                io.stderr(`Hint:  ${hint}\n`);
            }
        }
    };

    if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
        const topic = args[0] === 'help' ? args[1] : undefined;
        io.stdout(getHelpText(topic) + '\n');
        return EXIT_OK;
    }

    if (args[0] === '-V' || args[0] === '--version' || args[0] === 'version') {
        if (jsonOut) {
            io.stdout(
                JSON.stringify({
                    name: 'clipnest',
                    alias: 'clipn',
                    version: CLI_VERSION,
                    protocol: PROTOCOL_VERSION,
                }) + '\n'
            );
        } else {
            io.stdout(`clipnest ${CLI_VERSION}\n`);
        }
        return EXIT_OK;
    }

    const cmd = args[0].toLowerCase();
    const rest = args.slice(1);
    const dataDir = resolveDataDir(explicitDataDir);

    if (rest.includes('-h') || rest.includes('--help')) {
        io.stdout(getHelpText(cmd) + '\n');
        return EXIT_OK;
    }

    let op = '';
    let params: Record<string, unknown> = {};
    let outFile: string | undefined;

    try {
        switch (cmd) {
            case 'add': {
                let copy = false;
                let pinned = false;
                let board: string | null = null;
                let tags: string | undefined;
                let title: string | undefined;
                let filePath: string | undefined;
                const positional: string[] = [];
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if (r === '-c' || r === '--copy') {
                        copy = true;
                    } else if (r === '-p' || r === '--pin' || r === '--pinned') {
                        pinned = true;
                    } else if (
                        (r === '-b' || r === '--board' || r === '--pinboard' || r === '--category') &&
                        rest[j + 1]
                    ) {
                        board = rest[++j];
                    } else if ((r === '-t' || r === '--tags' || r === '--tag') && rest[j + 1]) {
                        tags = rest[++j];
                    } else if (r === '--title' && rest[j + 1]) {
                        title = rest[++j];
                    } else if ((r === '-f' || r === '--file') && rest[j + 1]) {
                        filePath = rest[++j];
                    } else {
                        positional.push(r);
                    }
                }
                const joined = positional.length > 0 ? positional.join(' ') : undefined;
                const text = await resolveInputText(io, joined, filePath, false);
                op = 'add';
                params = { text, copy, pinned, board, tags: tags ?? null, title: title ?? null };
                break;
            }

            case 'list':
            case 'ls': {
                let board: string | null = null;
                let limit = 30;
                let kind: string | null = null;
                let pinned = false;
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if (
                        (r === '-b' || r === '--board' || r === '--pinboard' || r === '--category' || r === '-c') &&
                        rest[j + 1]
                    ) {
                        board = rest[++j];
                    } else if ((r === '-n' || r === '--limit') && rest[j + 1]) {
                        limit = Number(rest[++j]) || 30;
                    } else if ((r === '-k' || r === '--kind' || r === '--type') && rest[j + 1]) {
                        kind = rest[++j];
                    } else if (r === '--pinned') {
                        pinned = true;
                    }
                }
                op = 'list';
                params = { query: '', mode: 'smart', board, limit, kind, pinned };
                break;
            }

            case 'search':
            case 'find': {
                let board: string | null = null;
                let limit = 50;
                let mode = 'smart';
                const terms: string[] = [];
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if (
                        (r === '-b' || r === '--board' || r === '--pinboard' || r === '--category' || r === '-c') &&
                        rest[j + 1]
                    ) {
                        board = rest[++j];
                    } else if ((r === '-n' || r === '--limit') && rest[j + 1]) {
                        limit = Number(rest[++j]) || 50;
                    } else if ((r === '-m' || r === '--mode') && rest[j + 1]) {
                        mode = rest[++j];
                    } else if (r === '--regex' || r === '-r') {
                        mode = 'regex';
                    } else if (r === '--fuzzy' || r === '-z') {
                        mode = 'fuzzy';
                    } else {
                        terms.push(r);
                    }
                }
                const query = terms.join(' ');
                if (!query.trim()) {
                    emitErr(EXIT_USAGE, 'Search query cannot be empty', 'Usage: clipnest search "keyword"');
                    return EXIT_USAGE;
                }
                op = 'search';
                params = { query, mode, board, limit };
                break;
            }

            case 'get': {
                let id: string | null = null;
                let format = 'plain';
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if ((r === '--format' || r === '-f') && rest[j + 1]) {
                        format = rest[++j];
                    } else if (r === '--html') {
                        format = 'html';
                    } else if (r === '--meta') {
                        format = 'meta';
                    } else if (r === '--formats') {
                        format = 'formats';
                    } else if ((r === '-o' || r === '--out' || r === '--output') && rest[j + 1]) {
                        outFile = rest[++j];
                    } else if (id === null) {
                        id = r;
                    }
                }
                op = 'get';
                params = { id, format };
                break;
            }

            case 'copy':
            case 'cp': {
                let id: string | null = null;
                let plain = false;
                let filePath: string | undefined;
                const positional: string[] = [];
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if ((r === '--id' || r === '-i') && rest[j + 1]) {
                        id = rest[++j];
                    } else if (r === '--plain' || r === '-p') {
                        plain = true;
                    } else if ((r === '-f' || r === '--file') && rest[j + 1]) {
                        filePath = rest[++j];
                    } else {
                        positional.push(r);
                    }
                }
                if (id !== null) {
                    op = 'copy';
                    params = { id, plain };
                } else {
                    const joined = positional.length > 0 ? positional.join(' ') : undefined;
                    const text = await resolveInputText(io, joined, filePath, true);
                    op = 'copy';
                    params = { text, plain };
                }
                break;
            }

            case 'paste': {
                let mode = 'auto';
                let id: string | null = null;
                for (const r of rest) {
                    if (r === '--plain' || r === '-p') {
                        mode = 'plain';
                    } else if (r === '--rich' || r === '-r') {
                        mode = 'rich';
                    } else if (r === '--auto') {
                        mode = 'auto';
                    } else if (id === null) {
                        id = r;
                    }
                }
                op = 'paste';
                params = { id: id ?? '@0', mode };
                break;
            }

            case 'edit': {
                const id = rest[0];
                if (!id) {
                    emitErr(EXIT_USAGE, 'Provide an item ID to edit', 'Usage: clipnest edit <id> <new_text|->');
                    return EXIT_USAGE;
                }
                let title: string | undefined;
                let tags: string | undefined;
                let filePath: string | undefined;
                const positional: string[] = [];
                for (let j = 1; j < rest.length; j++) {
                    const r = rest[j];
                    if (r === '--title' && rest[j + 1]) {
                        title = rest[++j];
                    } else if ((r === '-t' || r === '--tags') && rest[j + 1]) {
                        tags = rest[++j];
                    } else if ((r === '-f' || r === '--file') && rest[j + 1]) {
                        filePath = rest[++j];
                    } else {
                        positional.push(r);
                    }
                }
                let text: string | null = null;
                if (positional.length > 0 || filePath !== undefined) {
                    const joined = positional.length > 0 ? positional.join(' ') : undefined;
                    text = await resolveInputText(io, joined, filePath, false);
                }
                if (text === null && title === undefined && tags === undefined) {
                    emitErr(EXIT_USAGE, 'Provide new text, --title, or --tags to edit');
                    return EXIT_USAGE;
                }
                op = 'edit';
                params = { id, text, title: title ?? null, tags: tags ?? null };
                break;
            }

            case 'rename': {
                const id = rest[0];
                if (!id) {
                    emitErr(EXIT_USAGE, 'Provide an item ID and new title', 'Usage: clipnest rename <id> "Title"');
                    return EXIT_USAGE;
                }
                op = 'rename';
                params = { id, title: rest.slice(1).join(' ') };
                break;
            }

            case 'delete':
            case 'rm': {
                const ids = rest.filter((a: string) => !a.startsWith('-'));
                if (ids.length === 0) {
                    emitErr(EXIT_USAGE, 'Provide at least one item ID to delete', 'Usage: clipnest delete <id...>');
                    return EXIT_USAGE;
                }
                if (ids.length > 3 && !assumeYes) {
                    emitErr(
                        EXIT_USAGE,
                        `Refusing to bulk-delete ${ids.length} items without --yes confirmation.`,
                        'Re-run with --yes (-y) to confirm deleting multiple items.'
                    );
                    return EXIT_USAGE;
                }
                op = 'delete';
                params = { ids };
                break;
            }

            case 'pin':
            case 'unpin': {
                const ids: string[] = [];
                let board: string | null = null;
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if (
                        (r === '-b' || r === '--board' || r === '--pinboard' || r === '--category' || r === '-c') &&
                        rest[j + 1]
                    ) {
                        board = rest[++j];
                    } else if (!r.startsWith('-')) {
                        ids.push(r);
                    }
                }
                if (ids.length === 0) {
                    emitErr(
                        EXIT_USAGE,
                        `Provide at least one item ID to ${cmd}`,
                        `Usage: clipnest ${cmd} <id...> [--category <name>]`
                    );
                    return EXIT_USAGE;
                }
                op = cmd;
                params = board !== null ? { ids, board } : { ids };
                break;
            }

            case 'tag': {
                const id = rest[0];
                if (!id) {
                    emitErr(EXIT_USAGE, 'Provide an item ID', 'Usage: clipnest tag <id> <tags...>');
                    return EXIT_USAGE;
                }
                let mode = 'set';
                const parts: string[] = [];
                for (const a of rest.slice(1)) {
                    if (a === '--clear') {
                        mode = 'clear';
                    } else if (a === '--add') {
                        mode = 'add';
                    } else if (a === '--remove' || a === '--rm') {
                        mode = 'remove';
                    } else {
                        parts.push(a);
                    }
                }
                op = 'tag';
                params = { id, tags: parts.join(' '), mode };
                break;
            }

            case 'move':
            case 'mv': {
                const ids: string[] = [];
                let to: string | null = null;
                let from: string | null = null;
                let copy = false;
                let before: string | null = null;
                let after: string | null = null;
                let board: string | null = null;
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if (
                        (r === '--to' || r === '-b' || r === '--board' || r === '--pinboard' || r === '--category') &&
                        rest[j + 1]
                    ) {
                        to = rest[++j];
                    } else if (r === '--from' && rest[j + 1]) {
                        from = rest[++j];
                    } else if (r === '-c' || r === '--copy') {
                        copy = true;
                    } else if (r === '--before' && rest[j + 1]) {
                        before = rest[++j];
                    } else if (r === '--after' && rest[j + 1]) {
                        after = rest[++j];
                    } else if (r === '--scope' && rest[j + 1]) {
                        board = rest[++j];
                    } else {
                        ids.push(r);
                    }
                }
                if (to === null && before === null && after === null && ids.length >= 2) {
                    to = ids.pop() ?? null;
                }
                op = 'move';
                params = { ids, to, from, copy, before, after, board };
                break;
            }

            case 'merge': {
                const ids: string[] = [];
                let sep = '\n';
                let copy = false;
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if ((r === '-s' || r === '--sep' || r === '--separator') && rest[j + 1]) {
                        sep = rest[++j].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                    } else if (r === '-c' || r === '--copy') {
                        copy = true;
                    } else {
                        ids.push(r);
                    }
                }
                op = 'merge';
                params = { ids, sep, copy };
                break;
            }

            case 'formats': {
                op = 'formats';
                params = { id: rest[0] ?? '@0' };
                break;
            }

            case 'transform':
            case 'tr': {
                const trId = rest[0] ?? 'list';
                if (trId === 'list') {
                    op = 'transform';
                    params = { transform: 'list' };
                } else {
                    let id: string | null = null;
                    let text: string | null = null;
                    let save = false;
                    let copy = false;
                    for (let j = 1; j < rest.length; j++) {
                        const r = rest[j];
                        if (r === '--save' || r === '-s') {
                            save = true;
                        } else if (r === '--copy' || r === '-c') {
                            copy = true;
                        } else if ((r === '--text' || r === '-t') && rest[j + 1]) {
                            text = rest[++j];
                        } else if (r === '-') {
                            text = await readStdin(io);
                        } else if (id === null) {
                            id = r;
                        }
                    }
                    op = 'transform';
                    params = { transform: trId, id, text, save, copy };
                }
                break;
            }

            case 'categories':
            case 'pinboards':
                op = 'pinboard';
                params = { sub: 'list' };
                break;

            case 'category':
            case 'cat':
            case 'pinboard':
            case 'board': {
                const sub = rest[0] ?? 'list';
                if (sub === 'delete' || sub === 'rm') {
                    if (!assumeYes) {
                        emitErr(
                            EXIT_USAGE,
                            'Deleting a category also deletes its items. Pass --yes (-y) to confirm.',
                            'Usage: clipnest category delete <id|name> --yes'
                        );
                        return EXIT_USAGE;
                    }
                    op = 'pinboard';
                    params = { sub: 'delete', board: rest[1] ?? '' };
                } else if (sub === 'create' || sub === 'add') {
                    let name = '';
                    let color = '#4f8cff';
                    let max_items = 0;
                    let list_style = 'inherit';
                    let paste_mode = 'inherit';
                    let active = false;
                    for (let j = 1; j < rest.length; j++) {
                        const r = rest[j];
                        if ((r === '--color' || r === '-c') && rest[j + 1]) {
                            color = rest[++j];
                        } else if ((r === '--max' || r === '--max-items') && rest[j + 1]) {
                            max_items = Number(rest[++j]) || 0;
                        } else if (r === '--style' && rest[j + 1]) {
                            list_style = rest[++j];
                        } else if (r === '--paste-mode' && rest[j + 1]) {
                            paste_mode = rest[++j];
                        } else if (r === '--active') {
                            active = true;
                        } else if (!name) {
                            name = r;
                        }
                    }
                    op = 'pinboard';
                    params = { sub: 'create', name, color, max_items, list_style, paste_mode, active };
                } else if (sub === 'update' || sub === 'edit') {
                    const pObj: Record<string, unknown> = { sub: 'update', board: rest[1] ?? '' };
                    for (let j = 2; j < rest.length; j++) {
                        const r = rest[j];
                        if (r === '--name' && rest[j + 1]) {
                            pObj.name = rest[++j];
                        } else if ((r === '--color' || r === '-c') && rest[j + 1]) {
                            pObj.color = rest[++j];
                        } else if ((r === '--max' || r === '--max-items') && rest[j + 1]) {
                            pObj.max_items = Number(rest[++j]) || 0;
                        } else if (r === '--style' && rest[j + 1]) {
                            pObj.list_style = rest[++j];
                        } else if (r === '--paste-mode' && rest[j + 1]) {
                            pObj.paste_mode = rest[++j];
                        } else if (r === '--active') {
                            pObj.active = true;
                        } else if (r === '--inactive') {
                            pObj.active = false;
                        }
                    }
                    op = 'pinboard';
                    params = pObj;
                } else if (sub === 'activate' || sub === 'use') {
                    op = 'pinboard';
                    params = { sub: 'activate', board: rest[1] ?? 'none' };
                } else {
                    op = 'pinboard';
                    params = { sub: sub === 'ls' ? 'list' : sub };
                }
                break;
            }

            case 'queue':
            case 'basket': {
                const sub = rest[0] ?? 'list';
                if (sub === 'add') {
                    op = cmd;
                    params = { sub: 'add', items: rest.slice(1) };
                } else if (sub === 'remove' || sub === 'rm' || sub === 'cut') {
                    op = cmd;
                    params = { sub: sub === 'rm' ? 'remove' : sub, id: rest[1] ?? '' };
                } else if (sub === 'mode') {
                    op = cmd;
                    params = { sub: 'mode', mode: rest[1] ?? 'queue' };
                } else if (sub === 'fifo') {
                    const v = !['off', 'false', 'lifo', '0'].includes((rest[1] ?? 'on').toLowerCase());
                    op = cmd;
                    params = { sub: 'fifo', fifo: v };
                } else if (sub === 'paste-to') {
                    op = cmd;
                    params = { sub: 'paste-to', folder: rest[1] ?? '' };
                } else {
                    op = cmd;
                    params = { sub: sub === 'ls' ? 'list' : sub };
                }
                break;
            }

            case 'rules':
                op = 'rule';
                params = { sub: 'list' };
                break;

            case 'rule': {
                const sub = rest[0] ?? 'list';
                if (sub === 'enable' || sub === 'disable' || sub === 'delete' || sub === 'rm') {
                    op = 'rule';
                    params = { sub: sub === 'rm' ? 'delete' : sub, target: rest[1] ?? '' };
                } else if (sub === 'add') {
                    let name = 'CLI Rule';
                    let action = 'ignore';
                    let apps = '';
                    let pattern = '';
                    let value = '';
                    let board = 0;
                    const kinds: string[] = [];
                    for (let j = 1; j < rest.length; j++) {
                        const r = rest[j];
                        if (r === '--name' && rest[j + 1]) {
                            name = rest[++j];
                        } else if (r === '--action' && rest[j + 1]) {
                            action = rest[++j];
                        } else if (r === '--apps' && rest[j + 1]) {
                            apps = rest[++j];
                        } else if (r === '--pattern' && rest[j + 1]) {
                            pattern = rest[++j];
                        } else if (r === '--value' && rest[j + 1]) {
                            value = rest[++j];
                        } else if ((r === '--board' || r === '--category') && rest[j + 1]) {
                            board = Number(rest[++j]) || 0;
                        } else if (r === '--kind' && rest[j + 1]) {
                            kinds.push(rest[++j]);
                        } else if (name === 'CLI Rule') {
                            name = r;
                        }
                    }
                    op = 'rule';
                    params = { sub: 'add', name, action, apps, pattern, value, board, kinds };
                } else {
                    op = 'rule';
                    params = { sub: sub === 'ls' ? 'list' : sub };
                }
                break;
            }

            case 'actions':
                op = 'action';
                params = { sub: 'list' };
                break;

            case 'action': {
                const sub = rest[0] ?? 'list';
                if (sub === 'run') {
                    op = 'action';
                    params = { sub: 'run', target: rest[1] ?? '', id: rest[2] ?? '@0' };
                } else if (sub === 'add') {
                    let name = '';
                    let command = '';
                    let output = 'new_item';
                    for (let j = 1; j < rest.length; j++) {
                        const r = rest[j];
                        if ((r === '--cmd' || r === '--command' || r === '-c') && rest[j + 1]) {
                            command = rest[++j];
                        } else if ((r === '--output' || r === '-o') && rest[j + 1]) {
                            output = rest[++j];
                        } else if (!name) {
                            name = r;
                        }
                    }
                    op = 'action';
                    params = { sub: 'add', name, command, output };
                } else if (sub === 'delete' || sub === 'rm') {
                    op = 'action';
                    params = { sub: 'delete', target: rest[1] ?? '' };
                } else {
                    op = 'action';
                    params = { sub: sub === 'ls' ? 'list' : sub };
                }
                break;
            }

            case 'config': {
                const sub = rest[0] ?? 'list';
                if (sub === 'get') {
                    op = 'config';
                    params = { sub: 'get', key: rest[1] ?? '' };
                } else if (sub === 'set') {
                    const key = rest[1] ?? '';
                    const raw = rest[2] ?? '';
                    let parsed: unknown = raw;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        parsed = raw;
                    }
                    op = 'config';
                    params = { sub: 'set', key, value: parsed };
                } else if (sub === 'reset') {
                    const key = rest[1];
                    if (!key && !assumeYes) {
                        emitErr(
                            EXIT_USAGE,
                            'Resetting all settings requires --yes (-y)',
                            'Usage: clipnest config reset --yes OR clipnest config reset <key>'
                        );
                        return EXIT_USAGE;
                    }
                    op = 'config';
                    params = { sub: 'reset', key: key ?? null };
                } else {
                    op = 'config';
                    params = { sub: sub === 'ls' ? 'list' : sub };
                }
                break;
            }

            case 'status':
                op = 'status';
                params = {};
                break;
            case 'pause':
                op = 'pause';
                params = { minutes: rest[0] ? Number(rest[0]) : null };
                break;
            case 'resume':
                op = 'resume';
                params = {};
                break;
            case 'plain':
                op = 'plain';
                params = { mode: rest[0] ?? 'toggle' };
                break;
            case 'open':
            case 'show':
                op = 'open';
                params = {};
                break;
            case 'hide':
                op = 'hide';
                params = {};
                break;
            case 'settings':
                op = 'settings';
                params = {};
                break;
            case 'quit':
                op = 'quit';
                params = {};
                break;
            case 'backup':
                op = 'backup';
                params = { path: rest[0] ?? null };
                break;
            case 'export': {
                let pth = '';
                let format = '';
                let settingsOnly = false;
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if ((r === '--format' || r === '-f') && rest[j + 1]) {
                        format = rest[++j];
                    } else if (r === '--settings') {
                        settingsOnly = true;
                    } else if (!pth) {
                        pth = r;
                    }
                }
                op = 'export';
                params = { path: pth, format, settings: settingsOnly };
                break;
            }
            case 'import': {
                let pth = '';
                let settingsOnly = false;
                for (const r of rest) {
                    if (r === '--settings') {
                        settingsOnly = true;
                    } else if (!pth) {
                        pth = r;
                    }
                }
                op = 'import';
                params = { path: pth, settings: settingsOnly };
                break;
            }
            case 'erase':
            case 'clear-history': {
                if (!assumeYes) {
                    emitErr(
                        EXIT_USAGE,
                        'Erasing history is permanent. Pass --yes (-y) to confirm.',
                        'Example: clipnest erase --yes'
                    );
                    return EXIT_USAGE;
                }
                let includePinned = false;
                let allBoards = false;
                let board: string | null = null;
                for (let j = 0; j < rest.length; j++) {
                    const r = rest[j];
                    if (r === '--include-pinned' || r === '--pinned') {
                        includePinned = true;
                    } else if (r === '--all-boards' || r === '--all') {
                        allBoards = true;
                    } else if (
                        (r === '-b' || r === '--board' || r === '--pinboard' || r === '--category' || r === '-c') &&
                        rest[j + 1]
                    ) {
                        board = rest[++j];
                    }
                }
                op = 'erase';
                params = { include_pinned: includePinned, all_boards: allBoards, board };
                break;
            }
            case 'path': {
                const nativeBin = findNativeBinary();
                if (nativeBin) {
                    const r = spawnSync(nativeBin, rawArgs, { encoding: 'utf8' });
                    if (r.stdout) {
                        io.stdout(r.stdout);
                    }
                    if (r.stderr) {
                        io.stderr(r.stderr);
                    }
                    return r.status ?? EXIT_ERROR;
                }
                emitErr(
                    EXIT_OFFLINE,
                    'Native ClipNest binary not found for Windows Registry PATH update.',
                    'When installed via npm ("npm install -g @seymi/clipnest-cli"), npm manages the global "clipnest" and "clipn" shims on your PATH automatically.'
                );
                return EXIT_OFFLINE;
            }

            default: {
                const sug = suggestCommand(cmd);
                emitErr(
                    EXIT_USAGE,
                    `Unknown command '${cmd}'`,
                    sug
                        ? `Did you mean 'clipnest ${sug}'? Run 'clipnest --help' for all commands.`
                        : "Run 'clipnest --help' for all available commands."
                );
                return EXIT_USAGE;
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitErr(EXIT_USAGE, msg, `Run 'clipnest ${cmd} --help' for usage details.`);
        return EXIT_USAGE;
    }

    let resp = await callIpc(dataDir, op, params, timeoutMs);

    if (!resp) {
        if (onlineOnly) {
            emitErr(
                EXIT_OFFLINE,
                'ClipNest desktop app is not running (and --online-only was specified).',
                'Start ClipNest desktop app or omit --online-only.'
            );
            return EXIT_OFFLINE;
        }
        resp = await executeOfflineFallback(io, dataDir, op, params);
    }

    if (!resp.ok) {
        emitErr(resp.exit_code, resp.error || 'Operation failed', resp.hint);
        return resp.exit_code;
    }

    if (op === 'status' && rest.includes('--check-running') && !(resp.data as Record<string, unknown>)?.running) {
        if (jsonOut) {
            io.stdout(JSON.stringify(resp.data, null, 2) + '\n');
        } else {
            io.stdout(`ClipNest is offline (data_dir: ${dataDir})\n`);
        }
        return EXIT_OFFLINE;
    }

    if (jsonOut) {
        io.stdout(JSON.stringify(resp.data, null, 2) + '\n');
        return resp.exit_code;
    }

    return renderHuman(io, op, resp.data as Record<string, unknown>, outFile);
}

async function executeOfflineFallback(
    io: CliIo,
    dataDir: string,
    op: string,
    params: Record<string, unknown>
): Promise<IpcResponse> {
    if (['open', 'hide', 'settings', 'quit', 'pause', 'resume', 'queue', 'basket'].includes(op)) {
        return {
            ok: false,
            exit_code: EXIT_OFFLINE,
            data: null,
            error: `ClipNest desktop app is not running (command '${op}' requires the running desktop app).`,
            hint: 'Launch ClipNest first, then re-run this command.',
        };
    }

    if (op === 'copy' && params.id === undefined) {
        const text = String(params.text ?? '');
        try {
            await io.writeClipboard!(text);
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: { copied: true, chars: [...text].length, bytes: Buffer.byteLength(text, 'utf8') },
            };
        } catch (e) {
            return {
                ok: false,
                exit_code: EXIT_ERROR,
                data: null,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    if (op === 'get' && (params.id === null || params.id === undefined)) {
        try {
            const text = await io.readClipboard!();
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: { source: 'clipboard', text, chars: [...text].length },
            };
        } catch (e) {
            return {
                ok: false,
                exit_code: EXIT_ERROR,
                data: null,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    if (op === 'transform') {
        const trId = String(params.transform ?? 'list');
        if (trId === 'list') {
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: {
                    transforms: CLI_TRANSFORMS.map(({ id, group, label }) => ({ id, group, label })),
                },
            };
        }
        if (typeof params.text === 'string' && !params.save) {
            const found = CLI_TRANSFORMS.find((t) => t.id === trId);
            if (!found) {
                return {
                    ok: false,
                    exit_code: EXIT_USAGE,
                    data: null,
                    error: `unknown transform '${trId}'. Run 'clipnest transform list' to see available transforms.`,
                };
            }
            try {
                const out = found.run(params.text);
                if (params.copy) {
                    await io.writeClipboard!(out);
                }
                return {
                    ok: true,
                    exit_code: EXIT_OK,
                    data: { transform: trId, text: out, saved_id: null, copied: Boolean(params.copy) },
                };
            } catch (e) {
                return {
                    ok: false,
                    exit_code: EXIT_USAGE,
                    data: null,
                    error: e instanceof Error ? e.message : String(e),
                };
            }
        }
    }

    if (op === 'status') {
        const nativeBin = findNativeBinary();
        if (!nativeBin) {
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: {
                    running: false,
                    version: CLI_VERSION,
                    protocol: PROTOCOL_VERSION,
                    data_dir: dataDir,
                    total_items: 0,
                    pinboards_count: 0,
                    active_pinboard: null,
                    paused_until: 0,
                    plain_default: false,
                    queue_active: false,
                    queue_mode: 'queue',
                    queue_len: 0,
                    popup_pinned: false,
                },
            };
        }
    }

    const nativeBin = findNativeBinary();
    if (nativeBin) {
        return invokeNativeOffline(nativeBin, dataDir, op, params);
    }

    return {
        ok: false,
        exit_code: EXIT_OFFLINE,
        data: null,
        error: 'ClipNest desktop app is not running and native offline engine was not found.',
        hint: 'Start the ClipNest desktop app so the CLI can connect over local IPC.',
    };
}

function invokeNativeOffline(
    nativeBin: string,
    dataDir: string,
    op: string,
    params: Record<string, unknown>
): IpcResponse {
    const cliArgs = ['--json', '--data-dir', dataDir];
    let stdinInput: string | undefined;

    switch (op) {
        case 'add':
            cliArgs.push('add', '-');
            stdinInput = String(params.text ?? '');
            if (params.copy) cliArgs.push('--copy');
            if (params.pinned) cliArgs.push('--pin');
            if (params.board) cliArgs.push('--board', String(params.board));
            if (params.tags) cliArgs.push('--tags', String(params.tags));
            if (params.title) cliArgs.push('--title', String(params.title));
            break;
        case 'list':
            cliArgs.push('list', '-n', String(params.limit ?? 30));
            if (params.board) cliArgs.push('--board', String(params.board));
            if (params.kind) cliArgs.push('--kind', String(params.kind));
            if (params.pinned) cliArgs.push('--pinned');
            break;
        case 'search':
            cliArgs.push(
                'search',
                String(params.query ?? ''),
                '--mode',
                String(params.mode ?? 'smart'),
                '-n',
                String(params.limit ?? 50)
            );
            if (params.board) cliArgs.push('--board', String(params.board));
            break;
        case 'get':
            cliArgs.push('get');
            if (params.id !== null && params.id !== undefined) cliArgs.push(String(params.id));
            if (params.format) cliArgs.push('--format', String(params.format));
            break;
        default:
            cliArgs.push(op);
            break;
    }

    const r = spawnSync(nativeBin, cliArgs, {
        input: stdinInput,
        encoding: 'utf8',
        timeout: 10000,
    });
    if (r.status === 0 && r.stdout) {
        try {
            return { ok: true, exit_code: EXIT_OK, data: JSON.parse(r.stdout) };
        } catch {
            return { ok: true, exit_code: EXIT_OK, data: { text: r.stdout } };
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

function renderHuman(io: CliIo, op: string, data: Record<string, unknown>, outFile?: string): number {
    if (op === 'get') {
        if (Array.isArray(data.formats)) {
            for (const f of data.formats as { name: string; mime: string; size: number }[]) {
                io.stdout(`${f.name.padEnd(28)} ${f.mime.padEnd(26)} ${f.size} B\n`);
            }
            return EXIT_OK;
        }
        if (data.item && data.text === undefined) {
            io.stdout(JSON.stringify(data.item, null, 2) + '\n');
            return EXIT_OK;
        }
        const text = String(data.text ?? '');
        if (outFile) {
            const tmp = `${outFile}.tmp`;
            fs.writeFileSync(tmp, text, 'utf8');
            fs.renameSync(tmp, outFile);
            return EXIT_OK;
        }
        io.stdout(text);
        return EXIT_OK;
    }

    if (op === 'transform') {
        if (Array.isArray(data.transforms)) {
            io.stdout(`${'ID'.padEnd(18)} ${'GROUP'.padEnd(12)} DESCRIPTION\n`);
            for (const t of data.transforms as { id: string; group: string; label: string }[]) {
                io.stdout(`${t.id.padEnd(18)} ${t.group.padEnd(12)} ${t.label}\n`);
            }
            return EXIT_OK;
        }
        io.stdout(String(data.text ?? ''));
        return EXIT_OK;
    }

    if (op === 'add') {
        const item = data.item as { id?: number } | undefined;
        const id = item?.id ?? 0;
        if (data.copied) {
            io.stdout(`Added item #${id} and copied to clipboard.\n`);
        } else {
            io.stdout(`${id}\n`);
        }
        return EXIT_OK;
    }

    if (op === 'list' || op === 'search') {
        const items = (data.items as Record<string, unknown>[]) ?? [];
        if (items.length === 0) {
            io.stdout('No items found.\n');
            return EXIT_OK;
        }
        io.stdout(`${'ID'.padEnd(6)} ${'KIND'.padEnd(7)} ${'PIN'.padEnd(5)} ${'APP'.padEnd(14)} PREVIEW\n`);
        for (const it of items) {
            const id = String(it.id ?? '').padEnd(6);
            const kind = String(it.kind ?? 'text').padEnd(7);
            const pin = (it.pinned ? '★' : '').padEnd(5);
            const app = String(it.app_name ?? '')
                .slice(0, 14)
                .padEnd(14);
            const preview = String(it.preview ?? '')
                .replace(/[\r\n\t]+/g, ' ')
                .slice(0, 68);
            io.stdout(`${id} ${kind} ${pin} ${app} ${preview}\n`);
        }
        return EXIT_OK;
    }

    if (op === 'status') {
        io.stdout(`ClipNest v${CLI_VERSION}\n`);
        io.stdout(`  Daemon:        ${data.running ? 'running' : 'offline (direct DB mode)'}\n`);
        io.stdout(`  Capture:       ${Number(data.paused_until ?? 0) > 0 ? 'paused' : 'active'}\n`);
        io.stdout(`  Paste mode:    ${data.plain_default ? 'plain text' : 'rich (keep formatting)'}\n`);
        io.stdout(`  History items: ${data.total_items ?? 0} (${data.pinboards_count ?? 0} categories)\n`);
        io.stdout(
            `  Queue/Basket:  ${data.queue_active ? 'active' : 'inactive'} (${data.queue_mode ?? 'queue'}, ${
                data.queue_len ?? 0
            } items)\n`
        );
        io.stdout(`  Data folder:   ${data.data_dir ?? ''}\n`);
        return EXIT_OK;
    }

    io.stdout(JSON.stringify(data, null, 2) + '\n');
    return EXIT_OK;
}

const isDirectExecution =
    process.argv[1] &&
    (path.basename(process.argv[1]).startsWith('clipnest') ||
        path.basename(process.argv[1]).startsWith('clipn') ||
        path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)));

if (isDirectExecution && !process.env.VITEST) {
    runCli(process.argv.slice(2))
        .then((code: number) => process.exit(code))
        .catch((err: unknown) => {
            process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(EXIT_ERROR);
        });
}
