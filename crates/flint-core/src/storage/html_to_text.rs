//! Plain text out of an HTML mail body (port of `src/main/storage/htmlToText.ts`).
//! Good enough for search indexing and a fallback rendering; not a layout engine.
//!
//! Steps: drop comments and the contents of script/style/head/noscript/
//! template, turn block-level boundaries into newlines and cell boundaries
//! into spaces, strip the remaining tags, decode entities, collapse whitespace.

use regex::{Captures, Regex};
use std::sync::LazyLock;

static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
/// Opening tag of an element dropped with its content. The TS regex closes it
/// with a backreference (`<\/\1\s*>`), which the regex crate lacks, so the
/// closing tag is found by hand in [`drop_with_content`].
static DROP_OPEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<(script|style|head|noscript|template)(?-u:\b)[^>]*>").unwrap()
});
static BLOCK_BREAK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)</?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|thead|tbody|tfoot|blockquote|pre|section|article|header|footer|nav|aside|address|figure|figcaption|fieldset|legend|form|center|title)(?-u:\b)[^>]*/?>",
    )
    .unwrap()
});
static CELL_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</?(?:td|th)(?-u:\b)[^>]*>").unwrap());
/// A real tag starts with a letter, `/`, `!` or `?`; a lone `<` in prose is left alone
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?[a-zA-Z!?][^>]*>").unwrap());
static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});").unwrap()
});
static HSPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[ \t\r\x0C\x0B\u{00a0}]+").unwrap());
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{2,}").unwrap());

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "ensp" => " ",
        "emsp" => " ",
        "thinsp" => " ",
        "shy" => "",
        "zwnj" => "",
        "zwj" => "",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "lsquo" => "‘",
        "rsquo" => "’",
        "sbquo" => "‚",
        "ldquo" => "“",
        "rdquo" => "”",
        "bdquo" => "„",
        "laquo" => "«",
        "raquo" => "»",
        "bull" => "•",
        "middot" => "·",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "deg" => "°",
        "times" => "×",
        "divide" => "÷",
        "plusmn" => "±",
        "frac12" => "½",
        "frac14" => "¼",
        "frac34" => "¾",
        "iexcl" => "¡",
        "iquest" => "¿",
        "sect" => "§",
        "para" => "¶",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "harr" => "↔",
        "hearts" => "♥",
        "check" => "✓",
        "auml" => "ä",
        "ouml" => "ö",
        "uuml" => "ü",
        "Auml" => "Ä",
        "Ouml" => "Ö",
        "Uuml" => "Ü",
        "szlig" => "ß",
        "eacute" => "é",
        "egrave" => "è",
        "ecirc" => "ê",
        "agrave" => "à",
        "aacute" => "á",
        "acirc" => "â",
        "ccedil" => "ç",
        "ntilde" => "ñ",
        "oacute" => "ó",
        "iacute" => "í",
        "uacute" => "ú",
        "oslash" => "ø",
        "aring" => "å",
        "aelig" => "æ",
        _ => return None,
    })
}

pub fn decode_entities(input: &str) -> String {
    ENTITY
        .replace_all(input, |c: &Captures| {
            let body = &c[1];
            if let Some(num) = body.strip_prefix('#') {
                let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    num.parse::<u32>().ok()
                };
                return match code.filter(|&c| c > 0 && c <= 0x10ffff).and_then(char::from_u32) {
                    Some(ch) => ch.to_string(),
                    // NUL, surrogate halves, out of range: not text
                    None => String::new(),
                };
            }
            match named_entity(body) {
                Some(s) => s.to_string(),
                None => c[0].to_string(),
            }
        })
        .into_owned()
}

/// Remove script/style/head/noscript/template elements with their content:
/// the earliest opening tag whose matching closing tag (same name, any case)
/// follows it, scanning left to right like a global regex replace.
fn drop_with_content(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pos = 0; // copied up to here
    let mut search = 0;
    while let Some(open) = DROP_OPEN.captures_at(s, search) {
        let whole = open.get(0).unwrap();
        let tag = open[1].to_ascii_lowercase();
        let close_re = Regex::new(&format!(r"(?i)</{tag}\s*>")).unwrap();
        match close_re.find_at(s, whole.end()) {
            Some(close) => {
                out.push_str(&s[pos..whole.start()]);
                pos = close.end();
                search = close.end();
            }
            None => {
                // No closing tag: this start position does not match; move on
                let next = s[whole.start()..].chars().next().map_or(1, char::len_utf8);
                search = whole.start() + next;
            }
        }
        if search >= s.len() {
            break;
        }
    }
    out.push_str(&s[pos..]);
    out
}

/// JS String.prototype.trim: Unicode whitespace plus line terminators and BOM
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

pub fn html_to_text(html: &str) -> String {
    let s = COMMENTS.replace_all(html, "");
    let s = drop_with_content(&s);
    let s = BLOCK_BREAK.replace_all(&s, "\n");
    let s = CELL_BREAK.replace_all(&s, " ");
    let s = TAGS.replace_all(&s, "");
    let s = decode_entities(&s);
    let s = HSPACE.replace_all(&s, " ");
    let s = s.split('\n').map(js_trim).collect::<Vec<_>>().join("\n");
    let s = BLANK_RUNS.replace_all(&s, "\n");
    js_trim(&s).to_string()
}

/// Below this many non-blank characters a text part is not worth keeping over its HTML
pub const TRIVIAL_TEXT_CHARS: usize = 20;

/// Length in UTF-16 code units, as JS `.length` counts
pub(crate) fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The plain text to store for a message: the sender's text part when it
/// carries content, otherwise text derived from the HTML part.
pub fn best_plain_text(text: &str, html: Option<&str>) -> String {
    let trimmed = js_trim(text);
    let Some(html) = html.filter(|h| !h.is_empty()) else { return text.to_string() };
    if js_len(trimmed) >= TRIVIAL_TEXT_CHARS {
        return text.to_string();
    }
    let derived = html_to_text(html);
    if js_len(&derived) > js_len(trimmed) {
        derived
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_head_script_style_and_breaks_blocks() {
        let html = "<html><head><title>T</title><style>p{color:red}</style></head>
      <body><script>alert(1)</script><h1>Hello</h1><p>First   para</p><div>Second<br>line</div>
      <ul><li>one</li><li>two</li></ul></body></html>";
        assert_eq!(html_to_text(html), "Hello\nFirst para\nSecond\nline\none\ntwo");
    }

    #[test]
    fn table_cells_and_rows() {
        let html = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>";
        assert_eq!(html_to_text(html), "a b\nc d");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(
            decode_entities("&amp; &lt;b&gt; &quot;q&quot; &nbsp;x &#8212; &#x1F600; &bogus;"),
            "& <b> \"q\"  x — 😀 &bogus;"
        );
        assert_eq!(html_to_text("<p>Tom &amp; Jerry&rsquo;s caf&eacute;</p>"), "Tom & Jerry’s café");
    }

    #[test]
    fn lone_lt_and_comments() {
        assert_eq!(html_to_text("<p>if a < b then<!-- hidden --> ok</p>"), "if a < b then ok");
    }

    #[test]
    fn collapses_whitespace() {
        assert_eq!(html_to_text("<p>a</p>\n\n\n\n<p>&nbsp;</p><p>b</p>"), "a\nb");
    }

    #[test]
    fn newsletter_shell() {
        let html = r##"<!DOCTYPE html><html><body style="margin:0">
      <table role="presentation"><tr><td><a href="#">View in browser</a></td></tr>
      <tr><td><h2>Weekly digest</h2><p>Three things happened this week.</p></td></tr>
      </table><img src="pixel.gif" width="1" height="1"></body></html>"##;
        assert_eq!(html_to_text(html), "View in browser\nWeekly digest\nThree things happened this week.");
    }

    #[test]
    fn unclosed_drop_tag_is_left_for_tag_stripping() {
        assert_eq!(html_to_text("<script>x<p>kept</p>"), "x\nkept");
        assert_eq!(html_to_text("<STYLE>a{}</style >b"), "b");
        // <header> is not <head>
        assert_eq!(html_to_text("<header>top</header>"), "top");
    }

    #[test]
    fn best_plain_text_rules() {
        assert_eq!(
            best_plain_text("This is the plain text version.", Some("<p>HTML</p>")),
            "This is the plain text version."
        );
        assert_eq!(best_plain_text("", Some("<p>Only <b>HTML</b> here</p>")), "Only HTML here");
        assert_eq!(
            best_plain_text("View online", Some("<h1>Big announcement</h1><p>Details follow.</p>")),
            "Big announcement\nDetails follow."
        );
        assert_eq!(best_plain_text("hi", None), "hi");
        assert_eq!(best_plain_text("hi", Some("<img src=\"x\">")), "hi");
    }
}
