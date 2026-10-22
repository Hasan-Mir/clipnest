// CopyQ-style text transformations. Each returns the new text or throws with a readable message.

export interface Transform {
    id: string;
    label: string;
    group: string;
    run: (s: string) => string;
}

const arabicChars = ['ك', '\u0640', 'دِ', 'بِ', 'زِ', 'ذِ', 'ِشِ', 'ِسِ', 'ى', 'ي', 'ة'] as const;
const persianChars = ['ک', '', 'د', 'ب', 'ز', 'ذ', 'ش', 'س', 'ی', 'ی', 'ه'] as const;
const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;
const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
const englishDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const toEnglishDigits = (value: string): string => {
    let newValue = value;

    // Replace Arabic digits with English digits
    for (let i = 0; i < arabicDigits.length; i++) {
        newValue = newValue.replace(new RegExp(arabicDigits[i], 'gu'), englishDigits[i]);
    }

    // Replace Persian digits with English digits
    for (let i = 0; i < persianDigits.length; i++) {
        newValue = newValue.replace(new RegExp(persianDigits[i], 'gu'), englishDigits[i]);
    }

    return newValue;
};

export const arabicReplacer = (value: string): string => {
    let newValue = value;

    // Replace Arabic characters with Persian characters
    for (let i = 0, charsLen = arabicChars.length; i < charsLen; i++) {
        newValue = newValue.replace(new RegExp(arabicChars[i], 'gu'), persianChars[i]);
    }

    newValue = toEnglishDigits(newValue);

    return newValue;
};

export const toPersianDigits = (value: string): string => {
    let newValue = value;

    // Replace Arabic digits with Persian digits
    for (let i = 0; i < arabicDigits.length; i++) {
        newValue = newValue.replace(new RegExp(arabicDigits[i], 'gu'), persianDigits[i]);
    }

    // Replace English digits with Persian digits
    for (let i = 0; i < englishDigits.length; i++) {
        newValue = newValue.replace(new RegExp(englishDigits[i], 'gu'), persianDigits[i]);
    }

    return newValue;
};

const words = (s: string) =>
    s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

const b64enc = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
};

const b64dec = (s: string) => {
    const bin = atob(s.trim().replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export const TRANSFORMS: Transform[] = [
    {
        id: 'json-pretty',
        group: 'JSON',
        label: 'Prettify JSON',
        run: (s) => JSON.stringify(JSON.parse(s), null, 2),
    },
    { id: 'json-min', group: 'JSON', label: 'Minify JSON', run: (s) => JSON.stringify(JSON.parse(s)) },
    { id: 'upper', group: 'Case', label: 'UPPERCASE', run: (s) => s.toUpperCase() },
    { id: 'lower', group: 'Case', label: 'lowercase', run: (s) => s.toLowerCase() },
    {
        id: 'camel',
        group: 'Case',
        label: 'camelCase',
        run: (s) =>
            words(s)
                .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
                .join(''),
    },
    {
        id: 'pascal',
        group: 'Case',
        label: 'PascalCase',
        run: (s) =>
            words(s)
                .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
                .join(''),
    },
    {
        id: 'snake',
        group: 'Case',
        label: 'snake_case',
        run: (s) =>
            words(s)
                .map((w) => w.toLowerCase())
                .join('_'),
    },
    {
        id: 'kebab',
        group: 'Case',
        label: 'kebab-case',
        run: (s) =>
            words(s)
                .map((w) => w.toLowerCase())
                .join('-'),
    },
    { id: 'b64e', group: 'Encode', label: 'Base64 encode', run: b64enc },
    { id: 'b64d', group: 'Encode', label: 'Base64 decode', run: b64dec },
    { id: 'urle', group: 'Encode', label: 'URL encode', run: encodeURIComponent },
    { id: 'urld', group: 'Encode', label: 'URL decode', run: decodeURIComponent },
    {
        id: 'jwt',
        group: 'Encode',
        label: 'Decode JWT',
        run: (s) => {
            const p = s.trim().split('.');
            if (p.length < 2) {
                throw new Error('Not a JWT');
            }
            const pretty = (x: string) => JSON.stringify(JSON.parse(b64dec(x)), null, 2);
            return `// header\n${pretty(p[0])}\n\n// payload\n${pretty(p[1])}`;
        },
    },
    { id: 'trim', group: 'Whitespace', label: 'Trim', run: (s) => s.trim() },
    {
        id: 'collapse',
        group: 'Whitespace',
        label: 'Collapse whitespace',
        run: (s) =>
            s
                .replace(/[ \t]+/g, ' ')
                .replace(/\s*\n\s*/g, '\n')
                .trim(),
    },
    {
        id: 'join-lines',
        group: 'Lines',
        label: 'Join lines',
        run: (s) => s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim(),
    },
    {
        id: 'join-lines-dense',
        group: 'Lines',
        label: 'Join lines (dense)',
        run: (s) => s.replace(/\r?\n/g, ''),
    },
    {
        id: 'noblank',
        group: 'Lines',
        label: 'Remove blank lines',
        run: (s) =>
            s
                .split(/\r?\n/)
                .filter((l) => l.trim())
                .join('\n'),
    },
    {
        id: 'dedupe',
        group: 'Lines',
        label: 'Remove duplicate lines',
        run: (s) => [...new Set(s.split(/\r?\n/))].join('\n'),
    },
    {
        id: 'sort',
        group: 'Lines',
        label: 'Sort lines A→Z',
        run: (s) =>
            s
                .split(/\r?\n/)
                .sort((a, b) => a.localeCompare(b))
                .join('\n'),
    },
    {
        id: 'sortr',
        group: 'Lines',
        label: 'Sort lines Z→A',
        run: (s) =>
            s
                .split(/\r?\n/)
                .sort((a, b) => b.localeCompare(a))
                .join('\n'),
    },
    {
        id: 'reverse',
        group: 'Lines',
        label: 'Reverse lines',
        run: (s) => s.split(/\r?\n/).reverse().join('\n'),
    },
    {
        id: 'fa',
        group: 'Persian',
        label: 'Normalize chars & English digits (ی ک 123)',
        run: arabicReplacer,
    },
    {
        id: 'fa-digits',
        group: 'Persian',
        label: 'Farsi digits (۰۱۲۳۴۵۶۷۸۹)',
        run: toPersianDigits,
    },
    {
        id: 'count',
        group: 'Info',
        label: 'Count chars / words / lines',
        run: (s) =>
            `characters: ${[...s].length}\nwords: ${(s.match(/\S+/g) || []).length}\nlines: ${s.split(/\r?\n/).length}`,
    },
];
