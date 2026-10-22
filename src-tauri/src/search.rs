//! Instant multi-modal search.
//!
//! "smart" mode: whitespace separated tokens.
//!   * a token equal to a type word (text, code, link, image, file, color …) filters by kind;
//!   * a token that is a prefix (≥3 chars) of a known source-app name/exe matches that app
//!     OR the content (so normal words are never swallowed by the app filter);
//!   * "quoted words" are always literal content terms;
//!   * every remaining token must appear in the text, title, app name or tags.
//! "fuzzy" mode: the characters of the query must appear in order.
//! "regex" mode: case-insensitive regular expression over the (normalised) text.

use crate::classify::normalize;
use crate::db::{row_from, ClipRow, ROW_COLS};
use regex::Regex;
use rusqlite::{params_from_iter, Connection};
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
    apps: Vec<String>,
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

fn parse(query: &str, mode: &str, known_apps: &[String], use_apps: bool) -> Result<Parsed, String> {
    let mut p = Parsed { kinds: vec![], apps: vec![], terms: vec![], regex: None, fuzzy: None };
    let q = query.trim();
    if q.is_empty() {
        return Ok(p);
    }
    if mode == "regex" {
        let re = Regex::new(&format!("(?i){q}")).map_err(|e| format!("Invalid regular expression: {e}"))?;
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
            if use_apps && n.chars().count() >= 3 && known_apps.iter().any(|a| a.starts_with(&n)) {
                p.apps.push(n);
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
    f.search.contains(t) || f.title_n.contains(t) || f.app_n.contains(t) || f.tags_n.contains(t)
}

/// `typos`: when true a term may also match with spelling mistakes (second, slower tier).
fn matches(p: &Parsed, row: &ClipRow, f: &Fields, typos: bool) -> bool {
    if !p.kinds.is_empty() && !p.kinds.contains(&row.kind.as_str()) {
        return false;
    }
    // A word that looks like an app name matches the source app (name or exe) OR the content,
    // so ordinary words such as "note" or "word" are never swallowed by the app filter.
    if !p.apps.iter().all(|a| exact_term(f, a.as_str()) || f.exe_n.contains(a.as_str())) {
        return false;
    }
    if let Some(re) = &p.regex {
        return re.is_match(f.search) || re.is_match(f.title_n);
    }
    if let Some(fz) = &p.fuzzy {
        return subsequence(f.search, fz) || subsequence(f.title_n, fz) || subsequence(f.app_n, fz);
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
    })
}

fn known_apps(conn: &Connection) -> Vec<String> {
    let mut v = vec![];
    if let Ok(mut st) = conn.prepare("SELECT DISTINCT lower(app_name), lower(app_exe) FROM clips") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (n, e) in rows.flatten() {
                v.push(normalize(&n));
                let e = e.trim_end_matches(".exe").to_string();
                if !e.is_empty() {
                    v.push(normalize(&e));
                }
            }
        }
    }
    v.sort();
    v.dedup();
    v
}

#[derive(Clone, Copy, PartialEq)]
enum Tier {
    Exact,
    /// Rows that do NOT match exactly but match with spelling mistakes.
    Typos,
}

fn scan(conn: &Connection, a: &ListArgs, p: &Parsed, tier: Tier, limit: usize) -> Result<(Vec<ClipRow>, usize), String> {
    let board_clause = if a.pinboard.is_some() { "WHERE pinboard_id=?1" } else { "WHERE ?1 IS NULL" };
    let sql = format!("SELECT {ROW_COLS}, search FROM clips {board_clause} ORDER BY pinned DESC, sort_ts DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let bind: Vec<Option<i64>> = vec![a.pinboard];
    let mut rows = stmt.query(params_from_iter(bind.iter())).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    let mut total = 0usize;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let row = row_from(r).map_err(|e| e.to_string())?;
        let search: String = r.get(19).map_err(|e| e.to_string())?;
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
    if a.query.trim().is_empty() {
        // Fast path: no filtering, plain SQL.
        let (where_clause, bind): (&str, Vec<Option<i64>>) = match a.pinboard {
            Some(id) => ("WHERE pinboard_id=?1", vec![Some(id)]),
            None => ("WHERE ?1 IS NULL", vec![None]),
        };
        let total: usize = conn
            .query_row(&format!("SELECT COUNT(*) FROM clips {where_clause}"), params_from_iter(bind.iter()), |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize;
        let sql = format!(
            "SELECT {ROW_COLS} FROM clips {where_clause} ORDER BY pinned DESC, sort_ts DESC LIMIT {}",
            a.limit.max(1)
        );
        let mut items = vec![];
        if let Ok(mut st) = conn.prepare(&sql) {
            if let Ok(rows) = st.query_map(params_from_iter(bind.iter()), row_from) {
                items = rows.filter_map(|r| r.ok()).collect();
            }
        }
        return ListResult { items, total, error: None };
    }

    let apps = known_apps(conn);
    let parsed = match parse(&a.query, &a.mode, &apps, true) {
        Ok(p) => p,
        Err(e) => return ListResult { items: vec![], total: 0, error: Some(e) },
    };
    let (mut items, mut total) = match scan(conn, a, &parsed, Tier::Exact, a.limit) {
        Ok(r) => r,
        Err(e) => return ListResult { items: vec![], total: 0, error: Some(e) },
    };
    // Full-text results first; if there are few, add typo-tolerant (fuzzy) matches after them.
    if a.mode == "smart" && !parsed.terms.is_empty() && total < 30 {
        let room = a.limit.saturating_sub(items.len());
        if let Ok((more, n)) = scan(conn, a, &parsed, Tier::Typos, room) {
            items.extend(more);
            total += n;
        }
    }
    ListResult { items, total, error: None }
}
