import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const relDir = path.join('src-tauri', 'target', 'release');
const bundleDir = path.join(relDir, 'bundle');

const exeCandidates = [path.join(relDir, 'clipnest.exe'), path.join(relDir, 'ClipNest.exe')];
const exePath = exeCandidates.find((p) => fs.existsSync(p));

if (!exePath) {
    console.error('Could not find release executable in', relDir);
    process.exit(1);
}

const stageDir = path.join(bundleDir, 'portable-stage', 'ClipNest-Portable');
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, 'data'), { recursive: true });

fs.copyFileSync(exePath, path.join(stageDir, 'ClipNest.exe'));

const cliExe = path.join(relDir, 'clipnest-cli.exe');
if (fs.existsSync(cliExe)) {
    fs.copyFileSync(cliExe, path.join(stageDir, 'clipnest-cli.exe'));
}

const cmdShim = [
    '@echo off',
    'setlocal',
    'if exist "%~dp0clipnest-cli.exe" (',
    '  "%~dp0clipnest-cli.exe" %*',
    '  exit /b %ERRORLEVEL%',
    ')',
    '"%~dp0ClipNest.exe" %*',
    'exit /b %ERRORLEVEL%',
    '',
].join('\r\n');
fs.writeFileSync(path.join(stageDir, 'clipnest.cmd'), cmdShim, 'utf8');
fs.writeFileSync(path.join(stageDir, 'clipn.cmd'), cmdShim, 'utf8');

fs.writeFileSync(
    path.join(stageDir, 'portable.txt'),
    'ClipNest Portable Mode — All database, settings, and daily backups are stored in the local ./data folder.\r\n'
);

const zipOut = path.resolve(bundleDir, `ClipNest_${version}_x64-portable.zip`);
if (fs.existsSync(zipOut)) {
    fs.unlinkSync(zipOut);
}

execFileSync(
    'powershell',
    [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${path.resolve(stageDir)}\\*' -DestinationPath '${zipOut}' -Force`,
    ],
    { stdio: 'inherit' }
);

console.log('Created portable archive:', zipOut);
