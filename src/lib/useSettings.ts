import { useCallback, useEffect, useRef, useState } from "react";
import { api, on, Settings } from "./api";
import { setLang } from "./i18n";

/**
 * Loads the settings, keeps them in sync with the backend and applies the theme CSS variables.
 * Writes are debounced, and the "settings-changed" echo of our own save is ignored, so typing in a
 * text field can never be overwritten by an older value coming back from the backend.
 */
export function useSettings(): [Settings | null, (s: Settings) => void] {
  const [s, setS] = useState<Settings | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef<Settings | null>(null);
  const lastSent = useRef(0);

  const load = useCallback(() => {
    if (timer.current !== undefined || Date.now() - lastSent.current < 700) return;
    api.getSettings().then(setS).catch(() => {});
  }, []);

  useEffect(() => {
    api.getSettings().then(setS).catch(() => {});
    const p = on("settings-changed", load);
    return () => { p.then((u) => u()); };
  }, [load]);

  useEffect(() => {
    if (!s) return;
    const r = document.documentElement;
    r.dataset.theme = s.theme;
    r.dataset.density = s.density;
    r.style.setProperty("--accent", s.accent);
    r.style.setProperty("--fs", `${s.font_size}px`);
    setLang(s.language === "fa" ? "fa" : "en");
  }, [s]);

  const save = useCallback((next: Settings) => {
    setS(next);
    latest.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      lastSent.current = Date.now();
      if (latest.current) api.setSettings(latest.current).catch(() => {});
    }, 250);
  }, []);

  return [s, save];
}
