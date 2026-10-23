import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        watch: {
            ignored: ['**/src-tauri/**'],
        },
    },
    build: { target: 'es2021', chunkSizeWarningLimit: 1200 },
    test: {
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        exclude: ['packages/**', 'node_modules/**', 'dist/**'],
    },
} as Record<string, unknown>);
