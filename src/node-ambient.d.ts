/**
 * Self-contained ambient declarations for Node.js built-in modules and globals used by
 * the CLI workspace and integration tests so `npm run typecheck` (`tsc --noEmit`) succeeds
 * out of the box even when `@types/node` is not installed.
 */

declare namespace NodeJS {
    interface ErrnoException extends Error {
        errno?: number;
        code?: string;
        path?: string;
        syscall?: string;
    }
    interface ProcessEnv {
        [key: string]: string | undefined;
    }
    interface WriteStream {
        write(chunk: string | Uint8Array): boolean;
        isTTY?: boolean;
    }
    interface ReadStream {
        isTTY?: boolean;
        on(event: 'data', listener: (chunk: Buffer) => void): this;
        on(event: 'end', listener: () => void): this;
        on(event: 'error', listener: (err: Error) => void): this;
        on(event: string, listener: (...args: any[]) => void): this;
    }
    interface Process {
        env: ProcessEnv;
        argv: string[];
        platform: string;
        pid: number;
        stdout: WriteStream;
        stderr: WriteStream;
        stdin: ReadStream;
        exit(code?: number): never;
        cwd(): string;
    }
}

interface Buffer extends Uint8Array {
    toString(encoding?: string, start?: number, end?: number): string;
}

declare var Buffer: {
    from(data: string, encoding?: string): Buffer;
    from(data: ArrayBuffer | SharedArrayBuffer | ReadonlyArray<number> | Uint8Array): Buffer;
    concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): Buffer;
    byteLength(string: string, encoding?: string): number;
    isBuffer(obj: unknown): obj is Buffer;
};

declare var process: NodeJS.Process;

declare module 'node:fs' {
    export interface Stats {
        size: number;
        isFile(): boolean;
        isDirectory(): boolean;
    }
    export function existsSync(path: string): boolean;
    export function readFileSync(path: string, encoding: string): string;
    export function readFileSync(path: string): Buffer;
    export function writeFileSync(path: string, data: string | Uint8Array, encoding?: string): void;
    export function unlinkSync(path: string): void;
    export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
    export function mkdtempSync(prefix: string): string;
    export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
    export function statSync(path: string): Stats;
    export function copyFileSync(src: string, dest: string): void;
    export function chmodSync(path: string, mode: number): void;
    export function renameSync(oldPath: string, newPath: string): void;
    const fsDefault: {
        existsSync: typeof existsSync;
        readFileSync: typeof readFileSync;
        writeFileSync: typeof writeFileSync;
        unlinkSync: typeof unlinkSync;
        mkdirSync: typeof mkdirSync;
        mkdtempSync: typeof mkdtempSync;
        rmSync: typeof rmSync;
        statSync: typeof statSync;
        copyFileSync: typeof copyFileSync;
        chmodSync: typeof chmodSync;
        renameSync: typeof renameSync;
    };
    export default fsDefault;
}

declare module 'node:path' {
    export function join(...paths: string[]): string;
    export function resolve(...paths: string[]): string;
    export function dirname(p: string): string;
    export function basename(p: string, ext?: string): string;
    export function extname(p: string): string;
    const pathDefault: {
        join: typeof join;
        resolve: typeof resolve;
        dirname: typeof dirname;
        basename: typeof basename;
        extname: typeof extname;
    };
    export default pathDefault;
}

declare module 'node:os' {
    export function homedir(): string;
    export function tmpdir(): string;
    export function platform(): string;
    const osDefault: {
        homedir: typeof homedir;
        tmpdir: typeof tmpdir;
        platform: typeof platform;
    };
    export default osDefault;
}

declare module 'node:url' {
    export function fileURLToPath(url: string | URL): string;
}

declare module 'node:child_process' {
    export interface SpawnSyncOptions {
        input?: string | Uint8Array;
        encoding?: string;
        timeout?: number;
        stdio?: any;
        cwd?: string;
        env?: NodeJS.ProcessEnv;
    }
    export interface SpawnSyncReturns<T = string> {
        pid: number;
        output: Array<T | null>;
        stdout: T;
        stderr: T;
        status: number | null;
        signal: string | null;
        error?: Error;
    }
    export function spawnSync(
        command: string,
        args?: ReadonlyArray<string>,
        options?: SpawnSyncOptions
    ): SpawnSyncReturns<string>;
}

declare module 'node:net' {
    export interface AddressInfo {
        address: string;
        family: string;
        port: number;
    }
    export class Socket {
        constructor();
        setTimeout(timeout: number, callback?: () => void): this;
        connect(port: number, host?: string, connectionListener?: () => void): this;
        write(data: string | Uint8Array, cb?: (err?: Error) => void): boolean;
        destroy(error?: Error): this;
        on(event: 'data', listener: (chunk: Buffer) => void): this;
        on(event: 'timeout', listener: () => void): this;
        on(event: 'error', listener: (err: Error) => void): this;
        on(event: 'close', listener: (hadError: boolean) => void): this;
        on(event: string, listener: (...args: any[]) => void): this;
    }
    export class Server {
        listen(port?: number, hostname?: string, listeningListener?: () => void): this;
        close(callback?: (err?: Error) => void): this;
        address(): AddressInfo | string | null;
        on(event: string, listener: (...args: any[]) => void): this;
    }
    export function createServer(connectionListener?: (socket: Socket) => void): Server;
    const netDefault: {
        Socket: typeof Socket;
        Server: typeof Server;
        createServer: typeof createServer;
    };
    export default netDefault;
}
