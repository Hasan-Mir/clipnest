import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ClipRow, errText, ListResult, on, PasteMode, Pinboard, Status } from "../lib/api";
import { num, t, useLang } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { TRANSFORMS, Transform } from "../lib/transforms";
import { useSettings } from "../lib/useSettings";
import { Card, DropMark } from "./Card";
import { BOARD_COLORS, BoardDialog, ContextMenu, MenuEntry, Prompt, PromptState } from "./Overlays";
import { Preview } from "./Preview";

type SMode = "smart" | "regex" | "fuzzy";
const PAGE = 100;

export default function Popup() {
  const lang = useLang();
  const [settings] = useSettings();
  const [status, setStatus] = useState<Status | null>(null);
  const [boards, setBoards] = useState<Pinboard[]>([]);
  const [tab, setTab] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [smode, setSmode] = useState<SMode>("smart");
  const [limit, setLimit] = useState(PAGE);
  const [res, setRes] = useState<ListResult>({ items: [], total: 0, error: null });
  const [sel, setSel] = useState(0);
  const [multi, setMulti] = useState<number[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [preview, setPreview] = useState<{ item: ClipRow; edit: boolean; formats: boolean } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [boardDlg, setBoardDlg] = useState<Pinboard | null>(null);
  const [toast, setToast] = useState("");
  const [ctrl, setCtrl] = useState(false);
  const [quickIds, setQuickIds] = useState<number[]>([]);
  const [now, setNow] = useState(Date.now());
  const [iconRev, setIconRev] = useState(0);
  const [dropMark, setDropMark] = useState<{ id: number; mark: DropMark } | null>(null);

  const anchor = useRef(0);
  const seq = useRef(0);
  const hiddenAt = useRef(0);
  const dragId = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const items = res.items;
  const cur: ClipRow | undefined = items[sel];
  const curBoard = boards.find((b) => b.id === tab) ?? null;
  // Display style: per-pinboard override, otherwise the global setting.
  const richOn = (curBoard && curBoard.list_style !== "inherit" ? curBoard.list_style : settings?.list_style ?? "rich") === "rich";

  const showToast = useCallback((s: string) => {
    setToast(s);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);
  const fail = useCallback((e: unknown) => showToast(errText(e)), [showToast]);

  // ───────────── data ─────────────
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const [r, b] = await Promise.all([api.listItems(tab, query, smode, limit), api.listPinboards()]);
      if (my !== seq.current) return;
      setRes(r);
      setBoards(b);
      setSel((s) => Math.min(s, Math.max(0, r.items.length - 1)));
      setIconRev((v) => v + 1);
    } catch (e) {
      fail(e);
    }
  }, [tab, query, smode, limit, fail]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const timer = window.setTimeout(reload, query ? 45 : 0);
    return () => window.clearTimeout(timer);
  }, [reload, query]);

  const loadStatus = useCallback(() => { api.status().then(setStatus).catch(() => {}); }, []);

  const askErase = useCallback(() => {
    setMenu(null);
    setPrompt({
      title: t("Erase all history?"),
      confirm: true,
      okLabel: t("Erase"),
      onSubmit: () => { api.eraseHistory().then(() => showToast(t("History erased"))).catch(fail); },
    });
  }, [showToast, fail]);
  const askEraseRef = useRef(askErase);
  askEraseRef.current = askErase;

  useEffect(() => {
    loadStatus();
    const subs = [
      on("items-changed", () => reloadRef.current()),
      on("status-changed", loadStatus),
      on("erase-request", () => askEraseRef.current()),
      on("popup-hidden", () => { hiddenAt.current = Date.now(); }),
      on("popup-shown", () => {
        if (Date.now() - hiddenAt.current > 60_000) setQuery("");
        setTab(null);
        setLimit(PAGE);
        setSel(0);
        anchor.current = 0;
        setMulti([]);
        setPreview(null);
        setMenu(null);
        setPrompt(null);
        setBoardDlg(null);
        reloadRef.current();
        loadStatus();
        listRef.current?.scrollTo(0, 0);
        setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
      }),
    ];
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const clearCtrl = () => setCtrl(false);
    window.addEventListener("blur", clearCtrl);
    return () => {
      subs.forEach((p) => p.then((u) => u()));
      window.clearInterval(timer);
      window.removeEventListener("blur", clearCtrl);
    };
  }, [loadStatus]);

  useEffect(() => {
    setPreview((p) => {
      if (!p) return p;
      const fresh = items.find((i) => i.id === p.item.id);
      return fresh && fresh !== p.item ? { ...p, item: fresh } : p;
    });
  }, [items]);

  useEffect(() => {
    if (!menu && !preview && !prompt && !boardDlg) inputRef.current?.focus();
  }, [menu, preview, prompt, boardDlg]);

  useEffect(() => {
    if (cur) document.getElementById(`card-${cur.id}`)?.scrollIntoView({ block: "nearest" });
  }, [sel, cur?.id]);

  // ───────────── helpers ─────────────
  const targets = (): ClipRow[] => (multi.length > 1 ? items.filter((i) => multi.includes(i.id)) : cur ? [cur] : []);

  const move = (to: number, extend = false) => {
    const n = items.length;
    if (!n) return;
    const tt = Math.max(0, Math.min(n - 1, to));
    if (extend) {
      const a = Math.min(anchor.current, tt), b = Math.max(anchor.current, tt);
      setMulti(items.slice(a, b + 1).map((i) => i.id));
    } else {
      anchor.current = tt;
      setMulti([]);
    }
    setSel(tt);
    if (tt >= n - 8 && n < res.total) setLimit((l) => l + PAGE);
  };

  const resetView = () => { setSel(0); anchor.current = 0; setMulti([]); setLimit(PAGE); };

  const tabIds: (number | null)[] = useMemo(() => [null, ...boards.map((b) => b.id)], [boards]);
  const switchTab = (d: number) => {
    const i = tabIds.indexOf(tab);
    setTab(tabIds[(i + d + tabIds.length) % tabIds.length]);
    resetView();
  };

  const visibleIds = (): number[] => {
    const lst = listRef.current;
    if (!lst) return [];
    const lr = lst.getBoundingClientRect();
    const out: number[] = [];
    for (const it of items) {
      const el = document.getElementById(`card-${it.id}`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > lr.top + 4 && r.top < lr.bottom - 4) out.push(it.id);
      if (out.length === 9) break;
    }
    return out;
  };

  // ───────────── actions ─────────────
  const doPaste = async (mode: PasteMode, id?: number) => {
    try {
      const ts = targets();
      if (id === undefined && ts.length > 1) {
        const nid = await api.mergeItems(ts.map((x) => x.id), "\n");
        await api.pasteItem(nid, mode);
        return;
      }
      const target = id ?? cur?.id;
      if (target !== undefined) await api.pasteItem(target, mode);
    } catch (e) { fail(e); }
  };

  const doCopy = async (it?: ClipRow) => {
    const x = it ?? cur;
    if (x) api.copyItem(x.id, "auto").catch(fail);
  };

  const doDelete = async (hard: boolean) => {
    const ts = targets();
    if (!ts.length) return;
    const ids = ts.map((x) => x.id);
    try {
      if (tab !== null && !hard) await api.setPinboard(ids, null);
      else await api.deleteItems(ids);
      setMulti([]);
    } catch (e) { fail(e); }
  };

  const renameItem = (it?: ClipRow) => {
    const x = it ?? cur;
    if (!x) return;
    setPrompt({ title: t("Rename item"), initial: x.title ?? "", placeholder: t("Custom title (empty to clear)"), onSubmit: (v) => { api.renameItem(x.id, v).catch(fail); } });
  };
  const tagItem = (it?: ClipRow) => {
    const x = it ?? cur;
    if (!x) return;
    setPrompt({ title: t("Tags (space separated)"), initial: x.tags, placeholder: "work todo", onSubmit: (v) => { api.setTags(x.id, v).catch(fail); } });
  };
  const newBoard = (assignIds?: number[]) => {
    setPrompt({
      title: t("New pinboard"), placeholder: t("Name"),
      onSubmit: async (name) => {
        if (!name.trim()) return;
        try {
          const id = await api.createPinboard(name, BOARD_COLORS[boards.length % BOARD_COLORS.length]);
          if (assignIds?.length) await api.setPinboard(assignIds, id);
          else { setTab(id); resetView(); }
        } catch (e) { fail(e); }
      },
    });
  };
  const mergePrompt = () => {
    const ts = targets();
    if (ts.length < 2) { showToast(t("Select several items first (Shift+↑/↓)")); return; }
    setPrompt({
      title: t("Merge {n} items — separator", { n: ts.length }), initial: "\\n", placeholder: t("\\n = new line, \\t = tab, or any text"),
      onSubmit: async (v) => {
        const sep = v.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        try { await api.mergeItems(ts.map((x) => x.id), sep); setMulti([]); setSel(0); showToast(t("Merged into a new item")); } catch (e) { fail(e); }
      },
    });
  };
  const togglePin = (it?: ClipRow) => {
    const ts = it ? [it] : targets();
    if (!ts.length) return;
    api.setPinned(ts.map((x) => x.id), !ts[0].pinned).catch(fail);
  };
  const applyTransform = async (it: ClipRow, tr: Transform) => {
    try {
      const text = await api.getText(it.id);
      const out = tr.run(text);
      if (out === text) { showToast(t("No change")); return; }
      await api.createTextItem(out);
      setSel(0);
      showToast(t("{label}: new item created", { label: t(tr.label) }));
    } catch (e) { showToast(t("Cannot apply: {e}", { e: errText(e) })); }
  };
  const openPreview = (it?: ClipRow, edit = false, formats = false) => {
    const x = it ?? cur;
    if (x) setPreview({ item: x, edit, formats });
  };

  /** Keyboard / drag reordering. Only meaningful when no search is active. */
  const reorder = (id: number, target: number, after: boolean) => {
    if (query) { showToast(t("Clear the search to reorder items")); return; }
    api.moveItem(id, target, after, tab).catch(fail);
  };

  const openMenu = (it: ClipRow, x: number, y: number) => {
    const idx = items.findIndex((i) => i.id === it.id);
    if (idx >= 0 && !multi.includes(it.id)) { setSel(idx); anchor.current = idx; setMulti([]); }
    const plainDefault = settings?.default_mode === "plain";
    const ids = multi.length > 1 && multi.includes(it.id) ? multi : [it.id];
    const textual = it.kind !== "image" && it.kind !== "file";
    const e: MenuEntry[] = [
      { label: ids.length > 1 ? t("Paste {n} items merged", { n: ids.length }) : t("Paste"), hint: "↵", onClick: () => doPaste("auto", ids.length > 1 ? undefined : it.id) },
      plainDefault
        ? { label: t("Paste with formatting"), hint: "Ctrl+↵", onClick: () => doPaste("rich", it.id) }
        : { label: t("Paste as plain text"), hint: "⇧↵", onClick: () => doPaste("plain", it.id) },
      { label: t("Copy"), hint: "Ctrl+C", onClick: () => doCopy(it) },
      { sep: true },
    ];
    if (it.kind === "link") e.push({ label: t("Open link"), hint: "Ctrl+O", onClick: () => api.openItem(it.id) });
    if (it.kind === "file") {
      e.push({ label: t("Open"), hint: "Ctrl+O", onClick: () => api.openItem(it.id) });
      e.push({ label: t("Show in Explorer"), onClick: () => api.revealItem(it.id) });
    }
    e.push({ label: t("Preview"), hint: "Space", onClick: () => openPreview(it) });
    if (textual) e.push({ label: t("Edit…"), hint: "Ctrl+E", onClick: () => openPreview(it, true) });
    e.push({ label: t("Rename…"), hint: "F2", onClick: () => renameItem(it) });
    e.push({ label: t("Tags…"), hint: "Ctrl+T", onClick: () => tagItem(it) });
    e.push({ label: t("Formats (MIME inspector)"), hint: "Ctrl+I", onClick: () => openPreview(it, false, true) });
    e.push({ sep: true });
    e.push({ label: it.pinned ? t("Unpin from top") : t("Pin on top"), hint: "Ctrl+P", onClick: () => togglePin(it) });
    e.push({ header: true, label: it.pinboard_id ? t("Move to") : t("Pin to") });
    e.push({
      chips: [
        ...boards.map((b) => ({ label: b.name, color: b.color, onClick: () => { api.setPinboard(ids, b.id).catch(fail); } })),
        { label: t("+ New Pinboard"), onClick: () => newBoard(ids) },
      ],
    });
    if (it.pinboard_id) e.push({ label: t("Remove from pinboard"), onClick: () => { api.setPinboard(ids, null).catch(fail); } });
    if (textual) {
      e.push({ sep: true });
      e.push({ label: t("Transform ▸"), submenu: TRANSFORMS.map((tr) => ({ label: `${t(tr.group)} · ${t(tr.label)}`, onClick: () => applyTransform(it, tr) })) });
      if (settings?.actions.length)
        e.push({
          label: t("Actions ▸"),
          submenu: settings.actions.map((a) => ({
            label: a.name,
            onClick: () => { api.runAction(it.id, a.id).then((r) => showToast(r ? t("Action finished: new item") : t("Action finished"))).catch(fail); },
          })),
        });
    }
    if (ids.length > 1) e.push({ label: t("Merge {n} items…", { n: ids.length }), hint: "Ctrl+M", onClick: mergePrompt });
    e.push({ sep: true });
    if (tab !== null) e.push({ label: t("Delete permanently"), danger: true, onClick: () => { api.deleteItems(ids).catch(fail); } });
    else e.push({ label: ids.length > 1 ? t("Delete {n} items", { n: ids.length }) : t("Delete"), hint: "Del", danger: true, onClick: () => { api.deleteItems(ids).catch(fail); } });
    setMenu({ x, y, entries: e });
  };

  const openTabMenu = (b: Pinboard | null, x: number, y: number) => {
    if (!b) {
      setMenu({ x, y, entries: [{ label: t("Erase history…"), danger: true, onClick: askErase }] });
      return;
    }
    setMenu({
      x, y,
      entries: [
        { label: t("Pinboard settings…"), onClick: () => setBoardDlg(b) },
        { sep: true },
        {
          label: t("Delete pinboard…"), danger: true,
          onClick: () => setPrompt({
            title: t('Delete "{name}" and its {n} item(s)?', { name: b.name, n: b.count }), confirm: true, okLabel: t("Delete"),
            onSubmit: () => { api.deletePinboard(b.id).then(() => { if (tab === b.id) { setTab(null); resetView(); } }).catch(fail); },
          }),
        },
      ],
    });
  };

  // ───────────── keyboard ─────────────
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Control") { setCtrl(true); setQuickIds(visibleIds()); return; }
    if (menu) { if (e.key === "Escape") { e.preventDefault(); setMenu(null); } return; }
    const k = e.key;
    const ck = e.ctrlKey || e.metaKey;
    const empty = query === "";
    // In RTL the arrows are mirrored visually, so "next tab" follows the reading direction.
    const rtl = lang === "fa";

    if (ck && /^[1-9]$/.test(k)) {
      e.preventDefault();
      const id = visibleIds()[Number(k) - 1];
      if (id !== undefined) api.pasteItem(id, e.shiftKey ? "plain" : "auto").catch(fail);
      return;
    }
    if (e.altKey && (k === "ArrowUp" || k === "ArrowDown") && cur) {
      e.preventDefault();
      if (k === "ArrowUp" && sel > 0) { reorder(cur.id, items[sel - 1].id, false); setSel(sel - 1); anchor.current = sel - 1; }
      if (k === "ArrowDown" && sel < items.length - 1) { reorder(cur.id, items[sel + 1].id, true); setSel(sel + 1); anchor.current = sel + 1; }
      return;
    }
    if (ck && (k === "]" || k === "[")) { e.preventDefault(); switchTab(k === "]" ? 1 : -1); return; }
    switch (k) {
      case "ArrowDown": e.preventDefault(); move(ck ? items.length - 1 : sel + 1, e.shiftKey && !ck); return;
      case "ArrowUp": e.preventDefault(); move(ck ? 0 : sel - 1, e.shiftKey && !ck); return;
      case "PageDown": e.preventDefault(); move(sel + 5); return;
      case "PageUp": e.preventDefault(); move(sel - 5); return;
      case "Home": if (empty || ck) { e.preventDefault(); move(0); } return;
      case "End": if (empty || ck) { e.preventDefault(); move(items.length - 1); } return;
      case "ArrowLeft": if (empty || e.altKey) { e.preventDefault(); switchTab(rtl ? 1 : -1); } return;
      case "ArrowRight": if (empty || e.altKey) { e.preventDefault(); switchTab(rtl ? -1 : 1); } return;
      case "Tab": e.preventDefault(); switchTab(e.shiftKey ? -1 : 1); return;
      case "Enter": e.preventDefault(); doPaste(e.shiftKey ? "plain" : ck ? "rich" : "auto"); return;
      case " ": if (empty || ck) { e.preventDefault(); openPreview(); } return;
      case "F3": e.preventDefault(); openPreview(); return;
      case "F2": e.preventDefault(); renameItem(); return;
      case "Delete": if (empty || ck) { e.preventDefault(); doDelete(false); } return;
      case "Escape": e.preventDefault(); if (query) { setQuery(""); resetView(); } else api.hidePopup(); return;
    }
    if (ck) {
      const l = k.toLowerCase();
      if (l === "c" && !(window.getSelection()?.toString())) { e.preventDefault(); doCopy(); }
      else if (l === "o" && cur) { e.preventDefault(); api.openItem(cur.id); }
      else if (l === "r") { e.preventDefault(); renameItem(); }
      else if (l === "e" && cur) { e.preventDefault(); openPreview(cur, true); }
      else if (l === "n") { e.preventDefault(); newBoard(); }
      else if (l === "p") { e.preventDefault(); togglePin(); }
      else if (l === "t") { e.preventDefault(); tagItem(); }
      else if (l === "i" && cur) { e.preventDefault(); openPreview(cur, false, true); }
      else if (l === "m") { e.preventDefault(); mergePrompt(); }
      else if (k === ",") { e.preventDefault(); api.openSettings(); }
    }
  };

  const onCardClick = (it: ClipRow, e: React.MouseEvent) => {
    const idx = items.findIndex((i) => i.id === it.id);
    if (e.ctrlKey || e.metaKey) {
      setMulti((m) => { const base = m.length ? m : cur ? [cur.id] : []; return base.includes(it.id) ? base.filter((x) => x !== it.id) : [...base, it.id]; });
      setSel(idx);
      return;
    }
    setSel(idx);
    api.pasteItem(it.id, e.shiftKey ? "plain" : "auto").catch(fail);
  };

  // Card is memoised on its data props, so it receives STABLE handlers that forward to the latest closures.
  const handlers = useRef({
    click: onCardClick, menu: openMenu,
    dragOver: (_: ClipRow, __: boolean) => {}, drop: (_: ClipRow, __: boolean) => {},
  });
  handlers.current = {
    click: onCardClick,
    menu: openMenu,
    dragOver: (it, after) => {
      if (dragId.current === null || dragId.current === it.id || query) return;
      setDropMark((m) => (m && m.id === it.id && m.mark === (after ? "after" : "before") ? m : { id: it.id, mark: after ? "after" : "before" }));
    },
    drop: (it, after) => {
      const id = dragId.current;
      dragId.current = null;
      setDropMark(null);
      if (id !== null && id !== it.id) reorder(id, it.id, after);
    },
  };
  const stableClick = useCallback((it: ClipRow, e: React.MouseEvent) => handlers.current.click(it, e), []);
  const stableMenu = useCallback((it: ClipRow, x: number, y: number) => handlers.current.menu(it, x, y), []);
  const stableDragStart = useCallback((it: ClipRow) => { dragId.current = it.id; }, []);
  const stableDragOver = useCallback((it: ClipRow, after: boolean) => handlers.current.dragOver(it, after), []);
  const stableDrop = useCallback((it: ClipRow, after: boolean) => handlers.current.drop(it, after), []);
  const stableDragEnd = useCallback(() => { dragId.current = null; setDropMark(null); }, []);

  // ───────────── render ─────────────
  const s = settings;
  const lines = s?.card_lines ?? 4;
  const toolbar = s?.show_toolbar && cur;

  return (
    <div className="popup" tabIndex={-1} onKeyDown={onKey} onKeyUp={(e) => { if (e.key === "Control") setCtrl(false); }}>
      <header className="head" data-tauri-drag-region>
        <span className="logo" />
        <span className="brand">ClipNest</span>
        {status && status.paused_until > 0 && <button className="chipbtn warn" onClick={() => api.resume()}>{t("Paused · resume")}</button>}
        {status?.plain_default && <button className="chipbtn" title={t("Plain-text mode (click to turn off)")} onClick={() => api.togglePlain()}>{t("Plain text")}</button>}
        {status?.queue_active && <button className="chipbtn accent" onClick={() => api.queueToggle()}>{t("Queue")} {num(status.queue_len)}</button>}
        <span className="spacer" />
        <button className="iconbtn" title={t("Paste queue")} onClick={() => api.queueToggle()}><Icon name="list" /></button>
        <button className="iconbtn" title={t("Settings (Ctrl+,)")} onClick={() => api.openSettings()}><Icon name="gear" /></button>
        <button className="iconbtn" title={t("Close (Esc)")} onClick={() => api.hidePopup()}><Icon name="close" /></button>
      </header>

      <div className="searchrow">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          dir="auto"
          placeholder={smode === "regex" ? t("Regular expression…") : t("Type to search your clipboard")}
          onChange={(e) => { setQuery(e.target.value); resetView(); }}
        />
        {query && <button className="iconbtn" onClick={() => { setQuery(""); resetView(); }}><Icon name="close" size={12} /></button>}
        <button className={`mini${smode === "regex" ? " on" : ""}`} title={t("Regular expression")} onClick={() => setSmode(smode === "regex" ? "smart" : "regex")}>.*</button>
        <button className={`mini${smode === "fuzzy" ? " on" : ""}`} title={t("Strict fuzzy: letters in order")} onClick={() => setSmode(smode === "fuzzy" ? "smart" : "fuzzy")}>~</button>
      </div>

      <div className="tabs">
        <button
          className={`tab${tab === null ? " active" : ""}`}
          onClick={() => { setTab(null); resetView(); }}
          onContextMenu={(e) => { e.preventDefault(); openTabMenu(null, e.clientX, e.clientY); }}
        >{t("Clipboard")}</button>
        {boards.map((b) => (
          <button
            key={b.id}
            className={`tab${tab === b.id ? " active" : ""}`}
            onClick={() => { setTab(b.id); resetView(); }}
            onContextMenu={(e) => { e.preventDefault(); openTabMenu(b, e.clientX, e.clientY); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = Number(e.dataTransfer.getData("text/clip-id"));
              if (id) {
                const ids = multi.includes(id) ? multi : [id];
                api.setPinboard(ids, b.id).then(() => showToast(t("Pinned to {name}", { name: b.name }))).catch(fail);
              }
            }}
          >
            <span className="dot" style={{ background: b.color }} />{b.name}
          </button>
        ))}
        <button className="tab plus" title={t("New pinboard (Ctrl+N)")} onClick={() => newBoard()}><Icon name="plus" size={12} /></button>
      </div>

      <div className="mainrow">
        <div className="list" ref={listRef}>
          {res.error && <div className="empty err">{res.error}</div>}
          {!res.error && items.length === 0 && (
            <div className="empty">{query ? t("Nothing found") : tab === null ? t("Nothing copied yet") : t("This pinboard is empty — drag cards onto its tab")}</div>
          )}
          {items.map((it, i) => (
            <Card
              key={it.id}
              item={it}
              selected={i === sel}
              multi={multi.includes(it.id)}
              badge={ctrl && quickIds.includes(it.id) ? quickIds.indexOf(it.id) + 1 : null}
              lines={lines}
              now={now}
              lang={lang}
              rich={richOn}
              iconRev={iconRev}
              drop={dropMark && dropMark.id === it.id ? dropMark.mark : null}
              onClick={stableClick}
              onContext={stableMenu}
              onDragStart={stableDragStart}
              onDragOver={stableDragOver}
              onDrop={stableDrop}
              onDragEnd={stableDragEnd}
            />
          ))}
        </div>

        {toolbar && cur && (
          <div className="toolbar">
            <button title={t("Preview")} onClick={() => openPreview()}><Icon name="eye" size={16} /></button>
            <button title={t("Pin on top")} onClick={() => togglePin()}><Icon name="pin" size={16} /></button>
            <button title={t("Tags…")} onClick={() => tagItem()}><Icon name="tag" size={16} /></button>
            <button title={t("Copy")} onClick={() => doCopy()}><Icon name="copy" size={16} /></button>
            <button title={t("Formats (MIME inspector)")} onClick={() => openPreview(cur, false, true)}><Icon name="info" size={16} /></button>
            {cur.kind !== "image" && cur.kind !== "file" && <button title={t("Edit…")} onClick={() => openPreview(cur, true)}><Icon name="edit" size={16} /></button>}
            <button title={t("Merge selected")} onClick={mergePrompt}><Icon name="merge" size={16} /></button>
            <button title={t("Actions ▸")} onClick={(e) => openMenu(cur, e.clientX - 160, e.clientY)}><Icon name="bolt" size={16} /></button>
            <button title={t("Delete")} className="danger" onClick={() => doDelete(false)}><Icon name="trash" size={16} /></button>
          </div>
        )}
      </div>

      <footer className="foot">
        <span>{t(res.total === 1 ? "{n} item" : "{n} items", { n: num(res.total) })}{multi.length > 1 ? ` · ${t("{n} selected", { n: num(multi.length) })}` : ""}</span>
        <button className="iconbtn erase" title={t("Erase history…")} onClick={askErase}><Icon name="trash" size={13} /></button>
        <span className="spacer" />
        <span className="hints"><kbd>↵</kbd> {t("Paste")} <kbd>⇧↵</kbd> {t("Plain text")} <kbd>Del</kbd> {tab === null ? t("Delete") : t("Unpin")}</span>
      </footer>

      {toast && <div className="toast">{toast}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
      {prompt && <Prompt p={prompt} onClose={() => setPrompt(null)} />}
      {boardDlg && (
        <BoardDialog
          board={boardDlg}
          onSave={(name, color, max, style) => { api.updatePinboard(boardDlg.id, name, color, max, style).catch(fail); }}
          onClose={() => setBoardDlg(null)}
        />
      )}
      {preview && (
        <Preview
          item={preview.item}
          startEdit={preview.edit}
          startFormats={preview.formats}
          richDefault={richOn}
          onClose={() => setPreview(null)}
          onPaste={(id, mode) => { setPreview(null); api.pasteItem(id, mode).catch(fail); }}
          onToast={showToast}
        />
      )}
    </div>
  );
}
