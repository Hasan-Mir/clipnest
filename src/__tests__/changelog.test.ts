import { describe, expect, it } from 'vitest';
import { parseChangelog } from '../lib/changelog';

const TELEGRAM_SAMPLE = `
7.3.3 (21.10.26)

- Show TON DNS gift owners as links, not address groups.
- Fix green video tint when using D3D9 backend with ANGLE on Windows.
- Fix transparent unusable media viewer with ANGLE on Windows.
- Add DESKTOP_APP_DISABLE_PRIVATE_QT_API build option. (allows to build tdesktop without the need to rebuild on Qt updates at the price of feature degradation and KWindowSystem dependency)

7.3.2 (20.10.26)

- Reply with quotes to rich messages.
- Migrate to Qt 6 on Windows.

7.3.1 (09.10.26)

- Fix wallet encryption with Windows Hello sometimes failing.
- Remove attaching Link in photo editor.
`;

describe('parseChangelog (Telegram Desktop format)', () => {
    it('returns an empty array for an empty or whitespace-only CHANGELOG.md', () => {
        expect(parseChangelog('')).toEqual([]);
        expect(parseChangelog('   \n\n  ')).toEqual([]);
    });

    it('parses multiple Telegram-style release sections with DD.MM.YY dates and ISO dates', () => {
        const parsed = parseChangelog(TELEGRAM_SAMPLE);
        expect(parsed).toHaveLength(3);

        expect(parsed[0].version).toBe('7.3.3');
        expect(parsed[0].date).toBe('21.10.26');
        expect(parsed[0].isoDate).toBe('2026-10-21');
        expect(parsed[0].items).toHaveLength(4);

        expect(parsed[1].version).toBe('7.3.2');
        expect(parsed[1].isoDate).toBe('2026-10-20');
        expect(parsed[1].items).toHaveLength(2);

        expect(parsed[2].version).toBe('7.3.1');
        expect(parsed[2].isoDate).toBe('2026-10-09');
        expect(parsed[2].items).toHaveLength(2);
    });

    it('classifies bullet items into semantic categories (fix, add, improve, remove, other)', () => {
        const parsed = parseChangelog(TELEGRAM_SAMPLE);
        expect(parsed[0].items[0].category).toBe('other');
        expect(parsed[0].items[1].category).toBe('fix');
        expect(parsed[0].items[3].category).toBe('add');
        expect(parsed[1].items[1].category).toBe('improve');
        expect(parsed[2].items[1].category).toBe('remove');
    });

    it('supports pre-release semver tags like 1.5.0-beta.1', () => {
        const sample = `1.5.0-beta.1 (05.11.26)\n\n- Add experimental sync support.`;
        const parsed = parseChangelog(sample);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].version).toBe('1.5.0-beta.1');
        expect(parsed[0].isoDate).toBe('2026-11-05');
    });
});
