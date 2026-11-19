//! SQLite storage. WAL + synchronous=FULL means every committed clip has been fsync'ed
//! to disk before we report success, so a power cut can never lose a completed capture.

use crate::state::Settings;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ───────────────────────────── models ─────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct ClipRow {
    pub id: i64,
    pub kind: String,
    pub title: Option<String>,
    pub preview: String,
    pub app_name: String,
    pub app_exe: String,
    pub tags: String,
    pub lang: Option<String>,
    pub img_w: Option<i64>,
    pub img_h: Option<i64>,
    pub color: Option<String>,
    pub chars: i64,
    pub file_count: Option<i64>,
    pub pinboard_id: Option<i64>,
    pub pinned: bool,
    pub sensitive: bool,
    pub has_rich: bool,
    pub ts: i64,
    pub created_at: i64,
    pub has_thumb: bool,
    #[serde(default)]
    pub cut: bool,
}

pub const ROW_COLS: &str = "id,kind,title,preview,app_name,app_exe,tags,lang,img_w,img_h,color,chars,file_count,pinboard_id,pinned,sensitive,has_rich,ts,created_at,(thumb IS NOT NULL)";

pub fn row_from(r: &Row) -> rusqlite::Result<ClipRow> {
    Ok(ClipRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        preview: r.get(3)?,
        app_name: r.get(4)?,
        app_exe: r.get(5)?,
        tags: r.get(6)?,
        lang: r.get(7)?,
        img_w: r.get(8)?,
        img_h: r.get(9)?,
        color: r.get(10)?,
        chars: r.get(11)?,
        file_count: r.get(12)?,
        pinboard_id: r.get(13)?,
        pinned: r.get::<_, i64>(14)? != 0,
        sensitive: r.get::<_, i64>(15)? != 0,
        has_rich: r.get::<_, i64>(16)? != 0,
        ts: r.get(17)?,
        created_at: r.get(18)?,
        has_thumb: r.get::<_, i64>(19)? != 0,
        cut: false,
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Pinboard {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub count: i64,
    pub max_items: i64,
    pub list_style: String,
    pub paste_mode: String,
}

use serde::Deserialize;

#[derive(Serialize, Clone, Debug)]
pub struct FormatMeta {
    pub name: String,
    pub mime: String,
    pub size: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct AppInfo {
    pub exe: String,
    pub name: String,
}

pub struct NewClip {
    pub hash: String,
    pub kind: String,
    pub plain: String,
    pub preview: String,
    pub search: String,
    pub app_name: String,
    pub app_exe: String,
    pub lang: Option<String>,
    pub img_w: Option<i64>,
    pub img_h: Option<i64>,
    pub color: Option<String>,
    pub chars: i64,
    pub file_count: Option<i64>,
    pub sensitive: bool,
    pub has_rich: bool,
    pub expires_at: Option<i64>,
    pub thumb: Option<Vec<u8>>,
}

pub struct StoredFormat {
    pub fmt_id: u32,
    pub name: String,
    pub data: Vec<u8>,
}

pub fn mime_for(name: &str) -> String {
    match name {
        "CF_UNICODETEXT" | "CF_TEXT" => "text/plain".into(),
        "HTML Format" => "text/html".into(),
        "Rich Text Format" | "Rich Text Format Without Objects" => "text/rtf".into(),
        "PNG" => "image/png".into(),
        "CF_DIB" | "CF_DIBV5" => "image/bmp".into(),
        "CF_HDROP" => "text/uri-list".into(),
        "vscode-editor-data" => "application/vscode-editor-data".into(),
        other => format!("application/x-{}", other.to_lowercase().replace(' ', "-")),
    }
}

// ───────────────────────────── open / schema ─────────────────────────────

const PRAGMAS: &str =
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pinboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f8cff',
  position INTEGER NOT NULL DEFAULT 0,
  max_items INTEGER NOT NULL DEFAULT 0,
  list_style TEXT NOT NULL DEFAULT 'inherit',
  paste_mode TEXT NOT NULL DEFAULT 'inherit',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_icons (exe TEXT PRIMARY KEY, png BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  tags TEXT NOT NULL DEFAULT '',
  app_name TEXT NOT NULL DEFAULT '',
  app_exe TEXT NOT NULL DEFAULT '',
  lang TEXT,
  img_w INTEGER,
  img_h INTEGER,
  color TEXT,
  chars INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER,
  pinboard_id INTEGER REFERENCES pinboards(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0,
  has_rich INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  sort_ts REAL NOT NULL DEFAULT 0,
  -- heavy columns last: metadata scans (search, apps list) never read overflow pages
  preview TEXT NOT NULL DEFAULT '',
  search TEXT NOT NULL DEFAULT '',
  plain TEXT NOT NULL DEFAULT '',
  thumb BLOB
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_hash ON clips(hash);
CREATE INDEX IF NOT EXISTS idx_clips_order ON clips(pinned DESC, sort_ts DESC);
CREATE INDEX IF NOT EXISTS idx_clips_board ON clips(pinboard_id, sort_ts DESC);
CREATE TABLE IF NOT EXISTS clip_categories (
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  board_id INTEGER NOT NULL REFERENCES pinboards(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_ts REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (clip_id, board_id)
);
CREATE INDEX IF NOT EXISTS idx_clip_categories_board ON clip_categories(board_id, pinned DESC, sort_ts DESC);
CREATE TABLE IF NOT EXISTS clip_formats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  fmt_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_formats_clip ON clip_formats(clip_id);
INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','2');
";

fn has_column(conn: &Connection, table: &str, col: &str) -> bool {
    conn.query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name=?1"), params![col], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// Upgrades a database created by an older build (no-op for fresh databases).
pub fn migrate(conn: &Connection) {
    let clips_exist: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='clips'", [], |r| r.get(0))
        .unwrap_or(0);
    if clips_exist > 0 && !has_column(conn, "clips", "sort_ts") {
        let _ = conn.execute_batch(
            "DROP INDEX IF EXISTS idx_clips_order;
             DROP INDEX IF EXISTS idx_clips_board;
             ALTER TABLE clips ADD COLUMN sort_ts REAL NOT NULL DEFAULT 0;
             UPDATE clips SET sort_ts=ts;",
        );
    }
    let pb_exist: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pinboards'", [], |r| r.get(0))
        .unwrap_or(0);
    if pb_exist > 0 && !has_column(conn, "pinboards", "max_items") {
        let _ = conn.execute_batch(
            "ALTER TABLE pinboards ADD COLUMN max_items INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE pinboards ADD COLUMN list_style TEXT NOT NULL DEFAULT 'inherit';",
        );
    }
    if pb_exist > 0 && !has_column(conn, "pinboards", "paste_mode") {
        let _ = conn.execute_batch("ALTER TABLE pinboards ADD COLUMN paste_mode TEXT NOT NULL DEFAULT 'inherit';");
    }
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clip_categories (
           clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
           board_id INTEGER NOT NULL REFERENCES pinboards(id) ON DELETE CASCADE,
           pinned INTEGER NOT NULL DEFAULT 0,
           sort_ts REAL NOT NULL DEFAULT 0,
           PRIMARY KEY (clip_id, board_id)
         );
         CREATE INDEX IF NOT EXISTS idx_clip_categories_board ON clip_categories(board_id, pinned DESC, sort_ts DESC);",
    );
    if clips_exist > 0 && pb_exist > 0 {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO clip_categories(clip_id, board_id, pinned, sort_ts)
             SELECT id, pinboard_id, 0, sort_ts FROM clips WHERE pinboard_id IS NOT NULL",
            [],
        );
    }
}

fn try_open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(PRAGMAS).map_err(|e| e.to_string())?;
    let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if ok != "ok" {
        return Err(format!("integrity check failed: {ok}"));
    }
    migrate(&conn);
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Opens the database. If it is corrupt, the broken file is set aside and the newest
/// daily backup is restored.
pub fn open_with_recovery(dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("clipnest.db");
    match try_open(&path) {
        Ok(c) => Ok(c),
        Err(e) => {
            eprintln!("database problem: {e}; trying to recover");
            if path.exists() {
                let bad = dir.join(format!("clipnest.corrupt-{}.db", now_ms()));
                let _ = std::fs::rename(&path, &bad);
            }
            let _ = std::fs::remove_file(dir.join("clipnest.db-wal"));
            let _ = std::fs::remove_file(dir.join("clipnest.db-shm"));
            let _ = restore_latest_backup(dir, &path);
            try_open(&path)
        }
    }
}

// ───────────────────────────── backup ─────────────────────────────

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn today_string() -> String {
    let (y, m, d) = civil_from_days(now_ms() / 86_400_000);
    format!("{y:04}{m:02}{d:02}")
}

fn backup_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

fn list_backups(data_dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(backup_dir(data_dir))
        .map(|rd| {
            rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(".db.gz")).collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Writes `bytes` to `path` crash-safely: temp file, fsync, then atomic rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Consistent snapshot (VACUUM INTO) compressed with gzip, streamed (no big RAM buffer).
/// The DB lock is held only for the snapshot itself, never during compression.
/// Keeps the newest `keep` files.
pub fn backup(db: &parking_lot::Mutex<Connection>, data_dir: &Path, keep: u32) -> Result<PathBuf, String> {
    let dir = backup_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("clipnest-{}.db", today_string());
    let tmp = dir.join(format!("{name}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    {
        let conn = db.lock();
        conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy().to_string()]).map_err(|e| e.to_string())?;
    }
    let out = dir.join(format!("{name}.gz"));
    let part = dir.join(format!("{name}.gz.part"));
    {
        let mut src = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
        let dst = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut enc = flate2::write::GzEncoder::new(dst, flate2::Compression::fast());
        std::io::copy(&mut src, &mut enc).map_err(|e| e.to_string())?;
        let dst = enc.finish().map_err(|e| e.to_string())?;
        dst.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    let all = list_backups(data_dir);
    let keep = keep.max(1) as usize;
    if all.len() > keep {
        for p in &all[..all.len() - keep] {
            let _ = std::fs::remove_file(p);
        }
    }
    let _ = db.lock().execute(
        "INSERT INTO meta(key,value) VALUES('last_backup',?1) ON CONFLICT(key) DO UPDATE SET value=?1",
        params![today_string()],
    );
    Ok(out)
}

pub fn backup_due(conn: &Connection) -> bool {
    let last: Option<String> =
        conn.query_row("SELECT value FROM meta WHERE key='last_backup'", [], |r| r.get(0)).optional().ok().flatten();
    last.map(|l| l != today_string()).unwrap_or(true)
}

fn restore_latest_backup(data_dir: &Path, target: &Path) -> Result<(), String> {
    let newest = list_backups(data_dir).pop().ok_or("no backups")?;
    let gz = std::fs::read(&newest).map_err(|e| e.to_string())?;
    let mut dec = flate2::read::GzDecoder::new(&gz[..]);
    let mut raw = Vec::new();
    dec.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    write_atomic(target, &raw).map_err(|e| e.to_string())
}

// ───────────────────────────── clips ─────────────────────────────

pub fn insert_clip(conn: &mut Connection, c: &NewClip, fmts: &[StoredFormat]) -> Result<(i64, bool), String> {
    let now = now_ms();
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM clips WHERE hash=?1", params![c.hash], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE clips SET ts=?1, sort_ts=?1, app_name=?2, app_exe=?3, sensitive=?4, expires_at=?5, thumb=COALESCE(?6, thumb) WHERE id=?7",
            params![now, c.app_name, c.app_exe, c.sensitive as i64, c.expires_at, c.thumb, id],
        )
        .map_err(|e| e.to_string())?;
        // Same text copied again, now WITH styling (HTML/RTF/VS Code): upgrade the stored formats.
        if c.has_rich && !fmts.is_empty() {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM clip_formats WHERE clip_id=?1", params![id]).map_err(|e| e.to_string())?;
            for f in fmts {
                tx.execute(
                    "INSERT INTO clip_formats(clip_id,fmt_id,name,size,data) VALUES(?1,?2,?3,?4,?5)",
                    params![id, f.fmt_id, f.name, f.data.len() as i64, f.data],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.execute(
                "UPDATE clips SET has_rich=1, lang=COALESCE(?1,lang), kind=CASE WHEN ?1 IS NOT NULL THEN ?2 ELSE kind END WHERE id=?3",
                params![c.lang, c.kind, id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        return Ok((id, false));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO clips(hash,kind,plain,preview,search,app_name,app_exe,lang,img_w,img_h,color,chars,file_count,sensitive,has_rich,expires_at,thumb,created_at,ts,sort_ts)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18,?18)",
        params![
            c.hash, c.kind, c.plain, c.preview, c.search, c.app_name, c.app_exe, c.lang, c.img_w, c.img_h,
            c.color, c.chars, c.file_count, c.sensitive as i64, c.has_rich as i64, c.expires_at, c.thumb, now
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    for f in fmts {
        tx.execute(
            "INSERT INTO clip_formats(clip_id,fmt_id,name,size,data) VALUES(?1,?2,?3,?4,?5)",
            params![id, f.fmt_id, f.name, f.data.len() as i64, f.data],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((id, true))
}

pub fn get_row(conn: &Connection, id: i64) -> Option<ClipRow> {
    conn.query_row(&format!("SELECT {ROW_COLS} FROM clips WHERE id=?1"), params![id], row_from)
        .optional()
        .ok()
        .flatten()
}

pub fn get_plain(conn: &Connection, id: i64) -> Option<(String, String)> {
    conn.query_row("SELECT kind, plain FROM clips WHERE id=?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .ok()
        .flatten()
}

pub fn get_board_paste_mode(conn: &Connection, clip_id: i64) -> Option<String> {
    conn.query_row(
        "SELECT p.paste_mode FROM clips c JOIN pinboards p ON p.id = c.pinboard_id WHERE c.id = ?1",
        params![clip_id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn get_formats(conn: &Connection, id: i64) -> Vec<StoredFormat> {
    let mut stmt = match conn.prepare("SELECT fmt_id,name,data FROM clip_formats WHERE clip_id=?1 ORDER BY id") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map(params![id], |r| {
        Ok(StoredFormat { fmt_id: r.get::<_, i64>(0)? as u32, name: r.get(1)?, data: r.get(2)? })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => vec![],
    }
}

pub fn get_format_metas(conn: &Connection, id: i64) -> Vec<FormatMeta> {
    let mut stmt = match conn.prepare("SELECT name,size FROM clip_formats WHERE clip_id=?1 ORDER BY id") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map(params![id], |r| {
        let name: String = r.get(0)?;
        Ok(FormatMeta { mime: mime_for(&name), name, size: r.get(1)? })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => vec![],
    }
}

pub fn get_format_data(conn: &Connection, id: i64, name: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT data FROM clip_formats WHERE clip_id=?1 AND name=?2 LIMIT 1", params![id, name], |r| {
        r.get(0)
    })
    .optional()
    .ok()
    .flatten()
}

pub fn get_thumb(conn: &Connection, id: i64) -> Option<Vec<u8>> {
    conn.query_row("SELECT thumb FROM clips WHERE id=?1", params![id], |r| r.get::<_, Option<Vec<u8>>>(0))
        .optional()
        .ok()
        .flatten()
        .flatten()
}

pub fn touch(conn: &Connection, id: i64) {
    let now = now_ms();
    let _ = conn.execute("UPDATE clips SET ts=?1, sort_ts=?1 WHERE id=?2", params![now, id]);
    let _ = conn.execute("UPDATE clip_categories SET sort_ts=?1 WHERE clip_id=?2", params![now as f64, id]);
}

pub fn delete_ids(conn: &mut Connection, ids: &[i64]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in ids {
        tx.execute("DELETE FROM clips WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn rename(conn: &Connection, id: i64, title: &str) -> Result<(), String> {
    let t = title.trim();
    let v: Option<&str> = if t.is_empty() { None } else { Some(t) };
    conn.execute("UPDATE clips SET title=?1 WHERE id=?2", params![v, id]).map(|_| ()).map_err(|e| e.to_string())
}

pub fn set_tags(conn: &Connection, id: i64, tags: &str) -> Result<(), String> {
    let norm: Vec<String> = tags
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(|t| t.trim_start_matches('#').to_string())
        .collect();
    conn.execute("UPDATE clips SET tags=?1 WHERE id=?2", params![norm.join(" "), id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Assigns `ids` to a category (`board = Some(bid)`) or removes them (`board = None`).
/// - When `copy == true` (e.g. from the main Clipboard tab, or holding Ctrl inside a Category tab),
///   the items are added to `board` while keeping any existing category memberships.
/// - When `copy == false` and `source_board == Some(src)`, the items are moved from `src` to `board`.
/// - When `copy == false` and `source_board == None`, the items' category membership is replaced with `board`.
pub fn assign_category(
    conn: &Connection,
    ids: &[i64],
    board: Option<i64>,
    source_board: Option<i64>,
    copy: bool,
) -> Result<(), String> {
    for id in ids {
        let sort_ts: f64 = conn
            .query_row("SELECT sort_ts FROM clips WHERE id=?1", params![id], |r| r.get(0))
            .unwrap_or(now_ms() as f64);
        match board {
            Some(bid) => {
                if !copy {
                    if let Some(src) = source_board {
                        if src != bid {
                            let _ = conn.execute(
                                "DELETE FROM clip_categories WHERE clip_id=?1 AND board_id=?2",
                                params![id, src],
                            );
                        }
                    } else {
                        let _ = conn.execute("DELETE FROM clip_categories WHERE clip_id=?1", params![id]);
                    }
                }
                conn.execute(
                    "INSERT INTO clip_categories(clip_id, board_id, pinned, sort_ts) VALUES(?1, ?2, 0, ?3)
                     ON CONFLICT(clip_id, board_id) DO UPDATE SET sort_ts=excluded.sort_ts",
                    params![id, bid, sort_ts],
                )
                .map_err(|e| e.to_string())?;
                conn.execute("UPDATE clips SET pinboard_id=?1 WHERE id=?2", params![Some(bid), id])
                    .map_err(|e| e.to_string())?;
            }
            None => {
                if let Some(src) = source_board {
                    let _ =
                        conn.execute("DELETE FROM clip_categories WHERE clip_id=?1 AND board_id=?2", params![id, src]);
                } else {
                    let _ = conn.execute("DELETE FROM clip_categories WHERE clip_id=?1", params![id]);
                }
                let remaining: Option<i64> = conn
                    .query_row("SELECT board_id FROM clip_categories WHERE clip_id=?1 LIMIT 1", params![id], |r| {
                        r.get(0)
                    })
                    .optional()
                    .ok()
                    .flatten();
                conn.execute("UPDATE clips SET pinboard_id=?1 WHERE id=?2", params![remaining, id])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    if let Some(b) = board {
        trim_board(conn, b);
    }
    Ok(())
}

pub fn set_pinboard(conn: &Connection, ids: &[i64], board: Option<i64>) -> Result<(), String> {
    assign_category(conn, ids, board, None, false)
}

/// Sets the pinned status of `ids`.
/// - When `independent` is `true` (default):
///   - If `board` is `Some(bid)`, only pins/unpins inside category `bid` (`clip_categories.pinned`).
///   - If `board` is `None`, only pins/unpins in the main Clipboard tab (`clips.pinned`).
/// - When `independent` is `false`:
///   - Pins/unpins across both the main Clipboard tab (`clips.pinned`) and all categories (`clip_categories.pinned`).
pub fn set_pinned_scoped(
    conn: &Connection,
    ids: &[i64],
    pinned: bool,
    board: Option<i64>,
    independent: bool,
) -> Result<(), String> {
    let pval = pinned as i64;
    for id in ids {
        if independent {
            if let Some(bid) = board {
                conn.execute(
                    "UPDATE clip_categories SET pinned=?1 WHERE clip_id=?2 AND board_id=?3",
                    params![pval, id, bid],
                )
                .map_err(|e| e.to_string())?;
            } else {
                conn.execute("UPDATE clips SET pinned=?1 WHERE id=?2", params![pval, id]).map_err(|e| e.to_string())?;
            }
        } else {
            conn.execute("UPDATE clips SET pinned=?1 WHERE id=?2", params![pval, id]).map_err(|e| e.to_string())?;
            conn.execute("UPDATE clip_categories SET pinned=?1 WHERE clip_id=?2", params![pval, id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn set_pinned(conn: &Connection, ids: &[i64], pinned: bool) -> Result<(), String> {
    set_pinned_scoped(conn, ids, pinned, None, true)
}

pub fn get_rows(conn: &Connection, ids: &[i64]) -> Vec<ClipRow> {
    ids.iter().filter_map(|id| get_row(conn, *id)).collect()
}

// ───────────────────────────── categories (pinboards) ─────────────────────────────

pub fn list_pinboards(conn: &Connection) -> Result<Vec<Pinboard>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id,p.name,p.color,p.position,
                    (SELECT COUNT(*) FROM clip_categories cc WHERE cc.board_id=p.id),
                    p.max_items,p.list_style,p.paste_mode
             FROM pinboards p ORDER BY p.position, p.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Pinboard {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                position: r.get(3)?,
                count: r.get(4)?,
                max_items: r.get(5)?,
                list_style: r.get(6)?,
                paste_mode: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_pinboard(conn: &Connection, name: &str, color: &str) -> Result<i64, String> {
    let pos: i64 = conn.query_row("SELECT COALESCE(MAX(position),0)+1 FROM pinboards", [], |r| r.get(0)).unwrap_or(1);
    conn.execute(
        "INSERT INTO pinboards(name,color,position,created_at) VALUES(?1,?2,?3,?4)",
        params![name.trim(), color, pos, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn update_pinboard(
    conn: &Connection,
    id: i64,
    name: &str,
    color: &str,
    max_items: i64,
    list_style: &str,
    paste_mode: &str,
) -> Result<(), String> {
    let style = if matches!(list_style, "rich" | "plain") { list_style } else { "inherit" };
    let pmode = if matches!(paste_mode, "rich" | "plain") { paste_mode } else { "inherit" };
    conn.execute(
        "UPDATE pinboards SET name=?1,color=?2,max_items=?3,list_style=?4,paste_mode=?5 WHERE id=?6",
        params![name.trim(), color, max_items.max(0), style, pmode, id],
    )
    .map_err(|e| e.to_string())?;
    trim_board(conn, id);
    Ok(())
}

/// Per-category item limit: the oldest items beyond the limit are removed.
pub fn trim_board(conn: &Connection, board: i64) {
    let max: i64 =
        conn.query_row("SELECT max_items FROM pinboards WHERE id=?1", params![board], |r| r.get(0)).unwrap_or(0);
    if max > 0 {
        let overflow_ids: Vec<i64> = conn
            .prepare(
                "SELECT clip_id FROM clip_categories WHERE board_id=?1 ORDER BY pinned DESC, sort_ts DESC LIMIT -1 OFFSET ?2",
            )
            .and_then(|mut st| {
                let rows = st.query_map(params![board, max], |r| r.get::<_, i64>(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        for cid in overflow_ids {
            let _ = conn.execute("DELETE FROM clip_categories WHERE clip_id=?1 AND board_id=?2", params![cid, board]);
            let remaining: Option<i64> = conn
                .query_row("SELECT board_id FROM clip_categories WHERE clip_id=?1 LIMIT 1", params![cid], |r| r.get(0))
                .optional()
                .ok()
                .flatten();
            if let Some(other_board) = remaining {
                let _ = conn.execute(
                    "UPDATE clips SET pinboard_id=?1 WHERE id=?2 AND pinboard_id=?3",
                    params![other_board, cid, board],
                );
            } else {
                let _ = conn.execute("DELETE FROM clips WHERE id=?1 AND pinboard_id=?2", params![cid, board]);
            }
        }
    }
}

pub fn delete_pinboard(conn: &Connection, id: i64) -> Result<(), String> {
    // Remove membership in this category first, and re-point `clips.pinboard_id` for any clip
    // that still belongs to another category so `ON DELETE CASCADE` never deletes shared clips.
    // Wrap in a savepoint so intermediate failures never leave orphaned or corrupted category links.
    conn.execute("SAVEPOINT del_pb", []).map_err(|e| e.to_string())?;
    let res = (|| -> Result<(), String> {
        conn.execute("DELETE FROM clip_categories WHERE board_id=?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clips
             SET pinboard_id = (SELECT cc.board_id FROM clip_categories cc WHERE cc.clip_id = clips.id LIMIT 1)
             WHERE pinboard_id = ?1
               AND EXISTS (SELECT 1 FROM clip_categories cc WHERE cc.clip_id = clips.id)",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM pinboards WHERE id=?1", params![id]).map(|_| ()).map_err(|e| e.to_string())
    })();
    match res {
        Ok(()) => {
            let _ = conn.execute("RELEASE SAVEPOINT del_pb", []);
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK TO SAVEPOINT del_pb", []);
            let _ = conn.execute("RELEASE SAVEPOINT del_pb", []);
            Err(e)
        }
    }
}

// ───────────────────────────── retention ─────────────────────────────

pub fn apply_limits(conn: &Connection, s: &Settings) -> Result<(), String> {
    if s.retention_days > 0 {
        let cutoff = now_ms() - (s.retention_days as i64) * 86_400_000;
        conn.execute(
            "DELETE FROM clips WHERE pinned=0 AND pinboard_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM clip_categories cc WHERE cc.clip_id=clips.id)
             AND ts<?1",
            params![cutoff],
        )
        .map_err(|e| e.to_string())?;
    }
    if s.max_items > 0 {
        conn.execute(
            "DELETE FROM clips WHERE id IN (
               SELECT id FROM clips WHERE pinned=0 AND pinboard_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM clip_categories cc WHERE cc.clip_id=clips.id)
               ORDER BY sort_ts DESC LIMIT -1 OFFSET ?1)",
            params![s.max_items as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn delete_expired(conn: &Connection) -> usize {
    conn.execute("DELETE FROM clips WHERE expires_at IS NOT NULL AND expires_at<?1", params![now_ms()]).unwrap_or(0)
}

/// Erases clipboard history according to the selected scope and pinned-items option.
pub fn erase_history(
    conn: &Connection,
    include_pinned: bool,
    target_pinboard: Option<i64>,
    all_pinboards: bool,
) -> Result<usize, String> {
    if all_pinboards {
        if include_pinned {
            conn.execute("DELETE FROM clips", []).map_err(|e| e.to_string())
        } else {
            conn.execute(
                "DELETE FROM clips WHERE pinned=0
                 AND NOT EXISTS (SELECT 1 FROM clip_categories cc WHERE cc.clip_id=clips.id AND cc.pinned<>0)",
                [],
            )
            .map_err(|e| e.to_string())
        }
    } else if let Some(board_id) = target_pinboard {
        let target_ids: Vec<i64> = {
            let sql = if include_pinned {
                "SELECT clip_id FROM clip_categories WHERE board_id=?1"
            } else {
                "SELECT cc.clip_id FROM clip_categories cc JOIN clips c ON c.id=cc.clip_id
                 WHERE cc.board_id=?1 AND cc.pinned=0 AND c.pinned=0"
            };
            let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = st.query_map(params![board_id], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut count = 0usize;
        for cid in target_ids {
            let _ =
                conn.execute("DELETE FROM clip_categories WHERE clip_id=?1 AND board_id=?2", params![cid, board_id]);
            let remaining: Option<i64> = conn
                .query_row("SELECT board_id FROM clip_categories WHERE clip_id=?1 LIMIT 1", params![cid], |r| r.get(0))
                .optional()
                .ok()
                .flatten();
            if let Some(other_board) = remaining {
                let _ = conn.execute("UPDATE clips SET pinboard_id=?1 WHERE id=?2", params![other_board, cid]);
            } else {
                let _ = conn.execute("DELETE FROM clips WHERE id=?1", params![cid]);
            }
            count += 1;
        }
        Ok(count)
    } else if include_pinned {
        conn.execute(
            "DELETE FROM clips WHERE pinboard_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM clip_categories cc WHERE cc.clip_id=clips.id)",
            [],
        )
        .map_err(|e| e.to_string())
    } else {
        conn.execute(
            "DELETE FROM clips WHERE pinned=0 AND pinboard_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM clip_categories cc WHERE cc.clip_id=clips.id)",
            [],
        )
        .map_err(|e| e.to_string())
    }
}

pub fn recent_apps(conn: &Connection) -> Vec<AppInfo> {
    let mut stmt = match conn.prepare(
        "SELECT app_exe, app_name, MAX(ts) m FROM clips WHERE app_exe<>'' GROUP BY app_exe ORDER BY m DESC LIMIT 30",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map([], |r| Ok(AppInfo { exe: r.get::<_, String>(0)?.to_lowercase(), name: r.get(1)? }));
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => vec![],
    }
}

// ───────────────────────────── manual ordering ─────────────────────────────

/// Moves `id` directly above (`after=false`) or below (`after=true`) `target`, inside the current
/// view (`scope` = category id, or None for the whole history). Uses a fractional sort key so only
/// one row is written.
pub fn move_item(conn: &Connection, id: i64, target: i64, after: bool, scope: Option<i64>) -> Result<(), String> {
    if id == target {
        return Ok(());
    }
    if let Some(bid) = scope {
        let (_, t_pinned): (f64, i64) = conn
            .query_row(
                "SELECT sort_ts, pinned FROM clip_categories WHERE clip_id=?1 AND board_id=?2",
                params![target, bid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        // Normalize sort_ts if any two items in this category+pinned group share the same sort_ts
        let dup_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) - COUNT(DISTINCT sort_ts) FROM clip_categories WHERE board_id=?1 AND pinned=?2",
                params![bid, t_pinned],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if dup_count > 0 {
            let ordered_ids: Vec<i64> = conn
                .prepare("SELECT clip_id FROM clip_categories WHERE board_id=?1 AND pinned=?2 ORDER BY sort_ts DESC, clip_id DESC")
                .and_then(|mut st| {
                    let rows = st.query_map(params![bid, t_pinned], |r| r.get::<_, i64>(0))?;
                    Ok(rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();
            let base = now_ms() as f64;
            for (idx, cid) in ordered_ids.iter().enumerate() {
                let _ = conn.execute(
                    "UPDATE clip_categories SET sort_ts=?1 WHERE board_id=?2 AND clip_id=?3",
                    params![base - (idx as f64) * 1000.0, bid, cid],
                );
            }
        }
        let t_sort: f64 = conn
            .query_row(
                "SELECT sort_ts FROM clip_categories WHERE clip_id=?1 AND board_id=?2",
                params![target, bid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let neighbour: Option<f64> = if after {
            conn.query_row(
                "SELECT MAX(sort_ts) FROM clip_categories WHERE board_id=?1 AND pinned=?2 AND sort_ts<?3 AND clip_id<>?4",
                params![bid, t_pinned, t_sort, id],
                |r| r.get(0),
            )
        } else {
            conn.query_row(
                "SELECT MIN(sort_ts) FROM clip_categories WHERE board_id=?1 AND pinned=?2 AND sort_ts>?3 AND clip_id<>?4",
                params![bid, t_pinned, t_sort, id],
                |r| r.get(0),
            )
        }
        .map_err(|e| e.to_string())?;
        let new = match (after, neighbour) {
            (true, Some(lo)) => (t_sort + lo) / 2.0,
            (true, None) => t_sort - 1000.0,
            (false, Some(hi)) => (t_sort + hi) / 2.0,
            (false, None) => t_sort + 1000.0,
        };
        return conn
            .execute(
                "UPDATE clip_categories SET sort_ts=?1, pinned=?2 WHERE clip_id=?3 AND board_id=?4",
                params![new, t_pinned, id, bid],
            )
            .map(|_| ())
            .map_err(|e| e.to_string());
    }

    let (_, t_pinned): (f64, i64) = conn
        .query_row("SELECT sort_ts,pinned FROM clips WHERE id=?1", params![target], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let dup_count: i64 = conn
        .query_row("SELECT COUNT(*) - COUNT(DISTINCT sort_ts) FROM clips WHERE pinned=?1", params![t_pinned], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    if dup_count > 0 {
        let ordered_ids: Vec<i64> = conn
            .prepare("SELECT id FROM clips WHERE pinned=?1 ORDER BY sort_ts DESC, id DESC")
            .and_then(|mut st| {
                let rows = st.query_map(params![t_pinned], |r| r.get::<_, i64>(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        let base = now_ms() as f64;
        for (idx, cid) in ordered_ids.iter().enumerate() {
            let _ = conn.execute("UPDATE clips SET sort_ts=?1 WHERE id=?2", params![base - (idx as f64) * 1000.0, cid]);
        }
    }
    let t_sort: f64 = conn
        .query_row("SELECT sort_ts FROM clips WHERE id=?1", params![target], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let neighbour: Option<f64> = if after {
        conn.query_row(
            "SELECT MAX(sort_ts) FROM clips WHERE pinned=?1 AND sort_ts<?2 AND id<>?3",
            params![t_pinned, t_sort, id],
            |r| r.get(0),
        )
    } else {
        conn.query_row(
            "SELECT MIN(sort_ts) FROM clips WHERE pinned=?1 AND sort_ts>?2 AND id<>?3",
            params![t_pinned, t_sort, id],
            |r| r.get(0),
        )
    }
    .map_err(|e| e.to_string())?;
    let new = match (after, neighbour) {
        (true, Some(lo)) => (t_sort + lo) / 2.0,
        (true, None) => t_sort - 1000.0,
        (false, Some(hi)) => (t_sort + hi) / 2.0,
        (false, None) => t_sort + 1000.0,
    };
    conn.execute("UPDATE clips SET sort_ts=?1, pinned=?2 WHERE id=?3", params![new, t_pinned, id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ───────────────────────────── app icons ─────────────────────────────

pub fn has_icon(conn: &Connection, exe: &str) -> bool {
    conn.query_row("SELECT 1 FROM app_icons WHERE exe=?1", params![exe.to_lowercase()], |_| Ok(())).is_ok()
}

pub fn put_icon(conn: &Connection, exe: &str, png: &[u8]) {
    let _ = conn.execute("INSERT OR REPLACE INTO app_icons(exe,png) VALUES(?1,?2)", params![exe.to_lowercase(), png]);
}

pub fn get_icon(conn: &Connection, exe: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT png FROM app_icons WHERE exe=?1", params![exe.to_lowercase()], |r| r.get(0)).ok()
}

// ───────────────────────────── import (merge) ─────────────────────────────

/// Merges another ClipNest database (an export or a daily backup, already decompressed) into this one.
/// Non-destructive: items whose content hash already exists are skipped. Returns the number of new items.
pub fn merge_from(conn: &Connection, imp: &Path) -> Result<usize, String> {
    if let Ok(imp_conn) = Connection::open(imp) {
        migrate(&imp_conn);
    }
    conn.execute("ATTACH DATABASE ?1 AS imp", params![imp.to_string_lossy().to_string()]).map_err(|e| e.to_string())?;
    let result = (|| -> Result<usize, String> {
        let ok: String = conn.query_row("PRAGMA imp.quick_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if ok != "ok" {
            return Err("the file is damaged".into());
        }
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM imp.sqlite_master WHERE name IN ('clips','clip_formats','pinboards')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if n < 3 {
            return Err("not a ClipNest backup".into());
        }
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let body = (|| -> Result<usize, String> {
            conn.execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS pbmap(old INTEGER PRIMARY KEY, new INTEGER); DELETE FROM pbmap;",
            )
            .map_err(|e| e.to_string())?;
            let boards: Vec<(i64, String, String)> = {
                let mut st = conn.prepare("SELECT id,name,color FROM imp.pinboards").map_err(|e| e.to_string())?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|e| e.to_string())?;
                rows.filter_map(|r| r.ok()).collect()
            };
            for (old, name, color) in boards {
                let existing: Option<i64> = conn
                    .query_row("SELECT id FROM main.pinboards WHERE name=?1", params![name], |r| r.get(0))
                    .optional()
                    .map_err(|e| e.to_string())?;
                let new = match existing {
                    Some(id) => id,
                    None => create_pinboard(conn, &name, &color)?,
                };
                conn.execute("INSERT OR REPLACE INTO pbmap(old,new) VALUES(?1,?2)", params![old, new])
                    .map_err(|e| e.to_string())?;
            }
            let max_before: i64 = conn
                .query_row("SELECT COALESCE(MAX(id),0) FROM main.clips", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let added = conn
                .execute(
                    "INSERT INTO main.clips(hash,kind,title,tags,app_name,app_exe,lang,img_w,img_h,color,chars,file_count,
                                            pinned,sensitive,has_rich,expires_at,created_at,ts,sort_ts,preview,search,plain,thumb)
                     SELECT hash,kind,title,tags,app_name,app_exe,lang,img_w,img_h,color,chars,file_count,
                            pinned,sensitive,has_rich,expires_at,created_at,ts,sort_ts,preview,search,plain,thumb
                     FROM imp.clips WHERE hash NOT IN (SELECT hash FROM main.clips)",
                    [],
                )
                .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO main.clip_formats(clip_id,fmt_id,name,size,data)
                 SELECT mc.id,f.fmt_id,f.name,f.size,f.data
                 FROM imp.clip_formats f JOIN imp.clips ic ON ic.id=f.clip_id JOIN main.clips mc ON mc.hash=ic.hash
                 WHERE mc.id>?1",
                params![max_before],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE main.clips SET pinboard_id=(
                     SELECT m.new FROM pbmap m JOIN imp.clips i ON i.pinboard_id=m.old WHERE i.hash=main.clips.hash LIMIT 1)
                 WHERE id>?1 AND hash IN (SELECT hash FROM imp.clips WHERE pinboard_id IS NOT NULL)",
                params![max_before],
            )
            .map_err(|e| e.to_string())?;
            let _ = conn.execute(
                "INSERT OR IGNORE INTO main.clip_categories(clip_id, board_id, pinned, sort_ts)
                 SELECT id, pinboard_id, 0, sort_ts FROM main.clips WHERE id>?1 AND pinboard_id IS NOT NULL",
                params![max_before],
            );
            if let Ok(all_boards) = list_pinboards(conn) {
                for b in all_boards {
                    trim_board(conn, b.id);
                }
            }
            Ok(added)
        })();
        match body {
            Ok(n) => {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(n)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })();
    let _ = conn.execute_batch("DETACH DATABASE imp");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{build_text_clip, text_format};

    #[test]
    fn deduplicates_and_upgrades_rich_formats_and_expiry() {
        let dir = std::env::temp_dir().join(format!("clipnest_db_dedup_{}", now_ms()));
        let mut conn = open_with_recovery(&dir).unwrap();

        let c1 = build_text_clip("hello world", None, "Notepad", "notepad.exe", false);
        let (id1, is_new1) = insert_clip(&mut conn, &c1, &[text_format("hello world")]).unwrap();
        assert!(is_new1);
        assert!(!get_row(&conn, id1).unwrap().has_rich);

        // Re-copying the exact same text from VS Code with HTML format & sensitive expiry
        let mut c2 = build_text_clip("hello world", Some("rust".into()), "VS Code", "code.exe", true);
        c2.sensitive = true;
        c2.expires_at = Some(now_ms() + 60_000);
        let fmts2 = vec![
            text_format("hello world"),
            StoredFormat { fmt_id: 0xC100, name: "HTML Format".into(), data: b"<span>hello world</span>".to_vec() },
        ];
        let (id2, is_new2) = insert_clip(&mut conn, &c2, &fmts2).unwrap();
        assert!(!is_new2);
        assert_eq!(id1, id2);

        let row = get_row(&conn, id1).unwrap();
        assert!(row.has_rich);
        assert!(row.sensitive);
        assert_eq!(row.lang.as_deref(), Some("rust"));
        assert_eq!(row.kind, "code");
        assert_eq!(get_formats(&conn, id1).len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn erase_history_respects_include_pinned_and_active_pinboard() {
        let dir = std::env::temp_dir().join(format!("clipnest_db_erase_{}", now_ms()));
        let mut conn = open_with_recovery(&dir).unwrap();

        let c_normal = build_text_clip("normal item", None, "App", "app.exe", false);
        let (id_normal, _) = insert_clip(&mut conn, &c_normal, &[text_format("normal item")]).unwrap();

        let c_pinned = build_text_clip("pinned item", None, "App", "app.exe", false);
        let (id_pinned, _) = insert_clip(&mut conn, &c_pinned, &[text_format("pinned item")]).unwrap();
        set_pinned(&conn, &[id_pinned], true).unwrap();

        let bid = create_pinboard(&conn, "TestBoard", "#4f8cff").unwrap();
        let c_board = build_text_clip("board item", None, "App", "app.exe", false);
        let (id_board, _) = insert_clip(&mut conn, &c_board, &[text_format("board item")]).unwrap();
        set_pinboard(&conn, &[id_board], Some(bid)).unwrap();

        // 1. Erase only active pinboard (include_pinned=false, target_pinboard=Some(bid), all_pinboards=false):
        //    deletes unpinned item in TestBoard, keeps main normal item and pinned item.
        let deleted_board = erase_history(&conn, false, Some(bid), false).unwrap();
        assert_eq!(deleted_board, 1);
        assert!(get_row(&conn, id_board).is_none());
        assert!(get_row(&conn, id_normal).is_some());
        assert!(get_row(&conn, id_pinned).is_some());

        // 2. Erase main clipboard unpinned (include_pinned=false, target_pinboard=None, all_pinboards=false):
        let deleted_main = erase_history(&conn, false, None, false).unwrap();
        assert_eq!(deleted_main, 1);
        assert!(get_row(&conn, id_normal).is_none());
        assert!(get_row(&conn, id_pinned).is_some());

        // 3. Erase all including pinned across all boards (include_pinned=true, target_pinboard=None, all_pinboards=true):
        let deleted_all = erase_history(&conn, true, None, true).unwrap();
        assert_eq!(deleted_all, 1);
        assert!(get_row(&conn, id_pinned).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn independent_category_pinning_and_copy_vs_move() {
        let dir = std::env::temp_dir().join(format!("clipnest_db_indep_pin_{}", now_ms()));
        let mut conn = open_with_recovery(&dir).unwrap();

        let c = build_text_clip("category test item", None, "App", "app.exe", false);
        let (id, _) = insert_clip(&mut conn, &c, &[text_format("category test item")]).unwrap();

        let cat_a = create_pinboard(&conn, "CatA", "#4f8cff").unwrap();
        let cat_b = create_pinboard(&conn, "CatB", "#34c759").unwrap();

        // Copy from main clipboard to CatA
        assign_category(&conn, &[id], Some(cat_a), None, true).unwrap();
        // Copy from CatA to CatB (Ctrl+Drag / Ctrl+Click)
        assign_category(&conn, &[id], Some(cat_b), Some(cat_a), true).unwrap();

        let boards = list_pinboards(&conn).unwrap();
        assert_eq!(boards.iter().find(|b| b.id == cat_a).unwrap().count, 1);
        assert_eq!(boards.iter().find(|b| b.id == cat_b).unwrap().count, 1);

        // Pin inside CatA with independent_pinning = true
        set_pinned_scoped(&conn, &[id], true, Some(cat_a), true).unwrap();
        // Main clipboard remains unpinned, CatB remains unpinned
        assert!(!get_row(&conn, id).unwrap().pinned);
        let cat_a_pin: i64 = conn
            .query_row("SELECT pinned FROM clip_categories WHERE clip_id=?1 AND board_id=?2", params![id, cat_a], |r| {
                r.get(0)
            })
            .unwrap();
        let cat_b_pin: i64 = conn
            .query_row("SELECT pinned FROM clip_categories WHERE clip_id=?1 AND board_id=?2", params![id, cat_b], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(cat_a_pin, 1);
        assert_eq!(cat_b_pin, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fractional_reordering_and_pinboard_limits() {
        let dir = std::env::temp_dir().join(format!("clipnest_db_order_{}", now_ms()));
        let mut conn = open_with_recovery(&dir).unwrap();

        let mut ids = Vec::new();
        for i in 1..=3 {
            let txt = format!("item {i}");
            let c = build_text_clip(&txt, None, "App", "app.exe", false);
            let (id, _) = insert_clip(&mut conn, &c, &[text_format(&txt)]).unwrap();
            conn.execute("UPDATE clips SET sort_ts=?1 WHERE id=?2", params![(i * 1000) as f64, id]).unwrap();
            ids.push(id);
        }
        // Initially ordered: ids[2] (3000), ids[1] (2000), ids[0] (1000)
        // Move ids[0] before (above) ids[2]
        move_item(&conn, ids[0], ids[2], false, None).unwrap();
        let top_id: i64 =
            conn.query_row("SELECT id FROM clips ORDER BY sort_ts DESC LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(top_id, ids[0]);

        // Pinboard with max_items = 2 trims the oldest item
        let bid = create_pinboard(&conn, "Work", "#4f8cff").unwrap();
        update_pinboard(&conn, bid, "Work", "#4f8cff", 2, "rich", "plain").unwrap();
        set_pinboard(&conn, &ids, Some(bid)).unwrap();
        let boards = list_pinboards(&conn).unwrap();
        assert_eq!(boards[0].count, 2);
        assert_eq!(boards[0].list_style, "rich");
        assert_eq!(boards[0].paste_mode, "plain");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v1_migration_and_backup_recovery() {
        let dir = std::env::temp_dir().join(format!("clipnest_db_mig_{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();

        // Create a V1 database lacking sort_ts, max_items, list_style, paste_mode
        let v1_path = dir.join("v1_export.db");
        {
            let v1 = Connection::open(&v1_path).unwrap();
            v1.execute_batch(
                "CREATE TABLE pinboards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
                 CREATE TABLE clips (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT, tags TEXT NOT NULL DEFAULT '', app_name TEXT NOT NULL DEFAULT '', app_exe TEXT NOT NULL DEFAULT '', lang TEXT, img_w INTEGER, img_h INTEGER, color TEXT, chars INTEGER NOT NULL DEFAULT 0, file_count INTEGER, pinboard_id INTEGER, pinned INTEGER NOT NULL DEFAULT 0, sensitive INTEGER NOT NULL DEFAULT 0, has_rich INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL, ts INTEGER NOT NULL, preview TEXT NOT NULL DEFAULT '', search TEXT NOT NULL DEFAULT '', plain TEXT NOT NULL DEFAULT '', thumb BLOB);
                 CREATE TABLE clip_formats (id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id INTEGER NOT NULL, fmt_id INTEGER NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);
                 INSERT INTO pinboards(id,name,color,position,created_at) VALUES(1,'Legacy','#34c759',1,100);
                 INSERT INTO clips(id,hash,kind,plain,preview,search,pinboard_id,created_at,ts) VALUES(1,'h_v1','text','v1 clip','v1 clip','v1 clip',1,1000,1000);
                 INSERT INTO clip_formats(clip_id,fmt_id,name,size,data) VALUES(1,13,'CF_UNICODETEXT',4,X'76003100');",
            ).unwrap();
        }

        // Open main DB and merge from V1 export
        let conn = open_with_recovery(&dir).unwrap();
        let added = merge_from(&conn, &v1_path).unwrap();
        assert_eq!(added, 1);
        assert_eq!(list_pinboards(&conn).unwrap().len(), 1);

        // Create a daily backup, then corrupt clipnest.db and verify open_with_recovery restores it
        let mutex = parking_lot::Mutex::new(conn);
        let gz_path = backup(&mutex, &dir, 5).unwrap();
        assert!(gz_path.exists());
        drop(mutex);

        std::fs::write(dir.join("clipnest.db"), b"corrupted bytes not sqlite").unwrap();
        let recovered = open_with_recovery(&dir).unwrap();
        let count: i64 = recovered.query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_or_trimming_category_preserves_clips_in_other_categories() {
        let dir = std::env::temp_dir().join(format!("clipnest_db_multicat_del_{}", now_ms()));
        let mut conn = open_with_recovery(&dir).unwrap();

        let c = build_text_clip("shared clip", None, "App", "app.exe", false);
        let (id, _) = insert_clip(&mut conn, &c, &[text_format("shared clip")]).unwrap();
        let cat_a = create_pinboard(&conn, "CatA", "#4f8cff").unwrap();
        let cat_b = create_pinboard(&conn, "CatB", "#34c759").unwrap();

        assign_category(&conn, &[id], Some(cat_a), None, true).unwrap();
        assign_category(&conn, &[id], Some(cat_b), Some(cat_a), true).unwrap();
        // clips.pinboard_id is now cat_b; deleting cat_b must NOT delete the clip from cat_a
        delete_pinboard(&conn, cat_b).unwrap();

        let row = get_row(&conn, id).expect("shared clip must survive deleting CatB");
        assert_eq!(row.pinboard_id, Some(cat_a));
        let boards = list_pinboards(&conn).unwrap();
        assert_eq!(boards.iter().find(|b| b.id == cat_a).unwrap().count, 1);

        // Test trimming:
        // Create CatB2 and copy `id` into CatB2
        let cat_b2 = create_pinboard(&conn, "CatB2", "#34c759").unwrap();
        assign_category(&conn, &[id], Some(cat_b2), Some(cat_a), true).unwrap();
        // Set CatB2 max_items = 1
        update_pinboard(&conn, cat_b2, "CatB2", "#34c759", 1, "inherit", "inherit").unwrap();

        // Add a second, newer clip to CatB2 so CatB2 overflows and trims `id`
        let c2 = build_text_clip("newer clip in CatB2", None, "App", "app.exe", false);
        let (id2, _) = insert_clip(&mut conn, &c2, &[text_format("newer clip in CatB2")]).unwrap();
        assign_category(&conn, &[id2], Some(cat_b2), None, false).unwrap();
        // `id` was trimmed from CatB2, but is still in CatA: pinboard_id must be updated to CatA
        let row_trimmed = get_row(&conn, id).expect("shared clip must survive trimming CatB2");
        assert_eq!(row_trimmed.pinboard_id, Some(cat_a));

        // Now deleting CatB2 must NOT cascade to delete `id`
        delete_pinboard(&conn, cat_b2).unwrap();
        let row_after = get_row(&conn, id).expect("shared clip must survive deleting CatB2 after trim");
        assert_eq!(row_after.pinboard_id, Some(cat_a));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
