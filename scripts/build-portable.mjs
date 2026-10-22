import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version || '0.2.0';

const releaseDir = path.join(root, 'src-tauri', 'target', 'release');
const exeSrc = path.join(releaseDir, 'clipnest.exe');

if (!fs.existsSync(exeSrc)) {
    throw new Error(`Expected built binary at ${exeSrc}. Run "npm run tauri build" first.`);
}

const outRoot = path.join(releaseDir, 'bundle', 'portable');
const stagingDir = path.join(outRoot, 'ClipNest-Portable');
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const portableExe = path.join(stagingDir, 'ClipNest-Portable.exe');
fs.copyFileSync(exeSrc, portableExe);
fs.writeFileSync(
    path.join(stagingDir, 'portable.txt'),
    'ClipNest Portable Mode\nAll database, settings, and backup files are stored in the ./data folder next to this executable.\n',
    'utf8'
);

const zipName = `ClipNest_${version}_x64-portable.zip`;
const zipPath = path.join(outRoot, zipName);

if (process.platform === 'win32') {
    execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'inherit' }
    );
}

console.log(`Portable build ready:\n  Folder: ${stagingDir}\n  Archive: ${zipPath}`);
