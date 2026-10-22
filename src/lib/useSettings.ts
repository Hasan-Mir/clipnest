import { useCallback, useEffect, useRef, useState } from "react";
import { api, on, Settings } from "./api";
import { setLang } from "./i18n";

export const DEFAULT_SETTINGS: Settings = {
  language: "en",
  store_rich: true,
  list_style: "rich",
  rules: [],
  autostart: false,
  max_items: 5000,
  retention_days: 0,
  max_image_mb: 25,
  default_mode: "rich",
  direct_paste: true,
  move_to_top: true,
  app_rules: [
    { exe: "windowsterminal.exe", mode: "plain", keys: "ctrl+v" },
    { exe: "cmd.exe", mode: "plain", keys: "ctrl+v" },
    { exe: "powershell.exe", mode: "plain", keys: "ctrl+v" },
    { exe: "pwsh.exe", mode: "plain", keys: "ctrl+v" },
    { exe: "conhost.exe", mode: "plain", keys: "ctrl+v" },
    { exe: "mintty.exe", mode: "plain", keys: "shift+insert" },
  ],
  card_paste_click: "double",
  ctrl_click_action: "multi_select",
  ctrl_shift_click_action: "paste_plain",
  auto_save_edit: true,
  basket_allow_cut: true,
  active_pinboard: null,
  ignore_apps: [
    "keepass.exe",
    "keepassxc.exe",
    "bitwarden.exe",
    "1password.exe",
    "lastpass.exe",
    "dashlane.exe",
  ],
  ignore_confidential: true,
  detect_sensitive: true,
  sensitive_action: "mask",
  sensitive_ttl_min: 5,
  capture_protection: "black",
  theme: "dark",
  accent: "#4f8cff",
  density: "compact",
  font_size: 13,
  card_lines: 4,
  popup_width: 400,
  popup_height: 560,
  popup_position: "caret",
  remember_popup_size: true,
  show_toolbar: false,
  animations: true,
  show_thumbnails: true,
  thumbnail_size: "medium",
  virtual_scroll: true,
  highlight_matches: true,
  highlight_color: "#2ea8ff",
  highlight_bg: "transparent",
  shortcut_open: "Super+V",
  shortcut_queue: "Ctrl+Alt+Q",
  shortcut_plain_toggle: "Ctrl+Alt+P",
  shortcut_pause: "",
  queue_fifo: true,
  queue_intercept: true,
  auto_backup: true,
  backup_keep: 7,
  actions: [],
};

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
    if (timer.current !== undefined || Date.now() - lastSent.current < 700) {
      return;
    }
    api.getSettings().then(setS).catch(() => {});
  }, []);

  useEffect(() => {
    api.getSettings().then(setS).catch(() => {});
    const p = on("settings-changed", load);
    return () => {
      p.then((u) => u());
    };
  }, [load]);

  useEffect(() => {
    if (!s) {
      return;
    }
    const r = document.documentElement;
    r.dataset.theme = s.theme;
    r.dataset.density = s.density;
    r.dataset.animations = s.animations ? "on" : "off";
    r.style.setProperty("--accent", s.accent);
    r.style.setProperty("--fs", `${s.font_size}px`);
    const thumbPx = s.thumbnail_size === "small" ? "52px" : s.thumbnail_size === "large" ? "170px" : "110px";
    r.style.setProperty("--thumb-max-h", thumbPx);
    r.style.setProperty("--hl-color", s.highlight_matches ? s.highlight_color : "inherit");
    r.style.setProperty("--hl-bg", s.highlight_matches ? s.highlight_bg : "transparent");
    setLang(s.language || "en");
  }, [s]);

  const save = useCallback((next: Settings) => {
    setS(next);
    latest.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      lastSent.current = Date.now();
      if (latest.current) {
        api.setSettings(latest.current).catch(() => {});
      }
    }, 250);
  }, []);

  return [s, save];
}
