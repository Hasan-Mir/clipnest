import { describe, expect, it } from 'vitest';
import { TRANSFORMS, arabicReplacer, toEnglishDigits, toPersianDigits } from '../lib/transforms';

describe('Persian and Arabic text transforms', () => {
    describe('toEnglishDigits', () => {
        it('converts all Persian digits (۰-۹) to English digits (0-9)', () => {
            expect(toEnglishDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
            expect(toEnglishDigits('کد تایید: ۴۸۲۹۱۰')).toBe('کد تایید: 482910');
        });

        it('converts all Arabic-Indic digits (٠-٩) to English digits (0-9)', () => {
            expect(toEnglishDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
            expect(toEnglishDigits('رقم: ٩٨٧٦٥٤٣٢١٠')).toBe('رقم: 9876543210');
        });

        it('handles mixed Persian, Arabic, and English digits seamlessly', () => {
            expect(toEnglishDigits('Tel: ۰۹۱۲-٣٤٥-6789')).toBe('Tel: 0912-345-6789');
        });

        it('preserves empty strings and strings without digits', () => {
            expect(toEnglishDigits('')).toBe('');
            expect(toEnglishDigits('Hello سلام')).toBe('Hello سلام');
        });
    });

    describe('arabicReplacer (Normalize chars & English digits)', () => {
        it('replaces Arabic Yeh (ي and ى) and Kaf (ك) with Persian equivalents (ی and ک)', () => {
            expect(arabicReplacer('علي كتابي وى')).toBe('علی کتابی وی');
        });

        it('replaces Teh Marbuta (ة) with Persian Heh (ه)', () => {
            expect(arabicReplacer('مدرسة جميلة')).toBe('مدرسه جمیله');
        });

        it('replaces Zero-Width Joiner (‍) with Zero-Width Non-Joiner (‌)', () => {
            expect(arabicReplacer('می‍روم')).toBe('می‌روم');
        });

        it('replaces diacritic sequences (دِ بِ زِ ذِ ِشِ ِسِ) with clean Persian letters', () => {
            expect(arabicReplacer('دِ بِ زِ ذِ ِشِ ِسِ')).toBe('د ب ز ذ ش س');
        });

        it('normalizes both Arabic characters and Persian/Arabic digits to English digits simultaneously', () => {
            expect(arabicReplacer('كتاب شماره ٢ و قیمت ۳۵۰ تومان')).toBe('کتاب شماره 2 و قیمت 350 تومان');
        });
    });

    describe('toPersianDigits (Farsi digits)', () => {
        it('converts all English digits (0-9) to Persian digits (۰-۹)', () => {
            expect(toPersianDigits('0123456789')).toBe('۰۱۲۳۴۵۶۷۸۹');
            expect(toPersianDigits('2')).toBe('۲');
            expect(toPersianDigits('Version 1.4.20')).toBe('Version ۱.۴.۲۰');
        });

        it('converts all Arabic-Indic digits (٠-٩) to Persian digits (۰-۹)', () => {
            expect(toPersianDigits('٠١٢٣٤٥٦٧٨٩')).toBe('۰۱۲۳۴۵۶۷۸۹');
        });

        it('converts mixed English, Arabic, and existing Persian digits to uniform Persian digits', () => {
            expect(toPersianDigits('2 + ٣ = ۵')).toBe('۲ + ۳ = ۵');
        });
    });
});

describe('TRANSFORMS registry', () => {
    const findTransform = (id: string) => {
        const found = TRANSFORMS.find((t) => t.id === id);
        if (!found) {
            throw new Error(`Transform not found: ${id}`);
        }
        return found;
    };

    it('executes case conversions accurately', () => {
        expect(findTransform('upper').run('hello World')).toBe('HELLO WORLD');
        expect(findTransform('lower').run('Hello WORLD')).toBe('hello world');
        expect(findTransform('title').run('hello world example')).toBe('Hello World Example');
        expect(findTransform('sentence').run('HELLO WORLD. HOW ARE YOU?')).toBe('Hello world. How are you?');
    });

    it('executes developer identifier case conversions accurately', () => {
        expect(findTransform('camel').run('hello world example')).toBe('helloWorldExample');
        expect(findTransform('camel').run('HTTP_response_code')).toBe('httpResponseCode');
        expect(findTransform('pascal').run('hello_world-example')).toBe('HelloWorldExample');
        expect(findTransform('snake').run('helloWorldExample')).toBe('hello_world_example');
        expect(findTransform('kebab').run('helloWorldExample')).toBe('hello-world-example');
        expect(findTransform('const').run('helloWorldExample')).toBe('HELLO_WORLD_EXAMPLE');
    });

    it('executes whitespace & line operations accurately', () => {
        expect(findTransform('trim').run('  hello\n\n  world  \n')).toBe('hello\nworld');
        expect(findTransform('singleline').run('hello  \n\t  world')).toBe('hello world');
        expect(findTransform('sort').run('banana\napple\ncherry')).toBe('apple\nbanana\ncherry');
        expect(findTransform('dedupe').run('a\nb\na\nc\nb')).toBe('a\nb\nc');
        expect(findTransform('number').run('first\nsecond')).toBe('1. first\n2. second');
    });

    it('executes JSON formatting and minification with graceful fallback on invalid JSON', () => {
        expect(findTransform('json-pretty').run('{"a":1,"b":[2,3]}')).toBe(
            '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}'
        );
        expect(findTransform('json-pretty').run('not valid json')).toBe('not valid json');
        expect(findTransform('json-min').run('{\n  "a": 1,\n  "b": 2\n}')).toBe('{"a":1,"b":2}');
    });

    it('executes URL and Base64 encoding/decoding with full Unicode support', () => {
        const raw = 'سلام دنیا & ClipNest=100%';
        const urlEncoded = findTransform('url-enc').run(raw);
        expect(findTransform('url-dec').run(urlEncoded)).toBe(raw);

        const b64 = findTransform('b64-enc').run(raw);
        expect(findTransform('b64-dec').run(b64)).toBe(raw);
    });

    it('executes HTML entity escaping and unescaping', () => {
        const html = '<div class="card">Tom & Jerry\'s</div>';
        const escaped = findTransform('html-esc').run(html);
        expect(escaped).toBe('&lt;div class=&quot;card&quot;&gt;Tom &amp; Jerry&#39;s&lt;/div&gt;');
        expect(findTransform('html-unesc').run(escaped)).toBe(html);
    });

    it('executes Persian transforms registered in TRANSFORMS', () => {
        expect(findTransform('fa-normalize').run('كتاب ۱۲۳ و ٤٥٦')).toBe('کتاب 123 و 456');
        expect(findTransform('fa-digits').run('Version 2.0 - شماره ٤٥')).toBe('Version ۲.۰ - شماره ۴۵');
        expect(findTransform('fa-ye-ke').run('علي و كتاب')).toBe('علی و کتاب');
    });
});
