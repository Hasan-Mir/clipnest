#!/usr/bin/env node
/**
 * Builds the native Rust `clipnest_core` N-API addon (`clipnest-core.win32-x64-msvc.node`)
 * and `clipnest-cli.exe` binary, placing the `.node` addon in `packages/core/dist/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(__dirname, '..');
const distDir = path.join(coreRoot, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const r = spawnSync('cargo', ['build', '--release', '--manifest-path', path.join(coreRoot, 'Cargo.toml')], {
    stdio: 'inherit',
});
if (r.status !== 0) {
    process.exit(r.status ?? 1);
}

const isWin = process.platform === 'win32';
const dylibName = isWin ? 'clipnest_core.dll' : process.platform === 'darwin' ? 'libclipnest_core.dylib' : 'libclipnest_core.so';
const srcDylib = path.join(coreRoot, 'target', 'release', dylibName);
const destNode = path.join(distDir, 'clipnest-core.win32-x64-msvc.node');

if (fs.existsSync(srcDylib)) {
    fs.copyFileSync(srcDylib, destNode);
    console.log(`[clipnest-core] Built native N-API addon -> ${destNode}`);
}
