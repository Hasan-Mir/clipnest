import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
    CLI_VERSION,
    EXIT_NOT_FOUND,
    EXIT_OFFLINE,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_USAGE,
    PROTOCOL_VERSION,
    checkVersionCompatibility,
    getHelpText,
    runCli,
    suggestCommand,
} from '../dist/index.js';

interface MockIpcOverrides {
    token?: string;
    protocol?: number;
    version?: string;
}

type IpcHandler = (op: string, params: Record<string, unknown>) => Record<string, unknown>;

describe('@seymi/clipnest-cli end-to-end verification', () => {
    let tmpDir: string;
    let server: net.Server | null = null;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipnest-node-test-'));
    });

    afterEach(async () => {
        if (server) {
            await new Promise<void>((r) => server!.close(() => r()));
            server = null;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function startMockIpcServer(handler: IpcHandler, overrides: MockIpcOverrides = {}): Promise<void> {
        const token = overrides.token ?? 'secret-test-token-123';
        server = net.createServer((socket) => {
            let buf = '';
            socket.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl >= 0) {
                    const req = JSON.parse(buf.slice(0, nl)) as {
                        token?: string;
                        op: string;
                        params: Record<string, unknown>;
                    };
                    if (req.token !== token) {
                        socket.write(
                            JSON.stringify({
                                ok: false,
                                exit_code: EXIT_OFFLINE,
                                data: null,
                                error: 'Invalid IPC token',
                            }) + '\n'
                        );
                        return;
                    }
                    const resp = handler(req.op, req.params);
                    socket.write(JSON.stringify(resp) + '\n');
                }
            });
        });
        await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
        const addr = server.address() as net.AddressInfo;
        fs.writeFileSync(
            path.join(tmpDir, 'cli-rpc.json'),
            JSON.stringify({
                protocol: overrides.protocol ?? PROTOCOL_VERSION,
                version: overrides.version ?? CLI_VERSION,
                pid: process.pid,
                port: addr.port,
                token,
            }),
            'utf8'
        );
    }

    it('Scenario 1, 2 & 5: adds direct text and multiline stdin while preserving exact newlines, and rejects empty input', async () => {
        const received: Array<{ op: string; [key: string]: unknown }> = [];
        await startMockIpcServer((op, params) => {
            received.push({ op, ...params });
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: {
                    item: { id: 42 },
                    created: true,
                    copied: Boolean(params.copy),
                },
            };
        });

        let out = '';
        let err = '';
        const code1 = await runCli(['add', 'Hello direct clip'], {
            dataDir: tmpDir,
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(code1, EXIT_OK);
        assert.equal(out.trim(), '42');
        assert.equal(err, '');
        assert.equal(received[0].text, 'Hello direct clip');

        const multiline = 'line 1\n\nline 3 with فرمت فارسی\r\nline 4\n';
        out = '';
        const code2 = await runCli(['add', '-', '--pin', '--category', 'Work', '--tags', 'git,log'], {
            dataDir: tmpDir,
            stdin: multiline,
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(code2, EXIT_OK);
        assert.equal(received[1].text, multiline);
        assert.equal(received[1].pinned, true);
        assert.equal(received[1].board, 'Work');

        err = '';
        const codeEmpty = await runCli(['add', '-'], {
            dataDir: tmpDir,
            stdin: '',
            stdout: () => {},
            stderr: (s) => (err += s),
        });
        assert.equal(codeEmpty, EXIT_USAGE);
        assert.match(err, /empty/i);
    });

    it('Scenario 3 & 4: sets system clipboard from stdin and performs combined add - --copy reading stdin once (including partial failure)', async () => {
        let stdinReads = 0;
        let lastParams: Record<string, unknown> = {};
        await startMockIpcServer((op, params) => {
            lastParams = { op, ...params };
            if (params.text === 'trigger-partial') {
                return {
                    ok: false,
                    exit_code: EXIT_PARTIAL,
                    data: { item: { id: 99 }, created: true, copied: false },
                    error: 'Added item #99 to history, but failed to copy to system clipboard: clipboard is busy',
                };
            }
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: { item: { id: 77 }, created: true, copied: true },
            };
        });

        let out = '';
        let err = '';
        const code = await runCli(['add', '-', '--copy'], {
            dataDir: tmpDir,
            stdin: async () => {
                stdinReads += 1;
                return 'diff --git a/file.ts b/file.ts\n+added line\n';
            },
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(code, EXIT_OK);
        assert.equal(stdinReads, 1);
        assert.equal(lastParams.copy, true);
        assert.match(out, /#77/);

        out = '';
        err = '';
        const partialCode = await runCli(['add', '-', '--copy'], {
            dataDir: tmpDir,
            stdin: 'trigger-partial',
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(partialCode, EXIT_PARTIAL);
        assert.equal(out, '');
        assert.match(err, /Added item #99 to history, but failed to copy/);
    });

    it('Scenario 6 & 7: separates raw stdout from stderr, provides help for every command, and returns proper exit codes', async () => {
        await startMockIpcServer((op, params) => {
            if (op === 'get' && params.id === '12') {
                return {
                    ok: true,
                    exit_code: EXIT_OK,
                    data: {
                        source: 'history',
                        id: 12,
                        kind: 'text',
                        text: 'exact raw payload\nline 2',
                    },
                };
            }
            return {
                ok: false,
                exit_code: EXIT_NOT_FOUND,
                error: `Item #${params.id} not found`,
            };
        });

        let out = '';
        let err = '';
        const okCode = await runCli(['get', '12'], {
            dataDir: tmpDir,
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(okCode, EXIT_OK);
        assert.equal(out, 'exact raw payload\nline 2');
        assert.equal(err, '');

        out = '';
        err = '';
        const notFoundCode = await runCli(['get', '999'], {
            dataDir: tmpDir,
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(notFoundCode, EXIT_NOT_FOUND);
        assert.equal(out, '');
        assert.match(err, /Item #999 not found/);

        assert.equal(suggestCommand('lst'), 'list');
        err = '';
        const usageCode = await runCli(['lst'], {
            dataDir: tmpDir,
            stdout: () => {},
            stderr: (s) => (err += s),
        });
        assert.equal(usageCode, EXIT_USAGE);
        assert.match(err, /Did you mean 'clipnest list'\?/);

        assert.match(getHelpText(), /clipn <command>/);
        assert.match(getHelpText('category'), /clipnest category <subcommand>/);

        assert.equal(checkVersionCompatibility('0.2.0', '0.2.0', 1), null);
        assert.match(checkVersionCompatibility('0.2.0', '0.3.0', 1) ?? '', /Version mismatch/);
        assert.match(checkVersionCompatibility('0.2.0', '0.2.0', 2) ?? '', /Protocol mismatch/);
    });

    it('Scenario 8: handles offline behavior predictably when desktop app is not running', async () => {
        let out = '';
        let err = '';
        let clipContent = 'initial clipboard';

        const copyCode = await runCli(['copy', '-'], {
            dataDir: tmpDir,
            stdin: 'piped offline clipboard text',
            writeClipboard: async (t) => {
                clipContent = t;
            },
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(copyCode, EXIT_OK);
        assert.equal(clipContent, 'piped offline clipboard text');

        out = '';
        const getCode = await runCli(['get'], {
            dataDir: tmpDir,
            readClipboard: async () => clipContent,
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(getCode, EXIT_OK);
        assert.equal(out, 'piped offline clipboard text');

        out = '';
        const trCode = await runCli(['transform', 'fa-normalize', '-'], {
            dataDir: tmpDir,
            stdin: 'كتاب شماره ٢',
            stdout: (s) => (out += s),
            stderr: (s) => (err += s),
        });
        assert.equal(trCode, EXIT_OK);
        assert.equal(out, 'کتاب شماره 2');

        err = '';
        const pauseCode = await runCli(['pause', '15'], {
            dataDir: tmpDir,
            stdout: () => {},
            stderr: (s) => (err += s),
        });
        assert.equal(pauseCode, EXIT_OFFLINE);
        assert.match(err, /ClipNest desktop app is not running/);
    });
});
