import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@seymi/clipnest-core': path.resolve(rootDir, 'packages/core/src/index.ts'),
        },
    },
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        watch: {
            ignored: ['**/src-tauri/**', '**/packages/core/target/**'],
        },
    },
    build: { target: 'es2021', chunkSizeWarningLimit: 1200 },
    test: {
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        exclude: ['packages/**', 'node_modules/**', 'dist/**'],
    },
} as Record<string, unknown>);
