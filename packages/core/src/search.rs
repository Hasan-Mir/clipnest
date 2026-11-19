//! Instant multi-modal search.
//!
//! "smart" mode: whitespace separated tokens.
//!   * a token equal to a type word (text, code, link, image, file, color …) filters by kind;
//!   * "quoted words" are always literal content terms;
//!   * exact terms match against text, title, app name, app exe, or tags (typo-tolerant matching checks text, title, and apps).
//! "fuzzy" mode: the characters of the query must appear in order within text, title, or app name.
//! "regex" mode: case-insensitive regular expression over searchable text, preview, and normalised title.

use crate::classify::normalize;
use crate::db::{row_from, ClipRow, ROW_COLS};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug)]
pub struct ListArgs {
    pub pinboard: Option<i64>,
    pub query: String,
    pub mode: String,
    pub limit: usize,
}

#[derive(Serialize)]
pub struct ListResult {
    pub items: Vec<ClipRow>,
    pub total: usize,
    pub error: Option<String>,
}

struct Parsed {
    kinds: Vec<&'static str>,
    terms: Vec<String>,
    regex: Option<Regex>,
    fuzzy: Option<String>,
}

fn type_word(tok: &str) -> Option<&'static str> {
    match tok {
        "text" | "texts" => Some("text"),
        "code" | "codes" => Some("code"),
        "link" | "links" | "url" | "urls" => Some("link"),
        "image" | "images" | "img" | "picture" | "pictures" => Some("image"),
        "file" | "files" => Some("file"),
        "color" | "colors" | "colour" | "colours" => Some("color"),
        _ => None,
    }
}

fn tokenize(q: &str) -> Vec<(String, bool)> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_q = false;
    for ch in q.chars() {
        if ch == '"' {
            if !cur.is_empty() {
                out.push((std::mem::take(&mut cur), in_q));
            }
            in_q = !in_q;
        } else if ch.is_whitespace() && !in_q {
            if !cur.is_empty() {
                out.push((std::mem::take(&mut cur), false));
            }
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        out.push((cur, in_q));
    }
    out
}

fn parse(query: &str, mode: &str) -> Result<Parsed, String> {
    let mut p = Parsed { kinds: vec![], terms: vec![], regex: None, fuzzy: None };
    let q = query.trim();
    if q.is_empty() {
        return Ok(p);
    }
    if mode == "regex" {
        let norm_q = normalize(q);
        let pat = if norm_q != q.to_lowercase() && !norm_q.is_empty() {
            format!("(?i)(?:{q})|(?:{norm_q})")
        } else {
            format!("(?i){q}")
        };
        let re = Regex::new(&pat)
            .or_else(|_| Regex::new(&format!("(?i){q}")))
            .map_err(|e| format!("Invalid regular expression: {e}"))?;
        p.regex = Some(re);
        return Ok(p);
    }
    if mode == "fuzzy" {
        p.fuzzy = Some(normalize(q).chars().filter(|c| !c.is_whitespace()).collect());
        return Ok(p);
    }
    for (tok, quoted) in tokenize(q) {
        let n = normalize(&tok);
        if n.is_empty() {
            continue;
        }
        if !quoted {
            if let Some(k) = type_word(&n) {
                if !p.kinds.contains(&k) {
                    p.kinds.push(k);
                }
                continue;
            }
        }
        p.terms.push(n);
    }
    Ok(p)
}

fn subsequence(hay: &str, needle: &str) -> bool {
    let mut it = hay.chars();
    for n in needle.chars() {
        loop {
            match it.next() {
                Some(c) if c == n => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }
    true
}

/// Typo tolerance by term length: 1–3 letters exact only, 4–6 letters one edit, 7+ letters two edits.
fn max_typos(len: usize) -> usize {
    match len {
        0..=3 => 0,
        4..=6 => 1,
        _ => 2,
    }
}

/// Sellers' algorithm: does `hay` contain a substring within `k` edits (insert/delete/replace) of `needle`?
fn approx_contains(hay: &[char], needle: &[char], k: usize) -> bool {
    let m = needle.len();
    if m == 0 {
        return true;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0usize; m + 1];
    for &c in hay {
        cur[0] = 0;
        for i in 1..=m {
            let cost = if needle[i - 1] == c { 0 } else { 1 };
            cur[i] = (prev[i - 1] + cost).min(prev[i] + 1).min(cur[i - 1] + 1);
        }
        if cur[m] <= k {
            return true;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    false
}

struct Fields<'a> {
    search: &'a str,
    app_n: &'a str,
    exe_n: &'a str,
    title_n: &'a str,
    tags_n: &'a str,
}

fn exact_term(f: &Fields, t: &str) -> bool {
    f.search.contains(t) || f.title_n.contains(t) || f.app_n.contains(t) || f.exe_n.contains(t) || f.tags_n.contains(t)
}

/// `typos`: when true a term may also match with spelling mistakes (second, slower tier).
fn matches(p: &Parsed, row: &ClipRow, f: &Fields, typos: bool) -> bool {
    if !p.kinds.is_empty() && !p.kinds.contains(&row.kind.as_str()) {
        return false;
    }
    if let Some(re) = &p.regex {
        return re.is_match(f.search) || re.is_match(&row.preview) || re.is_match(f.title_n);
    }
    if let Some(fz) = &p.fuzzy {
        return subsequence(f.search, fz)
            || subsequence(f.title_n, fz)
            || subsequence(f.app_n, fz)
            || subsequence(f.exe_n, fz);
    }
    let mut hay: Option<Vec<char>> = None;
    p.terms.iter().all(|t| {
        if exact_term(f, t) {
            return true;
        }
        let tc: Vec<char> = t.chars().collect();
        let k = max_typos(tc.len());
        if !typos || k == 0 {
            return false;
        }
        let h = hay.get_or_insert_with(|| f.search.chars().take(3000).collect());
        approx_contains(h, &tc, k)
            || approx_contains(&f.title_n.chars().collect::<Vec<_>>(), &tc, k)
            || approx_contains(&f.app_n.chars().collect::<Vec<_>>(), &tc, k)
            || approx_contains(&f.exe_n.chars().collect::<Vec<_>>(), &tc, k)
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Tier {
    Exact,
    /// Rows that do NOT match exactly but match with spelling mistakes.
    Typos,
}

fn category_cols(independent_pinning: bool) -> &'static str {
    if independent_pinning {
        "c.id,c.kind,c.title,c.preview,c.app_name,c.app_exe,c.tags,c.lang,c.img_w,c.img_h,c.color,c.chars,c.file_count,cc.board_id,cc.pinned,c.sensitive,c.has_rich,c.ts,c.created_at,(c.thumb IS NOT NULL)"
    } else {
        "c.id,c.kind,c.title,c.preview,c.app_name,c.app_exe,c.tags,c.lang,c.img_w,c.img_h,c.color,c.chars,c.file_count,cc.board_id,(CASE WHEN c.pinned<>0 OR cc.pinned<>0 THEN 1 ELSE 0 END),c.sensitive,c.has_rich,c.ts,c.created_at,(c.thumb IS NOT NULL)"
    }
}

fn category_order(independent_pinning: bool) -> &'static str {
    if independent_pinning {
        "ORDER BY cc.pinned DESC, cc.sort_ts DESC, c.id DESC"
    } else {
        "ORDER BY (CASE WHEN c.pinned<>0 OR cc.pinned<>0 THEN 1 ELSE 0 END) DESC, cc.sort_ts DESC, c.id DESC"
    }
}

fn scan(
    conn: &Connection,
    a: &ListArgs,
    p: &Parsed,
    tier: Tier,
    limit: usize,
    independent_pinning: bool,
) -> Result<(Vec<ClipRow>, usize), String> {
    let sql = if a.pinboard.is_some() {
        format!(
            "SELECT {}, c.search FROM clips c JOIN clip_categories cc ON cc.clip_id=c.id WHERE cc.board_id=?1 {}",
            category_cols(independent_pinning),
            category_order(independent_pinning)
        )
    } else {
        format!("SELECT {ROW_COLS}, search FROM clips ORDER BY pinned DESC, sort_ts DESC, id DESC")
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = if let Some(bid) = a.pinboard {
        stmt.query(params![bid]).map_err(|e| e.to_string())?
    } else {
        stmt.query([]).map_err(|e| e.to_string())?
    };
    let mut items = Vec::new();
    let mut total = 0usize;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let row = row_from(r).map_err(|e| e.to_string())?;
        let search: String = r.get(20).map_err(|e| e.to_string())?;
        let app_n = normalize(&row.app_name);
        let exe_n = normalize(&row.app_exe);
        let title_n = row.title.as_deref().map(normalize).unwrap_or_default();
        let tags_n = normalize(&row.tags);
        let f = Fields { search: &search, app_n: &app_n, exe_n: &exe_n, title_n: &title_n, tags_n: &tags_n };
        let hit = match tier {
            Tier::Exact => matches(p, &row, &f, false),
            Tier::Typos => !matches(p, &row, &f, false) && matches(p, &row, &f, true),
        };
        if hit {
            total += 1;
            if items.len() < limit {
                items.push(row);
            }
        }
    }
    Ok((items, total))
}

pub fn list(conn: &Connection, a: &ListArgs) -> ListResult {
    list_scoped(conn, a, true)
}

pub fn list_scoped(conn: &Connection, a: &ListArgs, independent_pinning: bool) -> ListResult {
    if a.query.trim().is_empty() {
        // Fast path: no filtering, plain SQL.
        if let Some(bid) = a.pinboard {
            let total: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM clip_categories cc JOIN clips c ON c.id=cc.clip_id WHERE cc.board_id=?1",
                    params![bid],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            let sql = format!(
                "SELECT {} FROM clips c JOIN clip_categories cc ON cc.clip_id=c.id WHERE cc.board_id=?1 {} LIMIT {}",
                category_cols(independent_pinning),
                category_order(independent_pinning),
                a.limit.max(1)
            );
            let mut items = vec![];
            if let Ok(mut st) = conn.prepare(&sql) {
                if let Ok(rows) = st.query_map(params![bid], row_from) {
                    items = rows.filter_map(|r| r.ok()).collect();
                }
            }
            return ListResult { items, total, error: None };
        }

        let total: usize =
            conn.query_row("SELECT COUNT(*) FROM clips", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as usize;
        let sql = format!("SELECT {ROW_COLS} FROM clips ORDER BY pinned DESC, sort_ts DESC LIMIT {}", a.limit.max(1));
        let mut items = vec![];
        if let Ok(mut st) = conn.prepare(&sql) {
            if let Ok(rows) = st.query_map([], row_from) {
                items = rows.filter_map(|r| r.ok()).collect();
            }
        }
        return ListResult { items, total, error: None };
    }

    let parsed = match parse(&a.query, &a.mode) {
        Ok(p) => p,
        Err(e) => return ListResult { items: vec![], total: 0, error: Some(e) },
    };
    let (mut items, mut total) = match scan(conn, a, &parsed, Tier::Exact, a.limit, independent_pinning) {
        Ok(r) => r,
        Err(e) => return ListResult { items: vec![], total: 0, error: Some(e) },
    };
    // Full-text results first; if there are few, add typo-tolerant (fuzzy) matches after them.
    if a.mode == "smart" && parsed.terms.iter().any(|t| max_typos(t.chars().count()) > 0) && total < 30 {
        let room = a.limit.saturating_sub(items.len());
        if let Ok((more, n)) = scan(conn, a, &parsed, Tier::Typos, room, independent_pinning) {
            items.extend(more);
            total += n;
        }
    }
    ListResult { items, total, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{build_text_clip, text_format};
    use crate::db;

    static TEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn seed_db() -> Connection {
        let cnt = TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("clipnest_search_test_{}_{}_{}", std::process::id(), db::now_ms(), cnt));
        let mut conn = db::open_with_recovery(&dir).expect("open db");
        let c1 = build_text_clip("کتاب‌های برنامه‌نویسی Rust", None, "Chrome", "chrome.exe", false);
        db::insert_clip(&mut conn, &c1, &[text_format(&c1.plain)]).unwrap();

        let c2 = build_text_clip("https://tauri.app/v2/guide", None, "Edge", "msedge.exe", false);
        db::insert_clip(&mut conn, &c2, &[text_format(&c2.plain)]).unwrap();

        let c3 = build_text_clip("This text mentions an image file", None, "Word", "winword.exe", false);
        db::insert_clip(&mut conn, &c3, &[text_format(&c3.plain)]).unwrap();

        conn
    }

    #[test]
    fn smart_search_handles_persian_arabic_and_exe_names() {
        let conn = seed_db();
        // Searching with Arabic Kaf (U+0643) and no ZWNJ matches the Persian word
        let res = list(&conn, &ListArgs { pinboard: None, query: "كتابها".into(), mode: "smart".into(), limit: 50 });
        assert_eq!(res.total, 1);
        assert!(res.items[0].preview.contains("Rust"));

        // Searching by executable name 'winword' matches the Word clip
        let res_exe =
            list(&conn, &ListArgs { pinboard: None, query: "winword".into(), mode: "smart".into(), limit: 50 });
        assert_eq!(res_exe.total, 1);
        assert_eq!(res_exe.items[0].app_exe, "winword.exe");
    }

    #[test]
    fn type_word_vs_quoted_literal_search() {
        let conn = seed_db();
        // Unquoted 'image' filters by kind == 'image' (0 items in seed_db)
        let r_kind = list(&conn, &ListArgs { pinboard: None, query: "image".into(), mode: "smart".into(), limit: 50 });
        assert_eq!(r_kind.total, 0);

        // Quoted '"image"' searches literal text content
        let r_lit =
            list(&conn, &ListArgs { pinboard: None, query: "\"image\"".into(), mode: "smart".into(), limit: 50 });
        assert_eq!(r_lit.total, 1);
    }

    #[test]
    fn typo_tolerance_and_fuzzy_and_regex_modes() {
        let conn = seed_db();
        // Typo in 'mentions' -> 'mentoins' (2 edits in 8-letter word)
        let r_typo =
            list(&conn, &ListArgs { pinboard: None, query: "mentoins".into(), mode: "smart".into(), limit: 50 });
        assert_eq!(r_typo.total, 1);

        // Fuzzy subsequence 'trgde' -> matches 'https://tauri.app/v2/guide'
        let r_fuzzy = list(&conn, &ListArgs { pinboard: None, query: "trgde".into(), mode: "fuzzy".into(), limit: 50 });
        assert_eq!(r_fuzzy.total, 1);

        // Regex mode: valid vs invalid
        let r_re =
            list(&conn, &ListArgs { pinboard: None, query: r"v\d+/guide".into(), mode: "regex".into(), limit: 50 });
        assert_eq!(r_re.total, 1);

        let r_bad =
            list(&conn, &ListArgs { pinboard: None, query: "[unclosed".into(), mode: "regex".into(), limit: 50 });
        assert!(r_bad.error.is_some());
    }
}
