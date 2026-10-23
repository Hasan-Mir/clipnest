import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isKey } from './lib/shortcut';
import { TooltipHost } from './lib/TooltipHost';
import Popup from './popup/Popup';
import SettingsView from './settings/Settings';
import QueueView from './queue/Queue';
import TrayMenu from './tray/TrayMenu';
import './styles.css';

const label = getCurrentWindow().label;
document.documentElement.dataset.view = label;
try {
    const cachedTheme = localStorage.getItem('clipnest_theme');
    if (cachedTheme) {
        document.documentElement.dataset.theme = cachedTheme;
    }
} catch {
    // ignore storage errors
}

// Disable window.print() completely so WebView2 can never open the Chromium print dialog.
window.print = () => {};

// Block WebView2's native browser context menu; React's onContextMenu still runs normally.
window.addEventListener(
    'contextmenu',
    (e) => {
        e.preventDefault();
    },
    { capture: true }
);

// Block Ctrl + MouseWheel browser zoom in WebView2.
window.addEventListener(
    'wheel',
    (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
        }
    },
    { passive: false, capture: true }
);

const BROWSER_CTRL_KEYS = [
    'p', // Print
    'r', // Reload
    'g', // Find next
    'h', // History
    'j', // Downloads
    'k', // Search bar
    'l', // Address bar
    'u', // View source
    's', // Save page
    'o', // Open file
    'n', // New window
    't', // New tab
    'w', // Close window/tab
    'd', // Bookmark
    'e', // Search
    'i', // DevTools / Formats
    'm', // Merge
    '=', // Zoom in
    '-', // Zoom out
    '0', // Reset zoom
];

const BROWSER_F_KEYS = new Set([
    'F1',
    'F3',
    'F5',
    'F7',
    'F12',
    'Print',
    'BrowserBack',
    'BrowserForward',
    'BrowserRefresh',
    'BrowserStop',
    'BrowserSearch',
    'BrowserFavorites',
    'BrowserHome',
]);

function isEditableInput(el: Element | null): boolean {
    if (!el) {
        return false;
    }
    const tag = el.tagName;
    if (tag === 'TEXTAREA') {
        return true;
    }
    if (tag === 'INPUT') {
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        return !['checkbox', 'radio', 'button', 'color', 'range', 'file', 'submit', 'reset'].includes(type);
    }
    return (el as HTMLElement).isContentEditable === true;
}

// Block WebView2's built-in browser accelerators (Print, Find bar, Reload, History, Downloads,
// Caret browsing, DevTools, Zoom, Back/Forward navigation, Select-All outside inputs, etc.) in
// the capture phase so Chromium overlays never steal focus from ClipNest regardless of OS keyboard layout.
window.addEventListener(
    'keydown',
    (e) => {
        const ck = e.ctrlKey || e.metaKey;

        // In development mode (tauri dev), allow quick refresh with F5 or Ctrl+Shift+R
        if (import.meta.env.DEV && (e.key === 'F5' || (ck && e.shiftKey && isKey(e, 'r')))) {
            window.location.reload();
            return;
        }

        // Prevent Ctrl+A from selecting all UI text across the window when focus is not inside a text input/textarea.
        if (ck && isKey(e, 'a') && !isEditableInput(document.activeElement)) {
            e.preventDefault();
            return;
        }

        if (ck && isKey(e, 'f')) {
            e.preventDefault();
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('clipnest-focus-search'));
            return;
        }

        if (BROWSER_F_KEYS.has(e.key)) {
            e.preventDefault();
            return;
        }

        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home')) {
            e.preventDefault();
            return;
        }

        if (ck && BROWSER_CTRL_KEYS.some((k) => isKey(e, k))) {
            e.preventDefault();
        }
    },
    { capture: true }
);

ReactDOM.createRoot(document.getElementById('root')!).render(
    <>
        {label === 'settings' ? (
            <SettingsView />
        ) : label === 'queue' ? (
            <QueueView />
        ) : label === 'tray' ? (
            <TrayMenu />
        ) : (
            <Popup />
        )}
        <TooltipHost />
    </>
);
