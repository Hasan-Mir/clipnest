import { ar } from "./ar";
import { de } from "./de";
import { en } from "./en";
import { es } from "./es";
import { fa } from "./fa";
import { fr } from "./fr";
import { ru } from "./ru";
import { tr } from "./tr";
import { LocaleDefinition } from "./types";
import { zh } from "./zh";

export type { LocaleDefinition } from "./types";

export const LOCALES: LocaleDefinition[] = [en, fa, ar, es, zh, ru, de, fr, tr];

export const LOCALE_MAP: Record<string, LocaleDefinition> = Object.fromEntries(
  LOCALES.map((l) => [l.code, l])
);
