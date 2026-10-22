import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipHost } from "./lib/TooltipHost";
import Popup from "./popup/Popup";
import SettingsView from "./settings/Settings";
import QueueView from "./queue/Queue";
import TrayMenu from "./tray/TrayMenu";
import "./styles.css";

const label = getCurrentWindow().label;
document.documentElement.dataset.view = label;

// Block WebView2's native browser context menu; React's onContextMenu still runs normally.
window.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
  },
  { capture: true }
);

// Block WebView2's built-in browser accelerators (Find bar, Print, Reload, Caret browsing, etc.)
// in the capture phase so Chromium overlays never steal focus from ClipNest.
window.addEventListener(
  "keydown",
  (e) => {
    const ck = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ck && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("clipnest-focus-search"));
      return;
    }

    if (e.key === "F3") {
      e.preventDefault();
      return;
    }

    if (
      e.key === "F5" ||
      e.key === "F7" ||
      (ck && (key === "r" || key === "g" || key === "u" || key === "p" || key === "s" || key === "o"))
    ) {
      e.preventDefault();
    }
  },
  { capture: true }
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <>
    {label === "settings" ? (
      <SettingsView />
    ) : label === "queue" ? (
      <QueueView />
    ) : label === "tray" ? (
      <TrayMenu />
    ) : (
      <Popup />
    )}
    <TooltipHost />
  </>
);
