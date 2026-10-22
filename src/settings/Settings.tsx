import React, { useEffect, useState } from "react";
import { api, AppInfo, AppRule, AutoRule, CustomAction, Pinboard, Settings, errText } from "../lib/api";
import { t, useLang } from "../lib/i18n";
import { eventToShortcut } from "../lib/shortcut";
import { useSettings } from "../lib/useSettings";

type TabId = "general" | "clipboard" | "appearance" | "privacy" | "shortcuts" | "rules" | "actions" | "backup";
const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "clipboard", label: "Copy & Paste" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy & Screen capture" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "rules", label: "Automatic rules" },
  { id: "actions", label: "Custom actions" },
  { id: "backup", label: "Backup & Data" },
];

// ───────────── small controls ─────────────
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="srow">
      <div className="slabel"><div>{t(label)}</div>{hint && <div className="muted small">{t(hint)}</div>}</div>
      <div className="sctl">{children}</div>
    </div>
  );
}
function Toggle({ v, on }: { v: boolean; on: (b: boolean) => void }) {
  return <button className={`switch${v ? " on" : ""}`} onClick={() => on(!v)} role="switch" aria-checked={v}><span /></button>;
}
function Select<T extends string>({ v, on, opts }: { v: T; on: (v: T) => void; opts: [T, string][] }) {
  return <select value={v} onChange={(e) => on(e.target.value as T)}>{opts.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>;
}
function Num({ v, on, min = 0, max = 1_000_000, step = 1 }: { v: number; on: (n: number) => void; min?: number; max?: number; step?: number }) {
  return <input type="number" value={v} min={min} max={max} step={step} onChange={(e) => on(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />;
}

/** Shortcut recorder. The Windows key is toggled with a checkbox because Windows itself consumes Win+key
 *  before the page could ever see it. */
function ShortcutInput({ v, on }: { v: string; on: (s: string) => void }) {
  const [rec, setRec] = useState(false);
  const hasWin = /(^|\+)(super|win|meta)(\+|$)/i.test(v);
  const withoutWin = v.split("+").filter((p) => !/^(super|win|meta)$/i.test(p)).join("+");
  return (
    <div className="shortcut">
      <button
        className={`btn${rec ? " primary" : ""}`}
        dir="ltr"
        onClick={() => setRec(true)}
        onBlur={() => setRec(false)}
        onKeyDown={(e) => {
          if (!rec) return;
          e.preventDefault();
          if (e.key === "Escape") { setRec(false); return; }
          if (e.key === "Backspace" || e.key === "Delete") { on(""); setRec(false); return; }
          const s = eventToShortcut(e);
          if (s) { on(hasWin && !/super/i.test(s) ? `Super+${s}` : s); setRec(false); }
        }}
      >
        {rec ? t("Press keys…") : v || t("— none —")}
      </button>
      <label className="winbox" title={t("Include the Windows key")}>
        <input type="checkbox" checked={hasWin} disabled={!v}
          onChange={(e) => on(e.target.checked ? `Super+${withoutWin}` : withoutWin)} /> Win
      </label>
      {v && !rec && <button className="btn" onClick={() => on("")}>{t("Clear")}</button>}
    </div>
  );
}

function TagList({ items, onChange, suggestions, placeholder }: { items: string[]; onChange: (l: string[]) => void; suggestions?: AppInfo[]; placeholder: string }) {
  const [x, setX] = useState("");
  const add = (v0: string) => { const v = v0.trim().toLowerCase(); if (v && !items.includes(v)) onChange([...items, v]); setX(""); };
  return (
    <div className="taglist">
      <div className="pills">
        {items.map((a) => <span key={a} className="pill">{a}<button onClick={() => onChange(items.filter((y) => y !== a))}>×</button></span>)}
      </div>
      <div className="addrow">
        <input dir="ltr" value={x} placeholder={placeholder} onChange={(e) => setX(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add(x)} />
        <button className="btn" onClick={() => add(x)}>{t("Add")}</button>
      </div>
      {suggestions && suggestions.filter((s) => !items.includes(s.exe)).length > 0 && (
        <div className="suggest"><span className="muted small">{t("Recently seen:")}</span>
          {suggestions.filter((s) => !items.includes(s.exe)).slice(0, 10).map((s) => (
            <button key={s.exe} className="chip" onClick={() => add(s.exe)}>{s.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const KINDS = ["text", "code", "link", "image", "file", "color"];
const ACTIONS: [AutoRule["action"], string][] = [
  ["ignore", "Do not store"],
  ["to_board", "Move to pinboard"],
  ["tag", "Add tag"],
  ["plain_only", "Keep plain text only"],
  ["trim", "Trim whitespace"],
  ["expire", "Auto-delete after N minutes"],
  ["run_action", "Run custom action"],
];

// ───────────── main ─────────────
export default function SettingsView() {
  useLang();
  const [s, save] = useSettings();
  const [tab, setTab] = useState<TabId>("general");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [boards, setBoards] = useState<Pinboard[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.recentApps().then(setApps).catch(() => {});
    api.listPinboards().then(setBoards).catch(() => {});
  }, [tab]);
  if (!s) return <div className="settings"><div className="muted" style={{ padding: 24 }}>…</div></div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => save({ ...s, [k]: v });
  const flash = (x: string) => { setMsg(x); window.setTimeout(() => setMsg(""), 4000); };
  const run = async (f: () => Promise<string | null | undefined>) => {
    try { const r = await f(); if (r) flash(r); } catch (e) { flash(errText(e)); }
  };

  const updRule = (i: number, p: Partial<AppRule>) => set("app_rules", s.app_rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const updAct = (i: number, p: Partial<CustomAction>) => set("actions", s.actions.map((a, j) => (j === i ? { ...a, ...p } : a)));
  const updAuto = (i: number, p: Partial<AutoRule>) => set("rules", s.rules.map((a, j) => (j === i ? { ...a, ...p } : a)));

  return (
    <div className="settings">
      <nav className="snav">
        <div className="sbrand"><span className="logo" /> ClipNest</div>
        {TABS.map((x) => <button key={x.id} className={tab === x.id ? "active" : ""} onClick={() => setTab(x.id)}>{t(x.label)}</button>)}
      </nav>
      <main className="spane">
        {tab === "general" && (
          <>
            <h2>{t("General")}</h2>
            <Row label="Language / زبان"><Select v={s.language} on={(v) => set("language", v)} opts={[["en", "English"], ["fa", "فارسی"]]} /></Row>
            <Row label="Start with Windows"><Toggle v={s.autostart} on={(b) => set("autostart", b)} /></Row>
            <Row label="Maximum history items" hint="0 = unlimited. Pinned and pinboard items are never removed."><Num v={s.max_items} on={(n) => set("max_items", n)} step={100} /></Row>
            <Row label="Keep history for (days)" hint="0 = forever."><Num v={s.retention_days} on={(n) => set("retention_days", n)} /></Row>
            <Row label="Largest image to store (MB)"><Num v={s.max_image_mb} on={(n) => set("max_image_mb", n)} min={1} max={200} /></Row>
            <Row label="Erase history" hint="Removes everything except pinned items and pinboards.">
              <button className="btn danger" onClick={async () => { if (confirm(t("Erase all unpinned history?"))) { await api.eraseHistory(); flash(t("History erased")); } }}>{t("Erase history…")}</button>
            </Row>
          </>
        )}

        {tab === "clipboard" && (
          <>
            <h2>{t("Copy & Paste")}</h2>
            <Row label="Keep text styling (HTML / RTF)" hint="On: colours, fonts and backgrounds are stored and can be pasted back. Off: only plain text is stored (smaller database).">
              <Toggle v={s.store_rich} on={(b) => set("store_rich", b)} />
            </Row>
            <Row label="List display" hint="“Original style” draws each card exactly as it was copied (VS Code colours, backgrounds, fonts). “Plain text” shows only the text.">
              <Select v={s.list_style} on={(v) => set("list_style", v)} opts={[["rich", "Original style"], ["plain", "Plain text"]]} />
            </Row>
            <Row label="Default paste (Enter)" hint="“Keep formatting” restores every stored format. “Plain text” pastes only the text.">
              <Select v={s.default_mode} on={(v) => set("default_mode", v)} opts={[["rich", "Keep formatting"], ["plain", "Plain text only"]]} />
            </Row>
            <Row label="Paste directly into the app" hint="Off = the item is only copied; you press Ctrl+V yourself."><Toggle v={s.direct_paste} on={(b) => set("direct_paste", b)} /></Row>
            <Row label="Move used item to the top"><Toggle v={s.move_to_top} on={(b) => set("move_to_top", b)} /></Row>
            <Row label="Paste queue: order"><Select v={s.queue_fifo ? "fifo" : "lifo"} on={(v) => set("queue_fifo", v === "fifo")} opts={[["fifo", "First copied → first pasted"], ["lifo", "Last copied → first pasted"]]} /></Row>
            <Row label="Paste queue: take over Ctrl+V" hint="While the queue has items, Ctrl+V pastes the next one."><Toggle v={s.queue_intercept} on={(b) => set("queue_intercept", b)} /></Row>

            <h3>{t("Per-application rules")}</h3>
            <p className="muted small">{t("Overrides the default for a specific target app (executable name). Example: Word keeps formatting, terminals get plain text.")}</p>
            <table className="rules">
              <thead><tr><th>{t("Executable")}</th><th>{t("Paste as")}</th><th>{t("Keystroke")}</th><th /></tr></thead>
              <tbody>
                {s.app_rules.map((r, i) => (
                  <tr key={i}>
                    <td><input dir="ltr" value={r.exe} onChange={(e) => updRule(i, { exe: e.target.value.toLowerCase() })} /></td>
                    <td><Select v={r.mode} on={(v) => updRule(i, { mode: v })} opts={[["default", "Default"], ["rich", "Keep formatting"], ["plain", "Plain text"]]} /></td>
                    <td><Select v={r.keys} on={(v) => updRule(i, { keys: v })} opts={[["ctrl+v", "Ctrl+V"], ["shift+insert", "Shift+Insert"], ["ctrl+shift+v", "Ctrl+Shift+V"]]} /></td>
                    <td><button className="btn" onClick={() => set("app_rules", s.app_rules.filter((_, j) => j !== i))}>{t("Remove")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn" onClick={() => set("app_rules", [...s.app_rules, { exe: "winword.exe", mode: "rich", keys: "ctrl+v" }])}>{t("+ Add rule")}</button>
          </>
        )}

        {tab === "appearance" && (
          <>
            <h2>{t("Appearance")}</h2>
            <Row label="Theme"><Select v={s.theme} on={(v) => set("theme", v)} opts={[["dark", "Dark"], ["oled", "OLED black"], ["light", "Light"]]} /></Row>
            <Row label="Accent colour"><input type="color" value={s.accent} onChange={(e) => set("accent", e.target.value)} /></Row>
            <Row label="Card density"><Select v={s.density} on={(v) => set("density", v)} opts={[["compact", "Compact"], ["comfortable", "Comfortable"]]} /></Row>
            <Row label="Font size (px)"><Num v={s.font_size} on={(n) => set("font_size", n)} min={10} max={20} /></Row>
            <Row label="Text lines per card"><Num v={s.card_lines} on={(n) => set("card_lines", n)} min={1} max={12} /></Row>
            <Row label="Popup opens at">
              <Select v={s.popup_position} on={(v) => set("popup_position", v)} opts={[["caret", "Text cursor (falls back to mouse)"], ["mouse", "Mouse pointer"], ["center", "Screen centre"], ["last", "Last position"]]} />
            </Row>
            <Row label="Popup width (px)"><Num v={s.popup_width} on={(n) => set("popup_width", n)} min={320} max={900} step={10} /></Row>
            <Row label="Popup height (px)"><Num v={s.popup_height} on={(n) => set("popup_height", n)} min={360} max={1000} step={10} /></Row>
            <Row label="Side toolbar (CopyQ style)" hint="Quick buttons next to the list: preview, pin, tags, copy, formats, edit, merge, actions, delete."><Toggle v={s.show_toolbar} on={(b) => set("show_toolbar", b)} /></Row>
          </>
        )}

        {tab === "privacy" && (
          <>
            <h2>{t("Privacy & Screen capture")}</h2>
            <Row label="Screen-capture protection" hint="Applied instantly to the popup, queue and settings windows. Needs Windows 10 2004+ for “Invisible”. Does not work inside Remote Desktop sessions.">
              <Select v={s.capture_protection} on={(v) => set("capture_protection", v)} opts={[["black", "Black rectangle (CopyQ style)"], ["hidden", "Invisible in captures"], ["off", "Off"]]} />
            </Row>
            <Row label="Respect “do not record” flags" hint="Password managers mark their clipboard data; ClipNest then never stores it."><Toggle v={s.ignore_confidential} on={(b) => set("ignore_confidential", b)} /></Row>
            <Row label="Detect sensitive data" hint="Card numbers (Luhn), API keys (sk-…, ghp_…, AKIA…), private keys, JWTs."><Toggle v={s.detect_sensitive} on={(b) => set("detect_sensitive", b)} /></Row>
            {s.detect_sensitive && (
              <>
                <Row label="When detected"><Select v={s.sensitive_action} on={(v) => set("sensitive_action", v)} opts={[["mask", "Store, blur in the list"], ["mask_delete", "Store, blur, then auto-delete"], ["skip", "Do not store"]]} /></Row>
                {s.sensitive_action === "mask_delete" && <Row label="Auto-delete after (minutes)"><Num v={s.sensitive_ttl_min} on={(n) => set("sensitive_ttl_min", n)} min={1} max={1440} /></Row>}
              </>
            )}
            <h3>{t("Ignored applications")}</h3>
            <p className="muted small">{t("Nothing copied from these executables is stored.")}</p>
            <TagList items={s.ignore_apps} onChange={(l) => set("ignore_apps", l)} suggestions={apps} placeholder="keepass.exe" />
            <div className="cap-note muted small">{t("Database encryption and per-tab locking are not part of this version.")}</div>
          </>
        )}

        {tab === "shortcuts" && (
          <>
            <h2>{t("Global shortcuts")}</h2>
            <p className="muted small">
              {t("Shortcuts that include the Windows key (for example Win+V) are handled by a keyboard hook. Windows keeps Win+V for its own clipboard history: if it still opens, turn that off in Windows Settings → System → Clipboard.")}
            </p>
            <Row label="Open ClipNest">
              <div className="stack">
                <ShortcutInput v={s.shortcut_open} on={(v) => set("shortcut_open", v)} />
                <div className="presets">
                  <button className="chip" onClick={() => set("shortcut_open", "Super+V")}>{t("Use Win+V")}</button>
                  <button className="chip" onClick={() => set("shortcut_open", "Ctrl+Alt+V")}>Ctrl+Alt+V</button>
                </div>
              </div>
            </Row>
            <Row label="Paste queue on/off"><ShortcutInput v={s.shortcut_queue} on={(v) => set("shortcut_queue", v)} /></Row>
            <Row label="Toggle plain-text mode"><ShortcutInput v={s.shortcut_plain_toggle} on={(v) => set("shortcut_plain_toggle", v)} /></Row>
            <Row label="Pause / resume capture"><ShortcutInput v={s.shortcut_pause} on={(v) => set("shortcut_pause", v)} /></Row>
            <h3>{t("Inside the popup")}</h3>
            <table className="keys" dir="ltr"><tbody>
              {[
                ["↑ ↓ · Shift+↑↓ · PgUp/PgDn · Ctrl+↑↓", "Select / extend selection / jump"],
                ["← → · Tab · Ctrl+[ ]", "Switch Clipboard ↔ pinboards"],
                ["Enter · Shift+Enter · Ctrl+Enter", "Paste · plain text · keep formatting"],
                ["Ctrl+1 … Ctrl+9", "Quick-paste a visible card"],
                ["Alt+↑ / Alt+↓ (or drag a card)", "Move the card up / down"],
                ["Space (or F3)", "Preview (empty search)"],
                ["Ctrl+C", "Copy only"],
                ["Delete / Ctrl+Delete", "Delete (or unpin inside a pinboard)"],
                ["F2 · Ctrl+T · Ctrl+P", "Rename · tags · pin on top"],
                ["Ctrl+E · Ctrl+I · Ctrl+M", "Edit · formats inspector · merge selected"],
                ["Ctrl+O · Ctrl+N · Ctrl+,", "Open link/file · new pinboard · settings"],
                ["Esc", "Clear search, then close"],
              ].map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td className="muted" dir="auto">{t(d)}</td></tr>)}
            </tbody></table>
          </>
        )}

        {tab === "rules" && (
          <>
            <h2>{t("Automatic rules")}</h2>
            <p className="muted small">{t("Run on every new copy, in order. A rule applies when ALL of its filled-in conditions match. Example: app “keepass”, action “Do not store”; or pattern “^https?://”, action “Move to pinboard”.")}</p>
            {s.rules.map((r, i) => (
              <div key={r.id} className="rulecard">
                <div className="rulehead">
                  <Toggle v={r.enabled} on={(b) => updAuto(i, { enabled: b })} />
                  <input value={r.name} placeholder={t("Rule name")} onChange={(e) => updAuto(i, { name: e.target.value })} />
                  <button className="btn" disabled={i === 0} onClick={() => { const a = [...s.rules]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; set("rules", a); }}>↑</button>
                  <button className="btn" disabled={i === s.rules.length - 1} onClick={() => { const a = [...s.rules]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; set("rules", a); }}>↓</button>
                  <button className="btn" onClick={() => set("rules", s.rules.filter((_, j) => j !== i))}>{t("Remove")}</button>
                </div>
                <div className="rulegrid">
                  <label><span>{t("When copied from app(s)")}</span><input dir="ltr" value={r.apps} placeholder="code, chrome" onChange={(e) => updAuto(i, { apps: e.target.value })} /></label>
                  <label><span>{t("and text matches (regex)")}</span><input dir="ltr" value={r.pattern} placeholder="^https?://" onChange={(e) => updAuto(i, { pattern: e.target.value })} /></label>
                </div>
                <div className="kinds">
                  <span className="muted small">{t("Item type")}:</span>
                  {KINDS.map((k) => (
                    <label key={k} className="kind">
                      <input type="checkbox" checked={r.kinds.includes(k)} onChange={(e) => updAuto(i, { kinds: e.target.checked ? [...r.kinds, k] : r.kinds.filter((x) => x !== k) })} />
                      {t(k)}
                    </label>
                  ))}
                  <span className="muted small">{r.kinds.length === 0 ? t("(any)") : ""}</span>
                </div>
                <div className="rulegrid">
                  <label><span>{t("Then")}</span>
                    <Select v={r.action} on={(v) => updAuto(i, { action: v })} opts={ACTIONS} />
                  </label>
                  {r.action === "to_board" && (
                    <label><span>{t("Pinboard")}</span>
                      <select value={r.board} onChange={(e) => updAuto(i, { board: Number(e.target.value) })}>
                        <option value={0}>—</option>
                        {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select></label>
                  )}
                  {r.action === "tag" && <label><span>{t("Tag")}</span><input value={r.value} placeholder="work" onChange={(e) => updAuto(i, { value: e.target.value })} /></label>}
                  {r.action === "expire" && <label><span>{t("Minutes")}</span><input type="number" min={1} value={r.value} onChange={(e) => updAuto(i, { value: e.target.value })} /></label>}
                  {r.action === "run_action" && (
                    <label><span>{t("Custom action")}</span>
                      <select value={r.value} onChange={(e) => updAuto(i, { value: e.target.value })}>
                        <option value="">—</option>
                        {s.actions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select></label>
                  )}
                </div>
              </div>
            ))}
            <button className="btn" onClick={() => set("rules", [...s.rules, { id: `r${Date.now()}`, name: "", enabled: true, apps: "", kinds: [], pattern: "", action: "ignore", board: 0, value: "" }])}>{t("+ Add rule")}</button>
          </>
        )}

        {tab === "actions" && (
          <>
            <h2>{t("Custom actions")}</h2>
            <p className="muted small">{t("Shell commands (run with cmd /C) that receive the item’s text on stdin. They appear under “Actions” in the item menu and can be used by automatic rules.")} <code dir="ltr">{'powershell -NoProfile -Command "$input | ForEach-Object { $_.ToUpper() }"'}</code></p>
            {s.actions.map((a, i) => (
              <div key={a.id} className="action">
                <input value={a.name} placeholder={t("Name")} onChange={(e) => updAct(i, { name: e.target.value })} />
                <input className="wide" dir="ltr" value={a.command} placeholder="command" onChange={(e) => updAct(i, { command: e.target.value })} />
                <Select v={a.output} on={(v) => updAct(i, { output: v })} opts={[["new_item", "Output → new item"], ["clipboard", "Output → clipboard"], ["none", "Ignore output"]]} />
                <button className="btn" onClick={() => set("actions", s.actions.filter((_, j) => j !== i))}>{t("Remove")}</button>
              </div>
            ))}
            <button className="btn" onClick={() => set("actions", [...s.actions, { id: `a${Date.now()}`, name: t("My action"), command: "", output: "new_item" }])}>{t("+ Add action")}</button>
          </>
        )}

        {tab === "backup" && (
          <>
            <h2>{t("Backup & Data")}</h2>
            <p className="muted small">{t("Every copy is written to disk immediately (SQLite WAL, full fsync), so a power cut cannot lose a completed copy.")}</p>
            <Row label="Daily automatic backup"><Toggle v={s.auto_backup} on={(b) => set("auto_backup", b)} /></Row>
            <Row label="Backups to keep"><Num v={s.backup_keep} on={(n) => set("backup_keep", n)} min={1} max={90} /></Row>
            <Row label="Export history" hint="Saves everything (items, formats, pinboards) to a file you choose.">
              <button className="btn" onClick={() => run(async () => { const p = await api.exportData(); return p ? t("Saved: {p}", { p }) : null; })}>{t("Export…")}</button>
            </Row>
            <Row label="Import / restore" hint="Merges an export or a daily backup into the current history. Nothing is overwritten or deleted.">
              <button className="btn" onClick={() => run(async () => { const n = await api.importData(); return n === null ? null : t("Imported {n} new item(s)", { n }); })}>{t("Import…")}</button>
            </Row>
            <Row label="Export / import settings" hint="Settings, rules, actions and shortcuts as a JSON file.">
              <div className="shortcut">
                <button className="btn" onClick={() => run(async () => { const p = await api.exportSettings(); return p ? t("Saved: {p}", { p }) : null; })}>{t("Export…")}</button>
                <button className="btn" onClick={() => run(async () => ((await api.importSettings()) ? t("Settings imported") : null))}>{t("Import…")}</button>
              </div>
            </Row>
            <Row label="Back up now"><button className="btn" onClick={() => run(async () => t("Saved: {p}", { p: await api.backupNow() }))}>{t("Create backup")}</button></Row>
            <Row label="Data folder" hint="Database, settings.json and backups."><button className="btn" onClick={() => api.openDataDir()}>{t("Open in Explorer")}</button></Row>
            <Row label="Erase history" hint="Removes everything except pinned items and pinboards.">
              <button className="btn danger" onClick={async () => { if (confirm(t("Erase all unpinned history?"))) { await api.eraseHistory(); flash(t("History erased")); } }}>{t("Erase history…")}</button>
            </Row>
            <Row label="Quit ClipNest"><button className="btn danger" onClick={() => api.quit()}>{t("Quit")}</button></Row>
          </>
        )}
        {msg && <div className="toast">{msg}</div>}
      </main>
    </div>
  );
}
