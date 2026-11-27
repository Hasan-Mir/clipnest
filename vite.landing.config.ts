import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Adapts ClipNest's desktop app paths (`/fonts/...`, `/icon.png`) and entry HTML (`landing.html` -> `index.html`)
 * so the built GitHub Pages output under `docs/` works cleanly on any subpath (`https://user.github.io/clipnest/`).
 */
function clipnestLandingPlugin(): Plugin {
    const outDir = path.resolve(rootDir, 'docs');
    const assetsOutDir = path.join(outDir, 'landing-assets');
    return {
        name: 'clipnest-landing-pages',
        buildStart() {
            if (fs.existsSync(assetsOutDir)) {
                fs.rmSync(assetsOutDir, { recursive: true, force: true });
            }
        },
        configureServer(server) {
            server.middlewares.use((req, _res, next) => {
                if (req.url === '/' || req.url === '/index.html') {
                    req.url = '/landing.html';
                }
                next();
            });
        },
        generateBundle(_options, bundle) {
            for (const [fileName, asset] of Object.entries(bundle)) {
                if (fileName.endsWith('.css') && asset.type === 'asset' && typeof asset.source === 'string') {
                    asset.source = asset.source
                        .replace(/url\((['"]?)\/fonts\//g, 'url($1../fonts/')
                        .replace(/url\((['"]?)\/icon\.png(['"]?)\)/g, 'url($1../icon.png$2)');
                } else if (fileName.endsWith('.js') && asset.type === 'chunk') {
                    asset.code = asset.code.replace(/(["'`])\/icon\.png\1/g, '$1./icon.png$1');
                }
            }
        },
        closeBundle() {
            const builtHtml = path.join(outDir, 'landing.html');
            const targetHtml = path.join(outDir, 'index.html');
            if (fs.existsSync(builtHtml)) {
                fs.renameSync(builtHtml, targetHtml);
            }
        },
    };
}

export default defineConfig({
    base: './',
    plugins: [react(), clipnestLandingPlugin()],
    resolve: {
        alias: {
            '@seymi/clipnest-core': path.resolve(rootDir, 'packages/core/src/index.ts'),
            '@tauri-apps/api/core': path.resolve(rootDir, 'src/landing/tauriShim.ts'),
            '@tauri-apps/api/event': path.resolve(rootDir, 'src/landing/tauriShim.ts'),
            '@tauri-apps/api/window': path.resolve(rootDir, 'src/landing/tauriShim.ts'),
        },
    },
    clearScreen: false,
    server: {
        host: '127.0.0.1',
        port: 1425,
        strictPort: true,
    },
    build: {
        target: 'es2021',
        outDir: 'docs',
        emptyOutDir: false,
        assetsDir: 'landing-assets',
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            input: path.resolve(rootDir, 'landing.html'),
        },
    },
});
