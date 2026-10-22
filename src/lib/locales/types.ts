export interface LocaleDefinition {
  code: string;
  name: string; // Native name (e.g. "فارسی", "العربية", "Español")
  dir: "ltr" | "rtl"; // Automatically sets document.documentElement.dir
  translations: Record<string, string>;
}
