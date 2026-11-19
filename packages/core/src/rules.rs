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
                    clip.expires_at = Some(now_ms().saturating_add(m.saturating_mul(60_000)));
                }
            }
            "run_action" if !rule.value.is_empty() => out.run.push(rule.value.clone()),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_rules_apply_in_order_and_handle_all_actions() {
        let mut clip = build_text_clip("  https://secret.example.com  ", None, "Chrome", "chrome.exe", true);
        clip.sensitive = true;
        let mut fmts = vec![
            text_format(&clip.plain),
            StoredFormat { fmt_id: 0xC100, name: "HTML Format".into(), data: b"<b>hi</b>".to_vec() },
        ];

        let rules = vec![
            AutoRule {
                id: "r1".into(),
                name: "Trim".into(),
                enabled: true,
                apps: "chrome, msedge".into(),
                kinds: vec![],
                pattern: r"https://".into(),
                action: "trim".into(),
                board: 0,
                value: "".into(),
            },
            AutoRule {
                id: "r2".into(),
                name: "Board & Tag".into(),
                enabled: true,
                apps: "".into(),
                kinds: vec!["link".into()],
                pattern: "".into(),
                action: "to_board".into(),
                board: 42,
                value: "".into(),
            },
            AutoRule {
                id: "r3".into(),
                name: "Tags".into(),
                enabled: true,
                apps: "".into(),
                kinds: vec!["link".into()],
                pattern: "".into(),
                action: "tag".into(),
                board: 0,
                value: "#work, urgent".into(),
            },
            AutoRule {
                id: "r4".into(),
                name: "Expire".into(),
                enabled: true,
                apps: "".into(),
                kinds: vec![],
                pattern: "".into(),
                action: "expire".into(),
                board: 0,
                value: "10".into(),
            },
            AutoRule {
                id: "r5".into(),
                name: "Action".into(),
                enabled: true,
                apps: "".into(),
                kinds: vec![],
                pattern: "".into(),
                action: "run_action".into(),
                board: 0,
                value: "act_1".into(),
            },
        ];

        let out = apply(&rules, &mut clip, &mut fmts);
        assert!(!out.ignore);
        assert_eq!(clip.plain, "https://secret.example.com");
        assert_eq!(clip.kind, "link");
        assert!(clip.sensitive);
        assert!(!clip.has_rich);
        assert_eq!(fmts.len(), 1);
        assert_eq!(out.board, Some(42));
        assert_eq!(out.tags, vec!["work", "urgent"]);
        assert!(clip.expires_at.is_some());
        assert_eq!(out.run, vec!["act_1"]);
    }

    #[test]
    fn ignore_rule_short_circuits() {
        let mut clip = build_text_clip("secret password", None, "KeePass", "keepass.exe", false);
        let mut fmts = vec![text_format(&clip.plain)];
        let rules = vec![AutoRule {
            id: "r1".into(),
            name: "Ignore KeePass".into(),
            enabled: true,
            apps: "keepass".into(),
            kinds: vec![],
            pattern: "".into(),
            action: "ignore".into(),
            board: 0,
            value: "".into(),
        }];
        let out = apply(&rules, &mut clip, &mut fmts);
        assert!(out.ignore);
    }

    #[test]
    fn expire_rule_saturates_without_overflow() {
        let mut clip = build_text_clip("sample", None, "App", "app.exe", false);
        let mut fmts = vec![text_format(&clip.plain)];
        let rules = vec![AutoRule {
            id: "r_max".into(),
            name: "Max Expire".into(),
            enabled: true,
            apps: "".into(),
            kinds: vec![],
            pattern: "".into(),
            action: "expire".into(),
            board: 0,
            value: i64::MAX.to_string(),
        }];
        apply(&rules, &mut clip, &mut fmts);
        assert_eq!(clip.expires_at, Some(i64::MAX));
    }
}
