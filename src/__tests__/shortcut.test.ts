import { describe, expect, it } from 'vitest';
import { digitOfKey, eventToShortcut, formatHeldModifiers, isKey } from '../lib/shortcut';

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

describe('eventToShortcut & formatHeldModifiers keyboard shortcut recorder', () => {
    it("formats live held modifier keys while recording (e.g. 'Ctrl + ', 'Ctrl + Alt + ')", () => {
        expect(
            formatHeldModifiers({
                ctrlKey: true,
                altKey: false,
                shiftKey: false,
                metaKey: false,
            })
        ).toBe('Ctrl + ');
        expect(
            formatHeldModifiers({
                ctrlKey: true,
                altKey: true,
                shiftKey: false,
                metaKey: false,
            })
        ).toBe('Ctrl + Alt + ');
        expect(
            formatHeldModifiers(
                {
                    ctrlKey: true,
                    altKey: false,
                    shiftKey: true,
                    metaKey: false,
                },
                true
            )
        ).toBe('Win + Ctrl + Shift + ');
    });

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
                    ctrlKey: true,
                    altKey: true,
                })
            )
        ).toBe('Ctrl+Alt+Space');
    });

    it('matches physical keys via isKey and digitOfKey when OS layout is Persian', () => {
        // Ctrl+I on Persian keyboard sends key='ه', code='KeyI'
        expect(isKey({ key: 'ه', code: 'KeyI' }, 'i')).toBe(true);
        // Ctrl+E on Persian keyboard sends key='ث', code='KeyE'
        expect(isKey({ key: 'ث', code: 'KeyE' }, 'e')).toBe(true);
        // Ctrl+S on Persian keyboard sends key='س', code='KeyS'
        expect(isKey({ key: 'س', code: 'KeyS' }, 's')).toBe(true);
        // Ctrl+, on Persian keyboard sends key='و', code='Comma'
        expect(isKey({ key: 'و', code: 'Comma' }, ',')).toBe(true);
        // Ctrl+[ and Ctrl+] on Persian keyboard send 'ج' and 'چ'
        expect(isKey({ key: 'ج', code: 'BracketLeft' }, '[')).toBe(true);
        expect(isKey({ key: 'چ', code: 'BracketRight' }, ']')).toBe(true);
        // Ctrl+1..9 on Persian keyboard
        expect(digitOfKey({ key: '۱', code: 'Digit1' })).toBe(1);
        expect(digitOfKey({ key: '9', code: 'Numpad9' })).toBe(9);
        expect(digitOfKey({ key: '0', code: 'Digit0' })).toBeNull();
    });
});
