import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pinboard } from "../lib/api";
import { t } from "../lib/i18n";

// ───────────── context menu ─────────────
export interface MenuEntry {
  label?: string;
  hint?: string;
  onClick?: () => void;
  sep?: boolean;
  header?: boolean;
  chips?: { label: string; color?: string; onClick: () => void }[];
  submenu?: MenuEntry[];
  danger?: boolean;
}

export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y, entries]);
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
        {entries.map((e, i) => {
          if (e.sep) return <div key={i} className="menu-sep" />;
          if (e.header) return <div key={i} className="menu-head">{e.label}</div>;
          if (e.chips)
            return (
              <div key={i} className="menu-chips">
                {e.chips.map((c, j) => (
                  <button key={j} className="chip" onClick={() => { c.onClick(); onClose(); }}>
                    {c.color && <span className="dot" style={{ background: c.color }} />}{c.label}
                  </button>
                ))}
              </div>
            );
          if (e.submenu)
            return (
              <div key={i} className="menu-item has-sub"
                onMouseEnter={(ev) => { setOpen(i); setRect(ev.currentTarget.getBoundingClientRect()); }}>
                <span>{e.label}</span><span className="hint">▸</span>
                {open === i && rect && <SubMenu anchor={rect} entries={e.submenu} onPick={onClose} />}
              </div>
            );
          return (
            <div key={i} className={`menu-item${e.danger ? " danger" : ""}`} onMouseEnter={() => setOpen(null)}
              onClick={() => { e.onClick?.(); onClose(); }}>
              <span>{e.label}</span>{e.hint && <span className="hint">{e.hint}</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Fixed-position sub-menu: opens to the right if there is room, otherwise to the left, and is
 *  always clamped inside the window (the popup is only ~400px wide). */
function SubMenu({ anchor, entries, onPick }: { anchor: DOMRect; entries: MenuEntry[]; onPick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = anchor.right - 6;
    if (left + w > vw - 4) left = anchor.left - w + 6;
    left = Math.max(4, Math.min(left, vw - w - 4));
    const top = Math.max(4, Math.min(anchor.top - 6, vh - h - 4));
    setPos({ left, top });
  }, [anchor]);
  return (
    <div className="menu sub" ref={ref}
      style={{ position: "fixed", left: pos ? pos.left : -9999, top: pos ? pos.top : 0, maxHeight: window.innerHeight - 8 }}>
      {entries.map((s, j) => (
        <div key={j} className="menu-item" onClick={() => { s.onClick?.(); onPick(); }}>
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ───────────── prompt dialog ─────────────
export interface PromptState {
  title: string;
  initial?: string;
  placeholder?: string;
  confirm?: boolean; // confirm-only (no text field)
  okLabel?: string;
  onSubmit: (value: string) => void;
}

export function Prompt({ p, onClose }: { p: PromptState; onClose: () => void }) {
  const [v, setV] = useState(p.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const submit = () => { p.onSubmit(v); onClose(); };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") submit();
        }}>
        <div className="dialog-title">{p.title}</div>
        {!p.confirm && <input ref={ref} value={v} placeholder={p.placeholder} onChange={(e) => setV(e.target.value)} />}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn primary" autoFocus={p.confirm} onClick={submit}>{p.okLabel ?? t("OK")}</button>
        </div>
      </div>
    </div>
  );
}

// ───────────── pinboard settings dialog (per-tab settings) ─────────────
export const BOARD_COLORS = ["#4f8cff", "#34c759", "#ff9f0a", "#ff453a", "#bf5af2", "#64d2ff", "#ffd60a", "#8e8e93"];

export function BoardDialog({ board, onSave, onClose }: {
  board: Pinboard;
  onSave: (name: string, color: string, maxItems: number, listStyle: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(board.name);
  const [color, setColor] = useState(board.color);
  const [max, setMax] = useState(board.max_items);
  const [style, setStyle] = useState<string>(board.list_style);
  const save = () => { if (name.trim()) { onSave(name, color, max, style); onClose(); } };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); if (e.key === "Enter") save(); }}>
        <div className="dialog-title">{t("Pinboard settings")}</div>
        <label className="field"><span>{t("Name")}</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="field"><span>{t("Color")}</span>
          <div className="swatches">
            {BOARD_COLORS.map((c) => (
              <button key={c} className={`sw${c === color ? " on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <label className="field"><span>{t("Maximum items (0 = unlimited, oldest are deleted)")}</span>
          <input type="number" min={0} value={max} onChange={(e) => setMax(Math.max(0, Number(e.target.value) || 0))} /></label>
        <label className="field"><span>{t("Show items as")}</span>
          <select value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="inherit">{t("Same as global setting")}</option>
            <option value="rich">{t("Original style")}</option>
            <option value="plain">{t("Plain text")}</option>
          </select></label>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn primary" onClick={save}>{t("Save")}</button>
        </div>
      </div>
    </div>
  );
}
