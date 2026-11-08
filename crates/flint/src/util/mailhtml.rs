//! HTML for display and for compose.
//!
//! Display (`sanitize_for_display`): a message's text/html part is
//! attacker-controlled, so it goes through ammonia (an allowlist sanitizer):
//! scripts, styles, forms, event handlers and unknown tags go; links keep
//! only http/https/mailto. Remote images are blocked by default: an `<img>` whose src is not `data:`/`cid:` is removed and
//! counted, so the thread view can offer "Load images". Layout tables are
//! flattened into blocks, since the text view lays tables out as data grids
//! and nearly every table in mail is layout.
//!
//! Compose: the GPUI editor is a plain text area where the user writes the
//! usual Markdown shortcuts (`#`, `-`, `1.`, `>`,
//! fences, `**bold**`). `markdown_to_html` makes the text/html part,
//! `markdown_to_text` the text/plain part, and `html_to_markdown` turns a
//! stored draft's HTML back into editable text.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub struct SanitizedHtml {
    pub html: String,
    /// Elements whose remote image was removed (0 when images are allowed)
    #[cfg_attr(not(test), allow(dead_code))]
    pub blocked_images: usize,
}

fn is_inline_scheme(url: &str) -> bool {
    let u = url.trim_start().to_ascii_lowercase();
    u.starts_with("data:") || u.starts_with("cid:")
}

pub fn sanitize_for_display(html: &str, allow_remote_images: bool) -> SanitizedHtml {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let blocked = Arc::new(AtomicUsize::new(0));
    let tags: HashSet<&str> = [
        "a", "b", "strong", "i", "em", "u", "s", "del", "strike", "code", "pre", "blockquote",
        "p", "div", "span", "br", "hr", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
        "img", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "center", "font", "small",
        "big", "sup", "sub", "mark",
    ]
    .into_iter()
    .collect();

    let counter = blocked.clone();
    let cleaned = ammonia::Builder::default()
        .tags(tags)
        .rm_tags(["style", "script"])
        .clean_content_tags(["style", "script", "title", "head"].into_iter().collect())
        .generic_attributes(HashSet::new())
        .tag_attributes(
            [
                ("a", ["href", "title"].into_iter().collect::<HashSet<_>>()),
                ("img", ["src", "alt", "title", "width", "height"].into_iter().collect()),
            ]
            .into_iter()
            .collect(),
        )
        .url_schemes(["http", "https", "mailto", "data", "cid"].into_iter().collect())
        .link_rel(Some("noreferrer noopener"))
        .attribute_filter(move |element, attribute, value| {
            if element == "img" && attribute == "src" && !allow_remote_images && !is_inline_scheme(value) {
                counter.fetch_add(1, Ordering::Relaxed);
                return None;
            }
            if element == "a" && attribute == "href" && is_inline_scheme(value) {
                return None;
            }
            Some(value.into())
        })
        .clean(html)
        .to_string();

    SanitizedHtml { html: post_process(&cleaned), blocked_images: blocked.load(Ordering::Relaxed) }
}

/// Flatten tables, drop images with nothing to show (no src, or tracking pixels)
fn post_process(html: &str) -> String {
    static TABLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)<(/?)(?:table|thead|tbody|tfoot|tr|td|th|center)\b[^>]*>").unwrap()
    });
    static IMG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<img\b[^>]*>").unwrap());
    static SRC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bsrc=""#).unwrap());
    static TINY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)\b(?:width|height)="[0-2]""#).unwrap());
    let flat = TABLE.replace_all(html, "<${1}div>");
    let flat = unwrap_inline_code(&flat);
    IMG.replace_all(&flat, |c: &regex::Captures| {
        let tag = &c[0];
        if !SRC.is_match(tag) || TINY.is_match(tag) {
            String::new()
        } else {
            tag.to_string()
        }
    })
    .into_owned()
}

/// GPUI Kit's text view (0.9) paints inline code as a box over the whole
/// paragraph, hiding its text. Inline `<code>` outside `<pre>` is unwrapped
/// to plain text until that is fixed upstream; code blocks are unaffected.
fn unwrap_inline_code(html: &str) -> String {
    static PRE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<pre\b.*?</pre>").unwrap());
    static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</?code\b[^>]*>").unwrap());
    let mut out = String::with_capacity(html.len());
    let mut last = 0;
    for m in PRE.find_iter(html) {
        out.push_str(&CODE.replace_all(&html[last..m.start()], ""));
        out.push_str(m.as_str());
        last = m.end();
    }
    out.push_str(&CODE.replace_all(&html[last..], ""));
    out
}

// ---------- compose ----------

fn md_options() -> pulldown_cmark::Options {
    use pulldown_cmark::Options;
    Options::ENABLE_STRIKETHROUGH
}

pub fn markdown_to_html(md: &str) -> String {
    let parser = pulldown_cmark::Parser::new_ext(md, md_options()).map(|ev| match ev {
        // One Enter is one line break, as in the rich editor
        pulldown_cmark::Event::SoftBreak => pulldown_cmark::Event::HardBreak,
        other => other,
    });
    let mut out = String::new();
    pulldown_cmark::html::push_html(&mut out, parser);
    // `# Title` in the editor meant the editor's largest heading (h2)
    static H1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<(/?)h1>").unwrap());
    H1.replace_all(out.trim_end(), "<${1}h2>").into_owned()
}

/// The text/plain part: what the reader sees, without Markdown syntax
pub fn markdown_to_text(md: &str) -> String {
    use pulldown_cmark::{Event, Tag, TagEnd};
    let mut out = String::new();
    let mut list_stack: Vec<Option<u64>> = Vec::new();
    for ev in pulldown_cmark::Parser::new_ext(md, md_options()) {
        match ev {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::Start(Tag::List(start)) => list_stack.push(start),
            Event::End(TagEnd::List(_)) => {
                list_stack.pop();
                if list_stack.is_empty() {
                    out.push('\n');
                }
            }
            Event::Start(Tag::Item) => {
                let marker = match list_stack.last_mut() {
                    Some(Some(n)) => {
                        let s = format!("{n}. ");
                        *n += 1;
                        s
                    }
                    _ => "- ".to_string(),
                };
                out.push_str(&marker);
            }
            Event::End(TagEnd::Item) => out.push('\n'),
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Heading(_)) => {
                if list_stack.is_empty() {
                    out.push_str("\n\n");
                }
            }
            Event::End(TagEnd::CodeBlock) => out.push('\n'),
            Event::Start(Tag::BlockQuote(_)) => out.push_str("> "),
            _ => {}
        }
    }
    static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    BLANKS.replace_all(out.trim(), "\n\n").into_owned()
}

/// Stored draft HTML (ours, or an older build's rich editor) back to editable Markdown.
/// Handles the tags the editors produce; anything else contributes its text.
pub fn html_to_markdown(html: &str) -> String {
    static TOKEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)<(/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)").unwrap());
    static HREF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"href="([^"]*)""#).unwrap());
    let mut out = String::new();
    let mut lists: Vec<(bool, u32)> = Vec::new();
    let mut link: Option<String> = None;
    let mut in_pre = false;
    let mut quote = false;
    // Just wrote a list marker: the item's own <p> must not start a new line
    let mut after_marker = false;
    for c in TOKEN.captures_iter(html) {
        if let Some(text) = c.get(4) {
            after_marker = false;
            let t = decode_entities(text.as_str());
            if in_pre {
                out.push_str(&t);
            } else if t.trim().is_empty() && t.contains('\n') {
                // Whitespace between block tags, not content
            } else {
                let t = t.replace('\n', " ");
                let t = if out.is_empty() || out.ends_with('\n') { t.trim_start() } else { &t };
                out.push_str(t);
            }
            continue;
        }
        let closing = &c[1] == "/";
        let tag = c[2].to_ascii_lowercase();
        let attrs = &c[3];
        let line_start = |out: &mut String| {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
        };
        match (tag.as_str(), closing) {
            ("p" | "div", false) => {
                if !after_marker {
                    line_start(&mut out);
                }
                if attrs.contains("imgph") {
                    out.push_str("[image]");
                }
                if quote {
                    out.push_str("> ");
                }
            }
            ("p" | "div" | "h1" | "h2" | "h3" | "h4" | "blockquote", true) => {
                if lists.is_empty() {
                    out.push_str("\n\n");
                }
                if tag == "blockquote" {
                    quote = false;
                }
            }
            ("h1" | "h2", false) => {
                line_start(&mut out);
                out.push_str("# ");
            }
            ("h3" | "h4", false) => {
                line_start(&mut out);
                out.push_str("## ");
            }
            ("blockquote", false) => quote = true,
            ("strong" | "b", _) => out.push_str("**"),
            ("em" | "i", _) => out.push('*'),
            ("u", false) => out.push_str("<u>"),
            ("u", true) => out.push_str("</u>"),
            ("s" | "del", _) => out.push_str("~~"),
            ("code", _) if !in_pre => out.push('`'),
            ("pre", false) => {
                line_start(&mut out);
                out.push_str("```\n");
                in_pre = true;
            }
            ("pre", true) => {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n\n");
                in_pre = false;
            }
            ("br", _) => out.push('\n'),
            ("ul", false) => lists.push((false, 1)),
            ("ol", false) => lists.push((true, 1)),
            ("ul" | "ol", true) => {
                lists.pop();
                if lists.is_empty() {
                    while !out.ends_with("\n\n") {
                        out.push('\n');
                    }
                }
            }
            ("li", false) => {
                line_start(&mut out);
                let depth = lists.len().saturating_sub(1);
                out.push_str(&"  ".repeat(depth));
                match lists.last_mut() {
                    Some((true, n)) => {
                        out.push_str(&format!("{n}. "));
                        *n += 1;
                    }
                    _ => out.push_str("- "),
                }
                after_marker = true;
                continue;
            }
            ("a", false) => {
                link = HREF.captures(attrs).map(|h| decode_entities(&h[1]));
                out.push('[');
            }
            ("a", true) => {
                out.push(']');
                out.push_str(&format!("({})", link.take().unwrap_or_default()));
            }
            _ => {}
        }
    }
    static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    static EMPTY_P: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^[ \t]+$").unwrap());
    let s = EMPTY_P.replace_all(&out, "");
    BLANKS.replace_all(s.trim(), "\n\n").into_owned()
}

fn decode_entities(s: &str) -> String {
    static ENT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);").unwrap());
    ENT.replace_all(s, |c: &regex::Captures| {
        let body = &c[1];
        if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
            return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default();
        }
        if let Some(dec) = body.strip_prefix('#') {
            return dec.parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default();
        }
        match body {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            "apos" => "'",
            "nbsp" => " ",
            _ => return c[0].to_string(),
        }
        .to_string()
    })
    .into_owned()
}

pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_remote_images_and_scripts() {
        let s = sanitize_for_display(
            r#"<p onclick="x()">Hi<script>evil()</script></p><img src="https://t.co/p.gif" width="600"><img src="data:image/png;base64,AA" width="10"><a href="javascript:x">j</a><a href="https://ok">ok</a>"#,
            false,
        );
        assert_eq!(s.blocked_images, 1);
        assert!(!s.html.contains("script") && !s.html.contains("onclick"));
        assert!(!s.html.contains("t.co"));
        assert!(s.html.contains("data:image/png"));
        assert!(s.html.contains(r#"href="https://ok""#));
        assert!(!s.html.contains("javascript"));
    }

    #[test]
    fn allows_images_on_request_but_drops_pixels() {
        let s = sanitize_for_display(
            r#"<img src="https://h/a.png" width="300"><img src="https://h/p.gif" width="1" height="1">"#,
            true,
        );
        assert_eq!(s.blocked_images, 0);
        assert!(s.html.contains("a.png") && !s.html.contains("p.gif"));
    }

    #[test]
    fn unwraps_inline_code_only() {
        let s = sanitize_for_display("<p>Run <code>x</code></p><pre><code>y</code></pre>", false);
        assert_eq!(s.html, "<p>Run x</p><pre><code>y</code></pre>");
    }

    #[test]
    fn flattens_tables() {
        let s = sanitize_for_display("<table><tr><td>a</td><td>b</td></tr></table>", false);
        assert_eq!(s.html, "<div><div><div><div>a</div><div>b</div></div></div></div>");
    }

    #[test]
    fn markdown_round_trip() {
        let md = "# Plan\n\nHello **there**\nsecond line\n\n- one\n- two\n\n> quoted";
        let html = markdown_to_html(md);
        assert!(html.starts_with("<h2>Plan</h2>"));
        assert!(html.contains("<strong>there</strong><br />"));
        assert!(html.contains("<li>one</li>"));
        let text = markdown_to_text(md);
        assert_eq!(text, "Plan\n\nHello there\nsecond line\n\n- one\n- two\n\n> quoted");
        let back = html_to_markdown(&html);
        assert!(back.starts_with("# Plan\n\nHello **there**\nsecond line"), "{back}");
        assert!(back.contains("- one\n- two"), "{back}");
    }

    #[test]
    fn rich_editor_html_to_markdown() {
        let md = html_to_markdown(
            "<p>Hi &amp; bye</p><ol><li><p>a</p></li><li><p>b</p></li></ol><pre><code>x = 1</code></pre><p><a href=\"https://x.io\">x</a></p>",
        );
        assert_eq!(md, "Hi & bye\n\n1. a\n2. b\n\n```\nx = 1\n```\n\n[x](https://x.io)");
    }
}
