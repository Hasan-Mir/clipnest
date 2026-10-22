import React, { useCallback, useEffect, useState } from "react";
import { api, ClipRow, on, Settings } from "../lib/api";
import { Icon } from "../lib/icons";
import { t, useLang } from "../lib/i18n";
import { useSettings } from "../lib/useSettings";

export default function QueueView() {
  useLang();
  const [s, save] = useSettings();
  const [items, setItems] = useState<ClipRow[]>([]);
  const load = useCallback(() => { api.queueGet().then(setItems).catch(() => {}); }, []);
  useEffect(() => {
    load();
    const p = on("queue-changed", load);
    return () => { p.then((u) => u()); };
  }, [load]);
  const fifo = s?.queue_fifo ?? true;
  const flip = () => { if (s) save({ ...s, queue_fifo: !fifo } as Settings); };
  return (
    <div className="queue">
      <header className="head" data-tauri-drag-region>
        <span className="brand">{t("Paste Queue")}</span>
        <span className="spacer" />
        <button className="mini" title={t("Order (click to reverse)")} onClick={flip}>{fifo ? "FIFO ↓" : "LIFO ↑"}</button>
        <button className="iconbtn" title={t("Clear")} onClick={() => api.queueClear()}><Icon name="trash" /></button>
        <button className="iconbtn" title={t("Close queue")} onClick={() => api.queueToggle()}><Icon name="close" /></button>
      </header>
      <div className="qlist">
        {items.length === 0 && <div className="empty small">{t("Copy something — it is added here.")}<br />{t("Then press Ctrl+V repeatedly to paste in order.")}</div>}
        {(fifo ? items : [...items].reverse()).map((it, i) => (
          <div key={`${it.id}-${i}`} className={`qrow${i === 0 ? " next" : ""}`}>
            <span className="qn">{i + 1}</span>
            <span className="qtext" dir="auto">
              {it.kind === "image" ? `🖼 ${t("image")} ${it.img_w}×${it.img_h}` : it.kind === "file" ? `📄 ${it.preview.split("\n")[0]}` : it.preview.replace(/\s+/g, " ").slice(0, 80)}
            </span>
            <button className="iconbtn" onClick={() => api.queueRemove(it.id)}><Icon name="close" size={11} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
