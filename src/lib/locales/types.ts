export interface LocaleDefinition {
    code: string;
    name: string; // Native name (e.g. "فارسی", "العربية", "Español")
    englishName: string; // English subtitle (e.g. "Persian/Farsi", "Arabic", "Spanish")
    dir: 'ltr' | 'rtl'; // Automatically sets document.documentElement.dir
    translations: Record<string, string>;
}
