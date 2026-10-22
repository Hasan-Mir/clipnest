import React, { memo, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { parseCssColor } from "../lib/format";

// ───────────── HTML cache ─────────────
const cache = new Map<number, string | null>();
const inflight = new Map<number, Promise<string | null>>();

async function loadHtml(id: number): Promise<string | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const existing = inflight.get(id);
  if (existing) return existing;
  const p: Promise<string | null> = api.getHtml(id).then((raw) => {
    const clean = raw ? sanitizeHtml(raw) : null;
    if (cache.size > 80) cache.delete(cache.keys().next().value as number);
    cache.set(id, clean);
    inflight.delete(id);
    return clean;
  }).catch(() => { inflight.delete(id); return null; });
  inflight.set(id, p);
  return p;
}

export function forgetHtml(id: number) { cache.delete(id); }

// ───────────── sanitiser ─────────────
// The HTML comes from other applications, so it is parsed inertly (DOMParser never runs scripts) and
// stripped of anything active or networked. What remains is only structure + inline/embedded styling.

const REMOVE = "script,iframe,frame,frameset,object,embed,applet,link,meta,base,form,input,button,textarea,select,noscript,audio,video,source,track,portal,template";

function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "none")
    .replace(/url\(\s*(?!['"]?\s*data:image\/)[^)]*\)/gi, "none"); // no remote loads (privacy/tracking)
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(REMOVE).forEach((e) => e.remove());
  doc.querySelectorAll("style").forEach((st) => { st.textContent = cleanCss(st.textContent || ""); });
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || n === "href" || n === "xlink:href" || n === "srcset" || n === "action" || n === "formaction" || n === "poster" || n === "background") {
        el.removeAttribute(attr.name);
      } else if (n === "src" && !/^\s*data:image\//i.test(attr.value)) {
        el.removeAttribute(attr.name);
      } else if (n === "style") {
        el.setAttribute("style", cleanCss(attr.value));
      }
    }
  });
  const styles = Array.from(doc.head.querySelectorAll("style")).map((s) => s.outerHTML).join("");
  return styles + doc.body.innerHTML;
}

// ───────────── background ("paper") choice ─────────────
// Pages copied from the web often carry dark text and no background. On a dark list that would be
// unreadable, so such content gets a light paper (and light text gets a dark one). Content that defines
// its own background (VS Code, Word…) is shown untouched, exactly as it was copied.
function pickPaper(html: string): string | null {
  if (/background(-color)?\s*:/i.test(html) || /\sbgcolor=/i.test(html)) return null;
  const cols = Array.from(html.matchAll(/(?:^|[;\s"'])color\s*:\s*([^;"'>]+)/gi)).slice(0, 40).map((m) => parseCssColor(m[1].trim()));
  const ok = cols.filter((c): c is [number, number, number, number] => !!c);
  if (!ok.length) return null;
  const lum = ok.reduce((a, c) => a + (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255, 0) / ok.length;
  return lum > 0.6 ? "#1e1e1e" : "#ffffff";
}

const BASE_CSS = `
  :host { display: block; overflow: hidden; line-height: 1.35; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { pointer-events: none; }
  * { cursor: inherit; }
`;

interface Props {
  id: number;
  lines: number;
  full?: boolean;
  /** called when there is no HTML after all (so the caller can fall back to plain text) */
  onMissing?: () => void;
}

export const RichView = memo(function RichView({ id, lines, full, onMissing }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">(cache.has(id) ? (cache.get(id) ? "ok" : "none") : "loading");
  const [paper, setPaper] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadHtml(id).then((html) => {
      if (!alive) return;
      if (!html || !host.current) { setState("none"); onMissing?.(); return; }
      const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${BASE_CSS}</style>${html}`;
      setPaper(pickPaper(html));
      setState("ok");
    });
    return () => { alive = false; };
  }, [id]);

  if (state === "none") return null;
  const style: React.CSSProperties = {
    ["--rl" as any]: lines,
    maxHeight: full ? undefined : `calc(var(--rl) * 1.5em + 6px)`,
    overflow: full ? "auto" : "hidden",
    background: paper ?? undefined,
    color: paper === "#ffffff" ? "#1a1a1a" : paper ? "#f0f0f0" : undefined,
    padding: paper ? "6px 8px" : undefined,
    borderRadius: paper ? 6 : undefined,
    visibility: state === "loading" ? "hidden" : "visible",
    minHeight: state === "loading" ? 18 : undefined,
  };
  return <div ref={host} className="rich-host" style={style} dir="auto" />;
});
