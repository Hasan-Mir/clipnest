//! Built-in CopyQ-style text transformations shared between the GUI and CLI.

use base64::Engine;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct TransformInfo {
    pub id: &'static str,
    pub group: &'static str,
    pub label: &'static str,
}

pub const TRANSFORM_LIST: &[TransformInfo] = &[
    TransformInfo { id: "json-pretty", group: "JSON", label: "Prettify JSON" },
    TransformInfo { id: "json-min", group: "JSON", label: "Minify JSON" },
    TransformInfo { id: "upper", group: "Case", label: "UPPERCASE" },
    TransformInfo { id: "lower", group: "Case", label: "lowercase" },
    TransformInfo { id: "title", group: "Case", label: "Title Case" },
    TransformInfo { id: "sentence", group: "Case", label: "Sentence case" },
    TransformInfo { id: "camel", group: "Case", label: "camelCase" },
    TransformInfo { id: "pascal", group: "Case", label: "PascalCase" },
    TransformInfo { id: "snake", group: "Case", label: "snake_case" },
    TransformInfo { id: "kebab", group: "Case", label: "kebab-case" },
    TransformInfo { id: "const", group: "Case", label: "CONSTANT_CASE" },
    TransformInfo { id: "b64-enc", group: "Encode", label: "Base64 encode" },
    TransformInfo { id: "b64-dec", group: "Encode", label: "Base64 decode" },
    TransformInfo { id: "url-enc", group: "Encode", label: "URL encode" },
    TransformInfo { id: "url-dec", group: "Encode", label: "URL decode" },
    TransformInfo { id: "html-esc", group: "Encode", label: "HTML escape" },
    TransformInfo { id: "html-unesc", group: "Encode", label: "HTML unescape" },
    TransformInfo { id: "jwt", group: "Encode", label: "Decode JWT" },
    TransformInfo { id: "trim", group: "Whitespace", label: "Trim" },
    TransformInfo { id: "collapse", group: "Whitespace", label: "Collapse whitespace" },
    TransformInfo { id: "singleline", group: "Lines", label: "Join lines" },
    TransformInfo { id: "join-lines-dense", group: "Lines", label: "Join lines (dense)" },
    TransformInfo { id: "noblank", group: "Lines", label: "Remove blank lines" },
    TransformInfo { id: "dedupe", group: "Lines", label: "Remove duplicate lines" },
    TransformInfo { id: "sort", group: "Lines", label: "Sort lines A->Z" },
    TransformInfo { id: "sortr", group: "Lines", label: "Sort lines Z->A" },
    TransformInfo { id: "reverse", group: "Lines", label: "Reverse lines" },
    TransformInfo { id: "number", group: "Lines", label: "Number lines" },
    TransformInfo { id: "fa-normalize", group: "Persian", label: "Normalize chars & English digits (ی ک 123)" },
    TransformInfo { id: "fa-digits", group: "Persian", label: "Farsi digits (۰۱۲۳۴۵۶۷۸۹)" },
    TransformInfo { id: "fa-ye-ke", group: "Persian", label: "Arabic Yeh/Kaf -> Persian (ی ک)" },
    TransformInfo { id: "count", group: "Info", label: "Count chars / words / lines" },
];

fn split_words(s: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(s.len() + 16);
    let chars: Vec<char> = s.chars().collect();
    for i in 0..chars.len() {
        let c = chars[i];
        if i > 0 {
            let prev = chars[i - 1];
            if (prev.is_ascii_lowercase() || prev.is_ascii_digit()) && c.is_ascii_uppercase() {
                spaced.push(' ');
            } else if i + 1 < chars.len()
                && prev.is_ascii_uppercase()
                && c.is_ascii_uppercase()
                && chars[i + 1].is_ascii_lowercase()
            {
                spaced.push(' ');
            }
        }
        if matches!(c, '_' | '-' | '.') {
            spaced.push(' ');
        } else {
            spaced.push(c);
        }
    }
    spaced.split_whitespace().filter(|w| !w.is_empty()).map(|w| w.to_string()).collect()
}

fn capitalize_word(w: &str) -> String {
    let mut chars = w.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

fn b64_decode(s: &str) -> Result<String, String> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let pad = (4 - (cleaned.len() % 4)) % 4;
    let padded = format!("{cleaned}{}", "=".repeat(pad));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(padded.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("decoded base64 is not valid UTF-8: {e}"))
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(*b as char);
            }
            byte => {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

fn url_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(val) = u8::from_str_radix(hex, 16) {
                out.push(val);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|e| format!("invalid URL-encoded UTF-8: {e}"))
}

pub fn to_english_digits(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '۰'..='۹' => (b'0' + (c as u32 - '۰' as u32) as u8) as char,
            '٠'..='٩' => (b'0' + (c as u32 - '٠' as u32) as u8) as char,
            other => other,
        })
        .collect()
}

pub fn to_persian_digits(s: &str) -> String {
    const FA: [char; 10] = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    s.chars()
        .map(|c| match c {
            '0'..='9' => FA[(c as u8 - b'0') as usize],
            '٠'..='٩' => FA[(c as u32 - '٠' as u32) as usize],
            other => other,
        })
        .collect()
}

pub fn arabic_replacer(s: &str) -> String {
    let replaced = s
        .replace("دِ", "د")
        .replace("بِ", "ب")
        .replace("زِ", "ز")
        .replace("ذِ", "ذ")
        .replace("ِشِ", "ش")
        .replace("ِسِ", "س")
        .replace('ك', "ک")
        .replace('\u{0640}', "")
        .replace('\u{200d}', "\u{200c}")
        .replace(['ى', 'ي'], "ی")
        .replace('ة', "ه");
    to_english_digits(&replaced)
}

pub fn apply_transform(id: &str, input: &str) -> Result<String, String> {
    match id {
        "json-pretty" => {
            let v: serde_json::Value = serde_json::from_str(input).map_err(|e| format!("invalid JSON: {e}"))?;
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
        }
        "json-min" => {
            let v: serde_json::Value = serde_json::from_str(input).map_err(|e| format!("invalid JSON: {e}"))?;
            serde_json::to_string(&v).map_err(|e| e.to_string())
        }
        "upper" => Ok(input.to_uppercase()),
        "lower" => Ok(input.to_lowercase()),
        "title" => {
            let mut out = String::with_capacity(input.len());
            let mut new_word = true;
            for c in input.chars() {
                if c.is_whitespace() {
                    new_word = true;
                    out.push(c);
                } else if new_word {
                    new_word = false;
                    for u in c.to_uppercase() {
                        out.push(u);
                    }
                } else {
                    for l in c.to_lowercase() {
                        out.push(l);
                    }
                }
            }
            Ok(out)
        }
        "sentence" => {
            let lower = input.to_lowercase();
            let mut out = String::with_capacity(lower.len());
            let mut cap_next = true;
            for c in lower.chars() {
                if cap_next && c.is_alphabetic() {
                    for u in c.to_uppercase() {
                        out.push(u);
                    }
                    cap_next = false;
                } else {
                    out.push(c);
                    if matches!(c, '.' | '!' | '?') {
                        cap_next = true;
                    }
                }
            }
            Ok(out)
        }
        "camel" => {
            let w = split_words(input);
            Ok(w.iter()
                .enumerate()
                .map(|(i, word)| if i == 0 { word.to_lowercase() } else { capitalize_word(word) })
                .collect::<Vec<_>>()
                .join(""))
        }
        "pascal" => Ok(split_words(input).iter().map(|w| capitalize_word(w)).collect::<Vec<_>>().join("")),
        "snake" => Ok(split_words(input).iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join("_")),
        "kebab" => Ok(split_words(input).iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join("-")),
        "const" => Ok(split_words(input).iter().map(|w| w.to_uppercase()).collect::<Vec<_>>().join("_")),
        "b64-enc" => Ok(base64::engine::general_purpose::STANDARD.encode(input.as_bytes())),
        "b64-dec" => b64_decode(input),
        "url-enc" => Ok(url_encode(input)),
        "url-dec" => url_decode(input),
        "html-esc" => Ok(input
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;")),
        "html-unesc" => Ok(input
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .replace("&quot;", "\"")
            .replace("&gt;", ">")
            .replace("&lt;", "<")
            .replace("&amp;", "&")),
        "jwt" => {
            let parts: Vec<&str> = input.trim().split('.').collect();
            if parts.len() < 2 {
                return Err("not a valid JWT".into());
            }
            let pretty = |seg: &str| -> Result<String, String> {
                let decoded = b64_decode(seg)?;
                let val: serde_json::Value = serde_json::from_str(&decoded).map_err(|e| e.to_string())?;
                serde_json::to_string_pretty(&val).map_err(|e| e.to_string())
            };
            Ok(format!("// header\n{}\n\n// payload\n{}", pretty(parts[0])?, pretty(parts[1])?))
        }
        "trim" => Ok(input.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")),
        "collapse" => {
            let lines: Vec<String> = input
                .lines()
                .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|l| !l.is_empty())
                .collect();
            Ok(lines.join("\n"))
        }
        "singleline" => Ok(input.split_whitespace().collect::<Vec<_>>().join(" ")),
        "join-lines-dense" => Ok(input.replace("\r\n", "").replace('\n', "")),
        "noblank" => Ok(input.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")),
        "dedupe" => {
            let mut seen = std::collections::HashSet::new();
            let mut out = Vec::new();
            for line in input.lines() {
                if seen.insert(line) {
                    out.push(line);
                }
            }
            Ok(out.join("\n"))
        }
        "sort" => {
            let mut lines: Vec<&str> = input.lines().collect();
            lines.sort();
            Ok(lines.join("\n"))
        }
        "sortr" => {
            let mut lines: Vec<&str> = input.lines().collect();
            lines.sort_by(|a, b| b.cmp(a));
            Ok(lines.join("\n"))
        }
        "reverse" => {
            let mut lines: Vec<&str> = input.lines().collect();
            lines.reverse();
            Ok(lines.join("\n"))
        }
        "number" => {
            Ok(input.lines().enumerate().map(|(i, l)| format!("{}. {l}", i + 1)).collect::<Vec<_>>().join("\n"))
        }
        "fa-normalize" => Ok(arabic_replacer(input)),
        "fa-digits" => Ok(to_persian_digits(input)),
        "fa-ye-ke" => Ok(input.replace(['ي', 'ى'], "ی").replace('ك', "ک").replace('ة', "ه")),
        "count" => {
            let chars = input.chars().count();
            let words = input.split_whitespace().count();
            let lines = if input.is_empty() { 1 } else { input.split('\n').count() };
            Ok(format!("characters: {chars}\nwords: {words}\nlines: {lines}"))
        }
        other => {
            Err(format!("unknown transform '{other}'. Run 'clipnest transform list' to see available transforms."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transforms_match_frontend_behavior() {
        assert_eq!(apply_transform("camel", "hello world example").unwrap(), "helloWorldExample");
        assert_eq!(apply_transform("snake", "helloWorldExample").unwrap(), "hello_world_example");
        assert_eq!(apply_transform("fa-normalize", "كتاب شماره ٢ و ۳").unwrap(), "کتاب شماره 2 و 3");
        assert_eq!(apply_transform("fa-digits", "Version 1.2").unwrap(), "Version ۱.۲");
        assert_eq!(apply_transform("sentence", "über. école. привет. мир!").unwrap(), "Über. École. Привет. Мир!");
        assert_eq!(apply_transform("dedupe", "b\na\nb\nc\na").unwrap(), "b\na\nc");
        let b64 = apply_transform("b64-enc", "ClipNest CLI").unwrap();
        assert_eq!(apply_transform("b64-dec", &b64).unwrap(), "ClipNest CLI");
    }
}
