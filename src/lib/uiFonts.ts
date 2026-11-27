/**
 * Modern UI typography registry and on-demand loader for ClipNest.
 *
 * Design rationale:
 * - Latin UI glyphs use the user's selected modern sans-serif variable font (defaulting to
 *   Google Sans Flex, self-hosted via `@fontsource-variable/*` to comply with the strict
 *   offline `font-src 'self' data:` CSP).
 * - Persian/Arabic glyphs ALWAYS fall back to the self-hosted `Vazirmatn` font embedded in
 *   `public/fonts/` immediately after the Latin UI family. Because Fontsource Latin variable
 *   packages do not contain Arabic/Persian code points, Persian UI text unconditionally renders
 *   in `Vazirmatn` and cannot be accidentally overridden or broken by font selection.
 * - Non-default font families are lazy-loaded via dynamic `import()` so cold startup and
 *   `tauri dev` stay fast while Settings previews can preload all options on demand.
 */

import '@fontsource-variable/google-sans-flex';

export type UiFontId = 'google-sans' | 'inter' | 'plus-jakarta-sans' | 'dm-sans' | 'roboto';

export interface UiFontPreset {
    id: UiFontId;
    label: string;
    /** CSS font-family name registered by the corresponding `@fontsource-variable/*` package. */
    cssFamily: string;
    /** Full CSS font-family stack with embedded Vazirmatn locked in right after the Latin face. */
    stack: string;
}

const PERSIAN_AND_SYSTEM_FALLBACK =
    "'Vazirmatn', system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Tahoma, sans-serif";

export const UI_FONTS: readonly UiFontPreset[] = [
    {
        id: 'google-sans',
        label: 'Google Sans',
        cssFamily: 'Google Sans Flex Variable',
        stack: `'Google Sans Flex Variable', 'Google Sans Flex', 'Google Sans', ${PERSIAN_AND_SYSTEM_FALLBACK}`,
    },
    {
        id: 'inter',
        label: 'Inter',
        cssFamily: 'Inter Variable',
        stack: `'Inter Variable', 'Inter', ${PERSIAN_AND_SYSTEM_FALLBACK}`,
    },
    {
        id: 'plus-jakarta-sans',
        label: 'Plus Jakarta Sans',
        cssFamily: 'Plus Jakarta Sans Variable',
        stack: `'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', ${PERSIAN_AND_SYSTEM_FALLBACK}`,
    },
    {
        id: 'dm-sans',
        label: 'DM Sans',
        cssFamily: 'DM Sans Variable',
        stack: `'DM Sans Variable', 'DM Sans', ${PERSIAN_AND_SYSTEM_FALLBACK}`,
    },
    {
        id: 'roboto',
        label: 'Roboto',
        cssFamily: 'Roboto Variable',
        stack: `'Roboto Variable', 'Roboto', ${PERSIAN_AND_SYSTEM_FALLBACK}`,
    },
] as const;

export const UI_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const;

const loadedFonts = new Set<UiFontId>(['google-sans']);

const FONT_LOADERS: Record<Exclude<UiFontId, 'google-sans'>, () => Promise<unknown>> = {
    inter: () => import('@fontsource-variable/inter'),
    'plus-jakarta-sans': () => import('@fontsource-variable/plus-jakarta-sans'),
    'dm-sans': () => import('@fontsource-variable/dm-sans'),
    roboto: () => import('@fontsource-variable/roboto'),
};

/** Resolves any stored `ui_font` string (including legacy/unknown values) to a valid preset. */
export function resolveUiFont(id?: string | null): UiFontPreset {
    return UI_FONTS.find((f) => f.id === id) ?? UI_FONTS[0];
}

/** Lazy-loads the stylesheet for `id` if it has not been imported yet. */
export function ensureUiFontLoaded(id: UiFontId): void {
    if (loadedFonts.has(id) || id === 'google-sans') {
        return;
    }
    loadedFonts.add(id);
    FONT_LOADERS[id]().catch((e) => {
        loadedFonts.delete(id);
        console.error(`clipnest: failed to load UI font "${id}"`, e);
    });
}

/** Preloads all non-default UI font families so the Settings font picker renders live previews. */
export function preloadAllUiFonts(): void {
    for (const preset of UI_FONTS) {
        ensureUiFontLoaded(preset.id);
    }
}

/** Applies the chosen UI font stack to `--ui-font` on `:root` and triggers lazy loading. */
export function applyUiFont(id?: string | null): void {
    const preset = resolveUiFont(id);
    ensureUiFontLoaded(preset.id);
    document.documentElement.style.setProperty('--ui-font', preset.stack);
    try {
        localStorage.setItem('clipnest_ui_font', preset.id);
    } catch {
        // ignore storage errors in restricted contexts
    }
}
