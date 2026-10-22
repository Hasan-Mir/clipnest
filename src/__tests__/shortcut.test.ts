import { describe, expect, it } from 'vitest';
import { eventToShortcut } from '../lib/shortcut';

function makeKeyEvent(
    overrides: Partial<{
        key: string;
        code: string;
        ctrlKey: boolean;
        altKey: boolean;
        shiftKey: boolean;
        metaKey: boolean;
    }>
): Parameters<typeof eventToShortcut>[0] {
    return {
        key: overrides.key ?? '',
        code: overrides.code ?? '',
        ctrlKey: overrides.ctrlKey ?? false,
        altKey: overrides.altKey ?? false,
        shiftKey: overrides.shiftKey ?? false,
        metaKey: overrides.metaKey ?? false,
    } as Parameters<typeof eventToShortcut>[0];
}

describe('eventToShortcut keyboard shortcut recorder', () => {
    it('ignores standalone modifier key presses', () => {
        expect(eventToShortcut(makeKeyEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
        expect(eventToShortcut(makeKeyEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
        expect(eventToShortcut(makeKeyEvent({ key: 'Alt', altKey: true }))).toBeNull();
        expect(eventToShortcut(makeKeyEvent({ key: 'Meta', metaKey: true }))).toBeNull();
    });

    it('rejects bare single keys by default to prevent hijacking normal typing', () => {
        expect(eventToShortcut(makeKeyEvent({ key: 'v', code: 'KeyV' }))).toBeNull();
        expect(eventToShortcut(makeKeyEvent({ key: '5', code: 'Digit5' }))).toBeNull();
    });

    it('allows bare single keys when allowBare is true (e.g. when Win modifier checkbox is enabled)', () => {
        expect(eventToShortcut(makeKeyEvent({ key: 'v', code: 'KeyV' }), true)).toBe('V');
        expect(eventToShortcut(makeKeyEvent({ key: 'b', code: 'KeyB' }), true)).toBe('B');
    });

    it('allows bare function keys (F1-F24) even without modifiers', () => {
        expect(eventToShortcut(makeKeyEvent({ key: 'F12', code: 'F12' }), false)).toBe('F12');
    });

    it('formats physical key codes consistently regardless of active keyboard layout (e.g. Persian layout)', () => {
        expect(
            eventToShortcut(
                makeKeyEvent({
                    key: 'ر',
                    code: 'KeyV',
                    ctrlKey: true,
                    shiftKey: true,
                })
            )
        ).toBe('Ctrl+Shift+V');
    });

    it('normalizes punctuation and navigation keys into Tauri-compatible names', () => {
        expect(
            eventToShortcut(
                makeKeyEvent({
                    key: '`',
                    code: 'Backquote',
                    ctrlKey: true,
                })
            )
        ).toBe('Ctrl+Backquote');
        expect(
            eventToShortcut(
                makeKeyEvent({
                    key: ' ',
                    code: 'Space',
                    altKey: true,
                })
            )
        ).toBe('Alt+Space');
    });
});
