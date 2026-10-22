//! Automatic rules ("when X is copied, do Y"), the ClipNest take on CopyQ's automatic commands.

use crate::capture::{build_text_clip, text_format};
use crate::db::{now_ms, NewClip, StoredFormat};
use crate::platform::win::CF_UNICODETEXT_ID;
use crate::state::AutoRule;
use regex::Regex;

#[derive(Default)]
pub struct Outcome {
    pub ignore: bool,
    pub board: Option<i64>,
    pub tags: Vec<String>,
    /// Custom-action ids to run on the stored item.
    pub run: Vec<String>,
}

fn applies(rule: &AutoRule, clip: &NewClip) -> bool {
    if !rule.apps.trim().is_empty() {
        let exe = clip.app_exe.to_lowercase();
        let name = clip.app_name.to_lowercase();
        let any = rule
            .apps
            .split(',')
            .map(|a| a.trim().to_lowercase())
            .filter(|a| !a.is_empty())
            .any(|a| exe.contains(&a) || name.contains(&a));
        if !any {
            return false;
        }
    }
    if !rule.kinds.is_empty() && !rule.kinds.iter().any(|k| k == &clip.kind) {
        return false;
    }
    if !rule.pattern.trim().is_empty() {
        let re = match Regex::new(&format!("(?i){}", rule.pattern)) {
            Ok(r) => r,
            Err(_) => return false, // an invalid pattern never matches
        };
        let text: String = clip.plain.chars().take(20_000).collect();
        if !re.is_match(&text) {
            return false;
        }
    }
    true
}

pub fn apply(rules: &[AutoRule], clip: &mut NewClip, fmts: &mut Vec<StoredFormat>) -> Outcome {
    let mut out = Outcome::default();
    for rule in rules.iter().filter(|r| r.enabled) {
        if !applies(rule, clip) {
            continue;
        }
        let textual = matches!(clip.kind.as_str(), "text" | "code" | "link" | "color");
        match rule.action.as_str() {
            "ignore" => {
                out.ignore = true;
                return out;
            }
            "to_board" if rule.board > 0 => out.board = Some(rule.board),
            "tag" => {
                for t in rule.value.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()) {
                    out.tags.push(t.trim_start_matches('#').to_string());
                }
            }
            "plain_only" if textual => {
                fmts.retain(|f| f.fmt_id == CF_UNICODETEXT_ID);
                clip.has_rich = false;
            }
            "trim" if textual => {
                let t = clip.plain.trim().to_string();
                if t != clip.plain && !t.is_empty() {
                    let mut nc = build_text_clip(&t, clip.lang.clone(), &clip.app_name, &clip.app_exe, false);
                    nc.sensitive = clip.sensitive;
                    nc.expires_at = clip.expires_at;
                    *clip = nc;
                    *fmts = vec![text_format(&t)];
                }
            }
            "expire" => {
                let m: i64 = rule.value.trim().parse().unwrap_or(0);
                if m > 0 {
                    clip.expires_at = Some(now_ms() + m * 60_000);
                }
            }
            "run_action" if !rule.value.is_empty() => out.run.push(rule.value.clone()),
            _ => {}
        }
    }
    out
}
