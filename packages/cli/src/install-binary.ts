/**
 * Post-install helper for @seymi/clipnest-cli.
 *
 * Locates or copies the native `clipnest-cli` binary for the current OS and CPU architecture
 * without requiring Rust or C++ build tools on end-user machines. If the desktop app is already
 * installed (or running), the pure Node.js IPC client in `dist/index.js` also works directly
 * without needing a separate binary download.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');
const binDir = path.join(pkgRoot, 'bin');

function ensureBinDir(): void {
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }
}

function tryCopyLocalBuild(): boolean {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'clipnest-cli.exe' : 'clipnest-cli';
    const dest = path.join(binDir, exeName);
    if (fs.existsSync(dest)) {
        return true;
    }

    const repoCandidate = path.resolve(pkgRoot, '..', '..', 'src-tauri', 'target', 'release', exeName);
    if (fs.existsSync(repoCandidate)) {
        ensureBinDir();
        fs.copyFileSync(repoCandidate, dest);
        return true;
    }

    if (isWin) {
        const localAppData = (process.env.LOCALAPPDATA || '').trim();
        const programFiles = (process.env.ProgramFiles || 'C:\\Program Files').trim();
        const candidates: string[] = [];
        if (localAppData && path.isAbsolute(localAppData)) {
            candidates.push(
                path.join(localAppData, 'Programs', 'ClipNest', 'clipnest-cli.exe'),
                path.join(localAppData, 'Programs', 'ClipNest', 'ClipNest.exe'),
                path.join(localAppData, 'ClipNest', 'clipnest-cli.exe'),
                path.join(localAppData, 'ClipNest', 'ClipNest.exe')
            );
        }
        if (programFiles && path.isAbsolute(programFiles)) {
            candidates.push(
                path.join(programFiles, 'ClipNest', 'clipnest-cli.exe'),
                path.join(programFiles, 'ClipNest', 'ClipNest.exe')
            );
        }
        for (const c of candidates) {
            if (c && fs.existsSync(c)) {
                ensureBinDir();
                fs.copyFileSync(c, dest);
                return true;
            }
        }
    }
    return false;
}

try {
    tryCopyLocalBuild();
} catch {
    // Non-fatal: dist/index.js communicates directly with the running ClipNest desktop app over local IPC.
}
