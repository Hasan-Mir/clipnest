import { describe, expect, it } from 'vitest';
import { contrastOn, detectDir, fmtBytes, relTime, urlHost } from '../lib/format';

describe('Formatting, localization, and layout utilities', () => {
    describe('relTime', () => {
        const now = 1_700_000_000_000;

        it('formats English relative timestamps across seconds, minutes, hours, days, and months', () => {
            expect(relTime(now - 2_000, now, 'en')).toBe('now');
            expect(relTime(now - 45_000, now, 'en')).toBe('45s');
            expect(relTime(now - 5 * 60_000, now, 'en')).toBe('5m');
            expect(relTime(now - 3 * 3_600_000, now, 'en')).toBe('3h');
            expect(relTime(now - 10 * 86_400_000, now, 'en')).toBe('10d');
            expect(relTime(now - 90 * 86_400_000, now, 'en')).toBe('3mo');
        });

        it('formats Persian relative timestamps with space between numbers and Persian units', () => {
            expect(relTime(now - 1_000, now, 'fa')).toBe('الان');
            expect(relTime(now - 30_000, now, 'fa')).toBe('30 ثانیه');
            expect(relTime(now - 12 * 60_000, now, 'fa')).toBe('12 دقیقه');
            expect(relTime(now - 4 * 3_600_000, now, 'fa')).toBe('4 ساعت');
            expect(relTime(now - 7 * 86_400_000, now, 'fa')).toBe('7 روز');
            expect(relTime(now - 65 * 86_400_000, now, 'fa')).toBe('2 ماه');
        });

        it("clamps future timestamps gracefully to 'now' / 'الان'", () => {
            expect(relTime(now + 60_000, now, 'en')).toBe('now');
            expect(relTime(now + 60_000, now, 'fa')).toBe('الان');
        });
    });

    describe('fmtBytes', () => {
        it('formats bytes, kilobytes, and megabytes accurately', () => {
            expect(fmtBytes(0)).toBe('0 B');
            expect(fmtBytes(512)).toBe('512 B');
            expect(fmtBytes(2048)).toBe('2.0 KB');
            expect(fmtBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
        });
    });

    describe('detectDir', () => {
        it('detects RTL direction when first strong directional character is Persian/Arabic/Hebrew', () => {
            expect(detectDir('سلام دنیا')).toBe('rtl');
            expect(detectDir('   123 !@# آزمایش متن')).toBe('rtl');
        });

        it('detects LTR direction when first strong directional character is Latin', () => {
            expect(detectDir('Hello سلام')).toBe('ltr');
            expect(detectDir("const x = 'فارسی';")).toBe('ltr');
            expect(detectDir('123456')).toBe('ltr');
        });
    });

    describe('contrastOn', () => {
        it('returns dark text (#000) for bright background colors and light text (#fff) for dark colors', () => {
            expect(contrastOn('#FFFFFF')).toBe('#000');
            expect(contrastOn('#FACC15')).toBe('#000');
            expect(contrastOn('#000000')).toBe('#fff');
            expect(contrastOn('#1E293B')).toBe('#fff');
        });

        it('expands 3-digit shorthand hex colors properly', () => {
            expect(contrastOn('#FFF')).toBe('#000');
            expect(contrastOn('#000')).toBe('#fff');
        });
    });

    describe('urlHost', () => {
        it('extracts hostname without www. prefix', () => {
            expect(urlHost('https://www.github.com/tauri-apps/tauri')).toBe('github.com');
            expect(urlHost('https://clipnest.dev/docs')).toBe('clipnest.dev');
        });

        it('returns original input if string is not a valid URL', () => {
            expect(urlHost('not-a-valid-url')).toBe('not-a-valid-url');
        });
    });
});
