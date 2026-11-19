#!/usr/bin/env bun
/**
 * Builds the native Rust `clipnest_core` N-API addon (`clipnest-core.win32-x64-msvc.node`)
 * and `clipnest-cli.exe` binary, placing the `.node` addon in `packages/core/dist/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const coreRoot = path.resolve(__dirname, '..');
const distDir = path.join(coreRoot, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const cargoManifest = path.join(coreRoot, 'Cargo.toml');
const r = spawnSync('cargo', ['build', '--release', '--manifest-path', cargoManifest], {
    stdio: 'inherit',
});
if (r.status !== 0) {
    process.exit(r.status ?? 1);
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.error(
        `[clipnest-core] Native N-API addon is currently only supported on win32-x64 (got ${process.platform}-${process.arch}).`
    );
    process.exit(1);
}

const dylibName = 'clipnest_core.dll';
const srcDylib = path.join(coreRoot, 'target', 'release', dylibName);
const destNode = path.join(distDir, 'clipnest-core.win32-x64-msvc.node');

if (!fs.existsSync(srcDylib)) {
    console.error(`[clipnest-core] Expected native library not found at ${srcDylib}`);
    process.exit(1);
}

fs.copyFileSync(srcDylib, destNode);
console.log(`[clipnest-core] Built native N-API addon -> ${destNode}`);
