import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Popup from "./popup/Popup";
import SettingsView from "./settings/Settings";
import QueueView from "./queue/Queue";
import "./styles.css";

const label = getCurrentWindow().label;
document.documentElement.dataset.view = label;

ReactDOM.createRoot(document.getElementById("root")!).render(
  label === "settings" ? <SettingsView /> : label === "queue" ? <QueueView /> : <Popup />
);
