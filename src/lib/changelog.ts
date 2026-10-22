export interface ChangelogEntry {
    text: string;
    category: 'fix' | 'add' | 'improve' | 'remove' | 'security' | 'other';
}

export interface ChangelogRelease {
    version: string;
    date: string;
    isoDate: string;
    items: ChangelogEntry[];
}

const HEADER_RE = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\((\d{2})\.(\d{2})\.(\d{2})\)$/;

function detectCategory(text: string): ChangelogEntry['category'] {
    const lower = text.toLowerCase();
    if (lower.startsWith('fix ')) {
        return 'fix';
    }
    if (lower.startsWith('add ') || lower.startsWith('support ')) {
        return 'add';
    }
    if (
        lower.startsWith('improve ') ||
        lower.startsWith('update ') ||
        lower.startsWith('migrate ') ||
        lower.startsWith('optimize ')
    ) {
        return 'improve';
    }
    if (lower.startsWith('remove ') || lower.startsWith('drop ')) {
        return 'remove';
    }
    if (lower.startsWith('security:')) {
        return 'security';
    }
    return 'other';
}

/**
 * Parses a Telegram Desktop-style CHANGELOG.md file into structured release objects.
 *
 * Format example:
 * ```text
 * 7.3.3 (21.10.26)
 *
 * - Show TON DNS gift owners as links, not address groups.
 * - Fix green video tint when using D3D9 backend with ANGLE on Windows.
 * ```
 */
export function parseChangelog(raw: string): ChangelogRelease[] {
    const releases: ChangelogRelease[] = [];
    let current: ChangelogRelease | null = null;

    const lines = raw.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const headerMatch = HEADER_RE.exec(line);
        if (headerMatch) {
            const [, version, dd, mm, yy] = headerMatch;
            current = {
                version,
                date: `${dd}.${mm}.${yy}`,
                isoDate: `20${yy}-${mm}-${dd}`,
                items: [],
            };
            releases.push(current);
            continue;
        }

        if (line.startsWith('- ') && current) {
            const itemText = line.slice(2).trim();
            if (itemText) {
                current.items.push({
                    text: itemText,
                    category: detectCategory(itemText),
                });
            }
        }
    }

    return releases;
}
