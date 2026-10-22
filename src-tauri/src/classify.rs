//! Content classification, sensitive-data detection and search normalisation
//! (including Persian/Arabic letter, digit and half-space handling).

use regex::{Regex, RegexSet};
use std::sync::OnceLock;

fn cached(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Lower-case + unify Persian/Arabic variants + drop half-spaces, tatweel and diacritics
/// + map Persian/Arabic-Indic digits to ASCII, so "کتاب‌ها" matches "کتابها", "ي" matches "ی".
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\u{200C}' | '\u{200D}' | '\u{200B}' | '\u{0640}' | '\u{0670}' => {}
            '\u{064B}'..='\u{065F}' => {}
            'ي' | 'ى' | 'ئ' => out.push('ی'),
            'ك' => out.push('ک'),
            'ة' => out.push('ه'),
            'أ' | 'إ' | 'ٱ' => out.push('ا'),
            '۰'..='۹' => out.push((b'0' + (ch as u32 - '۰' as u32) as u8) as char),
            '٠'..='٩' => out.push((b'0' + (ch as u32 - '٠' as u32) as u8) as char),
            c => {
                for l in c.to_lowercase() {
                    out.push(l);
                }
            }
        }
    }
    out
}

pub fn parse_color(s: &str) -> Option<String> {
    static HEX: OnceLock<Regex> = OnceLock::new();
    static FUNC: OnceLock<Regex> = OnceLock::new();
    let t = s.trim();
    if t.len() > 64 || t.contains('\n') {
        return None;
    }
    let hex = cached(&HEX, r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$");
    let func = cached(
        &FUNC,
        r"(?i)^(?:rgb|rgba|hsl|hsla)\(\s*[\d.]+%?(?:deg)?\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$",
    );
    if hex.is_match(t) || func.is_match(t) {
        Some(t.to_string())
    } else {
        None
    }
}

pub fn parse_link(s: &str) -> Option<String> {
    static URL: OnceLock<Regex> = OnceLock::new();
    let t = s.trim();
    if t.is_empty() || t.len() > 2048 || t.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    if cached(&URL, r"(?i)^(?:(?:https?|ftp)://\S+|mailto:\S+)$").is_match(t) {
        Some(t.to_string())
    } else {
        None
    }
}

pub fn looks_like_code(t: &str) -> bool {
    let lines: Vec<&str> = t.lines().collect();
    if lines.len() < 2 || t.len() > 300_000 {
        return false;
    }
    const STARTS: &[&str] = &[
        "function ", "const ", "let ", "var ", "def ", "class ", "import ", "from ", "return ", "if (", "for (",
        "fn ", "pub ", "use ", "#include", "public ", "private ", "</", "<div", "select ", "//", "/*", "* ", "#!",
    ];
    const ENDS: &[&str] = &["{", "}", ";", ")", "]", "=>", ","];
    let n = lines.len().min(200);
    let mut hits = 0usize;
    for l in lines.iter().take(n) {
        let s = l.trim();
        if s.is_empty() {
            continue;
        }
        let lower = s.to_lowercase();
        if ENDS.iter().any(|e| s.ends_with(e)) || STARTS.iter().any(|p| lower.starts_with(p)) {
            hits += 1;
        }
    }
    hits >= 2 && hits * 3 >= n
}

/// Programming language reported by VS Code's `vscode-editor-data` clipboard format.
pub fn vscode_language(data: &[u8]) -> Option<String> {
    // GlobalSize() can be larger than the payload: strip trailing NUL padding before parsing.
    let end = data.iter().rposition(|&b| b != 0).map(|i| i + 1).unwrap_or(0);
    let v: serde_json::Value = serde_json::from_slice(&data[..end]).ok()?;
    v.get("mode")?.as_str().map(|s| s.to_string()).filter(|s| !s.is_empty() && s != "plaintext")
}

/// Card kind for a piece of text.
pub fn text_kind(text: &str, vscode_lang: Option<&str>) -> (&'static str, Option<String>, Option<String>) {
    if let Some(c) = parse_color(text) {
        return ("color", None, Some(c));
    }
    if parse_link(text).is_some() {
        return ("link", None, None);
    }
    if let Some(l) = vscode_lang {
        return ("code", Some(l.to_string()), None);
    }
    if looks_like_code(text) {
        return ("code", None, None);
    }
    ("text", None, None)
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    let mut alt = false;
    for c in digits.chars().rev() {
        let mut d = match c.to_digit(10) {
            Some(d) => d,
            None => return false,
        };
        if alt {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        alt = !alt;
    }
    sum % 10 == 0
}

/// Credit-card numbers (Luhn), API keys, private keys and JWTs.
pub fn is_sensitive(text: &str) -> bool {
    static SET: OnceLock<RegexSet> = OnceLock::new();
    if text.len() > 6000 {
        return false;
    }
    let set = SET.get_or_init(|| {
        RegexSet::new([
            r"\bsk-[A-Za-z0-9_\-]{20,}",
            r"\bgh[pousr]_[A-Za-z0-9]{30,}",
            r"\bgithub_pat_[A-Za-z0-9_]{40,}",
            r"\bAKIA[0-9A-Z]{16}\b",
            r"\bxox[baprs]-[A-Za-z0-9\-]{10,}",
            r"\bAIza[0-9A-Za-z_\-]{35}",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
            r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        ])
        .expect("valid regex set")
    });
    if set.is_match(text) {
        return true;
    }
    let t = text.trim();
    if t.len() >= 13 && t.len() <= 23 && t.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') {
        let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
        if (13..=19).contains(&digits.len()) && luhn(&digits) {
            return true;
        }
    }
    false
}

pub fn friendly_app_name(exe: &str) -> String {
    let stem = exe.trim_end_matches(".exe").trim_end_matches(".EXE");
    let l = stem.to_lowercase();
    let known = match l.as_str() {
        "code" => "VS Code",
        "code - insiders" => "VS Code Insiders",
        "chrome" => "Chrome",
        "msedge" => "Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "opera" => "Opera",
        "winword" => "Word",
        "excel" => "Excel",
        "powerpnt" => "PowerPoint",
        "outlook" => "Outlook",
        "onenote" => "OneNote",
        "notepad" => "Notepad",
        "notepad++" => "Notepad++",
        "explorer" => "Explorer",
        "windowsterminal" => "Terminal",
        "cmd" => "Command Prompt",
        "powershell" | "pwsh" => "PowerShell",
        "devenv" => "Visual Studio",
        "telegram" => "Telegram",
        "whatsapp" => "WhatsApp",
        "slack" => "Slack",
        "discord" => "Discord",
        "teams" | "ms-teams" => "Teams",
        "idea64" => "IntelliJ IDEA",
        "pycharm64" => "PyCharm",
        "webstorm64" => "WebStorm",
        "sublime_text" => "Sublime Text",
        "clipnest" => "ClipNest",
        "" => "Unknown",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    let mut c = stem.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_persian_and_arabic() {
        assert_eq!(normalize("كتاب‌ها"), normalize("کتابها"));
        assert_eq!(normalize("علي"), normalize("علی"));
        assert_eq!(normalize("۱۲۳٤٥"), "12345");
        assert_eq!(normalize("HeLLo"), "hello");
    }

    #[test]
    fn detects_colors_and_links() {
        assert!(parse_color("#3B66EA").is_some());
        assert!(parse_color("rgb(10, 20, 30)").is_some());
        assert!(parse_color("#12345").is_none());
        assert!(parse_link("https://example.com/a?b=1").is_some());
        assert!(parse_link("not a link").is_none());
    }

    #[test]
    fn detects_sensitive_data() {
        assert!(is_sensitive("4111 1111 1111 1111"));
        assert!(!is_sensitive("4111 1111 1111 1112"));
        assert!(is_sensitive("sk-abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!is_sensitive("hello world"));
    }

    #[test]
    fn vscode_language_tolerates_nul_padding() {
        let mut d = br#"{"version":1,"mode":"typescript"}"#.to_vec();
        d.extend_from_slice(&[0, 0, 0]);
        assert_eq!(vscode_language(&d).as_deref(), Some("typescript"));
    }

    #[test]
    fn code_heuristic() {
        assert!(looks_like_code("function a() {\n  return 1;\n}\n"));
        assert!(!looks_like_code("just a normal sentence\nand another one"));
    }
}
