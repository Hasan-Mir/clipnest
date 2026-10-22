import { useEffect, useState } from "react";
import { FA } from "./fa";

export type Lang = "en" | "fa";
let current: Lang = "en";
const listeners = new Set<() => void>();

/** Switches the UI language (and the text direction of the whole window). */
export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  document.documentElement.lang = l;
  document.documentElement.dir = l === "fa" ? "rtl" : "ltr";
  listeners.forEach((f) => f());
}

export function getLang(): Lang {
  return current;
}

/** English text is the key. Persian comes from the FA dictionary; `{name}` placeholders are filled from `vars`. */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = current === "fa" ? FA[s] ?? s : s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
  return out;
}

export function num(n: number): string {
  return n.toLocaleString(current === "fa" ? "fa-IR" : "en-US");
}

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return current;
}
