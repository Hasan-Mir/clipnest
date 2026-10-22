import React, { memo, useEffect, useState } from "react";
import { api, ClipRow } from "../lib/api";
import { appColor, basename, extOf, hostOf, relTime } from "../lib/format";
import { highlightText, SearchMode } from "../lib/highlightMatch";
import { Lang, t } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { RichView } from "./RichView";

const thumbCache = new Map<number, string | null>();
const iconCache = new Map<string, string | null>();
let lastIconRev = 0;

function Thumb({ id, w, h }: { id: number; w: number | null; h: number | null }) {
  const [src, setSrc] = useState<string | null | undefined>(() => thumbCache.get(id));
  useEffect(() => {
    if (thumbCache.has(id)) {
      setSrc(thumbCache.get(id));
      return;
    }
    let alive = true;
    api
      .getThumb(id)
      .then((s) => {
        if (thumbCache.size > 120) {
          thumbCache.clear();
        }
        thumbCache.set(id, s);
        if (alive) {
          setSrc(s);
        }
      })
      .catch(() => {
        thumbCache.set(id, null);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (src === null) {
    return null;
  }
  return (
    <div className="thumbwrap">
      {src ? <img className="thumb" src={src} alt="" draggable={false} /> : <div className="thumb ph" />}
      {w && h ? <div className="dims">{w}×{h}</div> : null}
    </div>
  );
}

/** Real application icon (extracted from the .exe), with a coloured letter as fallback. */
function AppIcon({ exe, name, rev }: { exe: string; name: string; rev: number }) {
  if (rev !== lastIconRev) {
    lastIconRev = rev;
    iconCache.clear();
  }
  const key = exe.toLowerCase();
  const [src, setSrc] = useState<string | null | undefined>(() => iconCache.get(key));
  useEffect(() => {
    if (!key) {
      return;
    }
    if (iconCache.has(key)) {
      setSrc(iconCache.get(key));
      return;
    }
    let alive = true;
    api
      .getAppIcon(key)
      .then((s) => {
        iconCache.set(key, s);
        if (alive) {
          setSrc(s);
        }
      })
      .catch(() => {
        iconCache.set(key, null);
      });
    return () => {
      alive = false;
    };
  }, [key, rev]);
  if (src) {
    return <img className="appicon" src={src} alt="" draggable={false} />;
  }
  return (
    <span className="appdot" style={{ background: appColor(exe || name) }}>
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

export type DropMark = "before" | "after" | null;

interface Props {
  item: ClipRow;
  selected: boolean;
  multi: boolean;
  badge: number | null;
  lines: number;
  now: number;
  lang: Lang;
  /** show the original styling (HTML) instead of plain text */
  rich: boolean;
  showThumbnails: boolean;
  query: string;
  searchMode: SearchMode;
  highlight: boolean;
  iconRev: number;
  dragging: boolean;
  drop: DropMark;
  onClick: (it: ClipRow, e: React.MouseEvent) => void;
  onDoubleClick: (it: ClipRow, e: React.MouseEvent) => void;
  onContext: (it: ClipRow, x: number, y: number) => void;
  onDragStart: (it: ClipRow, e: React.DragEvent) => void;
  onDragOver: (it: ClipRow, after: boolean) => void;
  onDrop: (it: ClipRow, after: boolean) => void;
  onDragEnd: () => void;
}

function PlainText({
  item,
  lines,
  query,
  searchMode,
  highlight,
}: {
  item: ClipRow;
  lines: number;
  query: string;
  searchMode: SearchMode;
  highlight: boolean;
}) {
  const content = highlightText(item.preview, query, searchMode, highlight);
  if (item.kind === "code") {
    return (
      <pre className="code" dir="ltr" style={{ WebkitLineClamp: lines + 1 } as React.CSSProperties}>
        {content}
      </pre>
    );
  }
  return (
    <div className="text" dir="auto" style={{ WebkitLineClamp: lines }}>
      {content}
    </div>
  );
}

function Body({
  item,
  lines,
  rich,
  showThumbnails,
  query,
  searchMode,
  highlight,
}: {
  item: ClipRow;
  lines: number;
  rich: boolean;
  showThumbnails: boolean;
  query: string;
  searchMode: SearchMode;
  highlight: boolean;
}) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setMissing(false);
  }, [item.id, item.ts, item.has_rich]);

  switch (item.kind) {
    case "link":
      return (
        <>
          <div className="link-host">{highlightText(hostOf(item.preview), query, searchMode, highlight)}</div>
          <div className="link-url">{highlightText(item.preview, query, searchMode, highlight)}</div>
        </>
      );
    case "image":
      if (!showThumbnails) {
        return (
          <div className="text muted" dir="auto">
            🖼 {t("image")} {item.img_w && item.img_h ? `${item.img_w}×${item.img_h}` : ""}
          </div>
        );
      }
      return <Thumb id={item.id} w={item.img_w} h={item.img_h} />;
    case "color":
      return (
        <div className="color-row">
          <span className="swatch" style={{ background: item.color || item.preview }} />
          <span className="mono">{highlightText(item.color || item.preview, query, searchMode, highlight)}</span>
        </div>
      );
    case "file": {
      const paths = item.preview.split("\n").filter(Boolean);
      const shown = paths.slice(0, 3);
      const more = (item.file_count ?? paths.length) - shown.length;
      return (
        <div className="file-card-body">
          {showThumbnails && item.has_thumb && <Thumb id={item.id} w={null} h={null} />}
          <div className="files">
            {shown.map((p, i) => (
              <div key={i} className="file-row">
                <span className="ext">{extOf(basename(p))}</span>
                <span className="fname" dir="auto">
                  {highlightText(basename(p), query, searchMode, highlight)}
                </span>
              </div>
            ))}
            {more > 0 && <div className="muted small">{t("and {n} more", { n: more })}</div>}
          </div>
        </div>
      );
    }
    default:
      if (rich && item.has_rich && !missing) {
        return (
          <RichView
            id={item.id}
            ts={item.ts}
            lines={lines}
            query={query}
            searchMode={searchMode}
            highlight={highlight}
            onMissing={() => setMissing(true)}
          />
        );
      }
      return <PlainText item={item} lines={lines} query={query} searchMode={searchMode} highlight={highlight} />;
  }
}

function CardImpl(p: Props) {
  const {
    item,
    selected,
    multi,
    badge,
    lines,
    now,
    lang,
    rich,
    showThumbnails,
    query,
    searchMode,
    highlight,
    dragging,
    drop,
  } = p;
  return (
    <div
      id={`card-${item.id}`}
      className={`card${selected ? " sel" : ""}${multi ? " multi" : ""}${item.sensitive ? " sensitive" : ""}${
        dragging ? " dragging" : ""
      }${drop ? ` drop-${drop}` : ""}`}
      onClick={(e) => p.onClick(item, e)}
      onDoubleClick={(e) => p.onDoubleClick(item, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onContext(item, e.clientX, e.clientY);
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/clip-id", String(item.id));
        e.dataTransfer.effectAllowed = "move";
        p.onDragStart(item, e);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        p.onDragOver(item, e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        p.onDrop(item, e.clientY > r.top + r.height / 2);
      }}
      onDragEnd={p.onDragEnd}
    >
      <div className="meta">
        <AppIcon exe={item.app_exe} name={item.app_name} rev={p.iconRev} />
        <span className="appname">{highlightText(item.app_name || t("Unknown"), query, searchMode, highlight)}</span>
        <span className="muted">· {relTime(item.ts, now, lang)}</span>
        {item.pinned && (
          <span className="pin" data-tip={t("Pin on top")}>
            <Icon name="pin" size={11} />
          </span>
        )}
        {item.has_rich && (
          <span className="rich" data-tip={t("Keeps original formatting")}>
            RICH
          </span>
        )}
        <span className="spacer" />
        {badge !== null && <span className="badge">Ctrl+{badge}</span>}
        <button
          className="more"
          data-tip={t("More")}
          onClick={(e) => {
            e.stopPropagation();
            p.onContext(item, e.clientX, e.clientY);
          }}
        >
          <Icon name="dots" size={16} />
        </button>
      </div>
      {item.title && (
        <div className="title" dir="auto">
          {highlightText(item.title, query, searchMode, highlight)}
        </div>
      )}
      <div className="body">
        <Body
          item={item}
          lines={lines}
          rich={rich}
          showThumbnails={showThumbnails}
          query={query}
          searchMode={searchMode}
          highlight={highlight}
        />
      </div>
      {item.tags && (
        <div className="tags">
          {item.tags.split(" ").map((x) => (
            <span key={x} className="tag">
              #{highlightText(x, query, searchMode, highlight)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const Card = memo(
  CardImpl,
  (a, b) =>
    a.item === b.item &&
    a.selected === b.selected &&
    a.multi === b.multi &&
    a.badge === b.badge &&
    a.lines === b.lines &&
    a.now === b.now &&
    a.lang === b.lang &&
    a.rich === b.rich &&
    a.showThumbnails === b.showThumbnails &&
    a.query === b.query &&
    a.searchMode === b.searchMode &&
    a.highlight === b.highlight &&
    a.iconRev === b.iconRev &&
    a.dragging === b.dragging &&
    a.drop === b.drop
);
