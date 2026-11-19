import fs from 'node:fs';
import net, { AddressInfo, Server, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CLI_VERSION,
    EXIT_NOT_FOUND,
    EXIT_OFFLINE,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_USAGE,
    PROTOCOL_VERSION,
    callIpc,
    checkVersionCompatibility,
    getHelpText,
    runCli,
    suggestCommand,
} from '../../packages/cli/src/index';

describe('ClipNest CLI & Local IPC integration suite', () => {
    let tmpDir: string;
    let server: Server | null = null;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipnest-cli-test-'));
    });

    afterEach(async () => {
        if (server) {
            await new Promise<void>((r) => server!.close(() => r()));
            server = null;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function startMockIpcServer(
        handler: (
            op: string,
            params: Record<string, unknown>
        ) => {
            ok: boolean;
            exit_code: number;
            data?: unknown;
            error?: string;
            hint?: string;
        },
        overrides?: Partial<{ version: string; protocol: number; token: string }>
    ) {
        const token = overrides?.token ?? 'secret-test-token-123';
        server = net.createServer((socket: Socket) => {
            let buf = '';
            socket.on('data', (chunk: Buffer) => {
                buf += chunk.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl >= 0) {
                    const req = JSON.parse(buf.slice(0, nl));
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
        const addr = server.address() as AddressInfo;
        fs.writeFileSync(
            path.join(tmpDir, 'cli-rpc.json'),
            JSON.stringify({
                protocol: overrides?.protocol ?? PROTOCOL_VERSION,
                version: overrides?.version ?? CLI_VERSION,
                pid: process.pid,
                port: addr.port,
                token,
            }),
            'utf8'
        );
    }

    it('1 & 2 & 5. adds direct text and multiline stdin while preserving exact newlines, and rejects empty stdin', async () => {
        const received: Record<string, unknown>[] = [];
        await startMockIpcServer((op, params) => {
            received.push({ op, ...params });
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: { item: { id: 42 }, created: true, copied: Boolean(params.copy) },
            };
        });

        let out = '';
        let err = '';
        const code1 = await runCli(['add', 'Hello direct clip'], {
            dataDir: tmpDir,
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(code1).toBe(EXIT_OK);
        expect(out.trim()).toBe('42');
        expect(err).toBe('');
        expect(received[0].text).toBe('Hello direct clip');

        const multiline = 'line 1\n\nline 3 with فرمت فارسی\r\nline 4\n';
        out = '';
        const code2 = await runCli(['add', '-', '--pin', '--category', 'Work', '--tags', 'git,log'], {
            dataDir: tmpDir,
            stdin: multiline,
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(code2).toBe(EXIT_OK);
        expect(received[1].text).toBe(multiline);
        expect(received[1].pinned).toBe(true);
        expect(received[1].board).toBe('Work');

        err = '';
        const codeEmpty = await runCli(['add', '-'], {
            dataDir: tmpDir,
            stdin: '',
            stdout: () => {},
            stderr: (s: string) => (err += s),
        });
        expect(codeEmpty).toBe(EXIT_USAGE);
        expect(err).toContain('empty');
    });

    it('3 & 4. sets system clipboard from stdin and handles combined add - --copy reading stdin once (including partial failure)', async () => {
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
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(code).toBe(EXIT_OK);
        expect(stdinReads).toBe(1);
        expect(lastParams.copy).toBe(true);
        expect(out).toContain('#77');

        out = '';
        err = '';
        const partialCode = await runCli(['add', '-', '--copy'], {
            dataDir: tmpDir,
            stdin: 'trigger-partial',
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(partialCode).toBe(EXIT_PARTIAL);
        expect(out).toBe('');
        expect(err).toContain('Added item #99 to history, but failed to copy');
    });

    it('6 & 7. separates raw stdout from stderr, provides help for every command, and returns proper exit codes', async () => {
        await startMockIpcServer((op, params) => {
            if (op === 'get' && params.id === '12') {
                return {
                    ok: true,
                    exit_code: EXIT_OK,
                    data: { source: 'history', id: 12, kind: 'text', text: 'exact raw payload\nline 2' },
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
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(okCode).toBe(EXIT_OK);
        expect(out).toBe('exact raw payload\nline 2');
        expect(err).toBe('');

        out = '';
        err = '';
        const notFoundCode = await runCli(['get', '999'], {
            dataDir: tmpDir,
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(notFoundCode).toBe(EXIT_NOT_FOUND);
        expect(out).toBe('');
        expect(err).toContain('Item #999 not found');

        expect(suggestCommand('lst')).toBe('list');
        err = '';
        const usageCode = await runCli(['lst'], {
            dataDir: tmpDir,
            stdout: () => {},
            stderr: (s: string) => (err += s),
        });
        expect(usageCode).toBe(EXIT_USAGE);
        expect(err).toContain("Did you mean 'clipnest list'?");

        // Per-command help and clipn alias documentation
        expect(getHelpText()).toContain('clipn <command>');
        expect(getHelpText('category')).toContain('clipnest category <subcommand>');
        expect(getHelpText('move')).toContain('--copy');

        out = '';
        const helpCmdCode = await runCli(['move', '--help'], {
            dataDir: tmpDir,
            stdout: (s: string) => (out += s),
            stderr: () => {},
        });
        expect(helpCmdCode).toBe(EXIT_OK);
        expect(out).toContain('Usage: clipnest move');

        expect(checkVersionCompatibility('0.2.0', '0.2.0', 1)).toBeNull();
        expect(checkVersionCompatibility('0.2.0', '0.3.0', 1)).toContain('Version mismatch');
        expect(checkVersionCompatibility('0.2.0', '0.2.0', 2)).toContain('Protocol mismatch');
    });

    it('8. handles offline behavior predictably when desktop app is not running', async () => {
        let out = '';
        let err = '';
        let clipContent = 'initial clipboard';

        const copyCode = await runCli(['copy', '-'], {
            dataDir: tmpDir,
            stdin: 'piped offline clipboard text',
            writeClipboard: async (t: string) => {
                clipContent = t;
            },
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(copyCode).toBe(EXIT_OK);
        expect(clipContent).toBe('piped offline clipboard text');

        out = '';
        const getCode = await runCli(['get'], {
            dataDir: tmpDir,
            readClipboard: async () => clipContent,
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(getCode).toBe(EXIT_OK);
        expect(out).toBe('piped offline clipboard text');

        out = '';
        const trCode = await runCli(['transform', 'fa-normalize', '-'], {
            dataDir: tmpDir,
            stdin: 'كتاب شماره ٢',
            stdout: (s: string) => (out += s),
            stderr: (s: string) => (err += s),
        });
        expect(trCode).toBe(EXIT_OK);
        expect(out).toBe('کتاب شماره 2');

        err = '';
        const pauseCode = await runCli(['pause', '15'], {
            dataDir: tmpDir,
            stdout: () => {},
            stderr: (s: string) => (err += s),
        });
        expect(pauseCode).toBe(EXIT_OFFLINE);
        expect(err).toContain('ClipNest desktop app is not running');
    });

    it('9. preserves multi-byte UTF-8 text split across TCP chunks without U+FFFD corruption', async () => {
        const persianText = 'سلام این یک متن طولانی برای تست یکپارچگی است '.repeat(100);
        const respPayload =
            JSON.stringify({
                ok: true,
                exit_code: EXIT_OK,
                data: { text: persianText },
            }) + '\n';

        const respBuf = Buffer.from(respPayload, 'utf8');
        // Find a byte inside a 2-byte UTF-8 sequence to split on
        // 'س' in UTF-8 is 0xD8 0xB3. Split right between 0xD8 and 0xB3:
        const d8Index = respBuf.indexOf(0xd8);
        expect(d8Index).toBeGreaterThan(0);
        const splitPoint = d8Index + 1;

        const chunk1 = respBuf.subarray(0, splitPoint);
        const chunk2 = respBuf.subarray(splitPoint);

        const token = 'token-utf8-split';
        server = net.createServer((socket: Socket) => {
            socket.on('data', () => {
                socket.write(chunk1);
                setTimeout(() => {
                    socket.write(chunk2);
                }, 10);
            });
        });

        await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as AddressInfo).port;
        fs.writeFileSync(
            path.join(tmpDir, 'cli-rpc.json'),
            JSON.stringify({
                protocol: PROTOCOL_VERSION,
                version: CLI_VERSION,
                pid: process.pid,
                port,
                token,
            })
        );

        const res = await callIpc(tmpDir, 'get', { id: 1 }, 2000);
        expect(res).not.toBeNull();
        expect(res!.ok).toBe(true);
        const retrieved = (res!.data as { text: string }).text;
        expect(retrieved).toBe(persianText);
        expect(retrieved).not.toContain('\uFFFD');
    });

    it('10. queries basket status & list via IPC without mutating queue parameters', async () => {
        let lastOp = '';
        let lastParams: Record<string, unknown> = {};

        await startMockIpcServer((op, params) => {
            lastOp = op;
            lastParams = params;
            return {
                ok: true,
                exit_code: EXIT_OK,
                data: {
                    active: false,
                    mode: 'queue',
                    fifo: true,
                    items: [],
                },
            };
        });

        const statusRes = await callIpc(tmpDir, 'basket', { sub: 'status' }, 2000);
        expect(statusRes).not.toBeNull();
        expect(statusRes!.ok).toBe(true);
        expect(lastOp).toBe('basket');
        expect(lastParams.sub).toBe('status');
        const data = statusRes!.data as { mode: string; active: boolean };
        expect(data.mode).toBe('queue'); // queue mode remains unaffected

        const listRes = await callIpc(tmpDir, 'basket', { sub: 'list' }, 2000);
        expect(listRes).not.toBeNull();
        expect(listRes!.ok).toBe(true);
        expect(lastOp).toBe('basket');
        expect(lastParams.sub).toBe('list');
    });

    it('11. callIpc deletes endpoint file on ECONNREFUSED and leaves it on non-refusal error', async () => {
        // Write an endpoint pointing to a closed port
        const epFile = path.join(tmpDir, 'cli-rpc.json');
        fs.writeFileSync(
            epFile,
            JSON.stringify({
                version: '0.2.0',
                protocol: 1,
                port: 59999, // unopened port
                token: 'dummy-token',
                pid: 99999,
            }),
            'utf8'
        );
        expect(fs.existsSync(epFile)).toBe(true);

        const res = await callIpc(tmpDir, 'status', {}, 1000);
        expect(res).toBeNull();
        // Since connection to port 59999 is refused, epFile should be unlinked
        expect(fs.existsSync(epFile)).toBe(false);

        // 2. Transient socket error: epFile must NOT be deleted on non-ECONNREFUSED errors
        const transientServer = net.createServer((sock) => {
            sock.on('error', () => {});
            sock.destroy(new Error('transient socket failure'));
        });
        await new Promise<void>((resolve) => transientServer.listen(0, '127.0.0.1', () => resolve()));
        const transientPort = (transientServer.address() as net.AddressInfo).port;

        fs.writeFileSync(
            epFile,
            JSON.stringify({
                version: '0.2.0',
                protocol: 1,
                port: transientPort,
                token: 'dummy-token',
                pid: 99999,
            }),
            'utf8'
        );
        expect(fs.existsSync(epFile)).toBe(true);

        const res2 = await callIpc(tmpDir, 'status', {}, 1000);
        expect(res2).toBeNull();
        // Since it was a transient error (not ECONNREFUSED), epFile MUST still exist
        expect(fs.existsSync(epFile)).toBe(true);

        await new Promise<void>((resolve) => transientServer.close(() => resolve()));
    });
});
